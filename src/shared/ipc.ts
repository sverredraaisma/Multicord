// IPC channel names and payload validators. Every payload that crosses from a
// renderer into the main process is validated before use.

export const IPC = {
  discordState: "discord:state",
  discordNavigate: "discord:navigate",
  railState: "shell:rail",
  railOpen: "shell:open",
  railReady: "shell:ready",
  railTooltip: "shell:tooltip",
  tooltipShow: "tooltip:show",
  pickerSources: "picker:sources",
  pickerChoose: "picker:choose",
} as const;

/** DOM event the main-world store bridge uses to hand store data to the preload. */
export const BRIDGE_EVENT = "multicord:stores";

export interface DiscordGuild {
  id: string;
  name: string;
  iconUrl?: string;
  unread: boolean;
  mentions: number;
  /** Set when the guild sits inside a folder; such guilds follow their folder. */
  folderId?: string;
}

/** A guild folder; it sits in the bar just before `guilds[index]`. */
export interface DiscordFolder {
  id: string;
  name: string;
  color?: string; // "#rrggbb"
  expanded: boolean;
  unread: boolean;
  mentions: number;
  iconUrls: string[]; // up to four previews for the collapsed tile
  index: number;
}

export interface TitleBadge {
  unread: boolean;
  mentions: number;
}

export interface DiscordDm {
  id: string; // channel snowflake
  title: string;
  avatarUrl?: string;
  unread: boolean;
  mentions: number;
  lastActivity: number; // epoch ms
}

/**
 * Guild details from Discord's stores. Read state is included when the store
 * offers it, which covers guilds hidden inside collapsed folders.
 */
export interface GuildInfo {
  id: string;
  name: string;
  iconUrl?: string;
  unread?: boolean;
  mentions?: number;
}

/** One slot of the guild bar from SortedGuildStore: a folder, or a lone guild without folderId. */
export interface LayoutEntry {
  folderId?: string;
  name?: string;
  color?: string;
  expanded?: boolean;
  guildIds: string[];
}

export interface BridgePayload {
  dms: DiscordDm[];
  guilds: GuildInfo[];
  /** Absent when SortedGuildStore was not found. */
  layout?: LayoutEntry[];
}

export interface DiscordState {
  guilds: DiscordGuild[];
  badge: TitleBadge;
  /** Absent until the store bridge has found Discord's stores. */
  dms?: DiscordDm[];
  folders?: DiscordFolder[];
}

/** "home", a guild snowflake, "dm:<channel snowflake>" or "folder:<folder id>" (toggles it). */
export type DiscordTarget = "home" | string;

export interface RailEntry {
  key: string;
  platform: string;
  kind: "home" | "dm" | "server" | "group";
  name: string;
  iconUrl?: string;
  unread: boolean;
  mentions: number;
  /** Groups (Discord folders) only. */
  color?: string;
  expanded?: boolean;
  previewIconUrls?: string[];
  /** Set on servers shown inside an expanded group. */
  parentKey?: string;
}

export interface RailState {
  entries: RailEntry[];
  activeKey: string | null;
}

export interface PickerSource {
  id: string;
  name: string;
  thumbnail: string; // data URL
}

export interface PickerRequest {
  sources: PickerSource[];
  audioSupported: boolean;
}

export interface PickerChoice {
  id: string;
  audio: boolean;
}

/** Hover label for a rail item; y is the item's vertical centre in rail coordinates. */
export interface TooltipRequest {
  text: string;
  y: number;
}

export const MAX_GUILDS = 1000;
export const MAX_DMS = 200;
const MAX_TEXT = 200;
const SNOWFLAKE = /^\d{1,20}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const MAX_PREVIEWS = 4;
const MAX_FOLDER_GUILDS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

export function isTitleBadge(value: unknown): value is TitleBadge {
  return isRecord(value) && typeof value.unread === "boolean" && isCount(value.mentions);
}

export function isDiscordGuild(value: unknown): value is DiscordGuild {
  return (
    isRecord(value) &&
    isSnowflake(value.id) &&
    typeof value.name === "string" &&
    (value.iconUrl === undefined || isHttpsUrl(value.iconUrl)) &&
    typeof value.unread === "boolean" &&
    isCount(value.mentions) &&
    (value.folderId === undefined || isSnowflake(value.folderId))
  );
}

function isOptionalColor(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && COLOR.test(value));
}

