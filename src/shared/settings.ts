import type { FavouritesSummary } from "./favourites";

// App settings, the services list shown in the settings page, and the
// settings page's actions. Everything the page sends is validated here
// before the main process uses it.

export const SETTINGS_IPC = {
  state: "settings:state",
  action: "settings:action",
  ready: "settings:ready",
  /** Main -> native views: the voice settings to use for calls. */
  voice: "settings:voice",
  /** Main -> native views: a voice shortcut was pressed, or the background push-to-talk key went down or up (VoiceCommand). */
  voiceCommand: "settings:voice-command",
  /** Main -> native views of modules that hold media back: that service's limit for media that loads by itself, in bytes. */
  mediaAutoLoad: "settings:media-auto-load",
} as const;

/** A limit in bytes as a view takes it: 0 or more, Infinity for any size. */
export const isAutoLoadLimit = (value: unknown): value is number => typeof value === "number" && value >= 0;

/**
 * A chosen media device. Chromium salts device ids per site, so a view other
 * than the settings page may see different ids; the label is the fallback.
 */
export interface DeviceChoice {
  id: string;
  label: string;
}

export interface VoiceSettings {
  /** Absent: the system default. */
  input?: DeviceChoice;
  output?: DeviceChoice;
  camera?: DeviceChoice;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** RNNoise on the microphone in Multicord's own calls, on top of the browser's processing. */
  enhancedNoiseSuppression: boolean;
  /** Hold this key (a KeyboardEvent code) to talk; absent: voice activity. */
  pushToTalk?: string;
  /** The push-to-talk key works while Multicord is in the background too (a keyboard hook). */
  pushToTalkGlobal: boolean;
}

/** What main tells native views about voice keys pressed while Multicord may be in the background. */
export type VoiceCommand = "toggleMute" | "toggleDeafen" | "talkStart" | "talkStop";

export function isVoiceCommand(value: unknown): value is VoiceCommand {
  return value === "toggleMute" || value === "toggleDeafen" || value === "talkStart" || value === "talkStop";
}

/** A push-to-talk key, as KeyboardEvent.code names it, e.g. "Backquote" or "F13". */
export function isPushToTalkKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{1,24}$/.test(value);
}

export interface GeneralSettings {
  /** Closing the window keeps Multicord running in the tray. */
  closeToTray: boolean;
  launchAtLogin: boolean;
  notifications: boolean;
  spellcheck: boolean;
  /** Servers of all services in one order ("mixed"), or grouped per service. */
  railGrouping: "mixed" | "platform";
  /** Zoom of the content area, one of ZOOM_LEVELS. */
  zoom: number;
  /** Hide message content in notifications and previews: always, never, or while streaming software runs. */
  streamerMode: "auto" | "on" | "off";
  /** Open app links (e.g. discord://) in Multicord; off by default, as an installed app may want them. */
  openLinks: boolean;
  /** Check for, download and install updates by itself. */
  autoUpdate: boolean;
  /** Show games' and apps' Rich Presence on Discord, through a local Discord IPC server. */
  richPresence: boolean;
  /** Media a native view fetches on request loads by itself up to this size; services may choose their own. */
  mediaAutoLoad: MediaAutoLoad;
  /** Native modules tell others while the user types; services may choose their own. */
  typingIndicators: boolean;
}

/** How much held-back media loads by itself: nothing, up to a size, or anything. */
export const MEDIA_AUTO_LOAD = ["off", "1mb", "5mb", "10mb", "25mb", "all"] as const;
export type MediaAutoLoad = (typeof MEDIA_AUTO_LOAD)[number];
export const isMediaAutoLoad = (value: unknown): value is MediaAutoLoad => (MEDIA_AUTO_LOAD as readonly unknown[]).includes(value);

const MB = 1024 * 1024;
const AUTO_LOAD_BYTES: Record<MediaAutoLoad, number> = { off: 0, "1mb": MB, "5mb": 5 * MB, "10mb": 10 * MB, "25mb": 25 * MB, all: Number.POSITIVE_INFINITY };

