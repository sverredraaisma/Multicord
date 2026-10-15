// Fluxer API objects, as far as this client uses them, with parsers that turn
// untrusted JSON from the network into these shapes (dropping what does not fit).
// Shapes follow https://docs.fluxer.app (API version 1).

export const ChannelType = {
  GuildText: 0,
  Dm: 1,
  GuildVoice: 2,
  GroupDm: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildForum: 15,
  GuildMedia: 16,
} as const;

export const THREAD_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

/** Forum and media channels hold posts (threads) instead of messages. */
export const FORUM_TYPES: ReadonlySet<number> = new Set([ChannelType.GuildForum, ChannelType.GuildMedia]);

/** Channels whose messages we show, threads and forum posts included. */
export const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.Dm,
  ChannelType.GroupDm,
  ...THREAD_TYPES,
]);

export interface FluxerUser {
  id: string;
  username: string;
  globalName?: string;
  avatar?: string;
}

export interface FluxerGuild {
  id: string;
  name: string;
  icon?: string;
}

export interface FluxerChannel {
  id: string;
  type: number;
  guildId?: string;
  name?: string;
  position: number;
  parentId?: string;
  lastMessageId?: string;
  recipients: FluxerUser[];
  icon?: string;
  /** Threads only. */
  archived?: boolean;
  messageCount?: number;
}

export interface FluxerAttachment {
  id: string;
  filename: string;
  contentType?: string;
  url?: string;
  width?: number;
  height?: number;
  size?: number;
}

/**
 * A sticker sent with a message. Fluxer stores stickers as WebP, still or
 * animated (`animated`); `format` is Discord's format_type where a payload
 * carries one (3 is Lottie, which has no picture here), else 1.
 */
export interface FluxerSticker {
  id: string;
  name: string;
  format: number;
  animated: boolean;
}

/** A guild's sticker, as READY, GUILD_CREATE and GUILD_STICKERS_UPDATE carry it. */
export interface FluxerGuildSticker {
  id: string;
  name: string;
  animated: boolean;
}

export function parseGuildSticker(value: unknown): FluxerGuildSticker | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== "string" || value.name === "") return undefined;
  return { id: value.id, name: value.name.slice(0, 100), animated: value.animated === true };
}

/** A result of Fluxer's GIF search (its proxy for the instance's provider, e.g. Klipy). */
export interface FluxerGif {
  id: string;
  /** The provider's page, which Fluxer unfurls into the GIF when sent. */
  url: string;
  preview: string;
  video: boolean;
  width?: number;
  height?: number;
  title?: string;
}

/** Small formats first: a looping video where there is one, else a picture. */
const GIF_PREVIEWS: [string, boolean][] = [
  ["tinymp4", true],
  ["mediummp4", true],
  ["mp4", true],
  ["tinywebp", false],
  ["tinygif", false],
  ["mediumwebp", false],
  ["mediumgif", false],
  ["webp", false],
  ["gif", false],
];

const httpsUrl = (value: unknown): string | undefined => (typeof value === "string" && value.startsWith("https://") ? value : undefined);

