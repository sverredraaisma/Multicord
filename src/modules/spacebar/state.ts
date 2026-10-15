import { Emitter } from "../../shared/emitter";
import {
  ChannelType,
  TEXT_CHANNEL_TYPES,
  compareIds,
  emojiKey,
  isId,
  isRecord,
  list,
  parseChannel,
  parseEmoji,
  parseGuild,
  parseMessage,
  parseReactionEmoji,
  parseReadState,
  parseRole,
  parseUser,
  type ReactionEmoji,
  type SpacebarChannel,
  type SpacebarEmoji,
  type SpacebarGuild,
  type SpacebarMessage,
  type SpacebarReadState,
  type SpacebarRole,
  type SpacebarUser,
} from "./types";

/** Most messages kept per channel. */
const MAX_CACHED_MESSAGES = 200;
/** Spacebar, like Discord, shows typing for about 10 seconds per event. */
export const TYPING_MS = 10_000;

/** Client-side view of one Spacebar session, built from READY and dispatch events. */
export class SpacebarState {
  me: SpacebarUser | undefined;
  readonly guilds = new Map<string, SpacebarGuild>();
  readonly channels = new Map<string, SpacebarChannel>();
  readonly readStates = new Map<string, SpacebarReadState>();
  readonly users = new Map<string, SpacebarUser>();
  readonly messages = new Map<string, SpacebarMessage[]>();
  /** The newest message seen per channel, loaded or not, for previews. */
  readonly latest = new Map<string, SpacebarMessage>();
  /** Each guild's custom emoji. */
  readonly emojis = new Map<string, SpacebarEmoji[]>();
  /** Each guild's roles. */
  readonly roles = new Map<string, SpacebarRole[]>();
  /** The user's own roles in each guild, for role mentions. */
  readonly ownRoles = new Map<string, string[]>();
  /** Who is typing where: channel id -> user id -> expiry (epoch ms). */
  readonly typing = new Map<string, Map<string, number>>();

  readonly changed = new Emitter<void>();
  /** New messages from others, for acking in the open channel and notifying. */
  readonly incoming = new Emitter<SpacebarMessage>();

  reset(): void {
    this.me = undefined;
    for (const map of [this.guilds, this.channels, this.readStates, this.users, this.messages, this.latest, this.emojis, this.roles, this.ownRoles, this.typing]) map.clear();
  }