/** Where updating stands; development runs cannot update. */
export type UpdateStatus =
  | { state: "unavailable" }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "none" }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

/** Zoom steps, as browsers offer them. */
export const ZOOM_LEVELS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

/** The next zoom step up (+1) or down (-1) from the current one. */
/**
 * The zoom shortcut a key press means: Ctrl/Cmd with +/= zooms in, with -
 * zooms out, with 0 resets (returned as 0).
 */
export function zoomShortcut(input: { type: string; control: boolean; meta: boolean; key: string }): 1 | -1 | 0 | undefined {
  if (input.type !== "keyDown" || !(input.control || input.meta)) return undefined;
  if (input.key === "=" || input.key === "+") return 1;
  if (input.key === "-" || input.key === "_") return -1;
  return input.key === "0" ? 0 : undefined;
}

export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_LEVELS.find((level) => level > zoom) ?? ZOOM_LEVELS.at(-1)!;
  return [...ZOOM_LEVELS].reverse().find((level) => level < zoom) ?? ZOOM_LEVELS[0];
}

/** System-wide keyboard shortcuts (Electron accelerators); null when unset. */
export interface ShortcutSettings {
  toggleMute: string | null;
  toggleDeafen: string | null;
  /** Shows Multicord, or hides it when it is in front. */
  showApp: string | null;
}

export type ShortcutAction = keyof ShortcutSettings;

/** Settings for one service (platform instance), by its id. */
export interface ServiceSettings {
  /** Desktop notifications from this service; the general switch still applies. */
  notifications: boolean;
  /** Its own limit for media that loads by itself; absent: the general one. */
  mediaAutoLoad?: MediaAutoLoad;
  /** Its own choice of sending typing indicators, where its module sends them (ModuleManifest.sendsTyping); absent: the general one. */
  typing?: boolean;
  /**
   * Values for the settings its module declares (ModuleManifest.settings).
   * Stored loosely; serviceSettingValues() checks them against the fields.
   */
  options?: ServiceSettingValues;
}

// --- Settings a module declares for its services -----------------------------

/**
 * A setting a module declares for each of its services. Settings > Services
 * shows it under the service; the module gets the values (not actions)
 * through serviceSettingValues(), and only its own service's.
 */
export type ServiceSettingField =
  | { kind: "toggle"; key: string; label: string; hint?: string; default: boolean }
  | { kind: "choice"; key: string; label: string; hint?: string; options: { value: string; label: string }[]; default: string }
  /** A button that has the running service do something once, e.g. forget what it learned. With `confirm`, it asks for a second click. */
  | { kind: "action"; key: string; label: string; hint?: string; confirm?: string };

/** A service's values for its module's toggles and choices, by field key. */
export type ServiceSettingValues = Record<string, boolean | string>;

/** What a running service says about its fields now, by key: a line of text, and whether an action has nothing to do. */
export type ServiceSettingStatus = Record<string, { text?: string; disabled?: boolean }>;

/**
 * The key under which a module that sends typing indicators gets the
 * service's choice in its values, beside its own fields. The shell sets it,
 * so no module may declare a field of that name.
 */
export const TYPING_SETTING = "typing";

/** Fields a module may declare, and so values and statuses a service may have. */
export const MAX_SERVICE_FIELDS = 16;
export const MAX_STATUS_TEXT = 500;
const FIELD_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const CHOICE_VALUE = /^[a-z0-9-]{1,32}$/;

export const isSettingKey = (value: unknown): value is string => typeof value === "string" && FIELD_KEY.test(value);
const isSettingValue = (value: unknown): value is boolean | string => typeof value === "boolean" || (typeof value === "string" && CHOICE_VALUE.test(value));

/** Values as a patch or an engine command may carry them: known shapes only, not yet checked against any module's fields. */
export function isServiceSettingValues(value: unknown): value is ServiceSettingValues {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_SERVICE_FIELDS && entries.every(([key, v]) => isSettingKey(key) && isSettingValue(v));
}

