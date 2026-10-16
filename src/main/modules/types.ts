import type { BaseWindow, Session, WebContentsView } from "electron";
import type { ModuleManifest } from "../../core/modules";
import type { PlatformAdapter } from "../../shared/adapter";
import type { ServiceSettingValues } from "../../shared/settings";
import type { SecretBox, SecretStore } from "../credentials";
import type { PlatformDef } from "../../core/platforms";

export type { ModuleManifest };

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
