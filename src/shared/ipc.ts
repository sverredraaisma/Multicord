import type { ActivityUpdate } from "./adapter";
// IPC channel names and payload validators. Every payload that crosses from a
// renderer into the main process is validated before use.

export const IPC = {
  discordState: "discord:state",
  discordNavigate: "discord:navigate",
  /** Discord view -> main: a notification Discord's page wanted to show. */
  discordNotification: "discord:notification",
  /** Main -> Discord view: the user clicked that notification. */
  discordNotificationClick: "discord:notification-click",
  /** Main -> Discord view: a local app's Rich Presence activity (ActivityUpdate). */
  discordActivity: "discord:activity",
  railState: "shell:rail",
  railOpen: "shell:open",
  railReady: "shell:ready",
  railTooltip: "shell:tooltip",
  railReorder: "shell:reorder",
  /** Rail -> main: open or close the settings page. */
  railSettings: "shell:settings",
  /** Rail -> main: open or close the unified Messages page. */
  railMessages: "shell:messages",
  /** Main -> platform views: hide the platform's own sidebar beside the Messages list. */
  viewCompact: "view:compact",
  messagesState: "messages:state",
  /** Messages page -> main: open a conversation by its rail key. */
  messagesOpen: "messages:open",
  messagesReady: "messages:ready",
  tooltipShow: "tooltip:show",
  pickerSources: "picker:sources",
  pickerChoose: "picker:choose",
} as const;

/** DOM event the main-world store bridge uses to hand store data to the preload. */
export const BRIDGE_EVENT = "multicord:stores";
/** DOM events between the main-world notification relay and the preload. */
export const NOTIFY_EVENT = "multicord:notification";
export const NOTIFY_CLICK_EVENT = "multicord:notification-click";
/** DOM event carrying a Rich Presence update from the isolated preload to the page. */
export const ACTIVITY_EVENT = "multicord:activity";
const MAX_ACTIVITY_JSON = 8192;

/** A Rich Presence update as main sends it: checked already, re-checked in shape and size. */
export function isActivityUpdate(value: unknown): value is ActivityUpdate {
  if (typeof value !== "object" || value === null) return false;
  const { source, pid, activity } = value as ActivityUpdate;
  if (typeof source !== "string" || !/^rpc-\d{1,9}$/.test(source)) return false;
  if (pid !== undefined && !(Number.isInteger(pid) && pid > 0)) return false;
  if (activity === null) return true;
  if (typeof activity !== "object" || typeof activity.application_id !== "string" || !/^\d{1,20}$/.test(activity.application_id)) return false;
  return JSON.stringify(value).length <= MAX_ACTIVITY_JSON;
}

/** A notification from Discord's page, relayed to the shell. */
export interface RelayedNotification {
  id: string;
  title: string;
  body: string;
}

export function isRelayedNotification(value: unknown): value is RelayedNotification {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RelayedNotification).id === "string" &&
    /^\d{1,10}$/.test((value as RelayedNotification).id) &&
    typeof (value as RelayedNotification).title === "string" &&
    (value as RelayedNotification).title.length <= 200 &&
    typeof (value as RelayedNotification).body === "string" &&
    (value as RelayedNotification).body.length <= 2000
  );
}

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

/** The signed-in Discord user; null when Discord's client has nobody signed in. */
export interface DiscordUser {
  name: string;
}

/** A call ringing the user, in a DM or group DM. */
export interface DiscordCall {
  channelId: string;
  /** Who is calling: the DM's title. */
  from: string;
}

export const MAX_CALLS = 20;

export interface BridgePayload {
  dms: DiscordDm[];
  guilds: GuildInfo[];
  /** Absent when SortedGuildStore was not found. */
  layout?: LayoutEntry[];
  user?: DiscordUser | null;
  calls?: DiscordCall[];
  /** Names of the Discord stores the bridge found, for diagnostics. */
  stores?: string[];
}