/** Whether a field accepts a value: a boolean for a toggle, one of its options for a choice; actions take none. */
function accepts(field: ServiceSettingField, value: unknown): value is boolean | string {
  if (field.kind === "toggle") return typeof value === "boolean";
  return field.kind === "choice" && field.options.some((option) => option.value === value);
}

/** Each toggle and choice with its stored value, or its default when the stored one is missing or does not fit. */
export function serviceSettingValues(fields: readonly ServiceSettingField[] | undefined, stored: ServiceSettingValues | undefined): ServiceSettingValues {
  const values: ServiceSettingValues = {};
  for (const field of fields ?? []) {
    if (field.kind === "action") continue;
    const value = stored && Object.hasOwn(stored, field.key) ? stored[field.key] : undefined;
    values[field.key] = accepts(field, value) ? value : field.default;
  }
  return values;
}

/** Whether every value in a patch names a toggle or choice of these fields and fits it. */
export function fitsServiceFields(fields: readonly ServiceSettingField[] | undefined, values: ServiceSettingValues): boolean {
  return Object.entries(values).every(([key, value]) => {
    const field = fields?.find((f) => f.key === key);
    return field !== undefined && accepts(field, value);
  });
}

const isLabel = (value: unknown, max = 80): value is string => isText(value, max) && value.trim() !== "";

/** A well-formed field list, as a manifest must declare it (tested for every module). */
export function isServiceSettingFields(value: unknown): value is ServiceSettingField[] {
  if (!Array.isArray(value) || value.length > MAX_SERVICE_FIELDS) return false;
  const keys = new Set<string>();
  return value.every((field: unknown) => {
    if (!isRecord(field) || !isSettingKey(field.key) || field.key === TYPING_SETTING || keys.has(field.key) || !isLabel(field.label) || !(field.hint === undefined || isLabel(field.hint, 300))) return false;
    keys.add(field.key);
    switch (field.kind) {
      case "toggle":
        return typeof field.default === "boolean";
      case "choice":
        return (
          Array.isArray(field.options) &&
          field.options.length >= 2 &&
          field.options.length <= 16 &&
          field.options.every((o: unknown) => isRecord(o) && typeof o.value === "string" && CHOICE_VALUE.test(o.value) && isLabel(o.label)) &&
          field.options.some((o: { value: string }) => o.value === field.default)
        );
      case "action":
        return field.confirm === undefined || isLabel(field.confirm);
      default:
        return false;
    }
  });
}

/** A status as an engine may report it; the settings page shows only the keys the module declares. */
export function isServiceSettingStatus(value: unknown): value is ServiceSettingStatus {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_SERVICE_FIELDS &&
    entries.every(
      ([key, s]) =>
        isSettingKey(key) &&
        isRecord(s) &&
        Object.keys(s).every((k) => k === "text" || k === "disabled") &&
        (s.text === undefined || isText(s.text, MAX_STATUS_TEXT)) &&
        (s.disabled === undefined || typeof s.disabled === "boolean"),
    )
  );
}

/** Stored values, leniently: what does not fit the known shapes is dropped. */
function parseServiceSettingValues(value: unknown): ServiceSettingValues | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, boolean | string] => isSettingKey(entry[0]) && isSettingValue(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries.slice(0, MAX_SERVICE_FIELDS)) : undefined;
}

export interface AppSettings {
  general: GeneralSettings;
  voice: VoiceSettings;
  shortcuts: ShortcutSettings;
  /** Per-service settings; services without an entry use the defaults. */
  services: Record<string, ServiceSettings>;
}

export const DEFAULT_SERVICE_SETTINGS: ServiceSettings = { notifications: true };
/** Services with settings of their own, at most. */
export const MAX_SERVICE_SETTINGS = 200;

/** One service's settings, defaults filled in. */
export function serviceSettings(settings: AppSettings, id: string): ServiceSettings {
  return { ...DEFAULT_SERVICE_SETTINGS, ...(Object.hasOwn(settings.services, id) ? settings.services[id] : {}) };
}

