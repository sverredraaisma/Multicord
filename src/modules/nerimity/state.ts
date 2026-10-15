import { Emitter } from "../../shared/emitter";
import {
  ChannelPermission,
  ChannelType,
  NotifyMode,
  RolePermission,
  TEXT_CHANNEL_TYPES,
  compareIds,
  hexColor,
  isCdnPath,
  isId,
  isRecord,
  list,
  parseChannel,
  parseEmbed,
  parseEmoji,
  parseInbox,
  parseMember,
  parseMessage,
  parsePermissions,
  parseRole,
  parseServer,
  parseUser,
  reactionKey,
  time,
  type NerimityChannel,
  type NerimityEmoji,
  type NerimityInbox,
  type NerimityMember,
  type NerimityMessage,
  type NerimityReaction,
  type NerimityRole,
  type NerimityServer,
  type NerimityUser,
} from "./types";

/** Most messages kept per channel. */
const MAX_CACHED_MESSAGES = 200;
/** Nerimity's client shows typing for 5 seconds per event. */
export const TYPING_MS = 5_000;

type Json = Record<string, unknown>;

/** Client-side view of one Nerimity session, built from user:authenticated and the events after it. */
export class NerimityState {
  me: NerimityUser | undefined;
  /** The user's own order of their servers. */
  serverOrder: string[] = [];
  readonly servers = new Map<string, NerimityServer>();
  readonly channels = new Map<string, NerimityChannel>();
  /** Each server's roles. */
  readonly roles = new Map<string, NerimityRole[]>();
  /** Each server's custom emoji. */
  readonly emojis = new Map<string, NerimityEmoji[]>();
  /** Each server's members by user id. */
  readonly members = new Map<string, Map<string, NerimityMember>>();
  /** DMs by channel id. */
  readonly inbox = new Map<string, NerimityInbox>();
  /** When the user last read each channel, epoch ms. */
  readonly lastSeen = new Map<string, number>();
  /** Unread mentions per channel (every DM message counts). */
  readonly mentionCounts = new Map<string, number>();
  /** Presence by user id (UserStatus). */
  readonly presence = new Map<string, number>();
  readonly users = new Map<string, NerimityUser>();
  readonly messages = new Map<string, NerimityMessage[]>();
  /** The newest message seen per channel, loaded or not, for previews. */
  readonly latest = new Map<string, NerimityMessage>();
  /** Who is typing where: channel id -> user id -> expiry (epoch ms). */
  readonly typing = new Map<string, Map<string, number>>();
  /** The user's ping mode (NotifyMode) per server or channel id; null or absent follows the server. */
  readonly pingModes = new Map<string, number | null>();

  readonly changed = new Emitter<void>();
  /** New messages from others, for marking read in the open channel and notifying. */
  readonly incoming = new Emitter<NerimityMessage>();

  reset(): void {
    this.me = undefined;
    this.serverOrder = [];
    for (const map of [this.servers, this.channels, this.roles, this.emojis, this.members, this.inbox, this.lastSeen, this.mentionCounts, this.presence, this.users, this.messages, this.latest, this.typing, this.pingModes]) map.clear();
  }

