import type { BaseWindow, Session, WebContentsView } from "electron";
import type { PlatformAdapter } from "../../shared/adapter";
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
  /** Engines only: whether the module has a home (DM) entry in the rail. */
  home?: boolean;
  /** Engines only: route screen sharing in the module's view through the shell's picker. */
  screenShare?: boolean;
  /** Engines only: what the module supports. */
  capabilities?: PlatformAdapter["capabilities"];
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
