// Spacebar API objects, as far as this client uses them, with parsers that turn
// untrusted JSON from the network into these shapes (dropping what does not fit).
// Spacebar reimplements Discord's API (version 9), so the shapes are Discord's,
// as its server (github.com/spacebarchat/server) sends them.

export const ChannelType = {
  GuildText: 0,
  Dm: 1,
  GuildVoice: 2,
  GroupDm: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
} as const;

/** Channels whose messages we show. */
export const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.Dm, ChannelType.GroupDm]);

/** Spacebar's snowflakes count from Discord's epoch (2015-01-01). */
const EPOCH = 1420070400000n;

export interface SpacebarUser {
  id: string;
  username: string;
  globalName?: string;
  avatar?: string;
  bot?: boolean;
}

export interface SpacebarRole {
  id: string;
  name: string;
  /** 0xrrggbb; 0 for none. */
  color: number;
  position: number;
  /** Shown apart in the member list. */
  hoist: boolean;
}

export interface SpacebarEmoji {
  id: string;
  name: string;
  animated: boolean;
}

export interface SpacebarGuild {
  id: string;
  name: string;
  icon?: string;
}

export interface SpacebarChannel {
  id: string;
  type: number;
  guildId?: string;
  name?: string;
  position: number;
  parentId?: string;
  lastMessageId?: string;
  recipients: SpacebarUser[];
}

export interface SpacebarAttachment {
  id: string;
  filename: string;
  contentType?: string;
  url?: string;
  width?: number;
  height?: number;
  size?: number;
}

/** A reaction's emoji: a Unicode character, or a custom emoji with its id. */
export interface ReactionEmoji {
  id?: string;
  name: string;
}

export interface SpacebarReaction {
  emoji: ReactionEmoji;
  count: number;
  me: boolean;
}

/** A link preview with words: an article, a site's card, or a rich embed a bot made. */
export interface SpacebarLinkEmbed {
  url?: string;
  site?: string;
  title?: string;
  description?: string;
  /** "#rrggbb". */
  color?: string;
  /** Its picture as the instance names it (its proxy where it has one); the adapter decides whether it may be shown. */
  image?: { url: string; width?: number; height?: number; thumbnail: boolean };
}

export interface SpacebarMessage {
  id: string;
  channelId: string;
  author: SpacebarUser;
  content: string;
  timestamp: string;
  edited: boolean;
  mentionIds: string[];
  mentionEveryone: boolean;
  roleMentionIds: string[];
  attachments: SpacebarAttachment[];
  links: SpacebarLinkEmbed[];
  /** 0 DEFAULT, 19 REPLY; only these can be edited. */
  type: number;
  /** The message this one replies to; null when it no longer exists. */
  replyTo?: { id: string; author: SpacebarUser; content: string; timestamp: string } | null;
  reactions: SpacebarReaction[];
}

export const MessageType = { Default: 0, Reply: 19 } as const;

export interface SpacebarReadState {
  channelId: string;
  lastMessageId?: string;
  mentionCount: number;
}

/** Someone in a guild, as GET /guilds/{id}/members lists them. */
export interface SpacebarMember {
  user: SpacebarUser;
  nick?: string;
  roles: string[];
}

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** A positive whole number (pixels, bytes), else undefined. */
const dimension = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** Snowflakes compare by value, not as strings. */
export function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** When a snowflake was made, in epoch ms; 0 without one. */
export function timestampOf(id: string | undefined): number {
  return id ? Number((BigInt(id) >> 22n) + EPOCH) : 0;
}

export function parseUser(value: unknown): SpacebarUser | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.username !== "string") return undefined;
  const user: SpacebarUser = { id: value.id, username: value.username.slice(0, 100) };
  const globalName = str(value.global_name);
  if (globalName) user.globalName = globalName.slice(0, 100);
  const avatar = str(value.avatar);
  if (avatar && /^(a_)?[0-9a-f]{1,64}$/.test(avatar)) user.avatar = avatar;
  if (value.bot === true) user.bot = true;
  return user;
}