  apply(event: string, data: unknown): void {
    const d = isRecord(data) ? data : {};
    switch (event) {
      case "READY":
        this.reset();
        this.me = parseUser(d.user);
        this.addUser(this.me);
        for (const u of list(d.users)) this.addUser(parseUser(u));
        list(d.guilds).forEach((g, index) => this.addGuild(g, list(d.merged_members)[index]));
        for (const c of list(d.private_channels)) this.addChannel(parseChannel(c));
        // Spacebar sends read states as { entries }, as Discord does; a bare list is taken too.
        for (const r of isRecord(d.read_state) ? list(d.read_state.entries) : list(d.read_state)) this.setReadState(parseReadState(r));
        break;
      case "GUILD_CREATE":
        this.addGuild(data, undefined);
        break;
      case "GUILD_UPDATE": {
        const guild = parseGuild(data);
        if (guild) this.guilds.set(guild.id, guild);
        if (guild && Array.isArray(d.roles)) this.roles.set(guild.id, d.roles.flatMap((r) => parseRole(r) ?? []));
        break;
      }
      case "GUILD_DELETE":
        if (isId(d.id)) this.removeGuild(d.id);
        break;
      case "GUILD_EMOJIS_UPDATE":
        if (isId(d.guild_id)) this.emojis.set(d.guild_id, list(d.emojis).flatMap((e) => parseEmoji(e) ?? []));
        break;
      case "GUILD_ROLE_CREATE":
      case "GUILD_ROLE_UPDATE": {
        const role = parseRole(d.role);
        const roles = isId(d.guild_id) ? (this.roles.get(d.guild_id) ?? []) : undefined;
        if (role && roles) this.roles.set(d.guild_id as string, [...roles.filter((r) => r.id !== role.id), role]);
        break;
      }
      case "GUILD_ROLE_DELETE": {
        const roles = isId(d.guild_id) ? this.roles.get(d.guild_id) : undefined;
        if (roles) this.roles.set(d.guild_id as string, roles.filter((r) => r.id !== d.role_id));
        break;
      }
      case "GUILD_MEMBER_UPDATE":
        if (isId(d.guild_id) && isRecord(d.user) && d.user.id === this.me?.id) this.ownRoles.set(d.guild_id, list(d.roles).filter(isId));
        break;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
        this.addChannel(parseChannel(data));
        break;
      case "CHANNEL_DELETE":
        if (isId(d.id)) {
          this.channels.delete(d.id);
          this.messages.delete(d.id);
        }
        break;
      case "MESSAGE_CREATE":
        this.onMessageCreate(parseMessage(data));
        break;
      case "MESSAGE_UPDATE": {
        // Updates that carry only part of a message (an embed added) have no author and are left out.
        const message = parseMessage(data);
        if (message) this.replaceMessage(message);
        break;
      }
      case "MESSAGE_DELETE":
      case "MESSAGE_DELETE_BULK": {
        const ids = new Set(isId(d.id) ? [d.id] : list(d.ids).filter(isId));
        const channelId = isId(d.channel_id) ? d.channel_id : undefined;
        if (!channelId) return;
        const cached = this.messages.get(channelId);
        if (cached) this.messages.set(channelId, cached.filter((m) => !ids.has(m.id)));
        // A deleted last message leaves no preview rather than a stale one.
        if (ids.has(this.latest.get(channelId)?.id ?? "")) this.latest.delete(channelId);
        break;
      }
      case "MESSAGE_REACTION_ADD":
      case "MESSAGE_REACTION_REMOVE": {
        const emoji = parseReactionEmoji(d.emoji);
        if (!emoji || !isId(d.channel_id) || !isId(d.message_id) || !isId(d.user_id)) return;
        this.applyReaction(d.channel_id, d.message_id, emoji, d.user_id === this.me?.id, event === "MESSAGE_REACTION_ADD");
        return;
      }
      case "MESSAGE_REACTION_REMOVE_ALL":
      case "MESSAGE_REACTION_REMOVE_EMOJI": {
        const message = this.findMessage(d.channel_id, d.message_id);
        if (!message) return;
        const emoji = event === "MESSAGE_REACTION_REMOVE_EMOJI" ? parseReactionEmoji(d.emoji) : undefined;
        message.reactions = emoji ? message.reactions.filter((r) => emojiKey(r.emoji) !== emojiKey(emoji)) : [];
        break;
      }
      case "TYPING_START": {
        if (!isId(d.channel_id) || !isId(d.user_id) || d.user_id === this.me?.id) return;
        const member = isRecord(d.member) ? parseUser(d.member.user) : undefined;
        this.addUser(member);
        const channel = this.typing.get(d.channel_id) ?? new Map<string, number>();
        channel.set(d.user_id, Date.now() + TYPING_MS);
        this.typing.set(d.channel_id, channel);
        break;
      }
      case "MESSAGE_ACK":
        this.setReadState(parseReadState(data));
        break;
      case "USER_UPDATE": {
        const user = parseUser(data);
        if (user && user.id === this.me?.id) this.me = user;
        this.addUser(user);
        break;
      }
      default:
        return; // Unhandled events do not change what we show.
    }
    this.changed.emit();
  }

  /** Swaps in an edited message where it is cached; returns whether it was. */
  replaceMessage(message: SpacebarMessage): boolean {
    if (this.latest.get(message.channelId)?.id === message.id) this.latest.set(message.channelId, message);
    const cached = this.messages.get(message.channelId);
    const index = cached?.findIndex((m) => m.id === message.id) ?? -1;
    if (index < 0) return false;
    cached![index] = message;
    return true;
  }

  removeMessage(channelId: string, messageId: string): void {
    const cached = this.messages.get(channelId);
    if (cached) this.messages.set(channelId, cached.filter((m) => m.id !== messageId));
    if (this.latest.get(channelId)?.id === messageId) this.latest.delete(channelId);
    this.changed.emit();
  }

