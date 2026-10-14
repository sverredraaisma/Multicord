import { Emitter } from "../../shared/emitter";
import {
  ChannelType,
  MessageFlag,
  TEXT_CHANNEL_TYPES,
  compareIds,
  isId,
  isRecord,
  parseCategories,
  parseChannel,
  parseEmoji,
  parseFile,
  parseMessage,
  parseNotifySettings,
  parseReactions,
  parseServer,
  parseUnread,
  parseUser,
  MAX_CONTENT,
  MAX_NAME,
  type StoatChannel,
  type StoatEmoji,
  type StoatMessage,
  type StoatNotifySettings,
  type StoatServer,
  type StoatUnread,
  type StoatUser,
} from "./types";

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const cleared = (value: Record<string, unknown>, field: string): boolean => list(value.clear).includes(field);
const MAX_CACHED_MESSAGES = 200;
/** How long a typing indicator lasts without a stop event. */
export const TYPING_MS = 10_000;

/** One entry of a server's channel list: a category heading or a channel. */
export type ServerEntry = { category: { id: string; title: string } } | { channel: StoatChannel };

/** Client-side view of one Stoat session, built from Ready and later events. */
export class StoatState {
  meId: string | undefined;
  readonly users = new Map<string, StoatUser>();
  readonly servers = new Map<string, StoatServer>();
  readonly channels = new Map<string, StoatChannel>();
  readonly unreads = new Map<string, StoatUnread>();
  readonly messages = new Map<string, StoatMessage[]>();
  /** The newest message seen per channel, loaded or not, for previews. */
  readonly latest = new Map<string, StoatMessage>();
  readonly emojis = new Map<string, StoatEmoji>();
  /** Who is typing where: channel id -> user id -> expiry (epoch ms). */
  readonly typing = new Map<string, Map<string, number>>();
  notifySettings: StoatNotifySettings = { servers: new Map(), channels: new Map() };
  /** Whether Ready carried unread state (older instances need /sync/unreads). */
  unreadsLoaded = false;

  readonly changed = new Emitter<void>();
  /** New messages from others, for acking and notifications. */
  readonly incoming = new Emitter<StoatMessage>();

  get me(): StoatUser | undefined {
    return this.meId ? this.users.get(this.meId) : undefined;
  }

  reset(): void {
    this.meId = undefined;
    this.unreadsLoaded = false;
    this.notifySettings = { servers: new Map(), channels: new Map() };
    for (const map of [this.users, this.servers, this.channels, this.unreads, this.messages, this.latest, this.emojis, this.typing]) map.clear();
  }