/** Display name: global name, else username. */
export function displayName(user: SpacebarUser): string {
  return user.globalName ?? user.username;
}

export function parseRole(value: unknown): SpacebarRole | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== "string") return undefined;
  const color = typeof value.color === "number" && Number.isInteger(value.color) && value.color > 0 && value.color <= 0xffffff ? value.color : 0;
  return { id: value.id, name: value.name.slice(0, 100), color, position: typeof value.position === "number" ? value.position : 0, hoist: value.hoist === true };
}

/** "#rrggbb" for a role colour; undefined for none. */
export const roleColor = (role: SpacebarRole | undefined): string | undefined => (role && role.color > 0 ? `#${role.color.toString(16).padStart(6, "0")}` : undefined);

export function parseEmoji(value: unknown): SpacebarEmoji | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== "string" || !/^\w{1,64}$/.test(value.name)) return undefined;
  return { id: value.id, name: value.name, animated: value.animated === true };
}

export function parseReactionEmoji(value: unknown): ReactionEmoji | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") return undefined;
  return isId(value.id) ? { id: value.id, name: value.name.slice(0, 64) } : { name: value.name.slice(0, 64) };
}

/** The path form of an emoji: the Unicode character, or name:id for custom emoji. */
export function emojiKey(emoji: ReactionEmoji): string {
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

export function parseGuild(value: unknown): SpacebarGuild | undefined {
  if (!isRecord(value) || !isId(value.id) || value.unavailable === true || typeof value.name !== "string") return undefined;
  const guild: SpacebarGuild = { id: value.id, name: value.name.slice(0, 100) };
  const icon = str(value.icon);
  if (icon && /^(a_)?[0-9a-f]{1,64}$/.test(icon)) guild.icon = icon;
  return guild;
}

export function parseChannel(value: unknown, guildId?: string): SpacebarChannel | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.type !== "number") return undefined;
  const channel: SpacebarChannel = {
    id: value.id,
    type: value.type,
    position: typeof value.position === "number" ? value.position : 0,
    recipients: list(value.recipients).flatMap((r) => parseUser(r) ?? []),
  };
  const ownGuild = isId(value.guild_id) ? value.guild_id : guildId;
  if (ownGuild) channel.guildId = ownGuild;
  const name = str(value.name);
  if (name) channel.name = name.slice(0, 100);
  if (isId(value.parent_id)) channel.parentId = value.parent_id;
  if (isId(value.last_message_id)) channel.lastMessageId = value.last_message_id;
  return channel;
}

function parseAttachments(value: unknown): SpacebarAttachment[] {
  return list(value).flatMap((a) => {
    if (!isRecord(a) || !isId(a.id) || typeof a.filename !== "string") return [];
    const url = str(a.proxy_url) ?? str(a.url);
    return [{ id: a.id, filename: a.filename.slice(0, 255), contentType: str(a.content_type), url: url?.startsWith("https://") ? url : undefined, width: dimension(a.width), height: dimension(a.height), size: dimension(a.size) }];
  });
}

export function parseMessage(value: unknown): SpacebarMessage | undefined {
  if (!isRecord(value) || !isId(value.id) || !isId(value.channel_id)) return undefined;
  const author = parseUser(value.author);
  if (!author) return undefined;
  return {
    id: value.id,
    channelId: value.channel_id,
    author,
    content: typeof value.content === "string" ? value.content : "",
    timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
    edited: typeof value.edited_timestamp === "string",
    mentionIds: list(value.mentions).flatMap((m) => (isRecord(m) && isId(m.id) ? [m.id] : isId(m) ? [m] : [])),
    mentionEveryone: value.mention_everyone === true,
    roleMentionIds: list(value.mention_roles).filter(isId),
    attachments: parseAttachments(value.attachments),
    links: list(value.embeds).flatMap((e) => parseLinkEmbed(e) ?? []),
    type: typeof value.type === "number" ? value.type : MessageType.Default,
    ...("referenced_message" in value ? { replyTo: parseReplyTo(value.referenced_message) } : {}),
    reactions: list(value.reactions).flatMap((r) => {
      const emoji = isRecord(r) ? parseReactionEmoji(r.emoji) : undefined;
      const count = isRecord(r) ? dimension(r.count) : undefined;
      return emoji && count ? [{ emoji, count, me: (r as Json).me === true }] : [];
    }),
  };
}