  apply(event: string, data: unknown): void {
    const d: Json = isRecord(data) ? data : {};
    switch (event) {
      case "user:authenticated":
        this.authenticated(d);
        break;
      case "message:created":
        this.onMessageCreate(parseMessage(d.message));
        break;
      case "message:updated":
        if (!this.patchMessage(d.channelId, d.messageId, d.updated)) return;
        break;
      case "message:deleted":
        if (!isId(d.channelId) || !isId(d.messageId)) return;
        this.dropMessages(d.channelId, (m) => m.id === d.messageId);
        break;
      case "message:deleted_batch": {
        // A moderator removed someone's recent messages across a server.
        const from = time(d.toTime) ?? 0;
        const to = time(d.fromTime) ?? 0;
        if (!isId(d.serverId) || !isId(d.userId)) return;
        for (const channel of this.channels.values())
          if (channel.serverId === d.serverId) this.dropMessages(channel.id, (m) => m.author?.id === d.userId && m.createdAt >= from && m.createdAt <= to);
        break;
      }
      case "message:reaction_added":
      case "message:reaction_removed": {
        const by = event === "message:reaction_added" ? d.reactedByUserId : d.reactionRemovedByUserId;
        if (!this.setReaction(d.channelId, d.messageId, d, by === this.me?.id ? event === "message:reaction_added" : undefined)) return;
        break;
      }
      case "message:mark_unread": {
        const at = time(d.at);
        if (!isId(d.channelId) || at === undefined) return;
        this.lastSeen.set(d.channelId, at);
        break;
      }
      case "notification:dismissed":
        // Read elsewhere (another device or tab).
        if (!isId(d.channelId)) return;
        this.markRead(d.channelId);
        return;
      case "channel:typing": {
        if (!isId(d.channelId) || !isId(d.userId) || d.userId === this.me?.id) return;
        const channel = this.typing.get(d.channelId) ?? new Map<string, number>();
        channel.set(d.userId, Date.now() + TYPING_MS);
        this.typing.set(d.channelId, channel);
        break;
      }
      case "inbox:opened": {
        const opened = parseInbox(d);
        if (!opened) return;
        this.addInbox(opened.inbox);
        if (opened.channel) this.channels.set(opened.channel.id, opened.channel);
        break;
      }
      case "inbox:closed":
        if (!isId(d.channelId)) return;
        this.inbox.delete(d.channelId);
        this.channels.delete(d.channelId);
        this.messages.delete(d.channelId);
        break;
      case "server:joined":
        this.addServer(d.server, d.channels, d.roles, d.members);
        break;
      case "server:left":
        if (!isId(d.serverId)) return;
        this.removeServer(d.serverId);
        break;
      case "server:updated": {
        const server = isId(d.serverId) ? this.servers.get(d.serverId) : undefined;
        if (!server || !isRecord(d.updated)) return;
        if (typeof d.updated.name === "string" && d.updated.name !== "") server.name = d.updated.name.slice(0, 100);
        if (isCdnPath(d.updated.avatar)) server.avatar = d.updated.avatar;
        else if (d.updated.avatar === null) delete server.avatar;
        break;
      }
      case "server:order_updated":
        this.serverOrder = list(d.serverIds).filter(isId);
        break;
      case "server:channel_created": {
        const channel = parseChannel(d.channel);
        if (!channel?.serverId || !this.servers.has(channel.serverId)) return;
        this.channels.set(channel.id, channel);
        break;
      }
      case "server:channel_updated": {
        const channel = isId(d.channelId) ? this.channels.get(d.channelId) : undefined;
        if (!channel || !isRecord(d.updated)) return;
        const updated = d.updated;
        if (typeof updated.name === "string" && updated.name !== "") channel.name = updated.name.slice(0, 100);
        if (isId(updated.categoryId)) channel.categoryId = updated.categoryId;
        else if (updated.categoryId === null) delete channel.categoryId;
        if (Array.isArray(updated.permissions)) channel.permissions = parsePermissions(updated.permissions);
        break;
      }
      case "server:channel_deleted":
        if (!isId(d.channelId)) return;
        this.channels.delete(d.channelId);
        this.messages.delete(d.channelId);
        break;
      case "server:channel_order_updated": {
        const ids = list(d.orderedChannelIds).filter(isId);
        ids.forEach((id, index) => {
          const channel = this.channels.get(id);
          if (!channel) return;
          channel.order = index + 1;
          if (isId(d.categoryId)) channel.categoryId = d.categoryId;
          else if (d.categoryId === undefined || d.categoryId === null) delete channel.categoryId;
        });
        break;
      }
      case "server:channel_permissions_updated": {
        const channel = isId(d.channelId) ? this.channels.get(d.channelId) : undefined;
        if (!channel || !isId(d.roleId) || typeof d.permissions !== "number") return;
        channel.permissions = [...channel.permissions.filter((p) => p.roleId !== d.roleId), { roleId: d.roleId, permissions: d.permissions }];
        break;
      }
      case "server:role_created": {
        const role = parseRole(data);
        if (!role || !isId(d.serverId) || !this.servers.has(d.serverId)) return;
        this.roles.set(d.serverId, [...(this.roles.get(d.serverId) ?? []).filter((r) => r.id !== role.id), role]);
        break;
      }
      case "server:role_updated": {
        const role = isId(d.serverId) ? this.roles.get(d.serverId)?.find((r) => r.id === d.roleId) : undefined;
        if (!role || !isRecord(d.updated)) return;
        const updated = d.updated;
        if (typeof updated.name === "string" && updated.name !== "") role.name = updated.name.slice(0, 100);
        if ("hexColor" in updated) role.color = hexColor(updated.hexColor);
        if (typeof updated.hideRole === "boolean") role.hidden = updated.hideRole;
        if (typeof updated.permissions === "number") role.permissions = updated.permissions;
        break;
      }
      case "server:role_order_updated": {
        // Top first.
        const roles = isId(d.serverId) ? this.roles.get(d.serverId) : undefined;
        const ids = list(d.roleIds).filter(isId);
        if (!roles) return;
        for (const role of roles) if (ids.includes(role.id)) role.order = ids.length - ids.indexOf(role.id);
        break;
      }
      case "server:role_deleted": {
        const roles = isId(d.serverId) ? this.roles.get(d.serverId) : undefined;
        if (!roles) return;
        this.roles.set(d.serverId as string, roles.filter((r) => r.id !== d.roleId));
        break;
      }
      case "server:member_joined": {
        const member = parseMember(d.member, isId(d.serverId) ? d.serverId : undefined);
        if (!member || !this.servers.has(member.serverId)) return;
        this.addMember(member);
        break;
      }
      case "server:member_left":
        if (!isId(d.serverId) || !isId(d.userId)) return;
        this.members.get(d.serverId)?.delete(d.userId);
        break;
      case "server:member_updated": {
        const member = isId(d.serverId) && isId(d.userId) ? this.members.get(d.serverId)?.get(d.userId) : undefined;
        if (!member || !isRecord(d.updated)) return;
        if (Array.isArray(d.updated.roleIds)) member.roleIds = d.updated.roleIds.filter(isId);
        if (typeof d.updated.nickname === "string" && d.updated.nickname !== "") member.nickname = d.updated.nickname.slice(0, 100);
        else if ("nickname" in d.updated) delete member.nickname;
        break;
      }
      case "server:emoji_add": {
        const emoji = parseEmoji(d.emoji);
        const emojis = isId(d.serverId) ? this.emojis.get(d.serverId) : undefined;
        if (!emoji || !emojis) return;
        this.emojis.set(d.serverId as string, [...emojis.filter((e) => e.id !== emoji.id), emoji]);
        break;
      }
      case "server:emoji_update": {
        const emoji = isId(d.serverId) ? this.emojis.get(d.serverId)?.find((e) => e.id === d.emojiId) : undefined;
        if (!emoji || typeof d.name !== "string" || !/^\w{1,64}$/.test(d.name)) return;
        emoji.name = d.name;
        break;
      }
      case "server:emoji_remove": {
        const emojis = isId(d.serverId) ? this.emojis.get(d.serverId) : undefined;
        if (!emojis) return;
        this.emojis.set(d.serverId as string, emojis.filter((e) => e.id !== d.emojiId));
        break;
      }
      case "user:updated":
      case "user:updatedSelf": {
        const id = event === "user:updatedSelf" ? this.me?.id : d.userId;
        const updated = event === "user:updatedSelf" ? d : d.updated;
        if (!this.updateUser(id, updated)) return;
        break;
      }
      case "user:notification_settings_update":
        // Changed here or on another device: only the modes it names.
        if (!isRecord(d.updated) || !("notificationPingMode" in d.updated)) return;
        if (!this.setPingMode(isId(d.channelId) ? d.channelId : d.serverId, d.updated.notificationPingMode)) return;
        break;
      case "user:presence_update":
        if (!isId(d.userId) || typeof d.status !== "number") return;
        this.presence.set(d.userId, d.status);
        break;
      default:
        return; // Unhandled events do not change what we show.
    }
    this.changed.emit();
  }