  apply(type: string, d: Record<string, unknown>): void {
    switch (type) {
      case "Ready": {
        const me = this.meId;
        this.reset();
        for (const u of list(d.users)) this.addUser(parseUser(u));
        // Ready lists the signed-in user with the relationship "User".
        this.meId = [...this.users.values()].find((u) => u.relationship === "User")?.id ?? me;
        for (const s of list(d.servers)) this.addServer(parseServer(s));
        for (const c of list(d.channels)) this.addChannel(parseChannel(c));
        for (const e of list(d.emojis)) this.addEmoji(parseEmoji(e));
        if (Array.isArray(d.channel_unreads)) this.loadUnreads(d.channel_unreads.flatMap((u) => parseUnread(u) ?? []));
        break;
      }
      case "Message":
        this.onMessage(parseMessage(d));
        break;
      case "MessageUpdate":
        this.updateMessage(d);
        break;
      case "MessageDelete":
        if (isId(d.channel) && isId(d.id)) this.dropMessages(d.channel, new Set([d.id]));
        break;
      case "BulkMessageDelete":
        if (isId(d.channel)) this.dropMessages(d.channel, new Set(list(d.ids).filter(isId)));
        break;
      case "MessageReact":
      case "MessageUnreact":
        if (!isId(d.user_id) || typeof d.emoji_id !== "string") return;
        this.applyReaction(d.channel_id, d.id, d.emoji_id, d.user_id, type === "MessageReact");
        break;
      case "MessageRemoveReaction": {
        const message = this.findMessage(d.channel_id, d.id);
        if (!message) return;
        message.reactions = message.reactions.filter((r) => r.emoji !== d.emoji_id);
        break;
      }
      case "ServerCreate":
        this.addServer(parseServer(d.server));
        for (const c of list(d.channels)) this.addChannel(parseChannel(c));
        for (const e of list(d.emojis)) this.addEmoji(parseEmoji(e));
        break;
      case "ServerUpdate":
        this.updateServer(d);
        break;
      case "ServerDelete":
        if (isId(d.id)) this.removeServer(d.id);
        break;
      case "ServerMemberLeave":
        if (isId(d.id) && d.user === this.meId) this.removeServer(d.id);
        break;
      case "ChannelCreate":
        this.addChannel(parseChannel(d));
        break;
      case "ChannelUpdate":
        this.updateChannel(d);
        break;
      case "ChannelDelete":
        if (isId(d.id)) this.removeChannel(d.id);
        break;
      case "ChannelGroupJoin":
      case "ChannelGroupLeave": {
        const channel = isId(d.id) ? this.channels.get(d.id) : undefined;
        if (!channel || !isId(d.user)) return;
        if (type === "ChannelGroupLeave" && d.user === this.meId) this.removeChannel(channel.id);
        else if (type === "ChannelGroupLeave") channel.recipients = channel.recipients.filter((r) => r !== d.user);
        else if (!channel.recipients.includes(d.user)) channel.recipients.push(d.user);
        break;
      }
      case "ChannelStartTyping":
      case "ChannelStopTyping": {
        if (!isId(d.id) || !isId(d.user) || d.user === this.meId) return;
        const channel = this.typing.get(d.id) ?? new Map<string, number>();
        if (type === "ChannelStartTyping") channel.set(d.user, Date.now() + TYPING_MS);
        else channel.delete(d.user);
        this.typing.set(d.id, channel);
        break;
      }
      case "ChannelAck":
        // Acks from our other sessions; others' acks are not ours to track.
        if (!isId(d.id) || !isId(d.message_id) || d.user !== this.meId) return;
        this.unreads.set(d.id, { channelId: d.id, lastId: d.message_id, mentions: this.unreadMentions(d.id).filter((m) => compareIds(m, d.message_id as string) > 0) });
        break;
      case "UserUpdate":
        this.updateUser(d);
        break;
      case "UserRelationship":
        this.addUser(parseUser(d.user));
        break;
      case "UserSettingsUpdate":
        if (!isRecord(d.update) || d.id !== this.meId) return;
        this.notifySettings = parseNotifySettings(d.update.notifications) ?? this.notifySettings;
        break;
      case "EmojiCreate":
        this.addEmoji(parseEmoji(d));
        break;
      case "EmojiDelete":
        if (typeof d.id === "string") this.emojis.delete(d.id);
        break;
      default:
        return; // Unhandled events do not change what we show.
    }
    this.changed.emit();
  }

  /** Unread state from /sync/unreads, for instances whose Ready lacks it. */
  setUnreads(unreads: StoatUnread[]): void {
    this.loadUnreads(unreads);
    this.changed.emit();
  }

  private loadUnreads(unreads: StoatUnread[]): void {
    this.unreadsLoaded = true;
    for (const unread of unreads) this.unreads.set(unread.channelId, unread);
  }

  /** The "notifications" setting from /sync/settings/fetch. */
  setNotifySettings(value: unknown): void {
    const settings = parseNotifySettings(value);
    if (settings) this.notifySettings = settings;
  }

