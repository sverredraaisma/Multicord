// Protocol between a module engine and the shell. A native module's logic
// runs in an engine: a hidden, sandboxed renderer with its own in-memory
// session and no Node access. It reaches the shell only through these
// messages, every one validated in the main process, so a module can see
// nothing of the shell or of other modules beyond what is handed to it.

import type { HealthCheck, HomeBadge, IncomingCall, PlatformNotification } from "./adapter";
import { isHttpsUrl } from "./ipc";
import { isServiceSettingStatus, isServiceSettingValues, isSettingKey, type AccountStatus, type ServiceSettingStatus, type ServiceSettingValues } from "./settings";

export const ENGINE_IPC = {
  /** Engine -> main: rail data, notifications, account state (EngineEvent). */
  event: "engine:event",
  /** Engine -> main -> the module's own view: display state. */
  render: "engine:render",
  /** Engine -> main, request/response (EngineRequest). */
  invoke: "engine:invoke",
  /** Main -> engine: shell commands (EngineCommand). */
  command: "engine:command",
  /** Main -> engine: a user action from the module's own view. */
  action: "engine:action",
} as const;

/** The scheme engine pages are served from: a standard, secure origin per module. */
export const ENGINE_SCHEME = "multicord-engine";

/** What an engine learns about itself. */
export interface EngineInfo {
  /** Instance id, e.g. "fluxer" or "fluxer-2". */
  id: string;
  name: string;
  url: string;
  /** The OS, as Node names it, for platform-specific behaviour. */
  os: string;
  /**
   * For a module that declares settings: this instance's values, each one
   * checked against its field. Changes come as a "settings" command.
   */
  settings?: ServiceSettingValues;
}

export interface EngineServer {
  key: string;
  name: string;
  iconUrl?: string;
  unread: boolean;
  mentions: number;
  kind?: "server" | "group";
  /** Groups only; their children are plain servers. */
  children?: EngineServer[];
  expanded?: boolean;
  color?: string;
  previewIconUrls?: string[];
}

export interface EngineDirect {
  key: string;
  title: string;
  avatarUrl?: string;
  lastActivity: number;
  preview?: string;
  unread: boolean;
  mentions: number;
}

export type EngineEvent =
  | { type: "servers"; servers: EngineServer[] }
  | { type: "directs"; directs: EngineDirect[] }
  | { type: "notification"; notification: PlatformNotification }
  | { type: "call"; call: IncomingCall }
  | { type: "account"; account: AccountStatus }
  | { type: "homeBadge"; badge: HomeBadge }
  /** What Settings shows with the module's declared settings; only declared keys are shown. */
  | { type: "settingsStatus"; status: ServiceSettingStatus }
  /** The module's own checks of its service (e.g. that its servers answer), shown in Settings > Diagnostics after the engine's. */
  | { type: "health"; checks: HealthCheck[] };

export type EngineCommand =
  | { type: "openHome" }
  | { type: "openServer"; key: string }
  | { type: "openConversation"; key: string }
  | { type: "toggleGroup"; key: string }
  | { type: "visible"; visible: boolean }
  | { type: "signOut" }
  /** The instance's values for the module's declared settings changed. */
  | { type: "settings"; values: ServiceSettingValues }
  /** The user pressed one of the module's declared action buttons for this instance. */
  | { type: "settingAction"; key: string };

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A file the user picked; the engine reads it in ranges through its handle. */
export interface PickedFile {
  handle: string;
  name: string;
  size: number;
  type: string;
}

export type EngineRequest =
  | { type: "info" }
  | { type: "secretLoad"; key: string }
  | { type: "secretSave"; key: string; value: string }
  | { type: "secretDelete"; key: string }
  | { type: "http"; request: HttpRequest }
  | { type: "pickFiles" }
  | { type: "readFile"; handle: string; start: number; end: number }
  /** From now on reach only these hosts ("example.com" or "*.example.com"); a lock can only narrow. */
  | { type: "lockHosts"; hosts: string[] }
  /**
   * Single sign-on (Matrix's m.login.sso): the shell opens this homeserver
   * SSO redirect address in the browser with a loopback redirectUrl of its
   * own, and answers with the one login token that comes back. Only right
   * after the user submitted a sign-in step in the module's view.
   */
  | { type: "ssoSignIn"; url: string };

/** Hosts an engine may lock itself to at once. */
export const MAX_LOCKED_HOSTS = 16;
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))+$/;

export const MAX_SERVERS = 1000;
export const MAX_DIRECTS = 500;
export const MAX_KEY = 200;
export const MAX_TEXT = 200;
export const MAX_BODY_TEXT = 2000;
/** Most checks an engine reports of its service, and the longest name and detail of one. */
export const MAX_HEALTH_CHECKS = 8;
export const MAX_HEALTH_NAME = 80;
export const MAX_HEALTH_DETAIL = 300;
/** Largest data: image URL accepted for icons and avatars. */
export const MAX_DATA_IMAGE = 200_000;
export const MAX_SECRET = 16_384;
export const MAX_HTTP_BODY = 50 * 1024 * 1024;
export const MAX_READ = 16 * 1024 * 1024;
const MAX_HEADERS = 50;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const COLOR = /^#[0-9a-f]{6}$/i;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown, max: number, min = 0): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isOptional = <T>(value: unknown, check: (v: unknown) => v is T): boolean => value === undefined || check(value);

/** An icon or avatar: an https URL, or a small inline raster image. */
export function isImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.startsWith("data:")) return value.length <= MAX_DATA_IMAGE && DATA_IMAGE.test(value);
  return value.length <= 2000 && isHttpsUrl(value);
}