export function isDiscordFolder(value: unknown): value is DiscordFolder {
  return (
    isRecord(value) &&
    isSnowflake(value.id) &&
    typeof value.name === "string" &&
    value.name.length <= MAX_TEXT &&
    isOptionalColor(value.color) &&
    typeof value.expanded === "boolean" &&
    typeof value.unread === "boolean" &&
    isCount(value.mentions) &&
    Array.isArray(value.iconUrls) &&
    value.iconUrls.length <= MAX_PREVIEWS &&
    value.iconUrls.every(isHttpsUrl) &&
    isCount(value.index)
  );
}

export function isDiscordDm(value: unknown): value is DiscordDm {
  return (
    isRecord(value) &&
    isSnowflake(value.id) &&
    typeof value.title === "string" &&
    value.title.length <= MAX_TEXT &&
    (value.avatarUrl === undefined || isHttpsUrl(value.avatarUrl)) &&
    typeof value.unread === "boolean" &&
    isCount(value.mentions) &&
    isCount(value.lastActivity)
  );
}

export function isDiscordDmList(value: unknown): value is DiscordDm[] {
  return Array.isArray(value) && value.length <= MAX_DMS && value.every(isDiscordDm);
}

export function isGuildInfo(value: unknown): value is GuildInfo {
  return (
    isRecord(value) &&
    isSnowflake(value.id) &&
    typeof value.name === "string" &&
    value.name.length <= MAX_TEXT &&
    (value.iconUrl === undefined || isHttpsUrl(value.iconUrl)) &&
    (value.unread === undefined || typeof value.unread === "boolean") &&
    (value.mentions === undefined || isCount(value.mentions))
  );
}

export function isLayoutEntry(value: unknown): value is LayoutEntry {
  return (
    isRecord(value) &&
    (value.folderId === undefined || isSnowflake(value.folderId)) &&
    (value.name === undefined || (typeof value.name === "string" && value.name.length <= MAX_TEXT)) &&
    isOptionalColor(value.color) &&
    (value.expanded === undefined || typeof value.expanded === "boolean") &&
    Array.isArray(value.guildIds) &&
    value.guildIds.length <= MAX_FOLDER_GUILDS &&
    value.guildIds.every(isSnowflake)
  );
}

export function isBridgePayload(value: unknown): value is BridgePayload {
  return (
    isRecord(value) &&
    isDiscordDmList(value.dms) &&
    Array.isArray(value.guilds) &&
    value.guilds.length <= MAX_GUILDS &&
    value.guilds.every(isGuildInfo) &&
    (value.layout === undefined ||
      (Array.isArray(value.layout) && value.layout.length <= MAX_GUILDS && value.layout.every(isLayoutEntry)))
  );
}

export function isDiscordState(value: unknown): value is DiscordState {
  return (
    isRecord(value) &&
    Array.isArray(value.guilds) &&
    value.guilds.length <= MAX_GUILDS &&
    value.guilds.every(isDiscordGuild) &&
    isTitleBadge(value.badge) &&
    (value.dms === undefined || isDiscordDmList(value.dms)) &&
    (value.folders === undefined ||
      (Array.isArray(value.folders) && value.folders.length <= MAX_GUILDS && value.folders.every(isDiscordFolder)))
  );
}

export function isDiscordTarget(value: unknown): value is DiscordTarget {
  if (typeof value !== "string") return false;
  if (value.startsWith("dm:")) return isSnowflake(value.slice(3));
  if (value.startsWith("folder:")) return isSnowflake(value.slice(7));
  return value === "home" || isSnowflake(value);
}

export function isTooltipRequest(value: unknown): value is TooltipRequest | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.text === "string" &&
      value.text.length > 0 &&
      value.text.length <= MAX_TEXT &&
      typeof value.y === "number" &&
      Number.isFinite(value.y))
  );
}

export function isRailKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export function isPickerChoice(value: unknown): value is PickerChoice | null {
  return (
    value === null ||
    (isRecord(value) && typeof value.id === "string" && typeof value.audio === "boolean")
  );
}

export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Reads unread state from a page title. Discord uses "(3) Discord | ..." for
 * mentions and a leading bullet for unread; Element uses "Element [3]" and a
 * trailing asterisk.
 */
export function parseTitleBadge(title: string): TitleBadge {
  const count = /^\((\d+)\)/.exec(title) ?? /\[(\d+)\]\s*$/.exec(title);
  const mentions = count ? Number(count[1]) : 0;
  const unread = mentions > 0 || /^[•*]/.test(title) || /\*\s*$/.test(title);
  return { unread, mentions };
}