  /**
   * Adds or removes one reaction. The user's own reactions are idempotent:
   * they are applied once the request succeeds, and the gateway may echo them.
   */
  applyReaction(channelId: string, messageId: string, emoji: ReactionEmoji, mine: boolean, add: boolean): void {
    const message = this.findMessage(channelId, messageId);
    if (!message) return;
    const key = emojiKey(emoji);
    const index = message.reactions.findIndex((r) => emojiKey(r.emoji) === key);
    const reaction = message.reactions[index];
    if (add) {
      if (mine && reaction?.me) return;
      if (reaction) {
        reaction.count++;
        reaction.me ||= mine;
      } else message.reactions.push({ emoji, count: 1, me: mine });
    } else {
      if (!reaction || (mine && !reaction.me)) return;
      reaction.count--;
      if (mine) reaction.me = false;
      if (reaction.count <= 0) message.reactions.splice(index, 1);
    }
    this.changed.emit();
  }

  findMessage(channelId: unknown, messageId: unknown): SpacebarMessage | undefined {
    return isId(channelId) && isId(messageId) ? this.messages.get(channelId)?.find((m) => m.id === messageId) : undefined;
  }

  /** Records a local read (we acked it); the server confirms with MESSAGE_ACK. */
  markRead(channelId: string, messageId: string): void {
    this.readStates.set(channelId, { channelId, lastMessageId: messageId, mentionCount: 0 });
    this.changed.emit();
  }

  /** Stores fetched history; `older` pages are prepended. */
  addHistory(channelId: string, messages: SpacebarMessage[], older: boolean): void {
    for (const m of messages) this.addUser(m.author);
    const existing = this.messages.get(channelId) ?? [];
    const known = new Set(existing.map((m) => m.id));
    const fresh = messages.filter((m) => !known.has(m.id));
    this.messages.set(channelId, older ? [...fresh, ...existing] : [...existing, ...fresh]);
    for (const m of fresh) this.noteLatest(m);
    this.changed.emit();
  }

  isUnread(channel: SpacebarChannel): boolean {
    if (!TEXT_CHANNEL_TYPES.has(channel.type) || !channel.lastMessageId) return false;
    const read = this.readStates.get(channel.id)?.lastMessageId;
    // Without a read position, only mentions count; otherwise every old channel would look unread.
    return read === undefined ? this.mentions(channel.id) > 0 : compareIds(channel.lastMessageId, read) > 0;
  }

  mentions(channelId: string): number {
    return this.readStates.get(channelId)?.mentionCount ?? 0;
  }

  /** A guild's channels in sidebar order: uncategorised first, then each category with its children. */
  guildChannels(guildId: string): SpacebarChannel[] {
    const all = [...this.channels.values()].filter((c) => c.guildId === guildId);
    const byPosition = (a: SpacebarChannel, b: SpacebarChannel) => a.position - b.position || compareIds(a.id, b.id);
    const categories = all.filter((c) => c.type === ChannelType.GuildCategory).sort(byPosition);
    const categoryIds = new Set(categories.map((c) => c.id));
    const childrenOf = (parent?: string) =>
      all.filter((c) => c.type !== ChannelType.GuildCategory && (parent ? c.parentId === parent : !c.parentId || !categoryIds.has(c.parentId))).sort(byPosition);
    return [...childrenOf(), ...categories.flatMap((cat) => [cat, ...childrenOf(cat.id)])];
  }

  guildUnread(guildId: string): boolean {
    return [...this.channels.values()].some((c) => c.guildId === guildId && this.isUnread(c));
  }

  guildMentions(guildId: string): number {
    return [...this.channels.values()].filter((c) => c.guildId === guildId).reduce((sum, c) => sum + this.mentions(c.id), 0);
  }

  /** DMs and group DMs, most recent first. */
  privateChannels(): SpacebarChannel[] {
    return [...this.channels.values()]
      .filter((c) => c.type === ChannelType.Dm || c.type === ChannelType.GroupDm)
      .sort((a, b) => compareIds(b.lastMessageId ?? "0", a.lastMessageId ?? "0"));
  }