  private authenticated(d: Json): void {
    this.reset();
    this.me = parseUser(d.user);
    this.addUser(this.me);
    if (isRecord(d.user)) this.serverOrder = list(d.user.orderedServerIds).filter(isId);
    for (const s of list(d.servers)) this.addServer(s, undefined, undefined, undefined);
    for (const r of list(d.serverRoles)) {
      const role = parseRole(r);
      const serverId = isRecord(r) && isId(r.serverId) ? r.serverId : undefined;
      if (role && serverId && this.servers.has(serverId)) this.roles.set(serverId, [...(this.roles.get(serverId) ?? []), role]);
    }
    for (const c of list(d.channels)) {
      const channel = parseChannel(c);
      if (channel && (!channel.serverId || this.servers.has(channel.serverId))) this.channels.set(channel.id, channel);
    }
    for (const m of list(d.serverMembers)) {
      const member = parseMember(m);
      if (member && this.servers.has(member.serverId)) this.addMember(member);
    }
    for (const i of list(d.inbox)) {
      const opened = parseInbox(i);
      if (opened) this.addInbox(opened.inbox);
    }
    if (isRecord(d.lastSeenServerChannelIds))
      for (const [channelId, at] of Object.entries(d.lastSeenServerChannelIds)) {
        const ms = time(at);
        if (isId(channelId) && ms !== undefined) this.lastSeen.set(channelId, ms);
      }
    for (const m of list(d.messageMentions)) {
      if (!isRecord(m) || !isId(m.channelId)) continue;
      const count = typeof m.count === "number" && Number.isInteger(m.count) && m.count > 0 ? m.count : 1;
      this.mentionCounts.set(m.channelId, (this.mentionCounts.get(m.channelId) ?? 0) + count);
    }
    for (const p of list(d.presences)) if (isRecord(p) && isId(p.userId) && typeof p.status === "number") this.presence.set(p.userId, p.status);
    for (const s of list(d.notificationSettings)) if (isRecord(s)) this.setPingMode(isId(s.channelId) ? s.channelId : s.serverId, s.notificationPingMode);
  }

