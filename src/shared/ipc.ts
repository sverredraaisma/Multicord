// IPC channel names and payload validators. Every payload that crosses from a
// renderer into the main process is validated before use.

export const IPC = {
  discordState: "discord:state",
  discordNavigate: "discord:navigate",
  railState: "shell:rail",
  railOpen: "shell:open",
  railReady: "shell:ready",
  pickerSources: "picker:sources",
  pickerChoose: "picker:choose",
} as const;

export interface DiscordGuild {
  id: string;
  name: string;
  iconUrl?: string;
  unread: boolean;
  mentions: number;
}

export interface TitleBadge {
  unread: boolean;
  mentions: number;
}

export interface DiscordState {
  guilds: DiscordGuild[];
  badge: TitleBadge;
}

/** "home" for the DM list, or a guild snowflake. */
export type DiscordTarget = "home" | string;

export interface RailEntry {
  key: string;
  platform: string;
  kind: "home" | "server";
  name: string;
  iconUrl?: string;
  unread: boolean;
  mentions: number;
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

const MAX_GUILDS = 1000;
const SNOWFLAKE = /^\d{1,20}$/;

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
    isCount(value.mentions)
  );
}

export function isDiscordState(value: unknown): value is DiscordState {
  return (
    isRecord(value) &&
    Array.isArray(value.guilds) &&
    value.guilds.length <= MAX_GUILDS &&
    value.guilds.every(isDiscordGuild) &&
    isTitleBadge(value.badge)
  );
}

export function isDiscordTarget(value: unknown): value is DiscordTarget {
  return value === "home" || isSnowflake(value);
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
