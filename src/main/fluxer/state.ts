import { Emitter } from "../adapters/emitter";
import {
  ChannelType,
  FORUM_TYPES,
  TEXT_CHANNEL_TYPES,
  THREAD_TYPES,
  compareIds,
  isId,
  isRecord,
  emojiKey,
  parseChannel,
  parseEmoji,
  parseFolders,
  parseGuild,
  parseGuildSettings,
  parseMessage,
  parseReadState,
  parseUser,
  type FluxerChannel,
  type FluxerEmoji,
  DM_SETTINGS,
  NotifyLevel,
  type FluxerFolder,
  type FluxerNotifySettings,
  type FluxerGuild,
  type FluxerMessage,
  type FluxerReadState,
  type FluxerUser,
} from "./types";

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const MAX_CACHED_MESSAGES = 200;
/** Fluxer, like Discord, shows typing for about 10 seconds per event. */
export const TYPING_MS = 10_000;

/** Client-side view of one Fluxer session, built from READY and dispatch events. */
export class FluxerState {
  me: FluxerUser | undefined;
  readonly guilds = new Map<string, FluxerGuild>();
  readonly channels = new Map<string, FluxerChannel>();
  readonly readStates = new Map<string, FluxerReadState>();
  readonly users = new Map<string, FluxerUser>();
  readonly messages = new Map<string, FluxerMessage[]>();
  /** Who is typing where: channel id -> user id -> expiry (epoch ms). */
  readonly typing = new Map<string, Map<string, number>>();
  /** Notification settings per guild id, or DM_SETTINGS for DMs. */
  readonly notifySettings = new Map<string, FluxerNotifySettings>();
  folders: FluxerFolder[] | undefined;

  readonly changed = new Emitter<void>();
  /** New messages from others, for acking in the open channel. */
  readonly incoming = new Emitter<FluxerMessage>();

  reset(): void {
    this.me = undefined;
    this.folders = undefined;
    for (const map of [this.guilds, this.channels, this.readStates, this.users, this.messages, this.notifySettings, this.typing]) map.clear();
  }