  /** Whether a message mentions the user: by name, as @everyone/@here, or through a role they have in its guild. */
  mentionsMe(message: SpacebarMessage): boolean {
    if (message.mentionEveryone || (this.me !== undefined && message.mentionIds.includes(this.me.id))) return true;
    const guildId = this.channels.get(message.channelId)?.guildId;
    const roles = guildId ? (this.ownRoles.get(guildId) ?? []) : [];
    return message.roleMentionIds.some((r) => roles.includes(r));
  }

  /** Users typing in a channel right now, excluding ourselves. */
  typingIn(channelId: string, now: number = Date.now()): SpacebarUser[] {
    return [...(this.typing.get(channelId) ?? [])].filter(([, expires]) => expires > now).flatMap(([userId]) => this.users.get(userId) ?? []);
  }

  private addUser(user: SpacebarUser | undefined): void {
    if (user) this.users.set(user.id, user);
  }

  /** A guild as READY or GUILD_CREATE gives it, with its channels, roles and emoji; `members` is READY's merged_members entry for it. */
  private addGuild(value: unknown, members: unknown): void {
    const guild = parseGuild(value);
    if (!guild) return;
    this.guilds.set(guild.id, guild);
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.channels)) {
      for (const c of [...this.channels.values()]) if (c.guildId === guild.id) this.channels.delete(c.id);
      for (const c of record.channels) this.addChannel(parseChannel(c, guild.id));
    }
    if (Array.isArray(record.emojis)) this.emojis.set(guild.id, record.emojis.flatMap((e) => parseEmoji(e) ?? []));
    if (Array.isArray(record.roles)) this.roles.set(guild.id, record.roles.flatMap((r) => parseRole(r) ?? []));
    // The user's own member object, with their roles: in READY's merged_members, or among a guild's members.
    const own = [...list(members), ...list(record.members)].find((m) => isRecord(m) && (m.user_id === this.me?.id || m.id === this.me?.id || (isRecord(m.user) && m.user.id === this.me?.id)));
    if (isRecord(own)) this.ownRoles.set(guild.id, list(own.roles).flatMap((r) => (isId(r) ? [r] : isRecord(r) && isId(r.id) ? [r.id] : [])));
  }

  private removeGuild(guildId: string): void {
    for (const map of [this.guilds, this.emojis, this.roles, this.ownRoles]) map.delete(guildId);
    for (const channel of [...this.channels.values()]) {
      if (channel.guildId !== guildId) continue;
      this.channels.delete(channel.id);
      this.messages.delete(channel.id);
    }
  }

  private addChannel(channel: SpacebarChannel | undefined): void {
    if (!channel) return;
    this.channels.set(channel.id, channel);
    for (const r of channel.recipients) this.addUser(r);
  }

  private setReadState(state: SpacebarReadState | undefined): void {
    if (state) this.readStates.set(state.channelId, state);
  }

  private noteLatest(message: SpacebarMessage): void {
    const current = this.latest.get(message.channelId);
    if (!current || compareIds(message.id, current.id) >= 0) this.latest.set(message.channelId, message);
  }

  private onMessageCreate(message: SpacebarMessage | undefined): void {
    if (!message) return;
    this.typing.get(message.channelId)?.delete(message.author.id);
    this.addUser(message.author);
    const channel = this.channels.get(message.channelId);
    if (channel) channel.lastMessageId = message.id;
    this.noteLatest(message);
    const cached = this.messages.get(message.channelId);
    if (cached && !cached.some((m) => m.id === message.id)) {
      cached.push(message);
      if (cached.length > MAX_CACHED_MESSAGES) cached.splice(0, cached.length - MAX_CACHED_MESSAGES);
    }
    if (message.author.id === this.me?.id) {
      this.readStates.set(message.channelId, { channelId: message.channelId, lastMessageId: message.id, mentionCount: 0 });
      return;
    }
    const isDm = channel?.type === ChannelType.Dm || channel?.type === ChannelType.GroupDm;
    if (isDm || this.mentionsMe(message)) {
      const current = this.readStates.get(message.channelId);
      this.readStates.set(message.channelId, { ...current, channelId: message.channelId, mentionCount: (current?.mentionCount ?? 0) + 1 });
    }
    this.incoming.emit(message);
  }
}
