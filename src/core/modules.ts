import type { PlatformAdapter } from "../shared/adapter";
import type { ServiceSettingField } from "../shared/settings";
import type { ModuleRule } from "./platforms";

/** A key press a module's page understands, e.g. Discord's own Ctrl+Shift+M. */
export interface PageKeys {
  keyCode: string;
  modifiers: ("commandOrControl" | "shift" | "alt")[];
}

/** Describes a platform module; the rail shows `label` in `color` next to its servers. */
export interface ModuleManifest {
  id: string;
  name: string;
  /** Short name for the rail's module badge and tooltips. */
  label: string;
  color: string;
  /** Whether users may add instances of this module (more services or accounts). */
  configurable: boolean;
  /** Address prefilled for new instances; with fixedUrl, the only one allowed. */
  defaultUrl?: string;
  fixedUrl?: boolean;
  /** What users should know before using the module (e.g. a risk to their account), shown with its services in Settings. */
  notice?: string;
  /** The module runs calls itself and takes the voice settings (devices, processing). */
  usesVoiceSettings?: boolean;
  /** Preload script for the module's view, relative to the build directory. */
  preload?: string;
  /** URL schemes the module opens (e.g. "discord"), when the user lets Multicord handle them. */
  protocols?: string[];
  /** The module's page has its own push to talk: the background push-to-talk key is passed on to it. */
  forwardPushToTalk?: boolean;
  /** Keys the module's own page uses for mute and deafen, sent to it when the global shortcuts fire. */
  voiceKeys?: Partial<Record<"toggleMute" | "toggleDeafen", PageKeys>>;
  /**
   * Native modules: the engine bundle (dist/engines/<engine>.js) that runs
   * the module's logic in a sandboxed engine, and the view it renders in.
   * Such modules have no main-process code at all.
   */
  engine?: string;
  /** Engines only: when set, the only hosts the engine may reach. */
  hosts?: string[];
  /**
   * Engines only: keep the engine's own web storage (IndexedDB) on disk, e.g.
   * for end-to-end encryption keys. It stays in the instance's own partition
   * and origin, and is cleared when the instance is removed.
   */
  storage?: boolean;
  /** Engines only: whether the module has a home (DM) entry in the rail. */
  home?: boolean;
  /** Engines only: route screen sharing in the module's view through the shell's picker. */
  screenShare?: boolean;
  /**
   * Engines only: the module's calls are peer-to-peer WebRTC (Nerimity's),
   * so its view connects straight to other people rather than to a voice
   * server. The view then gets Chromium's WebRTC IP handling policy
   * "default_public_interface_only": only the interface of the default
   * route is used, so no local network or VPN address is offered to peers.
   */
  peerToPeerCalls?: boolean;
  /**
   * Engines only: the engine holds media back until its view asks
   * (NativeAttachment.mediaKey). The view gets the service's limit for media
   * that loads by itself, and Settings offers a per-service choice of it.
   */
  holdsMedia?: boolean;
  /**
   * Engines only: the module tells others while the user types. Its
   * services get the "Send typing indicators" setting (the general one, or
   * the service's own) as `typing` (TYPING_SETTING) in their settings
   * values, and changes through applySettings().
   */
  sendsTyping?: boolean;
  /** Engines only: what the module supports. */
  capabilities?: PlatformAdapter["capabilities"];
  /**
   * Settings each service of this module has, shown under it in Settings >
   * Services. An engine gets its values in EngineInfo.settings and changes
   * as commands (ServedAdapter.applySettings), and its action buttons as
   * runSettingAction(); a load() module gets them from ModuleHost.settings().
   */
  settings?: ServiceSettingField[];
}

/** What core needs of a module: its manifest. Each host adds how it runs it. */
export interface ModuleEntry {
  manifest: ModuleManifest;
}

export function findModule<T extends ModuleEntry>(id: string, modules: readonly T[]): T | undefined {
  return modules.find((m) => m.manifest.id === id);
}

/** Modules users may instantiate from platforms.json, with their address rules. */
export function configurableModules(modules: readonly ModuleEntry[]): ModuleRule[] {
  return modules
    .filter((m) => m.manifest.configurable)
    .map(({ manifest: { id, defaultUrl, fixedUrl } }) => ({ id, defaultUrl, fixedUrl }));
}
