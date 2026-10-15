import { Emitter } from "../../shared/emitter";
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
  parseGuildEmoji,
  parseGuildSticker,
  parseTraits,
  overrideInputs,
  parseGuildSettings,
  type OverrideInput,
  parseMessage,
  parseReadState,
  parseUser,
  parseVoiceState,
  parseMemberListUpdate,
  parsePresence,
  parseRole,
  type FluxerListItem,
  type FluxerPresence,
  type FluxerRole,
  type FluxerChannel,
  type FluxerEmoji,
  DM_SETTINGS,
  NotifyLevel,
  type FluxerFolder,
  type FluxerNotifySettings,
  type FluxerGuild,
  type FluxerGuildEmoji,
  type FluxerGuildSticker,
  type FluxerMessage,
  type FluxerReadState,
  type FluxerUser,
  type FluxerVoiceState,
} from "./types";

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const MAX_CACHED_MESSAGES = 200;
/** Fluxer, like Discord, shows typing for about 10 seconds per event. */
export const TYPING_MS = 10_000;

/** List positions kept per member list: two of the windows of 100 that op 14 asks for. */
export const MEMBER_LIST_POSITIONS = 200;

/** A channel's member list as far as Fluxer has sent it: headings and members by list position. */
export interface MemberListState {
  guildId: string;
  /** Whether Fluxer has sent the list at all. */
  synced: boolean;
  memberCount: number;
  /** List positions the headings and their members take, as Fluxer counts them. */
  positions: number;
  /** How far SYNC operations have filled the list (the position after the last they replaced). */
  reach: number;
  items: (FluxerListItem | undefined)[];
}

/** Client-side view of one Fluxer session, built from READY and dispatch events. */
export class FluxerState {
  me: FluxerUser | undefined;
  /** Our account's traits ("premium" while premium is active), for the instance's limits. */
  traits: string[] = [];
  readonly guilds = new Map<string, FluxerGuild>();
  readonly channels = new Map<string, FluxerChannel>();
  readonly readStates = new Map<string, FluxerReadState>();
  readonly users = new Map<string, FluxerUser>();
  readonly messages = new Map<string, FluxerMessage[]>();
  /** The newest message seen per channel, loaded or not, for previews. */
  readonly latest = new Map<string, FluxerMessage>();
  /** Each guild's custom emoji. */
  readonly emojis = new Map<string, FluxerGuildEmoji[]>();
  /** Each guild's stickers. */
  readonly stickers = new Map<string, FluxerGuildSticker[]>();
  /** Voice connections by connection id. */
  readonly voiceStates = new Map<string, FluxerVoiceState>();
  /** Calls in DMs and groups, by channel id: who is being rung. Their participants are in voiceStates. */
  readonly calls = new Map<string, { ringing: string[] }>();
  /** Who is typing where: channel id -> user id -> expiry (epoch ms). */
  readonly typing = new Map<string, Map<string, number>>();
  /** Each settings object's channel overrides as a write sends them back, by the same key as notifySettings. */
  readonly overrideInputs = new Map<string, Record<string, OverrideInput>>();
  /** Notification settings per guild id, or DM_SETTINGS for DMs. */
  readonly notifySettings = new Map<string, FluxerNotifySettings>();
  folders: FluxerFolder[] | undefined;
  /** Each guild's roles. */
  readonly roles = new Map<string, FluxerRole[]>();
  /** The user's own roles in each guild, for role mentions: from the guild's own member object, kept current by GUILD_MEMBER_UPDATE. */
  readonly ownRoles = new Map<string, string[]>();
  /** Presences of those the server tells about (friends, DM partners, open member lists); by user id; unknown for the rest. */
  readonly presences = new Map<string, FluxerPresence>();
  /** Member lists the user asked for (the member panel), by channel id: list positions as Fluxer's SYNC operations fill them. */
  readonly memberLists = new Map<string, MemberListState>();