const https = (value: unknown): string | undefined => (typeof value === "string" && value.length <= 2048 && value.startsWith("https://") ? value : undefined);

/**
 * Embeds with words (articles, link cards, rich embeds); media embeds
 * (image, gifv, video) are left out. A picture is named by its proxy_url,
 * which is the instance's image proxy where it runs one and else the
 * linked site's own address.
 */
function parseLinkEmbed(e: unknown): SpacebarLinkEmbed | undefined {
  if (!isRecord(e) || e.type === "image" || e.type === "gifv" || e.type === "video") return undefined;
  const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : undefined);
  const embed: SpacebarLinkEmbed = {};
  const url = https(e.url);
  if (url) embed.url = url;
  const site = text(isRecord(e.provider) ? e.provider.name : undefined, 100) ?? text(isRecord(e.author) ? e.author.name : undefined, 100);
  if (site) embed.site = site;
  const title = text(e.title, 256);
  if (title) embed.title = title;
  const description = text(e.description, 1000);
  if (description) embed.description = description;
  if (typeof e.color === "number" && Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff) embed.color = `#${e.color.toString(16).padStart(6, "0")}`;
  const picture = (key: string, thumbnail: boolean): SpacebarLinkEmbed["image"] => {
    const media = isRecord(e[key]) ? (e[key] as Json) : {};
    const shown = https(media.proxy_url) ?? https(media.url);
    return shown ? { url: shown, width: dimension(media.width), height: dimension(media.height), thumbnail } : undefined;
  };
  const image = picture("image", false) ?? picture("thumbnail", true);
  if (image) embed.image = image;
  return title || description || image ? embed : undefined;
}

/** referenced_message: absent for non-replies, null when the original is gone. */
function parseReplyTo(ref: unknown): SpacebarMessage["replyTo"] {
  const author = isRecord(ref) ? parseUser(ref.author) : undefined;
  if (!isRecord(ref) || !isId(ref.id) || !author) return null;
  return { id: ref.id, author, content: typeof ref.content === "string" ? ref.content : "", timestamp: typeof ref.timestamp === "string" ? ref.timestamp : "" };
}

export function parseReadState(value: unknown): SpacebarReadState | undefined {
  if (!isRecord(value)) return undefined;
  const channelId = isId(value.channel_id) ? value.channel_id : isId(value.id) ? value.id : undefined;
  if (!channelId) return undefined;
  const mentions = value.mention_count;
  const state: SpacebarReadState = { channelId, mentionCount: typeof mentions === "number" && Number.isInteger(mentions) && mentions >= 0 ? mentions : 0 };
  const last = isId(value.last_message_id) ? value.last_message_id : isId(value.message_id) ? value.message_id : undefined;
  if (last) state.lastMessageId = last;
  return state;
}

export function parseMember(value: unknown): SpacebarMember | undefined {
  const user = isRecord(value) ? parseUser(value.user) : undefined;
  if (!user) return undefined;
  const record = value as Json;
  const member: SpacebarMember = { user, roles: list(record.roles).flatMap((r) => (isId(r) ? [r] : isRecord(r) && isId(r.id) ? [r.id] : [])) };
  const nick = str(record.nick);
  if (nick) member.nick = nick.slice(0, 100);
  return member;
}