  /** Records a server's or channel's ping mode: a NotifyMode, or null to follow the server. Returns whether it was one. */
  setPingMode(id: unknown, mode: unknown): boolean {
    if (!isId(id) || !(mode === null || mode === NotifyMode.All || mode === NotifyMode.MentionsOnly || mode === NotifyMode.Mute)) return false;
    this.pingModes.set(id, mode);
    return true;
  }

  /** Whether a channel is muted in Nerimity, as its client works it out: the channel's own ping mode, else its server's. */
  isMuted(channel: NerimityChannel): boolean {
    return (this.pingModes.get(channel.id) ?? (channel.serverId ? this.pingModes.get(channel.serverId) : undefined)) === NotifyMode.Mute;
  }

  /** A server with its custom emoji; its channels, roles and members where the payload carries them (server:joined). */
  private addServer(value: unknown, channels: unknown, roles: unknown, members: unknown): void {
    const server = parseServer(value);
    if (!server) return;
    this.servers.set(server.id, server);
    this.emojis.set(server.id, list((value as Json).customEmojis).flatMap((e) => parseEmoji(e) ?? []));
    for (const c of list(channels)) {
      const channel = parseChannel(c);
      if (channel?.serverId === server.id) this.channels.set(channel.id, channel);
    }
    if (Array.isArray(roles)) this.roles.set(server.id, roles.flatMap((r) => parseRole(r) ?? []));
    for (const m of list(members)) {
      const member = parseMember(m, server.id);
      if (member?.serverId === server.id) this.addMember(member);
    }
  }

  private removeServer(serverId: string): void {
    for (const map of [this.servers, this.roles, this.emojis, this.members]) map.delete(serverId);
    for (const channel of [...this.channels.values()]) {
      if (channel.serverId !== serverId) continue;
      this.channels.delete(channel.id);
      this.messages.delete(channel.id);
    }
    this.serverOrder = this.serverOrder.filter((id) => id !== serverId);
  }

