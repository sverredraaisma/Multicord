import type { PlatformAdapter } from "../shared/adapter";
import type { FavouritesSummary } from "../shared/favourites";
import {
  diagnosticsReport,
  fitsServiceFields,
  type ModuleInfo,
  type ServiceInfo,
  type ServiceSettingField,
  type SettingsAction,
  type SettingsViewState,
  type ShortcutAction,
  type UpdateStatus,
} from "../shared/settings";
import { configurableModules, type ModuleEntry } from "./modules";
import { loadPlatforms } from "./platforms";
import { addService, keepsOneEnabled, removeService, renameService, setServiceEnabled } from "./services";
import type { SettingsStore } from "./settingsStore";

/** Where platforms.json is kept: a file on the desktop. */
export interface PlatformsConfig {
  read(): string | undefined;
  write(text: string): void;
}

export interface SettingsDeps {
  /** platforms.json, which the settings page edits: its text (undefined when there is none), and writing it. */
  platformsConfig: PlatformsConfig;
  modules: readonly ModuleEntry[];
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
  /** Why the background push-to-talk key is not working. */
  pushToTalkError?(): string | undefined;
  updates?: { status: UpdateStatus; check(): Promise<void>; install(): void };
  /** Shows a running service, e.g. to sign in. */
  openService(id: string): void;
  /** Starts a running service again on its own, where the host can (the phone restarts its engine). */
  restartService?(id: string): void;
  /** Clears a service's web session (cookies, storage) and reloads it if running. */
  clearSession(id: string): Promise<void>;
  /** Drops a service's saved tokens. */
  forgetSecrets(id: string): void;
  restart(): void;
  publish(state: SettingsViewState): void;
  /** Puts text on the clipboard (the diagnostics report). */
  copyText?(text: string): void;
  /** The OS, for the diagnostics report, e.g. "win32 10.0.26200". */
  os?: string;
  /** The shell's favourites, for their section. */
  favourites?: { summary(): FavouritesSummary; clearCache(): void };
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
    const text = this.deps.platformsConfig.read();
    if (text === undefined) return [];
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("platforms.json has a syntax error. Fix or remove it to change services here.");
    }
  }

  private writeConfig(raw: unknown[]): void {
    this.deps.platformsConfig.write(`${JSON.stringify(raw, null, 2)}\n`);
    this.restartNeeded = true;
  }

  /** Every configured service, as platforms.json says now. */
  private platforms() {
    return loadPlatforms(() => this.deps.platformsConfig.read(), this.rules).all;
  }

  /** The settings a service's module declares. */
  private fieldsOf(id: string): ServiceSettingField[] {
    const def = this.platforms().find((p) => p.def.id === id)?.def;
    return (def && this.manifest(def.module)?.settings) ?? [];
  }

  state(): SettingsViewState {
    const services: ServiceInfo[] = this.platforms().map(({ def, enabled, builtIn }) => {
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
      if (manifest?.notice) service.notice = manifest.notice;
      if (manifest?.holdsMedia) service.holdsMedia = true;
      if (manifest?.sendsTyping) service.sendsTyping = true;
      if (adapter) service.account = adapter.accountStatus?.() ?? { state: "unknown" };
      if (adapter && this.deps.restartService) service.restartable = true;
      const health = adapter?.health?.();
      if (health) service.health = health;
      const fields = manifest?.settings ?? [];
      if (fields.length > 0) {
        service.settings = fields;
        // Only what the module declared: a status for anything else is not shown.
        const reported = adapter?.settingsStatus?.() ?? {};
        const status = Object.fromEntries(fields.flatMap((f) => (Object.hasOwn(reported, f.key) ? [[f.key, reported[f.key]!]] : [])));
        if (Object.keys(status).length > 0) service.settingsStatus = status;
      }
      return service;
    });
    const modules: ModuleInfo[] = this.deps.modules
      .filter((m) => m.manifest.configurable)
      .map(({ manifest: { id, name, label, color, defaultUrl, fixedUrl, usesVoiceSettings } }) => ({
        id,
        name,
        label,
        color,
        defaultUrl,
        fixedUrl: fixedUrl === true,
        calls: usesVoiceSettings === true,
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
    if (this.deps.favourites) state.favourites = this.deps.favourites.summary();
    const shortcutErrors = this.deps.shortcutErrors?.() ?? [];
    if (shortcutErrors.length > 0) state.shortcutErrors = shortcutErrors;
    const pushToTalkError = this.deps.pushToTalkError?.();
    if (pushToTalkError) state.pushToTalkError = pushToTalkError;
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
        // A module's values must name its own fields and fit them.
        for (const [id, value] of Object.entries(action.patch.services ?? {})) {
          if (value?.options && !fitsServiceFields(this.fieldsOf(id), value.options)) throw new Error("That setting does not exist for this service.");
        }
        this.deps.store.update(action.patch);
        return;
      case "serviceAction": {
        if (!this.fieldsOf(action.id).some((f) => f.kind === "action" && f.key === action.key)) throw new Error("That setting does not exist for this service.");
        const adapter = this.deps.adapters.get(action.id);
        if (!adapter?.runSettingAction) throw new Error("Turn the service on first.");
        await adapter.runSettingAction(action.key);
        return;
      }
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
      case "restartService":
        if (!this.deps.restartService || !this.deps.adapters.has(action.id)) throw new Error("Turn the service on first.");
        this.deps.restartService(action.id);
        return;
      case "restart":
        this.deps.restart();
        return;
      case "copyReport":
        this.deps.copyText?.(diagnosticsReport(this.state(), this.deps.os ?? "unknown"));
        return;
      case "checkUpdates":
        return this.deps.updates?.check();
      case "installUpdate":
        this.deps.updates?.install();
        return;
      case "clearFavouriteCache":
        this.deps.favourites?.clearCache();
        return;
    }
  }
}