/** How Discord's hooks are doing, for diagnostics. */
export interface DiscordHealth {
  /** The hidden guild bar the rail is read from. */
  guildBar: boolean;
  /** Stores the bridge found; absent until it reports. */
  stores?: string[];
}

export interface DiscordState {
  guilds: DiscordGuild[];
  badge: TitleBadge;
  /** Absent until the store bridge has found Discord's stores. */
  dms?: DiscordDm[];
  folders?: DiscordFolder[];
  /** Absent until the store bridge reports; null when signed out. */
  user?: DiscordUser | null;
  /** Calls ringing the user right now. */
  calls?: DiscordCall[];
  health?: DiscordHealth;
}

/**
 * "home", a guild snowflake, "dm:<channel snowflake>", "folder:<folder id>"
 * (toggles it) or "channel:<guild>/<channel>" (a channel inside a guild).
 */
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
  /** The platform module this entry comes from, for the rail's label. */
  module?: RailModule;
}

export interface RailModule {
  label: string;
  color: string;
}

export interface RailState {
  entries: RailEntry[];
  activeKey: string | null;
  /** Servers are grouped per platform rather than in one mixed order. */
  grouped?: boolean;
  /** The settings page is showing instead of a platform. */
  settingsOpen?: boolean;
  /** The unified Messages page is showing. */
  messagesOpen?: boolean;
  /** Unread direct messages across every platform. */
  messagesBadge?: { unread: boolean; mentions: number };
}

/** A direct conversation in the unified Messages list. */
export interface Conversation {
  /** Rail key, e.g. "discord:dm:123"; opening it routes to the platform. */
  key: string;
  platform: string;
  title: string;
  avatarUrl?: string;
  /** Last message text, where the platform provides it. */
  preview?: string;
  /** Epoch ms of the last message. */
  lastActivity: number;
  unread: boolean;
  mentions: number;
  module?: RailModule;
}

export interface MessagesState {
  conversations: Conversation[];
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

export function isDiscordUser(value: unknown): value is DiscordUser | null | undefined {
  return value === undefined || value === null || (isRecord(value) && typeof value.name === "string" && value.name.length <= MAX_TEXT);
}

export function isDiscordCallList(value: unknown): value is DiscordCall[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_CALLS &&
      value.every((c) => isRecord(c) && isSnowflake(c.channelId) && typeof c.from === "string" && c.from.length <= MAX_TEXT))
  );
}

const STORE_NAME = /^[A-Za-z]{1,40}$/;
const isStoreList = (value: unknown): value is string[] | undefined =>
  value === undefined || (Array.isArray(value) && value.length <= 20 && value.every((s) => typeof s === "string" && STORE_NAME.test(s)));

export function isBridgePayload(value: unknown): value is BridgePayload {
  return (
    isRecord(value) &&
    isDiscordUser(value.user) &&
    isDiscordCallList(value.calls) &&
    isStoreList(value.stores) &&
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
    isDiscordUser(value.user) &&
    isDiscordCallList(value.calls) &&
    (value.health === undefined || (isRecord(value.health) && typeof value.health.guildBar === "boolean" && isStoreList(value.health.stores))) &&
    (value.dms === undefined || isDiscordDmList(value.dms)) &&
    (value.folders === undefined ||
      (Array.isArray(value.folders) && value.folders.length <= MAX_GUILDS && value.folders.every(isDiscordFolder)))
  );
}

export function isDiscordTarget(value: unknown): value is DiscordTarget {
  if (typeof value !== "string") return false;
  if (value.startsWith("dm:")) return isSnowflake(value.slice(3));
  if (value.startsWith("folder:")) return isSnowflake(value.slice(7));
  if (value.startsWith("channel:")) {
    const [guild, channel, ...rest] = value.slice(8).split("/");
    return rest.length === 0 && isSnowflake(guild) && isSnowflake(channel);
  }
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

export const MAX_RAIL_ORDER = 5000;

/** A user-chosen order of top-level rail keys. */
export function isRailOrder(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_RAIL_ORDER && value.every(isRailKey);
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