  private addMember(member: NerimityMember): void {
    this.addUser(member.user);
    const members = this.members.get(member.serverId) ?? new Map<string, NerimityMember>();
    members.set(member.user.id, member);
    this.members.set(member.serverId, members);
  }

  private addInbox(inbox: NerimityInbox): void {
    this.inbox.set(inbox.channelId, inbox);
    this.addUser(inbox.recipient);
    if (inbox.lastSeen !== undefined) this.lastSeen.set(inbox.channelId, inbox.lastSeen);
  }

  private addUser(user: NerimityUser | undefined): void {
    if (user) this.users.set(user.id, user);
  }

  /** A user changed their name or picture; returns whether anyone known did. */
  private updateUser(id: unknown, updated: unknown): boolean {
    const user = isId(id) ? this.users.get(id) : undefined;
    if (!user || !isRecord(updated)) return false;
    if (typeof updated.username === "string" && updated.username !== "") user.username = updated.username.slice(0, 100);
    if (typeof updated.tag === "string") user.tag = updated.tag.slice(0, 20);
    if (isCdnPath(updated.avatar)) user.avatar = updated.avatar;
    else if (updated.avatar === null) delete user.avatar;
    if (this.me?.id === user.id) this.me = user;
    // Members and inbox entries hold their own copies.
    for (const members of this.members.values()) {
      const member = members.get(user.id);
      if (member) member.user = user;
    }
    for (const inbox of this.inbox.values()) if (inbox.recipient.id === user.id) inbox.recipient = user;
    return true;
  }

  /** Applies message:updated's partial message where it is cached; returns whether it was. */
  private patchMessage(channelId: unknown, messageId: unknown, updated: unknown): boolean {
    const message = this.findMessage(channelId, messageId);
    if (!message || !isRecord(updated)) return false;
    if (typeof updated.content === "string") message.content = updated.content;
    if (time(updated.editedAt) !== undefined) message.edited = true;
    if (Array.isArray(updated.mentions)) message.mentionIds = updated.mentions.flatMap((m) => (isRecord(m) && isId(m.id) ? [m.id] : []));
    // The server adds a link preview once it has read the linked page.
    if ("embed" in updated) {
      const embed = parseEmbed(updated.embed);
      if (embed) message.embed = embed;
      else delete message.embed;
    }
    if (updated.pinned === true) message.pinned = true;
    else if (updated.pinned === false) delete message.pinned;
    const latest = this.latest.get(message.channelId);
    if (latest?.id === message.id) this.latest.set(message.channelId, message);
    return true;
  }

  /** Swaps in an edited message where it is cached; returns whether it was. */
  replaceMessage(message: NerimityMessage): boolean {
    if (this.latest.get(message.channelId)?.id === message.id) this.latest.set(message.channelId, message);
    const cached = this.messages.get(message.channelId);
    const index = cached?.findIndex((m) => m.id === message.id) ?? -1;
    if (index < 0) return false;
    cached![index] = message;
    return true;
  }

  removeMessage(channelId: string, messageId: string): void {
    this.dropMessages(channelId, (m) => m.id === messageId);
    this.changed.emit();
  }

  private dropMessages(channelId: string, drop: (message: NerimityMessage) => boolean): void {
    const cached = this.messages.get(channelId);
    if (cached) this.messages.set(channelId, cached.filter((m) => !drop(m)));
    // A deleted last message leaves no preview rather than a stale one.
    const latest = this.latest.get(channelId);
    if (latest && drop(latest)) this.latest.delete(channelId);
  }

  /**
   * Sets a reaction's count as the server reports it (events and answers
   * carry the new total). `mine` says whether the user now has it, when the
   * change was theirs. Returns whether the message is cached.
   */
  setReaction(channelId: unknown, messageId: unknown, value: Json | NerimityReaction, mine: boolean | undefined): boolean {
    const message = this.findMessage(channelId, messageId);
    if (!message || typeof value.name !== "string" || value.name === "" || typeof value.count !== "number" || value.count < 0) return false;
    const emojiId = isId(value.emojiId) ? value.emojiId : undefined;
    const key = reactionKey({ name: value.name, emojiId });
    const index = message.reactions.findIndex((r) => reactionKey(r) === key);
    const current = message.reactions[index];
    if (value.count === 0) {
      if (current) message.reactions.splice(index, 1);
      return true;
    }
    const reaction: NerimityReaction = current ?? { name: value.name.slice(0, 64), gif: value.gif === true, webp: value.webp === true, count: 0, reacted: false };
    if (emojiId) reaction.emojiId = emojiId;
    reaction.count = value.count;
    if (mine !== undefined) reaction.reacted = mine;
    if (!current) message.reactions.push(reaction);
    return true;
  }