  /** Swaps in an edited message where it is cached; returns whether it was. */
  replaceMessage(message: StoatMessage): boolean {
    if (this.latest.get(message.channelId)?.id === message.id) this.latest.set(message.channelId, message);
    const cached = this.messages.get(message.channelId);
    const index = cached?.findIndex((m) => m.id === message.id) ?? -1;
    if (index < 0) return false;
    cached![index] = message;
    return true;
  }

  removeMessage(channelId: string, messageId: string): void {
    this.dropMessages(channelId, new Set([messageId]));
    this.changed.emit();
  }

  findMessage(channelId: unknown, messageId: unknown): StoatMessage | undefined {
    return isId(channelId) && isId(messageId) ? this.messages.get(channelId)?.find((m) => m.id === messageId) : undefined;
  }

  /**
   * Adds or removes one user's reaction. Reactions are sets of user ids, so
   * applying our own locally and again from the server's echo is harmless.
   */
  applyReaction(channelId: unknown, messageId: unknown, emoji: string, userId: string, add: boolean): void {
    const message = this.findMessage(channelId, messageId);
    if (!message) return;
    const reaction = message.reactions.find((r) => r.emoji === emoji);
    if (add) {
      if (!reaction) message.reactions.push({ emoji, userIds: [userId] });
      else if (!reaction.userIds.includes(userId)) reaction.userIds.push(userId);
    } else if (reaction) {
      reaction.userIds = reaction.userIds.filter((u) => u !== userId);
      if (reaction.userIds.length === 0) message.reactions = message.reactions.filter((r) => r !== reaction);
    }
    this.changed.emit();
  }

  /** Records a local read (we acked it); our other sessions hear of it as ChannelAck. */
  markRead(channelId: string, messageId: string): void {
    this.unreads.set(channelId, { channelId, lastId: messageId, mentions: [] });
    this.changed.emit();
  }

  /** Stores fetched history and its authors; `older` pages are prepended. */
  addHistory(channelId: string, messages: StoatMessage[], users: StoatUser[], older: boolean): void {
    for (const u of users) this.addUser(u);
    for (const m of messages) this.addUser(m.author);
    const existing = this.messages.get(channelId) ?? [];
    const known = new Set(existing.map((m) => m.id));
    const fresh = messages.filter((m) => !known.has(m.id));
    this.messages.set(channelId, older ? [...fresh, ...existing] : [...existing, ...fresh]);
    for (const m of fresh) this.noteLatest(m);
    this.changed.emit();
  }

  isUnread(channel: StoatChannel): boolean {
    if (!TEXT_CHANNEL_TYPES.has(channel.type) || !channel.lastMessageId) return false;
    const unread = this.unreads.get(channel.id);
    // Without a read position, only mentions count; otherwise every old channel would look unread.
    if (unread?.lastId === undefined) return this.mentions(channel.id) > 0;
    return compareIds(channel.lastMessageId, unread.lastId) > 0;
  }

  mentions(channelId: string): number {
    return this.unreadMentions(channelId).length;
  }

  private unreadMentions(channelId: string): string[] {
    return this.unreads.get(channelId)?.mentions ?? [];
  }

  /**
   * A server's text channels in sidebar order: uncategorised first, then
   * each category with its channels. Voice-only channels of older instances
   * are left out, as Multicord does not join Stoat calls.
   */
  serverEntries(serverId: string): ServerEntry[] {
    const server = this.servers.get(serverId);
    if (!server) return [];
    const shown = (id: string): StoatChannel[] => {
      const channel = this.channels.get(id);
      return channel?.serverId === serverId && channel.type === ChannelType.TextChannel ? [channel] : [];
    };
    const inCategory = new Set(server.categories.flatMap((c) => c.channelIds));
    const loose = server.channelIds.filter((id) => !inCategory.has(id));
    return [
      ...loose.flatMap(shown).map((channel) => ({ channel })),
      ...server.categories.flatMap((c) => [{ category: { id: c.id, title: c.title } }, ...c.channelIds.flatMap(shown).map((channel) => ({ channel }))]),
    ];
  }

