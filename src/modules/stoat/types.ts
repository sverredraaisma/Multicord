// Stoat (formerly Revolt) API objects, as far as this client uses them, with
// parsers that turn untrusted JSON from the network into these shapes
// (dropping what does not fit). Shapes follow the instance's OpenAPI document
// (https://stoat.chat/api/openapi.json, API 0.15) and the Bonfire event types.

export const ChannelType = {
  SavedMessages: "SavedMessages",
  DirectMessage: "DirectMessage",
  Group: "Group",
  TextChannel: "TextChannel",
  /** Older instances only; newer ones put voice on text channels. */
  VoiceChannel: "VoiceChannel",
} as const;
export type ChannelKind = (typeof ChannelType)[keyof typeof ChannelType];

/** Channels whose messages we show. */
export const TEXT_CHANNEL_TYPES: ReadonlySet<string> = new Set([ChannelType.DirectMessage, ChannelType.Group, ChannelType.TextChannel]);

/** Message flags (revolt_models MessageFlags). */
export const MessageFlag = { SuppressNotifications: 1, MentionsEveryone: 2, MentionsOnline: 4 } as const;

/** Autumn buckets whose files we link to. */
const FILE_TAGS: ReadonlySet<string> = new Set(["attachments", "avatars", "icons", "banners", "emojis", "backgrounds"]);

export const MAX_NAME = 100;
export const MAX_CONTENT = 10_000;
const MAX_LIST = 200;

export interface StoatFile {
  id: string;
  /** Autumn bucket, e.g. "attachments" or "avatars". */
  tag: string;
  filename: string;
  contentType?: string;
  /** What Autumn found the file to be. */
  kind: "image" | "video" | "audio" | "file";
  width?: number;
  height?: number;
  size?: number;
}

export interface StoatUser {
  id: string;
  username: string;
  displayName?: string;
  avatar?: StoatFile;
  /** "User" marks the signed-in user in Ready. */
  relationship?: string;
}

export interface StoatCategory {
  id: string;
  title: string;
  channelIds: string[];
}

export interface StoatServer {
  id: string;
  name: string;
  icon?: StoatFile;
  /** Channel ids in the server's own order. */
  channelIds: string[];
  categories: StoatCategory[];
}

export interface StoatChannel {
  id: string;
  type: ChannelKind;
  serverId?: string;
  name?: string;
  /** DMs and groups: who is in it. */
  recipients: string[];
  lastMessageId?: string;
  icon?: StoatFile;
  /** DMs: closed ones are hidden, as Stoat's own client does. */
  active: boolean;
}

export interface StoatReaction {
  /** A Unicode emoji or a custom emoji id. */
  emoji: string;
  userIds: string[];
}

export interface StoatMessage {
  id: string;
  channelId: string;
  authorId: string;
  /** Sent along with history (include_users) and live messages. */
  author?: StoatUser;
  /** A name override, e.g. from a bridge or bot. */
  masquerade?: string;
  content: string;
  /** System messages (joins, renames…), already turned into text. */
  system?: string;
  edited: boolean;
  mentionIds: string[];
  flags: number;
  attachments: StoatFile[];
  replies: string[];
  reactions: StoatReaction[];
  embeds: StoatEmbed[];
}

/**
 * A link preview the instance made (a Website, Image or Text embed). Its
 * picture is the linked site's own address, which is shown only through
 * the instance's proxy (January); a Text embed's picture is an uploaded file.
 */
export interface StoatEmbed {
  url?: string;
  site?: string;
  title?: string;
  description?: string;
  /** "#rrggbb"; other CSS colours are left out. */
  color?: string;
  image?: { url: string; width?: number; height?: number; thumbnail: boolean };
  media?: StoatFile;
}

export interface StoatUnread {
  channelId: string;
  lastId?: string;
  /** Ids of unread messages that mention us. */
  mentions: string[];
}