  findMessage(channelId: unknown, messageId: unknown): NerimityMessage | undefined {
    return isId(channelId) && isId(messageId) ? this.messages.get(channelId)?.find((m) => m.id === messageId) : undefined;
  }

  /** Records a read: now, or the last message's time if the clocks disagree. */
  markRead(channelId: string): void {
    const last = this.channels.get(channelId)?.lastMessagedAt ?? 0;
    this.lastSeen.set(channelId, Math.max(Date.now(), last));
    this.mentionCounts.delete(channelId);
    this.changed.emit();
  }

  /** Stores fetched history; `older` pages are prepended. */
  addHistory(channelId: string, messages: NerimityMessage[], older: boolean): void {
    for (const m of messages) this.addUser(m.author);
    const existing = this.messages.get(channelId) ?? [];
    const known = new Set(existing.map((m) => m.id));
    const fresh = messages.filter((m) => !known.has(m.id));
    this.messages.set(channelId, older ? [...fresh, ...existing] : [...existing, ...fresh]);
    for (const m of fresh) this.noteLatest(m);
    this.changed.emit();
  }

  /** Whether the user may see a channel: DMs; a server's channels its roles make public to them, or all for its owner and admins. */
  canSee(channel: NerimityChannel): boolean {
    if (!channel.serverId) return true;
    const server = this.servers.get(channel.serverId);
    if (!server || (this.me && server.createdById === this.me.id)) return server !== undefined;
    const roleIds = this.ownRoleIds(server);
    const granted = channel.permissions.filter((p) => roleIds.includes(p.roleId)).reduce((bits, p) => bits | p.permissions, 0);
    if (granted & ChannelPermission.Public) return true;
    return (this.roles.get(server.id) ?? []).some((r) => roleIds.includes(r.id) && (r.permissions & RolePermission.Admin) !== 0);
  }

  /** Whether the user may manage a server's channels (and so pin there): its owner, or by a role with Admin or Manage Channels. */
  canManageChannels(serverId: string): boolean {
    const server = this.servers.get(serverId);
    if (!server) return false;
    if (this.me && server.createdById === this.me.id) return true;
    const roleIds = this.ownRoleIds(server);
    return (this.roles.get(server.id) ?? []).some((r) => roleIds.includes(r.id) && (r.permissions & (RolePermission.Admin | RolePermission.ManageChannels)) !== 0);
  }

  /** The user's roles in a server, with its default role. */
  ownRoleIds(server: NerimityServer): string[] {
    const own = this.me ? (this.members.get(server.id)?.get(this.me.id)?.roleIds ?? []) : [];
    return server.defaultRoleId ? [...own, server.defaultRoleId] : own;
  }

  isUnread(channel: NerimityChannel): boolean {
    if (!TEXT_CHANNEL_TYPES.has(channel.type) || !channel.lastMessagedAt || !this.canSee(channel)) return false;
    const seen = this.lastSeen.get(channel.id);
    // As in Nerimity's client: a channel never opened counts as unread.
    return seen === undefined || channel.lastMessagedAt > seen;
  }

  mentions(channelId: string): number {
    return this.mentionCounts.get(channelId) ?? 0;
  }