  apply(event: string, data: unknown): void {
    const d = isRecord(data) ? data : {};
    switch (event) {
      case "READY":
        this.reset();
        this.me = parseUser(d.user);
        if (this.me) this.users.set(this.me.id, this.me);
        for (const u of list(d.users)) this.addUser(parseUser(u));
        for (const g of list(d.guilds)) this.addGuild(g);
        for (const c of list(d.private_channels)) this.addChannel(parseChannel(c));
        for (const r of list(d.read_states)) this.setReadState(parseReadState(r));
        this.folders = parseFolders(d.user_settings);
        for (const g of list(d.user_guild_settings)) this.setNotifySettings(parseGuildSettings(g));
        break;
      case "USER_GUILD_SETTINGS_UPDATE":
        this.setNotifySettings(parseGuildSettings(data));
        break;
      case "GUILD_CREATE":
      case "GUILD_SYNC":
        this.addGuild(data);
        break;
      case "GUILD_UPDATE": {
        const guild = parseGuild(data);
        if (guild) this.guilds.set(guild.id, guild);
        break;
      }
      case "GUILD_DELETE":
        if (isId(d.id)) this.removeGuild(d.id);
        break;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        this.addChannel(parseChannel(data));
        break;
      case "THREAD_LIST_SYNC":
        for (const t of list(d.threads)) this.addChannel(parseChannel(t, isId(d.guild_id) ? d.guild_id : undefined));
        break;
      case "CHANNEL_UPDATE_BULK":
        for (const c of list(d.channels)) this.addChannel(parseChannel(c, isId(d.guild_id) ? d.guild_id : undefined));
        break;
      case "CHANNEL_DELETE":
      case "THREAD_DELETE":
        if (isId(d.id)) {
          this.channels.delete(d.id);
          this.messages.delete(d.id);
        }
        break;
      case "MESSAGE_CREATE":
        this.onMessageCreate(parseMessage(data));
        break;
      case "MESSAGE_UPDATE": {
        const message = parseMessage(data);
        if (message) this.replaceMessage(message);
        break;
      }
      case "MESSAGE_REACTION_ADD":
      case "MESSAGE_REACTION_REMOVE": {
        const emoji = parseEmoji(d.emoji);
        if (!emoji || !isId(d.channel_id) || !isId(d.message_id) || !isId(d.user_id)) return;
        this.applyReaction(d.channel_id, d.message_id, emoji, d.user_id === this.me?.id, event === "MESSAGE_REACTION_ADD");
        break;
      }
      case "MESSAGE_REACTION_REMOVE_ALL":
      case "MESSAGE_REACTION_REMOVE_EMOJI": {
        const message = this.findMessage(d.channel_id, d.message_id);
        if (!message) return;
        const emoji = event === "MESSAGE_REACTION_REMOVE_EMOJI" ? parseEmoji(d.emoji) : undefined;
        message.reactions = emoji ? (message.reactions ?? []).filter((r) => emojiKey(r.emoji) !== emojiKey(emoji)) : [];
        break;
      }
      case "MESSAGE_DELETE":
      case "MESSAGE_DELETE_BULK": {
        const ids = new Set(isId(d.id) ? [d.id] : list(d.ids).filter(isId));
        const channelId = isId(d.channel_id) ? d.channel_id : undefined;
        const cached = channelId ? this.messages.get(channelId) : undefined;
        if (cached) this.messages.set(channelId!, cached.filter((m) => !ids.has(m.id)));
        break;
      }
      case "TYPING_START": {
        if (!isId(d.channel_id) || !isId(d.user_id) || d.user_id === this.me?.id) return;
        const started = typeof d.timestamp === "number" ? d.timestamp * 1000 : Date.now();
        const channel = this.typing.get(d.channel_id) ?? new Map<string, number>();
        channel.set(d.user_id, started + TYPING_MS);
        this.typing.set(d.channel_id, channel);
        break;
      }
      case "MESSAGE_ACK":
        this.setReadState(parseReadState(data));
        break;
      case "USER_SETTINGS_UPDATE":
        this.folders = parseFolders(data) ?? this.folders;
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
  replaceMessage(message: FluxerMessage): boolean {
    const cached = this.messages.get(message.channelId);
    const index = cached?.findIndex((m) => m.id === message.id) ?? -1;
    if (index < 0) return false;
    cached![index] = message;
    return true;
  }

  removeMessage(channelId: string, messageId: string): void {
    const cached = this.messages.get(channelId);
    if (cached) this.messages.set(channelId, cached.filter((m) => m.id !== messageId));
    this.changed.emit();
  }

  /**
   * Adds or removes one reaction. Our own reactions are idempotent: Fluxer
   * does not echo them to the acting session in guilds but may in DMs, and we
   * apply them locally once the request succeeds.
   */
  applyReaction(channelId: string, messageId: string, emoji: FluxerEmoji, mine: boolean, add: boolean): void {
    const message = this.findMessage(channelId, messageId);
    if (!message) return;
    const reactions = (message.reactions ??= []);
    const key = emojiKey(emoji);
    const index = reactions.findIndex((r) => emojiKey(r.emoji) === key);
    const reaction = reactions[index];
    if (add) {
      if (mine && reaction?.me) return;
      if (reaction) {
        reaction.count++;
        reaction.me ||= mine;
      } else {
        reactions.push({ emoji, count: 1, me: mine });
      }
    } else {
      if (!reaction || (mine && !reaction.me)) return;
      reaction.count--;
      if (mine) reaction.me = false;
      if (reaction.count <= 0) reactions.splice(index, 1);
    }
    this.changed.emit();
  }

  private findMessage(channelId: unknown, messageId: unknown): FluxerMessage | undefined {
    return isId(channelId) && isId(messageId) ? this.messages.get(channelId)?.find((m) => m.id === messageId) : undefined;
  }

  /** Records a local read (we acked it); the server confirms with MESSAGE_ACK. */
  markRead(channelId: string, messageId: string): void {
    this.readStates.set(channelId, { channelId, lastMessageId: messageId, mentionCount: 0 });
    this.changed.emit();
  }

  /** Stores fetched history; `older` pages are prepended. */
  addHistory(channelId: string, messages: FluxerMessage[], older: boolean): void {
    for (const m of messages) this.addUser(m.author);
    const existing = this.messages.get(channelId) ?? [];
    const known = new Set(existing.map((m) => m.id));
    const fresh = messages.filter((m) => !known.has(m.id));
    this.messages.set(channelId, older ? [...fresh, ...existing] : [...existing, ...fresh]);
    this.changed.emit();
  }

  isUnread(channel: FluxerChannel): boolean {
    if (!TEXT_CHANNEL_TYPES.has(channel.type) || !channel.lastMessageId) return false;
    const read = this.readStates.get(channel.id)?.lastMessageId;
    // Without a read position, only mentions count; otherwise every old channel would look unread.
    return read === undefined ? this.mentions(channel.id) > 0 : compareIds(channel.lastMessageId, read) > 0;
  }

  mentions(channelId: string): number {
    return this.readStates.get(channelId)?.mentionCount ?? 0;
  }

  /**
   * A guild's channels in sidebar order: uncategorised first, then each
   * category with its children, each channel followed by its open threads.
   * Forum posts are not listed here; see forumPosts().
   */
  guildChannels(guildId: string): FluxerChannel[] {
    const inGuild = [...this.channels.values()].filter((c) => c.guildId === guildId);
    const threads = inGuild.filter((c) => THREAD_TYPES.has(c.type) && !c.archived);
    const all = inGuild.filter((c) => !THREAD_TYPES.has(c.type));
    const byPosition = (a: FluxerChannel, b: FluxerChannel) => a.position - b.position || compareIds(a.id, b.id);
    const categories = all.filter((c) => c.type === ChannelType.GuildCategory).sort(byPosition);
    const categoryIds = new Set(categories.map((c) => c.id));
    const childrenOf = (parent?: string) =>
      all
        .filter((c) => c.type !== ChannelType.GuildCategory && (parent ? c.parentId === parent : !c.parentId || !categoryIds.has(c.parentId)))
        .sort(byPosition);
    const withThreads = (channels: FluxerChannel[]) =>
      channels.flatMap((c) =>
        FORUM_TYPES.has(c.type) ? [c] : [c, ...threads.filter((t) => t.parentId === c.id).sort(byPosition)],
      );
    return [...withThreads(childrenOf()), ...categories.flatMap((cat) => [cat, ...withThreads(childrenOf(cat.id))])];
  }

  /** A forum's open posts, most recently active first. */
  forumPosts(forumId: string): FluxerChannel[] {
    return [...this.channels.values()]
      .filter((c) => c.parentId === forumId && THREAD_TYPES.has(c.type) && !c.archived)
      .sort((a, b) => compareIds(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id));
  }

  /** Every channel of a guild, threads and forum posts included. */
  private allGuildChannels(guildId: string): FluxerChannel[] {
    return [...this.channels.values()].filter((c) => c.guildId === guildId);
  }

  guildUnread(guildId: string): boolean {
    return this.allGuildChannels(guildId).some((c) => this.isUnread(c));
  }

  guildMentions(guildId: string): number {
    return this.allGuildChannels(guildId).reduce((sum, c) => sum + this.mentions(c.id), 0);
  }

  /** DMs and group DMs, most recent first. */
  privateChannels(): FluxerChannel[] {
    return [...this.channels.values()]
      .filter((c) => c.type === ChannelType.Dm || c.type === ChannelType.GroupDm)
      .sort((a, b) => compareIds(b.lastMessageId ?? "0", a.lastMessageId ?? "0"));
  }

  /** Bar slots in the user's order; guilds missing from the folder settings go last. */
  guildLayout(): FluxerFolder[] {
    const placed = new Set<string>();
    const slots: FluxerFolder[] = [];
    for (const folder of this.folders ?? []) {
      const guildIds = folder.guildIds.filter((id) => this.guilds.has(id) && !placed.has(id));
      guildIds.forEach((id) => placed.add(id));
      if (guildIds.length === 0) continue;
      if (folder.id) slots.push({ ...folder, guildIds });
      else slots.push(...guildIds.map((id) => ({ guildIds: [id] })));
    }
    for (const id of this.guilds.keys()) if (!placed.has(id)) slots.push({ guildIds: [id] });
    return slots;
  }

  /**
   * Whether a message from someone else should raise a desktop notification,
   * following the user's settings: channel override, then guild, then the
   * default (every DM message, mentions only in guilds). Mutes win.
   */
  shouldNotify(message: FluxerMessage, now: number = Date.now()): boolean {
    const channel = this.channels.get(message.channelId);
    if (!channel || !this.me || message.author.id === this.me.id) return false;
    const settings = this.notifySettings.get(channel.guildId ?? DM_SETTINGS);
    const override = settings?.channels.get(channel.id);
    if ((override?.mutedUntil ?? 0) > now || (settings?.mutedUntil ?? 0) > now) return false;
    const pick = (value: number | undefined) => (value === undefined || value === NotifyLevel.Inherit ? undefined : value);
    const level = pick(override?.level) ?? pick(settings?.level) ?? (channel.guildId ? NotifyLevel.Mentions : NotifyLevel.All);
    if (level === NotifyLevel.All) return true;
    if (level === NotifyLevel.None) return false;
    return message.mentionIds.includes(this.me.id) || (message.mentionEveryone && !settings?.suppressEveryone);
  }

  private setNotifySettings(entry: [string, FluxerNotifySettings] | undefined): void {
    if (entry) this.notifySettings.set(entry[0], entry[1]);
  }

  private addUser(user: FluxerUser | undefined): void {
    if (user) this.users.set(user.id, user);
  }

  private addGuild(value: unknown): void {
    const guild = parseGuild(value);
    if (!guild) return;
    this.guilds.set(guild.id, guild);
    const record = value as Record<string, unknown>;
    // GUILD_CREATE and GUILD_SYNC carry complete channel and thread lists: replace what we had.
    const replaceChannels = Array.isArray(record.channels);
    const replaceThreads = Array.isArray(record.threads);
    for (const c of [...this.channels.values()]) {
      if (c.guildId !== guild.id) continue;
      if (THREAD_TYPES.has(c.type) ? replaceThreads : replaceChannels) this.channels.delete(c.id);
    }
    for (const c of [...list(record.channels), ...list(record.threads)]) this.addChannel(parseChannel(c, guild.id));
  }

  private removeGuild(guildId: string): void {
    this.guilds.delete(guildId);
    for (const channel of [...this.channels.values()]) {
      if (channel.guildId === guildId) {
        this.channels.delete(channel.id);
        this.messages.delete(channel.id);
      }
    }
  }

  /** Adds or replaces a channel, e.g. a forum post we just created. */
  upsertChannel(channel: FluxerChannel): void {
    this.addChannel(channel);
    this.changed.emit();
  }

  private addChannel(channel: FluxerChannel | undefined): void {
    if (!channel) return;
    this.channels.set(channel.id, channel);
    for (const r of channel.recipients) this.addUser(r);
  }

  private setReadState(state: FluxerReadState | undefined): void {
    if (state) this.readStates.set(state.channelId, state);
  }

  /** Users typing in a channel right now, excluding ourselves. */
  typingIn(channelId: string, now: number = Date.now()): FluxerUser[] {
    return [...(this.typing.get(channelId) ?? [])]
      .filter(([, expires]) => expires > now)
      .flatMap(([userId]) => this.users.get(userId) ?? []);
  }

  private onMessageCreate(message: FluxerMessage | undefined): void {
    if (!message) return;
    this.typing.get(message.channelId)?.delete(message.author.id);
    this.addUser(message.author);
    const channel = this.channels.get(message.channelId);
    if (channel) channel.lastMessageId = message.id;
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
    const mentioned = message.mentionEveryone || (this.me !== undefined && message.mentionIds.includes(this.me.id));
    if (isDm || mentioned) {
      const current = this.readStates.get(message.channelId);
      this.readStates.set(message.channelId, {
        channelId: message.channelId,
        lastMessageId: current?.lastMessageId,
        mentionCount: (current?.mentionCount ?? 0) + 1,
      });
    }
    this.incoming.emit(message);
  }
}
