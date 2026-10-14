import type { BaseWindow, Session, WebContentsView } from "electron";
import type { PlatformAdapter } from "../../shared/adapter";
import type { SecretBox } from "../credentials";
import type { SocketFactory } from "../fluxer/gateway";
import type { PlatformDef } from "../platforms";

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
}

/** Network and secret-store access for modules; replaceable in tests. */
export interface ShellServices {
  fetch: typeof fetch;
  createSocket: SocketFactory;
  secrets: SecretBox;
}

export interface SecretStore {
  load(key: string): string | undefined;
  save(key: string, value: string): void;
  delete(key: string): void;
}

/** What the shell gives a module for one platform instance. */
export interface ModuleHost {
  def: PlatformDef;
  view: WebContentsView;
  session: Session;
  window: BaseWindow;
  /** Directory holding the built pages and scripts. */
  dist: string;
  platform: NodeJS.Platform;
  services: ShellServices;
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
  load(host: ModuleHost): LoadedPlatform;
}
