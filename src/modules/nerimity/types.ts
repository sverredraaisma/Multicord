// Nerimity API objects, as far as this client uses them, with parsers that turn
// untrusted JSON from the network into these shapes (dropping what does not fit).
// The shapes are those Nerimity's server (github.com/Nerimity/nerimity-server)
// sends: Prisma rows with their dates as epoch milliseconds.

export const ChannelType = { Dm: 0, ServerText: 1, Category: 2, Ticket: 3 } as const;

/** Channels whose messages we show. */
export const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set([ChannelType.Dm, ChannelType.ServerText]);

/** Message types: only CONTENT messages are the user's own words; the others are system lines. */
export const MessageType = { Content: 0, JoinServer: 1, LeaveServer: 2, KickUser: 3, BanUser: 4, CallStarted: 5, BumpServer: 6, PinnedMessage: 7 } as const;

/** Role permission bits (ROLE_PERMISSIONS in Nerimity's server). */
export const RolePermission = { Admin: 1, SendMessage: 2, MentionEveryone: 64, MentionRoles: 256 } as const;
/** Channel permission bits a role is given per channel (CHANNEL_PERMISSIONS). */
export const ChannelPermission = { Public: 1, SendMessage: 2 } as const;

/** Presence: 0 offline, 1 online, 2 looking to play, 3 away, 4 do not disturb. */
export const UserStatus = { Offline: 0, Online: 1, LookingToPlay: 2, Away: 3, DoNotDisturb: 4 } as const;

export interface NerimityUser {
  /** A FlakeId; a webhook's messages carry "<webhook id>-<override id>". */
  id: string;
  username: string;
  tag: string;
  /** A path on the CDN, e.g. avatars/1/2.webp. */
  avatar?: string;
  bot?: boolean;
}

export interface NerimityServer {
  id: string;
  name: string;
  /** A path on the CDN. */
  avatar?: string;
  defaultRoleId?: string;
  createdById?: string;
}

export interface ChannelRolePermission {
  roleId: string;
  permissions: number;
}

export interface NerimityChannel {
  id: string;
  type: number;
  name?: string;
  serverId?: string;
  categoryId?: string;
  order: number;
  /** When its last message came, epoch ms; what unread state compares with. */
  lastMessagedAt?: number;
  permissions: ChannelRolePermission[];
}

export interface NerimityRole {
  id: string;
  name: string;
  /** "#rrggbb", or none. */
  color?: string;
  /** Higher is higher in the list. */
  order: number;
  /** Not shown as a section of its own in the member list. */
  hidden: boolean;
  permissions: number;
}

export interface NerimityEmoji {
  id: string;
  name: string;
  /** A GIF from before every emoji became WebP; such emoji live at <id>.gif. */
  gif: boolean;
  /** An animated WebP (or any emoji since): <id>.webp. */
  webp: boolean;
}

export interface NerimityMember {
  serverId: string;
  user: NerimityUser;
  nickname?: string;
  roleIds: string[];
}

export interface NerimityAttachment {
  id: string;
  /** A path on the CDN; absent for files stored elsewhere (Google Drive). */
  path?: string;
  provider: string;
  mime?: string;
  width?: number;
  height?: number;
  size?: number;
}

export interface NerimityReaction {
  /** The Unicode emoji, or a custom emoji's name. */
  name: string;
  emojiId?: string;
  gif: boolean;
  webp: boolean;
  count: number;
  /** Whether the user is among those who reacted. */
  reacted: boolean;
}

export interface NerimityReply {
  id: string;
  author?: NerimityUser;
  content: string;
  createdAt?: number;
}

export interface NerimityMessage {
  id: string;
  channelId: string;
  /** Absent when the account is gone. */
  author?: NerimityUser;
  content: string;
  type: number;
  createdAt: number;
  edited: boolean;
  mentionIds: string[];
  roleMentionIds: string[];
  /** A reply that notifies the author of the message it answers. */
  mentionReplies: boolean;
  attachments: NerimityAttachment[];
  reactions: NerimityReaction[];
  /** The first message this one answers, if any. */
  replyTo?: NerimityReply;
  /** Messages quoted inline with [q:id]. */
  quotes: NerimityReply[];
}

