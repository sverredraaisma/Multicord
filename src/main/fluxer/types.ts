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
} as const;

/** Channels whose messages we show; voice, forum and thread types are out of scope for now. */
export const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.Dm,
  ChannelType.GroupDm,
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
  };
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