  /**
   * A server's visible channels in sidebar order: uncategorised first, then
   * each category with its children. A category shows while it has a
   * channel the user may see.
   */
  serverChannels(serverId: string): NerimityChannel[] {
    const all = [...this.channels.values()].filter((c) => c.serverId === serverId);
    const byOrder = (a: NerimityChannel, b: NerimityChannel) => a.order - b.order || compareIds(a.id, b.id);
    const categories = all.filter((c) => c.type === ChannelType.Category).sort(byOrder);
    const categoryIds = new Set(categories.map((c) => c.id));
    const visible = all.filter((c) => c.type !== ChannelType.Category && this.canSee(c));
    const childrenOf = (parent?: string) => visible.filter((c) => (parent ? c.categoryId === parent : !c.categoryId || !categoryIds.has(c.categoryId))).sort(byOrder);
    return [
      ...childrenOf(),
      ...categories.flatMap((cat) => {
        const children = childrenOf(cat.id);
        return children.length > 0 ? [cat, ...children] : [];
      }),
    ];
  }

  serverUnread(serverId: string): boolean {
    return [...this.channels.values()].some((c) => c.serverId === serverId && this.isUnread(c));
  }

  serverMentions(serverId: string): number {
    return [...this.channels.values()].filter((c) => c.serverId === serverId).reduce((sum, c) => sum + this.mentions(c.id), 0);
  }

  /** Servers in the user's own order, then any it does not name. */
  orderedServers(): NerimityServer[] {
    const rank = (id: string) => {
      const index = this.serverOrder.indexOf(id);
      return index < 0 ? Infinity : index;
    };
    return [...this.servers.values()].sort((a, b) => rank(a.id) - rank(b.id));
  }

  /** DMs with their channels, most recent first. */
  dms(): { inbox: NerimityInbox; channel: NerimityChannel }[] {
    return [...this.inbox.values()]
      .flatMap((inbox) => {
        const channel = this.channels.get(inbox.channelId);
        return channel ? [{ inbox, channel }] : [];
      })
      .sort((a, b) => (b.channel.lastMessagedAt ?? 0) - (a.channel.lastMessagedAt ?? 0));
  }

  /** Whether a message mentions the user: by name, @everyone, a role they have, or a reply or quote that notifies them. */
  mentionsMe(message: NerimityMessage): boolean {
    const me = this.me?.id;
    if (!me) return false;
    if (message.mentionIds.includes(me)) return true;
    if (message.mentionReplies && message.replyTo?.author?.id === me) return true;
    if (message.quotes.some((q) => q.author?.id === me)) return true;
    const server = this.servers.get(this.channels.get(message.channelId)?.serverId ?? "");
    if (!server) return false;
    if (message.content.includes("[@:e]")) return true;
    const own = this.ownRoleIds(server).filter((id) => id !== server.defaultRoleId);
    return message.roleMentionIds.some((r) => own.includes(r));
  }

  /** Users typing in a channel right now, excluding ourselves. */
  typingIn(channelId: string, now: number = Date.now()): NerimityUser[] {
    return [...(this.typing.get(channelId) ?? [])].filter(([, expires]) => expires > now).flatMap(([userId]) => this.users.get(userId) ?? []);
  }

  private noteLatest(message: NerimityMessage): void {
    const current = this.latest.get(message.channelId);
    if (!current || compareIds(message.id, current.id) >= 0) this.latest.set(message.channelId, message);
  }

  private onMessageCreate(message: NerimityMessage | undefined): void {
    if (!message) return;
    if (message.author) this.typing.get(message.channelId)?.delete(message.author.id);
    this.addUser(message.author);
    const channel = this.channels.get(message.channelId);
    if (channel && message.createdAt > (channel.lastMessagedAt ?? 0)) channel.lastMessagedAt = message.createdAt;
    this.noteLatest(message);
    const cached = this.messages.get(message.channelId);
    if (cached && !cached.some((m) => m.id === message.id)) {
      cached.push(message);
      if (cached.length > MAX_CACHED_MESSAGES) cached.splice(0, cached.length - MAX_CACHED_MESSAGES);
    }
    if (message.author && message.author.id === this.me?.id) {
      this.lastSeen.set(message.channelId, message.createdAt);
      return;
    }
    if (channel?.type === ChannelType.Dm || this.mentionsMe(message)) this.mentionCounts.set(message.channelId, this.mentions(message.channelId) + 1);
    this.incoming.emit(message);
  }
}