/**
 * The most a service's native view loads by itself, in bytes: the service's
 * own choice, else the general one; 0 for nothing, Infinity for any size.
 */
export function mediaAutoLoadLimit(settings: AppSettings, id: string): number {
  return AUTO_LOAD_BYTES[serviceSettings(settings, id).mediaAutoLoad ?? settings.general.mediaAutoLoad];
}

/** Whether a service sends typing indicators: its own choice, else the general one. */
export function typingIndicators(settings: AppSettings, id: string): boolean {
  return serviceSettings(settings, id).typing ?? settings.general.typingIndicators;
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    closeToTray: true,
    launchAtLogin: false,
    notifications: true,
    spellcheck: true,
    railGrouping: "mixed",
    zoom: 1,
    streamerMode: "auto",
    openLinks: false,
    autoUpdate: true,
    richPresence: false,
    mediaAutoLoad: "5mb",
    typingIndicators: true,
  },
  voice: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, enhancedNoiseSuppression: false, pushToTalkGlobal: false },
  // Off by default: global shortcuts take keys away from every other app.
  shortcuts: { toggleMute: null, toggleDeafen: null, showApp: null },
  services: {},
};

const MODIFIER = "(?:CommandOrControl|CmdOrCtrl|Control|Ctrl|Command|Cmd|Alt|Option|AltGr|Shift|Super|Meta)";
const KEY = "(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|[-=;',./\\[\\]`])";
const WITH_MODIFIERS = new RegExp(`^(?:${MODIFIER}\\+){1,4}${KEY}$`);
const LONE_KEY = /^F(?:1[3-9]|2[0-4])$/;

/**
 * A global shortcut: at least one modifier with a key, or one of F13-F24
 * on its own, so a shortcut never swallows ordinary typing everywhere.
 */
export function isAccelerator(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && (WITH_MODIFIERS.test(value) || LONE_KEY.test(value));
}

const SHORTCUT_KEYS: readonly ShortcutAction[] = ["toggleMute", "toggleDeafen", "showApp"];

/** Device fields take null to go back to the system default. */
export interface SettingsPatch {
  general?: Partial<GeneralSettings>;
  shortcuts?: Partial<ShortcutSettings>;
  /** Per service: fields to change, or null to go back to the defaults. A media limit or typing choice of "inherit" drops the service's own. */
  services?: Record<string, (Partial<Omit<ServiceSettings, "mediaAutoLoad" | "typing">> & { mediaAutoLoad?: MediaAutoLoad | "inherit"; typing?: boolean | "inherit" }) | null>;
  voice?: Partial<Record<"input" | "output" | "camera", DeviceChoice | null>> &
    Partial<Pick<VoiceSettings, "echoCancellation" | "noiseSuppression" | "autoGainControl" | "enhancedNoiseSuppression" | "pushToTalkGlobal">> & { pushToTalk?: string | null };
}

const MAX_TEXT = 200;
/** Each general setting with the check its values must pass. */
const GENERAL_CHECKS: { [K in keyof GeneralSettings]: (value: unknown) => value is GeneralSettings[K] } = {
  closeToTray: (v): v is boolean => typeof v === "boolean",
  launchAtLogin: (v): v is boolean => typeof v === "boolean",
  notifications: (v): v is boolean => typeof v === "boolean",
  spellcheck: (v): v is boolean => typeof v === "boolean",
  railGrouping: (v): v is GeneralSettings["railGrouping"] => v === "mixed" || v === "platform",
  zoom: (v): v is number => (ZOOM_LEVELS as readonly unknown[]).includes(v),
  streamerMode: (v): v is GeneralSettings["streamerMode"] => v === "auto" || v === "on" || v === "off",
  openLinks: (v): v is boolean => typeof v === "boolean",
  autoUpdate: (v): v is boolean => typeof v === "boolean",
  richPresence: (v): v is boolean => typeof v === "boolean",
  mediaAutoLoad: isMediaAutoLoad,
  typingIndicators: (v): v is boolean => typeof v === "boolean",
};
const GENERAL_KEYS = Object.keys(GENERAL_CHECKS) as (keyof GeneralSettings)[];
const VOICE_FLAGS = ["echoCancellation", "noiseSuppression", "autoGainControl", "enhancedNoiseSuppression", "pushToTalkGlobal"] as const;
const DEVICE_KEYS = ["input", "output", "camera"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown, max = MAX_TEXT): value is string => typeof value === "string" && value.length <= max;