/** A DM: the conversation with one other user, as the inbox lists it. */
export interface NerimityInbox {
  channelId: string;
  recipient: NerimityUser;
  /** When the user last read it, epoch ms. */
  lastSeen?: number;
}

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A FlakeId: digits only. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

/** A user id: a FlakeId, or a webhook's "<id>-<override>". */
const isUserId = (value: unknown): value is string => typeof value === "string" && /^\d{1,20}(-\d{1,20})?$/.test(value);

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** A positive whole number (pixels, bytes), else undefined. */
const dimension = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** A date as epoch ms: the server sends numbers, older payloads ISO strings. */
export function time(value: unknown): number | undefined {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** FlakeIds compare by value, not as strings. */
export function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A path on the CDN that cannot step out of it: segments of plain characters, no "..". */
export function isCdnPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 300 && /^[\w-]+(\/[\w.%#-]+)*$/.test(value) && !/\/\.\.?(\/|$)/.test(value);
}

/** "#rrggbb" from what the server stores (with or without "#", any case); undefined otherwise. */
export function hexColor(value: unknown): string | undefined {
  const match = typeof value === "string" ? /^#?([0-9a-fA-F]{6})$/.exec(value) : null;
  return match ? `#${match[1]!.toLowerCase()}` : undefined;
}

export function parseUser(value: unknown): NerimityUser | undefined {
  if (!isRecord(value) || !isUserId(value.id) || typeof value.username !== "string" || value.username === "") return undefined;
  const user: NerimityUser = { id: value.id, username: value.username.slice(0, 100), tag: typeof value.tag === "string" ? value.tag.slice(0, 20) : "" };
  if (isCdnPath(value.avatar)) user.avatar = value.avatar;
  if (value.bot === true) user.bot = true;
  return user;
}

/** Display name: the username (Nerimity has no separate display name). */
export const displayName = (user: NerimityUser): string => user.username;

export function parseServer(value: unknown): NerimityServer | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== "string") return undefined;
  const server: NerimityServer = { id: value.id, name: value.name.slice(0, 100) };
  if (isCdnPath(value.avatar)) server.avatar = value.avatar;
  if (isId(value.defaultRoleId)) server.defaultRoleId = value.defaultRoleId;
  if (isId(value.createdById)) server.createdById = value.createdById;
  return server;
}

export function parsePermissions(value: unknown): ChannelRolePermission[] {
  return list(value).flatMap((p) => (isRecord(p) && isId(p.roleId) && typeof p.permissions === "number" ? [{ roleId: p.roleId, permissions: p.permissions }] : []));
}

export function parseChannel(value: unknown): NerimityChannel | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.type !== "number") return undefined;
  const channel: NerimityChannel = { id: value.id, type: value.type, order: typeof value.order === "number" ? value.order : 0, permissions: parsePermissions(value.permissions) };
  const name = str(value.name);
  if (name) channel.name = name.slice(0, 100);
  if (isId(value.serverId)) channel.serverId = value.serverId;
  if (isId(value.categoryId)) channel.categoryId = value.categoryId;
  const last = time(value.lastMessagedAt);
  if (last) channel.lastMessagedAt = last;
  return channel;
}

export function parseRole(value: unknown): NerimityRole | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== "string") return undefined;
  const role: NerimityRole = {
    id: value.id,
    name: value.name.slice(0, 100),
    order: typeof value.order === "number" ? value.order : 0,
    hidden: value.hideRole === true,
    permissions: typeof value.permissions === "number" ? value.permissions : 0,
  };
  const color = hexColor(value.hexColor);
  if (color) role.color = color;
  return role;
}

export function parseEmoji(value: unknown): NerimityEmoji | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== "string" || !/^\w{1,64}$/.test(value.name)) return undefined;
  return { id: value.id, name: value.name, gif: value.gif === true, webp: value.webp === true };
}

/** An emoji's file on the CDN: legacy GIFs at <id>.gif, everything else at <id>.webp. */
export const emojiFile = (emoji: { id: string; gif?: boolean; webp?: boolean }): string => `${emoji.id}.${emoji.gif && !emoji.webp ? "gif" : "webp"}`;