  serverChannels(serverId: string): StoatChannel[] {
    return [...this.channels.values()].filter((c) => c.serverId === serverId);
  }

  serverUnread(serverId: string): boolean {
    return this.serverChannels(serverId).some((c) => this.isUnread(c));
  }

  serverMentions(serverId: string): number {
    return this.serverChannels(serverId).reduce((sum, c) => sum + this.mentions(c.id), 0);
  }

  /** Open DMs and groups, most recent first. */
  privateChannels(): StoatChannel[] {
    return [...this.channels.values()]
      .filter((c) => (c.type === ChannelType.DirectMessage && c.active) || c.type === ChannelType.Group)
      .sort((a, b) => compareIds(b.lastMessageId ?? "", a.lastMessageId ?? ""));
  }

  /**
   * Whether a message from someone else should raise a desktop notification,
   * following the user's settings: channel, then server, then the default
   * (every DM and group message, mentions only in servers).
   */
  shouldNotify(message: StoatMessage): boolean {
    const channel = this.channels.get(message.channelId);
    if (!channel || !this.meId || message.authorId === this.meId || message.flags & MessageFlag.SuppressNotifications) return false;
    const level =
      this.notifySettings.channels.get(channel.id) ??
      (channel.serverId ? this.notifySettings.servers.get(channel.serverId) : undefined) ??
      (channel.serverId ? "mention" : "all");
    if (level === "all") return true;
    if (level === "mention") return this.mentionsMe(message);
    return false;
  }

  mentionsMe(message: StoatMessage): boolean {
    return (
      (this.meId !== undefined && message.mentionIds.includes(this.meId)) ||
      (message.flags & (MessageFlag.MentionsEveryone | MessageFlag.MentionsOnline)) !== 0
    );
  }

  /** Users typing in a channel right now, excluding ourselves. */
  typingIn(channelId: string, now: number = Date.now()): StoatUser[] {
    return [...(this.typing.get(channelId) ?? [])]
      .filter(([, expires]) => expires > now)
      .flatMap(([userId]) => this.users.get(userId) ?? []);
  }

  private addUser(user: StoatUser | undefined): void {
    if (!user) return;
    // History carries no relationship; keep the one Ready gave.
    const known = this.users.get(user.id);
    this.users.set(user.id, { ...user, relationship: user.relationship ?? known?.relationship });
  }

  private addServer(server: StoatServer | undefined): void {
    if (server) this.servers.set(server.id, server);
  }

  private addChannel(channel: StoatChannel | undefined): void {
    if (channel) this.channels.set(channel.id, channel);
  }

  private addEmoji(emoji: StoatEmoji | undefined): void {
    if (emoji) this.emojis.set(emoji.id, emoji);
  }

  private removeServer(serverId: string): void {
    this.servers.delete(serverId);
    for (const channel of this.serverChannels(serverId)) this.removeChannel(channel.id);
  }

  private removeChannel(channelId: string): void {
    this.channels.delete(channelId);
    this.messages.delete(channelId);
    this.latest.delete(channelId);
  }

  private dropMessages(channelId: string, ids: Set<string>): void {
    const cached = this.messages.get(channelId);
    if (cached) this.messages.set(channelId, cached.filter((m) => !ids.has(m.id)));
    // A deleted last message leaves no preview rather than a stale one.
    if (ids.has(this.latest.get(channelId)?.id ?? "")) this.latest.delete(channelId);
  }

  /** MessageUpdate carries only the changed fields. */
  private updateMessage(d: Record<string, unknown>): void {
    const data = isRecord(d.data) ? d.data : {};
    const targets = [this.findMessage(d.channel, d.id), isId(d.channel) ? this.latest.get(d.channel) : undefined];
    for (const message of new Set(targets)) {
      if (!message || message.id !== d.id) continue;
      if (typeof data.content === "string") message.content = data.content.slice(0, MAX_CONTENT);
      if (typeof data.edited === "string") message.edited = true;
      if (isRecord(data.reactions)) message.reactions = parseReactions(data.reactions);
    }
  }