export function isDeviceChoice(value: unknown): value is DeviceChoice {
  return isRecord(value) && isText(value.id, 500) && value.id !== "" && isText(value.label);
}

/** Reads settings.json leniently: unknown or broken fields fall back to the defaults. */
export function parseSettings(raw: unknown): AppSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (!isRecord(raw)) return settings;
  if (isRecord(raw.general)) {
    for (const key of GENERAL_KEYS) {
      const value = raw.general[key];
      if (GENERAL_CHECKS[key](value)) (settings.general as unknown as Record<string, unknown>)[key] = value;
    }
  }
  if (isRecord(raw.voice)) {
    for (const key of VOICE_FLAGS) if (typeof raw.voice[key] === "boolean") settings.voice[key] = raw.voice[key];
    for (const key of DEVICE_KEYS) if (isDeviceChoice(raw.voice[key])) settings.voice[key] = { ...raw.voice[key] };
    if (isPushToTalkKey(raw.voice.pushToTalk)) settings.voice.pushToTalk = raw.voice.pushToTalk;
  }
  if (isRecord(raw.shortcuts)) {
    for (const key of SHORTCUT_KEYS) if (isAccelerator(raw.shortcuts[key])) settings.shortcuts[key] = raw.shortcuts[key];
  }
  if (isRecord(raw.services)) {
    for (const [id, value] of Object.entries(raw.services).slice(0, MAX_SERVICE_SETTINGS)) {
      if (!SERVICE_ID.test(id) || !isRecord(value) || typeof value.notifications !== "boolean") continue;
      settings.services[id] = { notifications: value.notifications };
      if (isMediaAutoLoad(value.mediaAutoLoad)) settings.services[id].mediaAutoLoad = value.mediaAutoLoad;
      const options = parseServiceSettingValues(value.options);
      // Matrix kept its typing choice among its own fields before it became a shell setting: carry it over.
      if (options && Object.hasOwn(options, TYPING_SETTING)) {
        if (typeof options[TYPING_SETTING] === "boolean") settings.services[id].typing = options[TYPING_SETTING];
        delete options[TYPING_SETTING];
      }
      if (typeof value.typing === "boolean") settings.services[id].typing = value.typing;
      if (options && Object.keys(options).length > 0) settings.services[id].options = options;
    }
  }
  return settings;
}

/** Only known keys with the right types; anything else rejects the whole patch. */
export function isSettingsPatch(value: unknown): value is SettingsPatch {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) if (key !== "general" && key !== "voice" && key !== "shortcuts" && key !== "services") return false;
  const { general, voice, shortcuts, services } = value;
  if (services !== undefined) {
    if (!isRecord(services) || Object.keys(services).length > MAX_SERVICE_SETTINGS) return false;
    for (const [id, v] of Object.entries(services)) {
      if (!SERVICE_ID.test(id)) return false;
      if (v === null) continue;
      const fits = ([key, field]: [string, unknown]): boolean =>
        (key === "notifications" && typeof field === "boolean") ||
        (key === "mediaAutoLoad" && (field === "inherit" || isMediaAutoLoad(field))) ||
        (key === "typing" && (field === "inherit" || typeof field === "boolean")) ||
        (key === "options" && isServiceSettingValues(field));
      if (!isRecord(v) || !Object.entries(v).every(fits)) return false;
    }
  }
  if (shortcuts !== undefined) {
    if (!isRecord(shortcuts)) return false;
    for (const [key, v] of Object.entries(shortcuts)) {
      if (!(SHORTCUT_KEYS as readonly string[]).includes(key) || (v !== null && !isAccelerator(v))) return false;
    }
  }
  if (general !== undefined) {
    if (!isRecord(general)) return false;
    for (const [key, v] of Object.entries(general)) {
      if (!(GENERAL_KEYS as readonly string[]).includes(key) || !GENERAL_CHECKS[key as keyof GeneralSettings](v)) return false;
    }
  }
  if (voice !== undefined) {
    if (!isRecord(voice)) return false;
    for (const [key, v] of Object.entries(voice)) {
      if ((VOICE_FLAGS as readonly string[]).includes(key)) {
        if (typeof v !== "boolean") return false;
      } else if ((DEVICE_KEYS as readonly string[]).includes(key)) {
        if (v !== null && !isDeviceChoice(v)) return false;
      } else if (key === "pushToTalk") {
        if (v !== null && !isPushToTalkKey(v)) return false;
      } else {
        return false;
      }
    }
  }
  return true;
}

