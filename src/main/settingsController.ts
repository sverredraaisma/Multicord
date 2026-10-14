import fs from "node:fs";
import path from "node:path";
import type { PlatformAdapter } from "../shared/adapter";
import type { ModuleInfo, ServiceInfo, SettingsAction, SettingsViewState, ShortcutAction, UpdateStatus } from "../shared/settings";
import { configurableModules } from "./modules/index";
import type { PlatformModule } from "./modules/types";
import { loadPlatforms } from "./platforms";
import { addService, keepsOneEnabled, removeService, renameService, setServiceEnabled } from "./services";
import type { SettingsStore } from "./settingsStore";

export interface SettingsDeps {
  /** platforms.json, which the settings page edits. */
  platformsFile: string;
  modules: readonly PlatformModule[];
  store: SettingsStore;
  /** Adapters of the services running now. */
  adapters: ReadonlyMap<string, PlatformAdapter>;
  secretsPersistent(): boolean;
  launchAtLoginSupported: boolean;
  version: string;
  /** Whether streamer mode is hiding content right now. */
  streaming?(): boolean;
  /** App link schemes the running modules can open. */
  linkSchemes?: string[];
  /** Shortcuts another app already holds. */
  shortcutErrors?(): ShortcutAction[];
  updates?: { status: UpdateStatus; check(): Promise<void>; install(): void };
  /** Shows a running service, e.g. to sign in. */
  openService(id: string): void;
  /** Clears a service's web session (cookies, storage) and reloads it if running. */
  clearSession(id: string): Promise<void>;
  /** Drops a service's saved tokens. */
  forgetSecrets(id: string): void;
  restart(): void;
  publish(state: SettingsViewState): void;
}

/**
 * Backs the settings page: builds its state and carries out its actions.
 * Service changes go to platforms.json and apply after a restart; settings
 * changes go to the settings store, whose listeners apply them at once.
 */
export class SettingsController {
  private restartNeeded = false;
  private error: string | undefined;
  private lastPublished: string | undefined;

  constructor(private readonly deps: SettingsDeps) {}

  private get rules() {
    return configurableModules(this.deps.modules);
  }

  private manifest(id: string) {
    return this.deps.modules.find((m) => m.manifest.id === id)?.manifest;
  }

  /** The file's entries. A file that is not valid JSON is never overwritten. */
  private readConfig(): unknown {
    let text: string;
    try {
      text = fs.readFileSync(this.deps.platformsFile, "utf8");
    } catch {
      return [];
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("platforms.json has a syntax error. Fix or remove it to change services here.");
    }
  }

  private writeConfig(raw: unknown[]): void {
    fs.mkdirSync(path.dirname(this.deps.platformsFile), { recursive: true });
    fs.writeFileSync(this.deps.platformsFile, `${JSON.stringify(raw, null, 2)}\n`);
    this.restartNeeded = true;
  }

  state(): SettingsViewState {
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.deps.platformsFile, "utf8");
    } catch {
      text = undefined;
    }
    const { all } = loadPlatforms(() => text, this.rules);
    const services: ServiceInfo[] = all.map(({ def, enabled, builtIn }) => {
      const manifest = this.manifest(def.module);
      const adapter = this.deps.adapters.get(def.id);
      const service: ServiceInfo = {
        id: def.id,
        name: def.name,
        url: def.url,
        module: def.module,
        moduleName: manifest?.name ?? def.module,
        label: manifest?.label ?? def.module,
        color: manifest?.color ?? "#80848e",
        enabled,
        builtIn,
      };
      if (adapter) service.account = adapter.accountStatus?.() ?? { state: "unknown" };
      const health = adapter?.health?.();
      if (health) service.health = health;
      return service;
    });
    const modules: ModuleInfo[] = this.deps.modules
      .filter((m) => m.manifest.configurable)
      .map(({ manifest: { id, name, label, color, defaultUrl, fixedUrl } }) => ({
        id,
        name,
        label,
        color,
        defaultUrl,
        fixedUrl: fixedUrl === true,
      }));
    const state: SettingsViewState = {
      settings: this.deps.store.get(),
      services,
      modules,
      restartNeeded: this.restartNeeded,
      secretsPersistent: this.deps.secretsPersistent(),
      launchAtLoginSupported: this.deps.launchAtLoginSupported,
      version: this.deps.version,
    };
    if (this.deps.streaming?.()) state.streaming = true;
    if (this.deps.linkSchemes?.length) state.linkSchemes = this.deps.linkSchemes;
    if (this.deps.updates) state.update = this.deps.updates.status;
    const shortcutErrors = this.deps.shortcutErrors?.() ?? [];
    if (shortcutErrors.length > 0) state.shortcutErrors = shortcutErrors;
    if (this.error) state.error = this.error;
    return state;
  }

  /** Sends the page its state; unless forced, only when something changed. */
  refresh(force = false): void {
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (!force && serialized === this.lastPublished) return;
    this.lastPublished = serialized;
    this.deps.publish(state);
  }

  async handle(action: SettingsAction): Promise<void> {
    this.error = undefined;
    try {
      await this.run(action);
    } catch (error) {
      this.error = (error as Error).message;
    }
    this.refresh(true);
  }

  private async run(action: SettingsAction): Promise<void> {
    switch (action.type) {
      case "update":
        this.deps.store.update(action.patch);
        return;
      case "setEnabled": {
        const raw = setServiceEnabled(this.readConfig(), action.id, action.enabled);
        if (!keepsOneEnabled(raw, this.rules)) throw new Error("Keep at least one service turned on.");
        this.writeConfig(raw);
        return;
      }
      case "addService": {
        if (!this.rules.some((m) => m.id === action.module)) throw new Error("That module cannot be added.");
        const result = addService(this.readConfig(), action, this.rules);
        if (!result.ok) throw new Error(`Could not add ${action.name.trim()}: ${result.error}.`);
        this.writeConfig(result.raw);
        return;
      }
      case "renameService":
        this.writeConfig(renameService(this.readConfig(), action.id, action.name));
        return;
      case "removeService": {
        const raw = removeService(this.readConfig(), action.id);
        if (!keepsOneEnabled(raw, this.rules)) throw new Error("Keep at least one service turned on.");
        this.writeConfig(raw);
        this.deps.forgetSecrets(action.id);
        await this.deps.clearSession(action.id);
        return;
      }
      case "signOut": {
        const adapter = this.deps.adapters.get(action.id);
        if (!adapter) return;
        if (adapter.signOut) await adapter.signOut();
        else await this.deps.clearSession(action.id);
        return;
      }
      case "openService":
        if (this.deps.adapters.has(action.id)) this.deps.openService(action.id);
        return;
      case "restart":
        this.deps.restart();
        return;
      case "checkUpdates":
        return this.deps.updates?.check();
      case "installUpdate":
        this.deps.updates?.install();
        return;
    }
  }
}