  private updateServer(d: Record<string, unknown>): void {
    const server = isId(d.id) ? this.servers.get(d.id) : undefined;
    if (!server) return;
    const data = isRecord(d.data) ? d.data : {};
    if (typeof data.name === "string") server.name = data.name.slice(0, MAX_NAME);
    if ("icon" in data) server.icon = parseFile(data.icon);
    if (cleared(d, "Icon")) server.icon = undefined;
    if (Array.isArray(data.channels)) server.channelIds = data.channels.filter(isId);
    if ("categories" in data) server.categories = parseCategories(data.categories);
    if (cleared(d, "Categories")) server.categories = [];
  }

  private updateChannel(d: Record<string, unknown>): void {
    const channel = isId(d.id) ? this.channels.get(d.id) : undefined;
    if (!channel) return;
    const data = isRecord(d.data) ? d.data : {};
    if (typeof data.name === "string") channel.name = data.name.slice(0, MAX_NAME);
    if ("icon" in data) channel.icon = parseFile(data.icon);
    if (cleared(d, "Icon")) channel.icon = undefined;
    if (isId(data.last_message_id)) channel.lastMessageId = data.last_message_id;
    if (typeof data.active === "boolean") channel.active = data.active;
    if (Array.isArray(data.recipients)) channel.recipients = data.recipients.filter(isId);
  }

  private updateUser(d: Record<string, unknown>): void {
    const user = isId(d.id) ? this.users.get(d.id) : undefined;
    if (!user) return;
    const data = isRecord(d.data) ? d.data : {};
    if (typeof data.username === "string") user.username = data.username.slice(0, MAX_NAME);
    if (typeof data.display_name === "string") user.displayName = data.display_name.slice(0, MAX_NAME) || undefined;
    if ("avatar" in data) user.avatar = parseFile(data.avatar);
    if (cleared(d, "Avatar")) user.avatar = undefined;
    if (cleared(d, "DisplayName")) user.displayName = undefined;
  }

  private noteLatest(message: StoatMessage): void {
    const current = this.latest.get(message.channelId);
    if (!current || compareIds(message.id, current.id) >= 0) this.latest.set(message.channelId, message);
  }

  private onMessage(message: StoatMessage | undefined): void {
    if (!message) return;
    // A message we already have (e.g. the echo of one we sent) is not new.
    if (this.latest.get(message.channelId)?.id === message.id || this.findMessage(message.channelId, message.id)) {
      this.replaceMessage(message);
      return;
    }
    this.typing.get(message.channelId)?.delete(message.authorId);
    this.addUser(message.author);
    const channel = this.channels.get(message.channelId);
    if (channel) {
      channel.lastMessageId = message.id;
      // A new message reopens a closed DM, as in Stoat's own client.
      channel.active = true;
    }
    this.noteLatest(message);
    const cached = this.messages.get(message.channelId);
    if (cached) {
      cached.push(message);
      if (cached.length > MAX_CACHED_MESSAGES) cached.splice(0, cached.length - MAX_CACHED_MESSAGES);
    }
    if (message.authorId === this.meId) {
      this.unreads.set(message.channelId, { channelId: message.channelId, lastId: message.id, mentions: [] });
      return;
    }
    // DM messages count as mentions, so DM bubbles show a number, as with Fluxer.
    const isDm = channel?.type === ChannelType.DirectMessage || channel?.type === ChannelType.Group;
    if (isDm || this.mentionsMe(message)) {
      const current = this.unreads.get(message.channelId);
      this.unreads.set(message.channelId, {
        channelId: message.channelId,
        lastId: current?.lastId,
        mentions: [...(current?.mentions ?? []), message.id],
      });
    }
    this.incoming.emit(message);
  }
}