export function applySettingsPatch(settings: AppSettings, patch: SettingsPatch): AppSettings {
  const next = structuredClone(settings);
  Object.assign(next.general, patch.general);
  Object.assign(next.shortcuts, patch.shortcuts);
  for (const [id, value] of Object.entries(patch.services ?? {})) {
    if (value === null) delete next.services[id];
    else if (Object.keys(next.services).length < MAX_SERVICE_SETTINGS || Object.hasOwn(next.services, id)) {
      const current = serviceSettings(next, id);
      const { mediaAutoLoad, typing, ...rest } = value;
      const merged: ServiceSettings = { ...current, ...rest };
      if (mediaAutoLoad === "inherit") delete merged.mediaAutoLoad;
      else if (mediaAutoLoad) merged.mediaAutoLoad = mediaAutoLoad;
      if (typing === "inherit") delete merged.typing;
      else if (typing !== undefined) merged.typing = typing;
      // Values merge per key, so changing one keeps the others; at most MAX_SERVICE_FIELDS are kept.
      if (value.options) merged.options = Object.fromEntries(Object.entries({ ...current.options, ...value.options }).slice(-MAX_SERVICE_FIELDS));
      next.services[id] = merged;
    }
  }
  for (const [key, value] of Object.entries(patch.voice ?? {})) {
    if (value === null) delete next.voice[key as (typeof DEVICE_KEYS)[number] | "pushToTalk"];
    else (next.voice as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
}

// --- Services and accounts ---------------------------------------------------

export interface AccountStatus {
  state: "signed-in" | "signed-out" | "unknown";
  /** Who is signed in, when the platform tells us. */
  name?: string;
}

/** One configured platform instance, which is one account on one service. */
export interface ServiceInfo {
  id: string;
  name: string;
  url: string;
  module: string;
  /** The module's display name, label colour and short label. */
  moduleName: string;
  label: string;
  color: string;
  enabled: boolean;
  /** Built-in services can be turned off but not removed. */
  builtIn: boolean;
  /** What users should know before using the service's module. */
  notice?: string;
  /** Present for services running now; disabled ones have no account state. */
  account?: AccountStatus;
  /** Integration checks, for services that report them. */
  health?: { name: string; ok: boolean; detail?: string }[];
  /** The settings its module declares, shown under the service. */
  settings?: ServiceSettingField[];
  /** What the running service says about those settings, for declared keys only. */
  settingsStatus?: ServiceSettingStatus;
  /** Its module holds media back until asked, so the limit for media that loads by itself applies (ModuleManifest.holdsMedia). */
  holdsMedia?: boolean;
  /** Its module sends typing indicators, so the service may choose its own (ModuleManifest.sendsTyping). */
  sendsTyping?: boolean;
}

/** A module the user can add services (or extra accounts) from. */
export interface ModuleInfo {
  id: string;
  name: string;
  label: string;
  color: string;
  /** Prefilled address; with fixedUrl the module always uses it. */
  defaultUrl?: string;
  fixedUrl: boolean;
  /** Its calls run in Multicord's own call view, with the voice settings here. */
  calls: boolean;
}

export interface SettingsViewState {
  settings: AppSettings;
  services: ServiceInfo[];
  modules: ModuleInfo[];
  /** Service changes are saved but only take effect after a restart. */
  restartNeeded: boolean;
  /** False when the OS has no secret store, so sign-ins are not remembered. */
  secretsPersistent: boolean;
  launchAtLoginSupported: boolean;
  version: string;
  /** Streamer mode is hiding message content right now. */
  streaming?: boolean;
  /** App link schemes the running modules can open, e.g. ["discord"]. */
  linkSchemes?: string[];
  /** Shortcuts another app already holds, so they could not be set. */
  shortcutErrors?: ShortcutAction[];
  /** Why the background push-to-talk key is not working, if it is not. */
  pushToTalkError?: string;
  update?: UpdateStatus;
  /** The favourites the native views keep: their categories and the cache on disk. */
  favourites?: FavouritesSummary;
  /** The last action that could not be done, e.g. turning off the only service. */
  error?: string;
}

/**
 * A plain-text repair report from Settings > Diagnostics: versions and every
 * service's checks, failing ones with what they break. It holds no
 * messages, tokens or addresses beyond the services' public ones, so it can
 * go into an issue or to an AI assistant to propose a fix (the study's
 * "AI-assisted repair proposals").
 */
export function diagnosticsReport(state: Pick<SettingsViewState, "version" | "services">, os: string): string {
  const lines = ["Multicord diagnostics", `Version: ${state.version}`, `OS: ${os}`, ""];
  for (const service of state.services) {
    if (!service.health?.length) continue;
    const failed = service.health.filter((c) => !c.ok);
    lines.push(`## ${service.moduleName} (${failed.length === 0 ? "all working" : `${failed.length} not working`})`);
    for (const check of service.health) lines.push(`- [${check.ok ? "ok" : "FAILED"}] ${check.name}${!check.ok && check.detail ? ` — affects: ${check.detail}` : ""}`);
    lines.push("");
  }
  if (lines.length === 4) lines.push("No running service reports checks.");
  return lines.join("\n").trimEnd();
}

export type SettingsAction =
  | { type: "update"; patch: SettingsPatch }
  | { type: "setEnabled"; id: string; enabled: boolean }
  | { type: "addService"; module: string; name: string; url?: string }
  | { type: "removeService"; id: string }
  | { type: "renameService"; id: string; name: string }
  | { type: "signOut"; id: string }
  | { type: "openService"; id: string }
  /** Runs an action field its module declares, on the running service. */
  | { type: "serviceAction"; id: string; key: string }
  | { type: "restart" }
  | { type: "checkUpdates" }
  | { type: "installUpdate" }
  | { type: "copyReport" }
  /** Drops cached favourite files that can be downloaded again; the favourites stay. */
  | { type: "clearFavouriteCache" };

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const isServiceId = (value: unknown): value is string => typeof value === "string" && SERVICE_ID.test(value);
const isName = (value: unknown): value is string => isText(value, 64) && value.trim() !== "";

export function isSettingsAction(value: unknown): value is SettingsAction {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "update":
      return isSettingsPatch(value.patch);
    case "setEnabled":
      return isServiceId(value.id) && typeof value.enabled === "boolean";
    case "addService":
      return isServiceId(value.module) && isName(value.name) && (value.url === undefined || isText(value.url, 2000));
    case "renameService":
      return isServiceId(value.id) && isName(value.name);
    case "removeService":
    case "signOut":
    case "openService":
      return isServiceId(value.id);
    case "serviceAction":
      return isServiceId(value.id) && isSettingKey(value.key);
    case "restart":
    case "copyReport":
    case "checkUpdates":
    case "installUpdate":
    case "clearFavouriteCache":
      return true;
    default:
      return false;
  }
}
