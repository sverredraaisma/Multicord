// App settings, the services list shown in the settings page, and the
// settings page's actions. Everything the page sends is validated here
// before the main process uses it.

export const SETTINGS_IPC = {
  state: "settings:state",
  action: "settings:action",
  ready: "settings:ready",
  /** Main -> native views: the voice settings to use for calls. */
  voice: "settings:voice",
  /** Main -> native views: a voice shortcut was pressed ("toggleMute" or "toggleDeafen"). */
  voiceCommand: "settings:voice-command",
} as const;

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
  /** While Multicord is in front: hold this key (a KeyboardEvent code) to talk; absent: voice activity. */
  pushToTalk?: string;
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
}

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

export interface AppSettings {
  general: GeneralSettings;
  voice: VoiceSettings;
  shortcuts: ShortcutSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: { closeToTray: true, launchAtLogin: false, notifications: true, spellcheck: true, railGrouping: "mixed", zoom: 1, streamerMode: "auto", openLinks: false, autoUpdate: true },
  voice: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  // Off by default: global shortcuts take keys away from every other app.
  shortcuts: { toggleMute: null, toggleDeafen: null, showApp: null },
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
  voice?: Partial<Record<"input" | "output" | "camera", DeviceChoice | null>> &
    Partial<Pick<VoiceSettings, "echoCancellation" | "noiseSuppression" | "autoGainControl">> & { pushToTalk?: string | null };
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
};
const GENERAL_KEYS = Object.keys(GENERAL_CHECKS) as (keyof GeneralSettings)[];
const VOICE_FLAGS = ["echoCancellation", "noiseSuppression", "autoGainControl"] as const;
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
  return settings;
}

/** Only known keys with the right types; anything else rejects the whole patch. */
export function isSettingsPatch(value: unknown): value is SettingsPatch {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) if (key !== "general" && key !== "voice" && key !== "shortcuts") return false;
  const { general, voice, shortcuts } = value;
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
  /** Present for services running now; disabled ones have no account state. */
  account?: AccountStatus;
  /** Integration checks, for services that report them. */
  health?: { name: string; ok: boolean; detail?: string }[];
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
  update?: UpdateStatus;
  /** The last action that could not be done, e.g. turning off the only service. */
  error?: string;
}

export type SettingsAction =
  | { type: "update"; patch: SettingsPatch }
  | { type: "setEnabled"; id: string; enabled: boolean }
  | { type: "addService"; module: string; name: string; url?: string }
  | { type: "removeService"; id: string }
  | { type: "renameService"; id: string; name: string }
  | { type: "signOut"; id: string }
  | { type: "openService"; id: string }
  | { type: "restart" }
  | { type: "checkUpdates" }
  | { type: "installUpdate" };

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
    case "restart":
    case "checkUpdates":
    case "installUpdate":
      return true;
    default:
      return false;
  }
}