  readonly changed = new Emitter<void>();
  /** New messages from others, for acking in the open channel. */
  readonly incoming = new Emitter<FluxerMessage>();

  reset(): void {
    this.me = undefined;
    this.traits = [];
    this.folders = undefined;
    for (const map of [this.guilds, this.channels, this.readStates, this.users, this.messages, this.latest, this.notifySettings, this.overrideInputs, this.typing, this.voiceStates, this.calls, this.emojis, this.stickers, this.roles, this.ownRoles, this.presences, this.memberLists]) map.clear();
  }

  apply(event: string, data: unknown): void {
    const d = isRecord(data) ? data : {};
    switch (event) {
      case "READY":
        this.reset();
        this.me = parseUser(d.user);
        this.traits = parseTraits(d.user);
        if (this.me) this.users.set(this.me.id, this.me);
        for (const u of list(d.users)) this.addUser(parseUser(u));
        for (const g of list(d.guilds)) this.addGuild(g);
        for (const c of list(d.private_channels)) this.addChannel(parseChannel(c));
        for (const r of list(d.read_states)) this.setReadState(parseReadState(r));
        this.folders = parseFolders(d.user_settings);
        for (const g of list(d.user_guild_settings)) this.applyGuildSettings(g);
        for (const p of list(d.presences)) this.setPresence(parsePresence(p));
        break;
      case "PRESENCE_UPDATE":
        this.setPresence(parsePresence(data));
        break;
      case "PRESENCE_UPDATE_BULK":
        for (const p of list(d.presences)) this.setPresence(parsePresence(p));
        break;
      case "GUILD_ROLE_CREATE":
      case "GUILD_ROLE_UPDATE": {
        const role = parseRole(d.role);
        const roles = isId(d.guild_id) ? this.roles.get(d.guild_id) : undefined;
        if (role && roles) this.roles.set(d.guild_id as string, [...roles.filter((r) => r.id !== role.id), role]);
        break;
      }
      case "GUILD_ROLE_DELETE": {
        const roles = isId(d.guild_id) ? this.roles.get(d.guild_id) : undefined;
        if (roles) this.roles.set(d.guild_id as string, roles.filter((r) => r.id !== d.role_id));
        break;
      }
      case "GUILD_MEMBER_LIST_UPDATE":
        this.applyMemberList(data);
        break;
      case "USER_GUILD_SETTINGS_UPDATE":
        this.applyGuildSettings(data);
        break;
      case "GUILD_MEMBER_UPDATE":
        if (isId(d.guild_id) && isRecord(d.user) && d.user.id === this.me?.id) this.ownRoles.set(d.guild_id, list(d.roles).filter(isId));
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
        // A deleted last message leaves no preview rather than a stale one.
        if (channelId && ids.has(this.latest.get(channelId)?.id ?? "")) this.latest.delete(channelId);
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
      case "GUILD_EMOJIS_UPDATE":
        if (isId(d.guild_id)) this.setEmojis(d.guild_id, d.emojis);
        break;
      case "GUILD_STICKERS_UPDATE":
        if (isId(d.guild_id)) this.setStickers(d.guild_id, d.stickers);
        break;
      case "VOICE_STATE_UPDATE":
        this.setVoiceState(parseVoiceState(data));
        break;
      case "CALL_CREATE":
      case "CALL_UPDATE":
        this.setCall(d);
        break;
      case "CALL_DELETE":
        // Unavailable calls are dropped too: nothing can be done with them here until Fluxer creates them again.
        if (isId(d.channel_id)) this.dropCall(d.channel_id);
        break;
      case "MESSAGE_ACK":
        this.setReadState(parseReadState(data));
        break;
      case "USER_SETTINGS_UPDATE":
        this.folders = parseFolders(data) ?? this.folders;
        break;
      case "USER_UPDATE": {
        const user = parseUser(data);
        if (user && user.id === this.me?.id) {
          this.me = user;
          if (Array.isArray(d.traits)) this.traits = parseTraits(d);
        }
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

  findMessage(channelId: unknown, messageId: unknown): FluxerMessage | undefined {
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
    for (const m of fresh) this.noteLatest(m);
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

  /** Whether a message mentions the user: by name, as @everyone/@here, or through a role they have. */
  mentionsMe(message: FluxerMessage): boolean {
    return message.mentionEveryone || (this.me !== undefined && message.mentionIds.includes(this.me.id)) || this.mentionsMyRole(message);
  }

  /** Whether the user muted a channel (or its server, or all DMs) in Fluxer, for now. */
  isMuted(channel: FluxerChannel, now: number = Date.now()): boolean {
    const settings = this.notifySettings.get(channel.guildId ?? DM_SETTINGS);
    return (settings?.channels.get(channel.id)?.mutedUntil ?? 0) > now || (settings?.mutedUntil ?? 0) > now;
  }

  /**
   * Whether a message from someone else should raise a desktop notification,
   * following the user's settings: channel override, then guild, then the
   * default (every DM message, mentions only in guilds). Mutes win.
   */
  shouldNotify(message: FluxerMessage, now: number = Date.now()): boolean {
    const channel = this.channels.get(message.channelId);
    if (!channel || !this.me || message.author.id === this.me.id) return false;
    if (this.isMuted(channel, now)) return false;
    const settings = this.notifySettings.get(channel.guildId ?? DM_SETTINGS);
    const override = settings?.channels.get(channel.id);
    const pick = (value: number | undefined) => (value === undefined || value === NotifyLevel.Inherit ? undefined : value);
    const level = pick(override?.level) ?? pick(settings?.level) ?? (channel.guildId ? NotifyLevel.Mentions : NotifyLevel.All);
    if (level === NotifyLevel.All) return true;
    if (level === NotifyLevel.None) return false;
    return message.mentionIds.includes(this.me.id) || (message.mentionEveryone && !settings?.suppressEveryone) || (this.mentionsMyRole(message) && !settings?.suppressRoles);
  }

  /** Whether a guild message mentions a role the user has there. */
  private mentionsMyRole(message: FluxerMessage): boolean {
    const guildId = this.channels.get(message.channelId)?.guildId;
    const roles = guildId ? (this.ownRoles.get(guildId) ?? []) : [];
    return (message.roleMentionIds ?? []).some((r) => roles.includes(r));
  }

  /** One user guild settings object, from READY, its update event or a write's answer. */
  applyGuildSettings(value: unknown): void {
    const entry = parseGuildSettings(value);
    if (!entry) return;
    this.notifySettings.set(entry[0], entry[1]);
    this.overrideInputs.set(entry[0], overrideInputs(value));
  }

  private setPresence(presence: FluxerPresence | undefined): void {
    if (presence) this.presences.set(presence.userId, presence);
  }

  /** Starts keeping a channel's member list, which Fluxer sends once op 14 asks for it; lists not asked for are ignored. */
  watchMembers(channelId: string, guildId: string): void {
    this.memberLists.set(channelId, { guildId, synced: false, memberCount: 0, positions: 0, reach: 0, items: [] });
  }

  private applyMemberList(data: unknown): void {
    const update = parseMemberListUpdate(data);
    const list = update ? this.memberLists.get(update.channelId) : undefined;
    if (!update || !list || list.guildId !== update.guildId) return;
    list.synced = true;
    list.memberCount = update.memberCount;
    list.positions = update.groups.reduce((sum, g) => sum + 1 + g.count, 0);
    for (const op of update.ops) {
      const end = Math.min(op.end, MEMBER_LIST_POSITIONS - 1);
      if (op.start > end) continue;
      for (let i = op.start; i <= end; i++) list.items[i] = op.items[i - op.start];
      list.reach = Math.max(list.reach, end + 1);
    }
    for (const item of list.items) if (item && "member" in item) {
      this.addUser(item.member.user);
      this.setPresence(item.member.presence);
    }
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
    if (Array.isArray(record.emojis)) this.setEmojis(guild.id, record.emojis);
    if (Array.isArray(record.stickers)) this.setStickers(guild.id, record.stickers);
    if (Array.isArray(record.roles)) this.roles.set(guild.id, record.roles.flatMap((r) => parseRole(r) ?? []));
    // The session's own member object is among the members it gets.
    const own = list(record.members).find((m) => isRecord(m) && isRecord(m.user) && m.user.id === this.me?.id) as Record<string, unknown> | undefined;
    if (own) this.ownRoles.set(guild.id, list(own.roles).filter(isId));
    if (Array.isArray(record.voice_states)) {
      for (const [key, v] of [...this.voiceStates]) if (v.guildId === guild.id) this.voiceStates.delete(key);
      for (const v of record.voice_states) this.setVoiceState(parseVoiceState(v, guild.id));
    }
  }

  private removeGuild(guildId: string): void {
    this.guilds.delete(guildId);
    this.emojis.delete(guildId);
    this.stickers.delete(guildId);
    this.roles.delete(guildId);
    this.ownRoles.delete(guildId);
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

  /** Who is in a voice channel, in join order. */
  voiceMembers(channelId: string): { user: FluxerUser; state: FluxerVoiceState }[] {
    return [...this.voiceStates.values()]
      .filter((v) => v.channelId === channelId)
      .map((v) => ({ user: this.users.get(v.userId) ?? { id: v.userId, username: "Unknown user" }, state: v }));
  }

  private setEmojis(guildId: string, emojis: unknown): void {
    this.emojis.set(guildId, list(emojis).flatMap((e) => parseGuildEmoji(e) ?? []));
  }

  private setStickers(guildId: string, stickers: unknown): void {
    this.stickers.set(guildId, list(stickers).flatMap((s) => parseGuildSticker(s) ?? []));
  }

  /** A DM or group call as CALL_CREATE and CALL_UPDATE give it: who is rung, and who is in it. */
  private setCall(d: Record<string, unknown>): void {
    if (!isId(d.channel_id)) return;
    const channelId = d.channel_id;
    this.calls.set(channelId, { ringing: list(d.ringing).filter(isId) });
    if (!Array.isArray(d.voice_states)) return;
    for (const [key, v] of [...this.voiceStates]) if (v.channelId === channelId) this.voiceStates.delete(key);
    for (const v of list(d.voice_states)) this.setVoiceState(parseVoiceState(v));
  }

  private dropCall(channelId: string): void {
    this.calls.delete(channelId);
    for (const [key, v] of [...this.voiceStates]) if (v.channelId === channelId && v.guildId === undefined) this.voiceStates.delete(key);
  }

  private setVoiceState(state: FluxerVoiceState | undefined): void {
    if (!state) return;
    if (state.channelId) this.voiceStates.set(state.connectionId, state);
    else this.voiceStates.delete(state.connectionId);
  }

  /** Users typing in a channel right now, excluding ourselves. */
  typingIn(channelId: string, now: number = Date.now()): FluxerUser[] {
    return [...(this.typing.get(channelId) ?? [])]
      .filter(([, expires]) => expires > now)
      .flatMap(([userId]) => this.users.get(userId) ?? []);
  }

  private noteLatest(message: FluxerMessage): void {
    const current = this.latest.get(message.channelId);
    if (!current || compareIds(message.id, current.id) >= 0) this.latest.set(message.channelId, message);
  }

  private onMessageCreate(message: FluxerMessage | undefined): void {
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
      this.readStates.set(message.channelId, {
        channelId: message.channelId,
        lastMessageId: current?.lastMessageId,
        mentionCount: (current?.mentionCount ?? 0) + 1,
      });
    }
    this.incoming.emit(message);
  }
}
