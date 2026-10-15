import type { BaseWindow, Session, WebContentsView } from "electron";
import type { PlatformAdapter } from "../../shared/adapter";
import type { ServiceSettingField, ServiceSettingValues } from "../../shared/settings";
import type { SecretBox, SecretStore } from "../credentials";
import type { PlatformDef } from "../platforms";
import type { PageKeys } from "../shortcuts";

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

/** What the shell itself uses; modules never get the OS secret store. */
export interface ShellServices {
  secrets: SecretBox;
}

export type { SecretStore };

/** What the shell gives a module for one platform instance. */
export interface ModuleHost {
  def: PlatformDef;
  view: WebContentsView;
  session: Session;
  window: BaseWindow;
  /** Directory holding the built pages and scripts. */
  dist: string;
  platform: NodeJS.Platform;
  /** This instance's own secrets only. */
  secrets: SecretStore;
  /** Routes getDisplayMedia in this view through the shell's screen picker. */
  enableScreenShare(): void;
  /** This instance's values for the manifest's settings now; changes reach the adapter's applySettings(). */
  settings(): ServiceSettingValues;
  /**
   * Asks an https address on this instance's own host whether the service
   * answers (the HTTP status; a rejection when it could not be reached),
   * through the shell's own cookie-less session, to public addresses only
   * (main/serviceReach.ts). Absent where the instance is on a local or
   * private address.
   */
  reach?(url: string): Promise<number>;
}

export interface LoadedPlatform {
  adapter: PlatformAdapter;
  /** Called once the adapter is registered: load the view, connect, etc. */
  start(): void;
}

/**
 * A platform module. The shell knows platforms only through this interface:
 * it creates a view and session per instance and lets the module wire them up.
 */
export interface PlatformModule {
  manifest: ModuleManifest;
  /** Web-view modules wire their view here; engine modules (manifest.engine) have no main-process code. */
  load?(host: ModuleHost): LoadedPlatform;
}
