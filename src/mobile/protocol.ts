// The shell bridge on a phone: what the shell page (src/core with the mobile
// glue) and native code say to each other. Native code checks every command
// with its port of isShellCommand (mobile/android, ShellCommands.kt); the page
// checks every event with isNativeEvent. tests/fixtures/shell-bridge-cases.json
// holds the cases both sides run.
import { PLATFORM_ID } from "../core/platforms";
import { isEngineCommand, isEngineEvent, MAX_BODY_TEXT, MAX_KEY, MAX_TEXT, type EngineCommand, type EngineEvent } from "../shared/engine";
import { isServiceSettingValues, type ServiceSettingValues } from "../shared/settings";

/** The files native code keeps for the shell page, in app-private storage. */
export const SHELL_FILES = ["settings", "platforms", "order"] as const;
export type ShellFile = (typeof SHELL_FILES)[number];
/** The most a shell file may hold, in UTF-16 code units. */
export const MAX_FILE = 1024 * 1024;
/** The most text the diagnostics report may put on the clipboard. */
export const MAX_COPY = 65_536;
/** The longest service name (core/platforms MAX_NAME) and address. */
export const MAX_NAME = 64;
export const MAX_URL = 2048;
/** The highest launcher badge count. */
export const MAX_BADGE = 1_000_000;
/** How long an engine's last exit reason may be. */
export const MAX_EXIT = 200;

/** What native code answers the page's boot request with. */
export interface BootInfo {
  /** Each file's text, when there is one. */
  files: Partial<Record<ShellFile, string>>;
  version: string;
  /** For the diagnostics report, e.g. "android 14 (WebView 154.0)". */
  os: string;
}

/** What the shell page sends native code. */
export type ShellCommand =
  /** Keeps one of the shell's files. */
  | { type: "save"; file: ShellFile; text: string }
  /**
   * Starts an instance: its engine, or for a web-client module its web app at
   * `url`. Native code takes the engine, its hosts and storage, and whether
   * the module is a web client, from its own module table
   * (dist/mobile/modules.json), never from the page; `settings` is what the
   * engine gets with its info.
   */
  | { type: "start"; instance: string; module: string; name: string; url: string; settings?: ServiceSettingValues }
  /** A command for an instance's engine. */
  | { type: "command"; instance: string; command: EngineCommand }
  /**
   * What is on screen: an instance's chat view under the shell's bar (null:
   * the shell page alone), and whether the page lies over it (its drawer).
   */
  | { type: "layout"; instance: string | null; overlay: boolean }
  /** An instance's chat view's limit for media that loads by itself, in bytes; null for any size. */
  | { type: "viewSettings"; instance: string; mediaAutoLoad: number | null }
  /** Shows a notification for an instance; tapping it comes back as openNotification. */
  | { type: "notify"; instance: string; title: string; body: string; target: string; railKey?: string; urgent?: boolean }
  /** The unread mention count, for the launcher badge. */
  | { type: "badge"; count: number }
  /** Stops an instance and deletes its web storage (its Profiles). */
  | { type: "clearSession"; instance: string }
  /** Deletes an instance's secrets. */
  | { type: "forgetSecrets"; instance: string }
  /** Starts an instance again (the user's Restart in Settings): its engine with a fresh crash count, or its web app reloaded; the app keeps running. */
  | { type: "restartEngine"; instance: string }
  /** Stops every engine and loads the shell page again, which starts them as its settings say. */
  | { type: "restart" }
  | { type: "copyText"; text: string }
  /** The page had nothing to go back to: native code leaves the app (engines keep running). */
  | { type: "backUnhandled" };

export type EngineState = "starting" | "running" | "stopped";

/** What native code tells the shell page. */
export type NativeEvent =
  /** An event from an instance's engine, which native code checked with isEngineEvent first. */
  | { type: "engine"; instance: string; event: EngineEvent }
  | { type: "health"; instance: string; state: EngineState; restarts: number; lastExit?: string }
  /** A web-client instance's page title changed (its unread count is read from it); clipped to MAX_TEXT. */
  | { type: "title"; instance: string; title: string }
  /** Whether the app is on screen. */
  | { type: "appVisible"; visible: boolean }
  /** The user pressed back, and the shown chat view had nothing to go back to. */
  | { type: "back" }
  /** The user tapped a notification. */
  | { type: "openNotification"; instance: string; target: string; railKey?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number, min = 0): value is string => typeof value === "string" && value.length >= min && value.length <= max;