export function parseGif(value: unknown): FluxerGif | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
  const url = httpsUrl(value.url);
  if (!url) return undefined;
  const media = isRecord(value.media) ? value.media : {};
  for (const [key, video] of GIF_PREVIEWS) {
    const format = media[key];
    const preview = isRecord(format) ? (httpsUrl(format.proxy_src) ?? httpsUrl(format.src)) : undefined;
    if (isRecord(format) && preview) return gif(value, url, preview, video, format);
  }
  // Without a known format, the best format the server picked; its path says whether it is a video.
  const preview = httpsUrl(value.proxy_src) ?? httpsUrl(value.src);
  return preview ? gif(value, url, preview, /\.(mp4|webm)([?#]|$)/i.test(preview), value) : undefined;
}

function gif(value: Record<string, unknown>, url: string, preview: string, video: boolean, size: Record<string, unknown>): FluxerGif {
  return { id: String(value.id), url, preview, video, width: dimension(size.width), height: dimension(size.height), title: str(value.title) };
}

/** A link preview that is itself a picture, a GIF or a video. */
export interface FluxerMediaEmbed {
  kind: "image" | "gifv" | "video";
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
}

/** A link preview with words: an article, a site's card, or a rich embed a bot made. */
export interface FluxerLinkEmbed {
  url?: string;
  site?: string;
  title?: string;
  description?: string;
  /** "#rrggbb". */
  color?: string;
  /** Its picture, through the instance's media proxy only. */
  image?: { url: string; width?: number; height?: number; thumbnail: boolean };
}

export interface FluxerMessage {
  id: string;
  channelId: string;
  author: FluxerUser;
  content: string;
  timestamp: string;
  edited: boolean;
  mentionIds: string[];
  mentionEveryone: boolean;
  attachments: FluxerAttachment[];
  stickers: FluxerSticker[];
  embeds: FluxerMediaEmbed[];
  links: FluxerLinkEmbed[];
  /** 0 DEFAULT, 19 REPLY; only these can be edited. */
  type?: number;
  /** The message this one replies to; null when it no longer exists. */
  replyTo?: FluxerReplyPreview | null;
  reactions?: FluxerReaction[];
  pinned?: boolean;
  /** A forwarded message's copy of the original (message_snapshots): its text and files; who wrote it is not said. */
  forwarded?: { content: string; attachments: FluxerAttachment[] };
}

export interface FluxerReplyPreview {
  id: string;
  author: FluxerUser;
  content: string;
}

export interface FluxerEmoji {
  id?: string; // custom emoji only
  name: string;
}

export interface FluxerReaction {
  emoji: FluxerEmoji;
  count: number;
  me: boolean;
}

export const MessageType = { Default: 0, Reply: 19 } as const;

export interface FluxerGuildEmoji {
  id: string;
  name: string;
  animated: boolean;
}

/**
 * Fluxer's own user object (READY, USER_UPDATE) carries `traits`, with
 * "premium" while the account's premium (Plutonium) is active.
 */
export function parseTraits(user: unknown): string[] {
  return isRecord(user) ? list(user.traits).filter((t): t is string => typeof t === "string" && t !== "") : [];
}

export function parseGuildEmoji(value: unknown): FluxerGuildEmoji | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== "string" || value.name === "") return undefined;
  return { id: value.id, name: value.name, animated: value.animated === true };
}

export function parseEmoji(value: unknown): FluxerEmoji | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") return undefined;
  return isId(value.id) ? { id: value.id, name: value.name } : { name: value.name };
}

/** The path form of an emoji: the Unicode character, or name:id for custom emoji. */
export function emojiKey(emoji: FluxerEmoji): string {
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

export interface FluxerReadState {
  channelId: string;
  lastMessageId?: string;
  mentionCount: number;
}

export interface FluxerFolder {
  id?: string; // undefined for the uncategorised slot (id -1 or null)
  name?: string;
  color?: string;
  guildIds: string[];
}

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Snowflakes compare by value, not as strings. */
export function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function parseUser(value: unknown): FluxerUser | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.username !== "string") return undefined;
  return { id: value.id, username: value.username, globalName: str(value.global_name), avatar: str(value.avatar) };
}

/** Accepts both a plain guild and a READY / GUILD_CREATE object that nests the guild in `properties`. */
export function parseGuild(value: unknown): FluxerGuild | undefined {
  if (!isRecord(value) || !isId(value.id) || value.unavailable === true) return undefined;
  const source = isRecord(value.properties) ? { ...value.properties, id: value.id } : value;
  if (typeof source.name !== "string") return undefined;
  return { id: value.id, name: source.name, icon: str(source.icon) };
}

export function parseChannel(value: unknown, guildId?: string): FluxerChannel | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.type !== "number") return undefined;
  const ownGuild = isId(value.guild_id) ? value.guild_id : guildId;
  return {
    id: value.id,
    type: value.type,
    guildId: ownGuild,
    name: str(value.name),
    position: typeof value.position === "number" ? value.position : 0,
    parentId: isId(value.parent_id) ? value.parent_id : undefined,
    lastMessageId: isId(value.last_message_id) ? value.last_message_id : undefined,
    recipients: list(value.recipients).flatMap((r) => parseUser(r) ?? []),
    icon: str(value.icon),
    archived: isRecord(value.thread_metadata) ? value.thread_metadata.archived === true : undefined,
    messageCount: typeof value.message_count === "number" ? value.message_count : undefined,
  };
}