function isServer(value: unknown, depth = 0): value is EngineServer {
  if (!isRecord(value)) return false;
  const { key, name, iconUrl, unread, mentions, kind, children, expanded, color, previewIconUrls } = value;
  return (
    isText(key, MAX_KEY, 1) &&
    isText(name, MAX_TEXT) &&
    isOptional(iconUrl, isImageUrl) &&
    typeof unread === "boolean" &&
    isCount(mentions) &&
    (kind === undefined || kind === "server" || kind === "group") &&
    (children === undefined ||
      (depth === 0 && kind === "group" && Array.isArray(children) && children.length <= MAX_SERVERS && children.every((c) => isServer(c, 1) && c.kind !== "group"))) &&
    (expanded === undefined || typeof expanded === "boolean") &&
    (color === undefined || (typeof color === "string" && COLOR.test(color))) &&
    (previewIconUrls === undefined || (Array.isArray(previewIconUrls) && previewIconUrls.length <= 4 && previewIconUrls.every(isImageUrl)))
  );
}

function isDirect(value: unknown): value is EngineDirect {
  if (!isRecord(value)) return false;
  const { key, title, avatarUrl, lastActivity, preview, unread, mentions } = value;
  return (
    isText(key, MAX_KEY, 1) &&
    isText(title, MAX_TEXT) &&
    isOptional(avatarUrl, isImageUrl) &&
    isCount(lastActivity) &&
    (preview === undefined || isText(preview, MAX_BODY_TEXT)) &&
    typeof unread === "boolean" &&
    isCount(mentions)
  );
}

function isAccount(value: unknown): value is AccountStatus {
  return (
    isRecord(value) &&
    (value.state === "signed-in" || value.state === "signed-out" || value.state === "unknown") &&
    (value.name === undefined || isText(value.name, MAX_TEXT))
  );
}

export function isEngineEvent(value: unknown): value is EngineEvent {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "servers":
      return Array.isArray(value.servers) && value.servers.length <= MAX_SERVERS && value.servers.every((s) => isServer(s));
    case "directs":
      return Array.isArray(value.directs) && value.directs.length <= MAX_DIRECTS && value.directs.every(isDirect);
    case "notification": {
      const n = value.notification;
      return (
        isRecord(n) &&
        isText(n.title, MAX_TEXT) &&
        isText(n.body, MAX_BODY_TEXT) &&
        isText(n.target, MAX_KEY, 1) &&
        (n.railKey === undefined || isText(n.railKey, MAX_KEY, 1)) &&
        (n.inView === undefined || typeof n.inView === "boolean")
      );
    }
    case "call": {
      const c = value.call;
      return isRecord(c) && isText(c.conversationKey, MAX_KEY, 1) && isText(c.from, MAX_TEXT) && typeof c.video === "boolean";
    }
    case "account":
      return isAccount(value.account);
    case "homeBadge":
      return isRecord(value.badge) && typeof value.badge.unread === "boolean" && isCount(value.badge.mentions);
    case "settingsStatus":
      return isServiceSettingStatus(value.status);
    case "health":
      return (
        Array.isArray(value.checks) &&
        value.checks.length <= MAX_HEALTH_CHECKS &&
        value.checks.every((c) => isRecord(c) && isText(c.name, MAX_HEALTH_NAME, 1) && typeof c.ok === "boolean" && (c.detail === undefined || isText(c.detail, MAX_HEALTH_DETAIL)))
      );
    default:
      return false;
  }
}

export function isEngineCommand(value: unknown): value is EngineCommand {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "openHome":
    case "signOut":
      return true;
    case "openServer":
    case "openConversation":
    case "toggleGroup":
      return isText(value.key, MAX_KEY, 1);
    case "visible":
      return typeof value.visible === "boolean";
    case "settings":
      return isServiceSettingValues(value.values);
    case "settingAction":
      return isSettingKey(value.key);
    default:
      return false;
  }
}

function isHeaders(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_HEADERS && entries.every(([name, v]) => HEADER_NAME.test(name) && isText(v, 8192));
}

export function isHttpRequest(value: unknown): value is HttpRequest {
  if (!isRecord(value)) return false;
  const { url, method, headers, body } = value;
  return (
    isText(url, 8192, 1) &&
    typeof method === "string" &&
    METHODS.has(method) &&
    isHeaders(headers) &&
    (body === undefined ||
      (typeof body === "string" && body.length <= MAX_HTTP_BODY) ||
      (body instanceof Uint8Array && body.byteLength <= MAX_HTTP_BODY))
  );
}

export function isEngineRequest(value: unknown): value is EngineRequest {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "info":
    case "pickFiles":
      return true;
    case "secretLoad":
    case "secretDelete":
      return isText(value.key, MAX_KEY, 1);
    case "secretSave":
      return isText(value.key, MAX_KEY, 1) && isText(value.value, MAX_SECRET);
    case "http":
      return isHttpRequest(value.request);
    case "ssoSignIn":
      return isText(value.url, 2048, 1);
    case "lockHosts":
      return (
        Array.isArray(value.hosts) &&
        value.hosts.length >= 1 &&
        value.hosts.length <= MAX_LOCKED_HOSTS &&
        value.hosts.every((h) => typeof h === "string" && h.length <= 253 && HOST_PATTERN.test(h))
      );
    case "readFile":
      return (
        isText(value.handle, 64, 1) &&
        isCount(value.start) &&
        isCount(value.end) &&
        value.end >= value.start &&
        value.end - value.start <= MAX_READ
      );
    default:
      return false;
  }
}