const isCount = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const optional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);
export const isInstanceId = (value: unknown): value is string => typeof value === "string" && PLATFORM_ID.test(value);
const isFile = (value: unknown): value is ShellFile => (SHELL_FILES as readonly unknown[]).includes(value);
const isHttpsAddress = (value: unknown): boolean => {
  if (!isText(value, MAX_URL, 1)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};
/** Only the keys listed: a message carries nothing native code would ignore. */
const only = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

export function isShellCommand(value: unknown): value is ShellCommand {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "save":
      return only(value, ["type", "file", "text"]) && isFile(value.file) && isText(value.text, MAX_FILE);
    case "start":
      return (
        only(value, ["type", "instance", "module", "name", "url", "settings"]) &&
        isInstanceId(value.instance) &&
        isInstanceId(value.module) &&
        isText(value.name, MAX_NAME, 1) &&
        isHttpsAddress(value.url) &&
        optional(value.settings, isServiceSettingValues)
      );
    case "command":
      return only(value, ["type", "instance", "command"]) && isInstanceId(value.instance) && isEngineCommand(value.command);
    case "layout":
      return only(value, ["type", "instance", "overlay"]) && (value.instance === null || isInstanceId(value.instance)) && typeof value.overlay === "boolean";
    case "viewSettings":
      return only(value, ["type", "instance", "mediaAutoLoad"]) && isInstanceId(value.instance) && (value.mediaAutoLoad === null || isCount(value.mediaAutoLoad, Number.MAX_SAFE_INTEGER));
    case "notify":
      return (
        only(value, ["type", "instance", "title", "body", "target", "railKey", "urgent"]) &&
        isInstanceId(value.instance) &&
        isText(value.title, MAX_TEXT) &&
        isText(value.body, MAX_BODY_TEXT) &&
        isText(value.target, MAX_KEY, 1) &&
        optional(value.railKey, (v) => isText(v, MAX_KEY, 1)) &&
        optional(value.urgent, (v) => typeof v === "boolean")
      );
    case "badge":
      return only(value, ["type", "count"]) && isCount(value.count, MAX_BADGE);
    case "clearSession":
    case "forgetSecrets":
    case "restartEngine":
      return only(value, ["type", "instance"]) && isInstanceId(value.instance);
    case "restart":
    case "backUnhandled":
      return only(value, ["type"]);
    case "copyText":
      return only(value, ["type", "text"]) && isText(value.text, MAX_COPY);
    default:
      return false;
  }
}

export function isNativeEvent(value: unknown): value is NativeEvent {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "engine":
      return isInstanceId(value.instance) && isEngineEvent(value.event);
    case "health":
      return (
        isInstanceId(value.instance) &&
        (value.state === "starting" || value.state === "running" || value.state === "stopped") &&
        isCount(value.restarts, Number.MAX_SAFE_INTEGER) &&
        optional(value.lastExit, (v) => isText(v, MAX_EXIT))
      );
    case "title":
      return isInstanceId(value.instance) && isText(value.title, MAX_TEXT);
    case "appVisible":
      return typeof value.visible === "boolean";
    case "back":
      return true;
    case "openNotification":
      return isInstanceId(value.instance) && isText(value.target, MAX_KEY, 1) && optional(value.railKey, (v) => isText(v, MAX_KEY, 1));
    default:
      return false;
  }
}

export function isBootInfo(value: unknown): value is BootInfo {
  if (!isRecord(value) || !isRecord(value.files)) return false;
  const files = value.files;
  return Object.keys(files).every((key) => isFile(key) && isText(files[key], MAX_FILE)) && isText(value.version, MAX_TEXT) && isText(value.os, MAX_TEXT);
}

/** The bridge native code gives the shell page (mobile/android, assets/bridge/shell.js). */
export interface ShellBridge {
  /** Asks native code; only the boot request exists. */
  request(body: { type: "boot" }): Promise<unknown>;
  send(command: ShellCommand): void;
  onEvent(cb: (event: unknown) => void): void;
}