export function parseMessage(value: unknown): FluxerMessage | undefined {
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
    mentionIds: list(value.mentions).flatMap((m) => (isRecord(m) && isId(m.id) ? [m.id] : [])),
    mentionEveryone: value.mention_everyone === true,
    attachments: parseAttachments(value.attachments),
    stickers: list(value.sticker_items ?? value.stickers).flatMap((s) =>
      isRecord(s) && isId(s.id) && typeof s.name === "string" ? [{ id: s.id, name: s.name.slice(0, 100), format: typeof s.format_type === "number" ? s.format_type : 1, animated: s.animated === true }] : [],
    ),
    embeds: list(value.embeds).flatMap((e) => {
      const embed = isRecord(e) ? parseMediaEmbed(e) : undefined;
      return embed ? [embed] : [];
    }),
    links: list(value.embeds).flatMap((e) => {
      const embed = isRecord(e) ? parseLinkEmbed(e) : undefined;
      return embed ? [embed] : [];
    }),
    type: typeof value.type === "number" ? value.type : undefined,
    replyTo: parseReplyTo(value),
    reactions: list(value.reactions).flatMap((r) => {
      const emoji = isRecord(r) ? parseEmoji(r.emoji) : undefined;
      const count = isRecord(r) && typeof r.count === "number" && r.count > 0 ? r.count : 0;
      return emoji && count ? [{ emoji, count, me: (r as Record<string, unknown>).me === true }] : [];
    }),
    ...(value.pinned === true ? { pinned: true } : {}),
    ...parseForwarded(value.message_snapshots),
  };
}

function parseAttachments(value: unknown): FluxerAttachment[] {
  return list(value).flatMap((a) =>
    isRecord(a) && isId(a.id) && typeof a.filename === "string"
      ? [{ id: a.id, filename: a.filename, contentType: str(a.content_type), url: str(a.proxy_url) ?? str(a.url), width: dimension(a.width), height: dimension(a.height), size: dimension(a.size) }]
      : [],
  );
}

/** A forward's copy of the original message: the first snapshot's text and files. */
function parseForwarded(value: unknown): Pick<FluxerMessage, "forwarded"> {
  const snapshot = list(value)[0];
  const message = isRecord(snapshot) && isRecord(snapshot.message) ? snapshot.message : undefined;
  if (!message) return {};
  return { forwarded: { content: typeof message.content === "string" ? message.content : "", attachments: parseAttachments(message.attachments) } };
}

/** A positive whole number (pixels, bytes), else undefined. */
function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Embeds that are media themselves (an image link, a GIF, a video); article previews are left out. */
function parseMediaEmbed(e: Record<string, unknown>): FluxerMediaEmbed | undefined {
  const media = (key: string): Record<string, unknown> | undefined => (isRecord(e[key]) ? (e[key] as Record<string, unknown>) : undefined);
  const source = (m: Record<string, unknown> | undefined): string | undefined => (m ? (str(m.proxy_url) ?? str(m.url)) : undefined);
  const https = (url: string | undefined): string | undefined => (url?.startsWith("https://") ? url : undefined);
  const video = media("video");
  const image = media("image") ?? media("thumbnail");
  if (e.type === "gifv" || e.type === "video") {
    const url = https(source(video));
    if (!url) return undefined;
    return { kind: e.type, url, previewUrl: https(source(media("thumbnail"))), width: dimension(video?.width), height: dimension(video?.height) };
  }
  if (e.type === "image") {
    const url = https(source(image));
    return url ? { kind: "image", url, width: dimension(image?.width), height: dimension(image?.height) } : undefined;
  }
  return undefined;
}

/**
 * Embeds with words (articles, site cards, rich embeds), the media ones being
 * left to parseMediaEmbed. Pictures come only through the instance's media
 * proxy (proxy_url), so showing one does not reach the linked site.
 */
function parseLinkEmbed(e: Record<string, unknown>): FluxerLinkEmbed | undefined {
  if (e.type === "image" || e.type === "gifv" || e.type === "video") return undefined;
  const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : undefined);
  const embed: FluxerLinkEmbed = {};
  const url = httpsUrl(e.url);
  if (url) embed.url = url;
  const site = text(isRecord(e.provider) ? e.provider.name : undefined, 100) ?? text(isRecord(e.author) ? e.author.name : undefined, 100);
  if (site) embed.site = site;
  const title = text(e.title, 256);
  if (title) embed.title = title;
  const description = text(e.description, 1000);
  if (description) embed.description = description;
  if (typeof e.color === "number" && Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff) embed.color = `#${e.color.toString(16).padStart(6, "0")}`;
  const picture = (key: string, thumbnail: boolean): FluxerLinkEmbed["image"] => {
    const media = isRecord(e[key]) ? (e[key] as Record<string, unknown>) : {};
    const proxied = httpsUrl(media.proxy_url);
    return proxied ? { url: proxied, width: dimension(media.width), height: dimension(media.height), thumbnail } : undefined;
  };
  const image = picture("image", false) ?? picture("thumbnail", true);
  if (image) embed.image = image;
  return title || description || image ? embed : undefined;
}