/** A custom emoji. Its picture is <autumn>/emojis/<id>; messages carry it as :<id>: and reactions by its id. */
export interface StoatEmoji {
  id: string;
  name: string;
  animated: boolean;
  /** The server it belongs to; detached emoji (their server is gone) have none. */
  serverId?: string;
}

/** Per-server or per-channel notification choice, from the "notifications" user setting. */
export type NotifyLevel = "all" | "mention" | "none" | "muted";

export interface StoatNotifySettings {
  servers: Map<string, NotifyLevel>;
  channels: Map<string, NotifyLevel>;
}

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Stoat ids are ULIDs: 26 characters of Crockford base32. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && ULID.test(value);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** When a ULID was made: its first 10 characters are epoch milliseconds. */
export function idTime(id: string | undefined): number {
  if (!isId(id)) return 0;
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(char);
  return time;
}

/** ULIDs of one length sort by time as plain strings. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const str = (value: unknown, max = MAX_NAME): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, MAX_LIST) : []);
const ids = (value: unknown): string[] => list(value).filter(isId);

export function parseFile(value: unknown): StoatFile | undefined {
  if (!isRecord(value) || typeof value._id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value._id)) return undefined;
  if (typeof value.tag !== "string" || !FILE_TAGS.has(value.tag)) return undefined;
  const contentType = str(value.content_type);
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const type = metadata.type ?? (contentType?.startsWith("image/") ? "Image" : contentType?.startsWith("video/") ? "Video" : contentType?.startsWith("audio/") ? "Audio" : "File");
  const pixels = (n: unknown): number | undefined => (typeof n === "number" && Number.isInteger(n) && n > 0 && n < 100_000 ? n : undefined);
  return {
    id: value._id,
    tag: value.tag,
    filename: str(value.filename, 255) ?? "file",
    contentType,
    kind: type === "Image" ? "image" : type === "Video" ? "video" : type === "Audio" ? "audio" : "file",
    width: pixels(metadata.width),
    height: pixels(metadata.height),
    size: typeof value.size === "number" && Number.isInteger(value.size) && value.size >= 0 ? value.size : undefined,
  };
}

export function parseUser(value: unknown): StoatUser | undefined {
  if (!isRecord(value) || !isId(value._id) || typeof value.username !== "string") return undefined;
  return {
    id: value._id,
    username: value.username.slice(0, MAX_NAME),
    displayName: str(value.display_name),
    avatar: parseFile(value.avatar),
    relationship: str(value.relationship),
  };
}

export function parseServer(value: unknown): StoatServer | undefined {
  if (!isRecord(value) || !isId(value._id) || typeof value.name !== "string") return undefined;
  return {
    id: value._id,
    name: value.name.slice(0, MAX_NAME),
    icon: parseFile(value.icon),
    channelIds: ids(value.channels),
    categories: parseCategories(value.categories),
  };
}

export function parseCategories(value: unknown): StoatCategory[] {
  return list(value).flatMap((c) =>
    isRecord(c) && typeof c.id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(c.id) && typeof c.title === "string"
      ? [{ id: c.id, title: c.title.slice(0, MAX_NAME), channelIds: ids(c.channels) }]
      : [],
  );
}

const CHANNEL_TYPES: ReadonlySet<string> = new Set(Object.values(ChannelType));

export function parseChannel(value: unknown): StoatChannel | undefined {
  if (!isRecord(value) || !isId(value._id) || typeof value.channel_type !== "string" || !CHANNEL_TYPES.has(value.channel_type)) return undefined;
  const type = value.channel_type as ChannelKind;
  const serverId = isId(value.server) ? value.server : undefined;
  if ((type === ChannelType.TextChannel || type === ChannelType.VoiceChannel) && !serverId) return undefined;
  return {
    id: value._id,
    type,
    serverId,
    name: str(value.name),
    recipients: ids(value.recipients),
    lastMessageId: isId(value.last_message_id) ? value.last_message_id : undefined,
    icon: parseFile(value.icon),
    active: type !== ChannelType.DirectMessage || value.active !== false,
  };
}

export function parseMessage(value: unknown): StoatMessage | undefined {
  if (!isRecord(value) || !isId(value._id) || !isId(value.channel) || !isId(value.author)) return undefined;
  const user = parseUser(value.user);
  return {
    id: value._id,
    channelId: value.channel,
    authorId: value.author,
    author: user?.id === value.author ? user : undefined,
    masquerade: isRecord(value.masquerade) ? str(value.masquerade.name) : undefined,
    content: typeof value.content === "string" ? value.content.slice(0, MAX_CONTENT) : "",
    system: systemText(value.system),
    edited: typeof value.edited === "string",
    mentionIds: ids(value.mentions),
    flags: typeof value.flags === "number" && Number.isInteger(value.flags) && value.flags >= 0 ? value.flags : 0,
    attachments: list(value.attachments).flatMap((a) => parseFile(a) ?? []),
    replies: ids(value.replies),
    reactions: parseReactions(value.reactions),
    embeds: list(value.embeds).slice(0, 10).flatMap((e) => parseEmbed(e) ?? []),
  };
}

const httpsLink = (value: unknown): string | undefined => (typeof value === "string" && /^https:\/\/\S{1,2040}$/.test(value) ? value : undefined);
const pixels = (n: unknown): number | undefined => (typeof n === "number" && Number.isInteger(n) && n > 0 && n < 100_000 ? n : undefined);

/** A Website, Image or Text embed as a link preview; videos, "None" and previews without anything to show are left out. */
export function parseEmbed(value: unknown): StoatEmbed | undefined {
  if (!isRecord(value)) return undefined;
  const embed: StoatEmbed = {};
  if (value.type === "Image") {
    const url = httpsLink(value.url);
    if (!url) return undefined;
    embed.image = { url, width: pixels(value.width), height: pixels(value.height), thumbnail: false };
    return embed;
  }
  if (value.type !== "Website" && value.type !== "Text") return undefined;
  const url = httpsLink(value.url);
  if (url) embed.url = url;
  const site = str(value.site_name);
  if (site) embed.site = site;
  const title = str(value.title, 256);
  if (title) embed.title = title;
  const description = str(value.description, 1000);
  if (description) embed.description = description;
  if (typeof value.colour === "string" && /^#[0-9a-f]{6}$/i.test(value.colour)) embed.color = value.colour;
  const image = isRecord(value.image) ? value.image : {};
  const imageUrl = httpsLink(image.url);
  if (imageUrl) embed.image = { url: imageUrl, width: pixels(image.width), height: pixels(image.height), thumbnail: image.size === "Preview" };
  const media = parseFile(value.media);
  if (media?.kind === "image") embed.media = media;
  return embed.title || embed.description || embed.image || embed.media ? embed : undefined;
}

/** reactions: emoji (Unicode or custom id) -> user ids. */
export function parseReactions(value: unknown): StoatReaction[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .slice(0, MAX_LIST)
    .flatMap(([emoji, users]) => {
      const userIds = ids(users);
      return isEmojiKey(emoji) && userIds.length > 0 ? [{ emoji, userIds }] : [];
    });
}

/** A reaction key: a custom emoji id, or a short Unicode emoji (no ASCII letters, digits or markup). */
export function isEmojiKey(value: string): boolean {
  if (ULID.test(value)) return true;
  // Keycaps (1️⃣, #️⃣) are the only emoji with ASCII in them; joiners and variation selectors are not.
  const rest = value.replace(/[#*0-9]/g, "");
  return value.length <= 32 && rest.length > 0 && !/[\x00-\x7f]/.test(rest);
}

/**
 * System messages as text; user ids appear as <@id> mentions, which the
 * adapter resolves to names like any other mention.
 */
function systemText(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const who = (id: unknown) => (isId(id) ? `<@${id}>` : "Someone");
  switch (value.type) {
    case "text":
      return typeof value.content === "string" ? value.content.slice(0, MAX_CONTENT) : "";
    case "user_added":
      return `${who(value.id)} was added by ${who(value.by)}`;
    case "user_remove":
      return `${who(value.id)} was removed by ${who(value.by)}`;
    case "user_joined":
      return `${who(value.id)} joined`;
    case "user_left":
      return `${who(value.id)} left`;
    case "user_kicked":
      return `${who(value.id)} was kicked`;
    case "user_banned":
      return `${who(value.id)} was banned`;
    case "channel_renamed":
      return `${who(value.by)} renamed the channel to ${str(value.name) ?? "…"}`;
    case "channel_description_changed":
      return `${who(value.by)} changed the channel description`;
    case "channel_icon_changed":
      return `${who(value.by)} changed the channel icon`;
    case "channel_ownership_changed":
      return `${who(value.from)} gave the group to ${who(value.to)}`;
    case "message_pinned":
      return `${who(value.by)} pinned a message`;
    case "message_unpinned":
      return `${who(value.by)} unpinned a message`;
    case "call_started":
      return `${who(value.by)} started a call`;
    default:
      return "System message";
  }
}

export function parseUnread(value: unknown): StoatUnread | undefined {
  if (!isRecord(value) || !isRecord(value._id) || !isId(value._id.channel)) return undefined;
  return {
    channelId: value._id.channel,
    lastId: isId(value.last_id) ? value.last_id : undefined,
    mentions: ids(value.mentions),
  };
}

export function parseEmoji(value: unknown): StoatEmoji | undefined {
  if (!isRecord(value) || !isId(value._id) || typeof value.name !== "string" || !/^[a-z0-9_]{1,32}$/i.test(value.name)) return undefined;
  const parent = isRecord(value.parent) && value.parent.type === "Server" && isId(value.parent.id) ? value.parent.id : undefined;
  return { id: value._id, name: value.name, animated: value.animated === true, serverId: parent };
}

const LEVELS: ReadonlySet<string> = new Set(["all", "mention", "none", "muted"]);

/**
 * The "notifications" user setting, as /sync/settings/fetch and
 * UserSettingsUpdate deliver it: [timestamp, JSON text] holding
 * {server: {id: level}, channel: {id: level}}.
 */
export function parseNotifySettings(value: unknown): StoatNotifySettings | undefined {
  const raw = Array.isArray(value) && typeof value[1] === "string" ? value[1] : undefined;
  if (raw === undefined || raw.length > 100_000) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  const levels = (map: unknown) =>
    new Map(
      (isRecord(map) ? Object.entries(map) : []).flatMap(([id, level]): [string, NotifyLevel][] =>
        isId(id) && typeof level === "string" && LEVELS.has(level) ? [[id, level as NotifyLevel]] : [],
      ),
    );
  return { servers: levels(data.server), channels: levels(data.channel) };
}

/**
 * The "notifications" setting's JSON text with one channel's level set, or
 * its own level removed (undefined), keeping everything else in it as it was.
 * `value` is the setting as /sync/settings/fetch gives it; anything
 * unreadable counts as no settings yet.
 */
export function withChannelLevel(value: unknown, channelId: string, level: NotifyLevel | undefined): string {
  let data: unknown;
  try {
    data = Array.isArray(value) && typeof value[1] === "string" ? JSON.parse(value[1]) : {};
  } catch {
    data = {};
  }
  const settings = isRecord(data) ? data : {};
  const channels = isRecord(settings.channel) ? { ...settings.channel } : {};
  if (level) channels[channelId] = level;
  else delete channels[channelId];
  return JSON.stringify({ ...settings, channel: channels });
}

/** Display name: display name, else username. */
export function displayName(user: StoatUser): string {
  return user.displayName ?? user.username;
}
