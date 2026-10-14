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
  /** 0 DEFAULT, 19 REPLY; only these can be edited. */
  type?: number;
  /** The message this one replies to; null when it no longer exists. */
  replyTo?: FluxerReplyPreview | null;
  reactions?: FluxerReaction[];
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
    attachments: list(value.attachments).flatMap((a) =>
      isRecord(a) && isId(a.id) && typeof a.filename === "string"
        ? [{ id: a.id, filename: a.filename, contentType: str(a.content_type), url: str(a.proxy_url) ?? str(a.url) }]
        : [],
    ),
    type: typeof value.type === "number" ? value.type : undefined,
    replyTo: parseReplyTo(value),
    reactions: list(value.reactions).flatMap((r) => {
      const emoji = isRecord(r) ? parseEmoji(r.emoji) : undefined;
      const count = isRecord(r) && typeof r.count === "number" && r.count > 0 ? r.count : 0;
      return emoji && count ? [{ emoji, count, me: (r as Record<string, unknown>).me === true }] : [];
    }),
  };
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