/** referenced_message: absent for non-replies, null when the original is gone (per the docs). */
function parseReplyTo(value: Record<string, unknown>): FluxerReplyPreview | null | undefined {
  if (!("referenced_message" in value)) return undefined;
  const ref = value.referenced_message;
  const author = isRecord(ref) ? parseUser(ref.author) : undefined;
  if (!isRecord(ref) || !isId(ref.id) || !author) return null;
  return { id: ref.id, author, content: typeof ref.content === "string" ? ref.content : "" };
}

export function parseReadState(value: unknown): FluxerReadState | undefined {
  if (!isRecord(value)) return undefined;
  const channelId = isId(value.channel_id) ? value.channel_id : isId(value.id) ? value.id : undefined;
  if (!channelId) return undefined;
  const mentions = value.mention_count;
  return {
    channelId,
    lastMessageId: isId(value.last_message_id) ? value.last_message_id : isId(value.message_id) ? value.message_id : undefined,
    mentionCount: typeof mentions === "number" && Number.isInteger(mentions) && mentions >= 0 ? mentions : 0,
  };
}

export function parseFolders(settings: unknown): FluxerFolder[] | undefined {
  if (!isRecord(settings) || !Array.isArray(settings.guild_folders)) return undefined;
  return settings.guild_folders.flatMap((f): FluxerFolder[] => {
    if (!isRecord(f)) return [];
    const id = typeof f.id === "number" && f.id >= 0 ? String(f.id) : isId(f.id) ? f.id : undefined;
    const color =
      typeof f.color === "number" && Number.isInteger(f.color) && f.color >= 0 && f.color <= 0xffffff
        ? `#${f.color.toString(16).padStart(6, "0")}`
        : undefined;
    return [{ id, name: str(f.name), color, guildIds: list(f.guild_ids).filter(isId) }];
  });
}

/** Display name: global name, else username. */
export function displayName(user: FluxerUser): string {
  return user.globalName ?? user.username;
}

/** Someone's connection to a voice channel; one user may have several. */
export interface FluxerVoiceState {
  guildId?: string;
  channelId?: string; // undefined: the connection left
  userId: string;
  connectionId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  selfVideo: boolean;
  selfStream: boolean;
}

export function parseVoiceState(value: unknown, guildId?: string): FluxerVoiceState | undefined {
  if (!isRecord(value) || !isId(value.user_id)) return undefined;
  const connectionId = typeof value.connection_id === "string" && value.connection_id !== "" ? value.connection_id : value.user_id;
  return {
    guildId: isId(value.guild_id) ? value.guild_id : guildId,
    channelId: isId(value.channel_id) ? value.channel_id : undefined,
    userId: value.user_id,
    connectionId,
    selfMute: value.self_mute === true,
    selfDeaf: value.self_deaf === true,
    selfVideo: value.self_video === true,
    selfStream: value.self_stream === true,
  };
}

/** message_notifications levels; Inherit defers to the next level up. */
export const NotifyLevel = { All: 0, Mentions: 1, None: 2, Inherit: 3 } as const;

export interface FluxerNotifySettings {
  level?: number;
  /** Muted until this epoch ms; Infinity for an open-ended mute. */
  mutedUntil?: number;
  suppressEveryone: boolean;
  channels: Map<string, { level?: number; mutedUntil?: number }>;
}

/** Key for DM settings, which Fluxer files under guild id null, 0 or "@me". */
export const DM_SETTINGS = "@me";

function mutedUntil(muted: unknown, config: unknown): number | undefined {
  if (muted !== true) return undefined;
  const end = isRecord(config) && typeof config.end_time === "string" ? Date.parse(config.end_time) : NaN;
  return Number.isNaN(end) ? Infinity : end;
}

const level = (value: unknown): number | undefined =>
  typeof value === "number" && value >= NotifyLevel.All && value <= NotifyLevel.Inherit ? value : undefined;

/** Parses one user guild settings object; returns its guild key and settings. */
export function parseGuildSettings(value: unknown): [string, FluxerNotifySettings] | undefined {
  if (!isRecord(value)) return undefined;
  const key = isId(value.guild_id) && value.guild_id !== "0" ? value.guild_id : DM_SETTINGS;
  const channels = new Map<string, { level?: number; mutedUntil?: number }>();
  if (isRecord(value.channel_overrides)) {
    for (const [id, o] of Object.entries(value.channel_overrides)) {
      if (isId(id) && isRecord(o)) channels.set(id, { level: level(o.message_notifications), mutedUntil: mutedUntil(o.muted, o.mute_config) });
    }
  }
  return [
    key,
    {
      level: level(value.message_notifications),
      mutedUntil: mutedUntil(value.muted, value.mute_config),
      suppressEveryone: value.suppress_everyone === true,
      channels,
    },
  ];
}