/** A member as the session or a member event gives it; `serverId` fills in where the payload leaves it out. */
export function parseMember(value: unknown, serverId?: string): NerimityMember | undefined {
  const user = isRecord(value) ? parseUser(value.user) : undefined;
  const record = value as Json;
  const server = isId(record?.serverId) ? record.serverId : serverId;
  if (!user || !server) return undefined;
  const member: NerimityMember = { serverId: server, user, roleIds: list(record.roleIds).filter(isId) };
  const nickname = str(record.nickname);
  if (nickname) member.nickname = nickname.slice(0, 100);
  return member;
}

function parseAttachments(value: unknown): NerimityAttachment[] {
  return list(value).flatMap((a) => {
    if (!isRecord(a) || !isId(a.id)) return [];
    const attachment: NerimityAttachment = { id: a.id, provider: typeof a.provider === "string" ? a.provider : "local" };
    if (isCdnPath(a.path)) attachment.path = a.path;
    const mime = str(a.mime);
    if (mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)) attachment.mime = mime;
    const width = dimension(a.width);
    const height = dimension(a.height);
    const size = dimension(a.filesize);
    if (width) attachment.width = width;
    if (height) attachment.height = height;
    if (size) attachment.size = size;
    return [attachment];
  });
}

export function parseReactionCount(value: unknown): NerimityReaction | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") return undefined;
  const count = typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0 ? value.count : 0;
  const reaction: NerimityReaction = { name: value.name.slice(0, 64), gif: value.gif === true, webp: value.webp === true, count, reacted: value.reacted === true };
  if (isId(value.emojiId)) reaction.emojiId = value.emojiId;
  return reaction;
}

/** A reaction's key: the Unicode emoji, or name:id for a custom emoji. */
export const reactionKey = (reaction: { name: string; emojiId?: string }): string => (reaction.emojiId ? `${reaction.name}:${reaction.emojiId}` : reaction.name);

function parseReply(value: unknown): NerimityReply | undefined {
  if (!isRecord(value) || !isId(value.id)) return undefined;
  const reply: NerimityReply = { id: value.id, content: typeof value.content === "string" ? value.content : "" };
  const author = parseUser(value.createdBy);
  if (author) reply.author = author;
  const at = time(value.createdAt);
  if (at) reply.createdAt = at;
  return reply;
}

export function parseMessage(value: unknown): NerimityMessage | undefined {
  if (!isRecord(value) || !isId(value.id) || !isId(value.channelId)) return undefined;
  const message: NerimityMessage = {
    id: value.id,
    channelId: value.channelId,
    content: typeof value.content === "string" ? value.content : "",
    type: typeof value.type === "number" ? value.type : MessageType.Content,
    createdAt: time(value.createdAt) ?? 0,
    edited: time(value.editedAt) !== undefined,
    mentionIds: list(value.mentions).flatMap((m) => (isRecord(m) && isId(m.id) ? [m.id] : [])),
    roleMentionIds: list(value.roleMentions).flatMap((r) => (isRecord(r) && isId(r.id) ? [r.id] : [])),
    mentionReplies: value.mentionReplies === true,
    attachments: parseAttachments(value.attachments),
    reactions: list(value.reactions).flatMap((r) => {
      const reaction = parseReactionCount(r);
      return reaction && reaction.count > 0 ? [reaction] : [];
    }),
    quotes: list(value.quotedMessages).flatMap((q) => parseReply(q) ?? []),
  };
  const author = parseUser(value.createdBy);
  if (author) message.author = author;
  const replyTo = list(value.replyMessages)
    .map((r) => (isRecord(r) ? parseReply(r.replyToMessage) : undefined))
    .find((r) => r !== undefined);
  if (replyTo) message.replyTo = replyTo;
  return message;
}

/** An inbox entry (a DM), with its channel when the payload carries it. */
export function parseInbox(value: unknown): { inbox: NerimityInbox; channel?: NerimityChannel } | undefined {
  if (!isRecord(value)) return undefined;
  const channel = parseChannel(value.channel);
  const channelId = isId(value.channelId) ? value.channelId : channel?.id;
  const recipient = parseUser(value.recipient);
  if (!channelId || !recipient) return undefined;
  const inbox: NerimityInbox = { channelId, recipient };
  const lastSeen = time(value.lastSeen);
  if (lastSeen) inbox.lastSeen = lastSeen;
  return channel ? { inbox, channel } : { inbox };
}
