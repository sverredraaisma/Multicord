// The phone's shell: src/core run in the shell WebView, as src/main/app.ts
// runs it in Electron's main process. Native code does only what Electron did
// (views, sessions, network, secrets, notifications); everything it is told
// goes through the shell bridge as a ShellCommand, and everything it reports
// is checked with isNativeEvent first.
import { EngineAdapter } from "../core/engineAdapter";
import { GenericWebAdapter } from "../main/adapters/genericWebAdapter";
import { configurableModules, findModule, type ModuleManifest } from "../core/modules";
import { loadPlatforms, type PlatformDef } from "../core/platforms";
import { PlatformRegistry } from "../core/registry";
import { SettingsController, type PlatformsConfig } from "../core/settingsController";
import { SettingsStore, type SettingsPersistence } from "../core/settingsStore";
import type { PlatformAdapter, PlatformNotification } from "../shared/adapter";
import { MAX_BODY_TEXT, MAX_KEY, MAX_TEXT } from "../shared/engine";
import { isRailOrder, type MessagesState, type RailState } from "../shared/ipc";
import {
  isSettingsAction,
  mediaAutoLoadLimit,
  serviceSettings,
  serviceSettingValues,
  TYPING_SETTING,
  typingIndicators,
  type ServiceSettingValues,
  type SettingsViewState,
} from "../shared/settings";
import { MOBILE_MODULES, type MobileModule } from "./modules";
import { isBootInfo, isNativeEvent, MAX_COPY, type BootInfo, type NativeEvent, type ShellBridge, type ShellCommand } from "./protocol";

/**
 * What fills the screen: a service's chat view under the bar, the unified Messages list, the settings
 * page, or the home page (no service yet).
 */
export type Screen = { page: "service"; instance: string } | { page: "messages" } | { page: "settings" } | { page: "home" };

/** Everything the page draws, whenever any of it changes. */
export interface UiState {
  rail: RailState;
  screen: Screen;
  drawer: boolean;
  title: string;
  /** Unread mentions across every service, and whether anything is unread. */
  mentions: number;
  unread: boolean;
  /** The running services, in the order they started: their names and module colours, for the drawer's headings. */
  services: { id: string; name: string; label: string; color: string }[];
  /** Every service's direct conversations, newest first, as the desktop's Messages page has them (no previews while streaming). */
  messages: MessagesState;
  /** Unread direct messages across every service, for the drawer's Messages entry. */
  messagesBadge: { unread: boolean; mentions: number };
}

/** The page's side: it draws what the shell says. */
export interface ShellUi {
  render(state: UiState): void;
  /** The settings page's state, whenever it changes while the page is open. */
  settings(state: SettingsViewState): void;
}

/** A first run turns Discord off: it is not on the phone yet (docs/mobile.md, phase 3). */
export const FIRST_PLATFORMS = `${JSON.stringify([{ id: "discord", enabled: false }], null, 2)}\n`;

/** The bar's title for each page but a service's (which has the service's name). */
const TITLES: Partial<Record<Screen["page"], string>> = { messages: "Messages", settings: "Settings", home: "Multicord" };

const NO_CAPABILITIES = { directMessages: false, messagePreviews: false, voice: false, screenShare: false };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class MobileShell {
  readonly registry = new PlatformRegistry();
  /** The running native services' adapters, which their engines feed. */
  readonly adapters = new Map<string, EngineAdapter>();
  /** The running web-client services' adapters, which read their page titles. */
  readonly webAdapters = new Map<string, GenericWebAdapter>();
  /** Every running service, native or web: what Settings and the screen know. */
  private readonly services = new Map<string, PlatformAdapter>();
  private readonly manifests = new Map<string, ModuleManifest>();
  private readonly defs = new Map<string, PlatformDef>();
  private store!: SettingsStore;
  private controller!: SettingsController;
  private platformsText: string | undefined;
  private screen: Screen = { page: "home" };
  /** The service shown last, to go back to from the settings page. */
  private lastService: string | undefined;
  private drawer = false;
  private appVisible = true;
  private readonly visibleSent = new Map<string, boolean>();
  private lastBadge = -1;
  private lastLayout = "";
  /** Every service has started: until then nothing is drawn or shown. */
  private running = false;

  constructor(
    private readonly bridge: ShellBridge,
    private readonly ui: ShellUi,
    private readonly modules: readonly MobileModule[] = MOBILE_MODULES,
  ) {}

  get settings(): SettingsController {
    return this.controller;
  }

  /** Reads the shell's files from native code, then starts every service that is turned on. */
  async start(): Promise<void> {
    const boot = await this.bridge.request({ type: "boot" });
    if (!isBootInfo(boot)) throw new Error("Native code sent no valid boot info");
    this.bridge.onEvent((event) => {
      if (isNativeEvent(event)) void this.handle(event);
    });
    this.platformsText = boot.files.platforms;
    if (this.platformsText === undefined) this.savePlatforms(FIRST_PLATFORMS);
    this.store = new SettingsStore(this.persistence(boot));
    const order = parseJson(boot.files.order);
    if (isRailOrder(order)) this.registry.setOrder(order);
    this.registry.setGrouping(this.store.get().general.railGrouping);
    this.controller = this.createController(boot);
    this.registry.onChange(() => this.changed());
    this.store.changed.on(({ patch }) => {
      if (patch.general?.railGrouping !== undefined) this.registry.setGrouping(this.store.get().general.railGrouping);
    });

    const rules = configurableModules(this.modules);
    const { platforms, errors } = loadPlatforms(() => this.platformsText, rules);
    for (const error of errors) console.warn(`[platforms] ${error}`);
    for (const def of platforms) {
      const module = findModule(def.module, this.modules);
      if (module?.web) {
        await this.startWebService(def, module.manifest);
        continue;
      }
      if (!module?.manifest.engine) {
        console.warn(`[platforms] ${def.id}: module "${def.module}" does not run on this phone`);
        continue;
      }
      await this.startService(def, module.manifest);
    }
    this.running = true;
    const first = [...this.services.keys()][0];
    if (first) this.show(first);
    else this.setScreen({ page: "home" });
  }

  private persistence(boot: BootInfo): SettingsPersistence {
    return {
      read: () => (boot.files.settings === undefined ? undefined : JSON.parse(boot.files.settings)),
      write: (settings) => this.send({ type: "save", file: "settings", text: JSON.stringify(settings) }),
    };
  }

  private savePlatforms(text: string): void {
    this.platformsText = text;
    this.send({ type: "save", file: "platforms", text });
  }

  private createController(boot: BootInfo): SettingsController {
    const platformsConfig: PlatformsConfig = { read: () => this.platformsText, write: (text) => this.savePlatforms(text) };
    return new SettingsController({
      platformsConfig,
      modules: this.modules,
      store: this.store,
      adapters: this.services,
      // Secrets are under a Keystore key: they always persist.
      secretsPersistent: () => true,
      // "Start with your phone": native code reads it from the settings file at boot or after an update (BootReceiver).
      launchAtLoginSupported: true,
      version: boot.version,
      streaming: () => this.streaming(),
      openService: (id) => this.show(id),
      clearSession: async (id) => this.send({ type: "clearSession", instance: id }),
      forgetSecrets: (id) => this.send({ type: "forgetSecrets", instance: id }),
      restartService: (id) => this.send({ type: "restartEngine", instance: id }),
      restart: () => this.send({ type: "restart" }),
      publish: (state) => this.ui.settings(this.forPhone(state)),
      copyText: (text) => this.send({ type: "copyText", text: text.slice(0, MAX_COPY) }),
      os: boot.os,
    });
  }

  /** Only services whose module runs here: Discord's built-in entry stays out of sight. */
  private forPhone(state: SettingsViewState): SettingsViewState {
    const ids = new Set(this.modules.map((m) => m.manifest.id));
    return { ...state, services: state.services.filter((s) => ids.has(s.module)) };
  }

  private send(command: ShellCommand): void {
    this.bridge.send(command);
  }

  private general() {
    return this.store.get().general;
  }

  /** Streamer mode on a phone: only when turned on; there is nothing to detect. */
  private streaming(): boolean {
    return this.general().streamerMode === "on";
  }

  private notificationsOn(id: string): boolean {
    return this.general().notifications && serviceSettings(this.store.get(), id).notifications;
  }

  private settingValues(manifest: ModuleManifest, id: string): ServiceSettingValues {
    const values = serviceSettingValues(manifest.settings, serviceSettings(this.store.get(), id).options);
    if (manifest.sendsTyping) values[TYPING_SETTING] = typingIndicators(this.store.get(), id);
    return values;
  }

  private viewSettings(id: string): void {
    const limit = mediaAutoLoadLimit(this.store.get(), id);
    this.send({ type: "viewSettings", instance: id, mediaAutoLoad: Number.isFinite(limit) ? limit : null });
  }

  private async startService(def: PlatformDef, manifest: ModuleManifest): Promise<void> {
    const id = def.id;
    const adapter = new EngineAdapter(
      id,
      new URL(def.url).host,
      manifest.capabilities ?? NO_CAPABILITIES,
      (command) => this.send({ type: "command", instance: id, command }),
      manifest.home === true,
      "tap Restart beside it in Settings to try again",
    );
    this.adapters.set(id, adapter);
    this.services.set(id, adapter);
    this.manifests.set(id, manifest);
    this.defs.set(id, def);
    await this.registry.add(adapter, def.name, { label: manifest.label, color: manifest.color });
    const takesSettings = (manifest.settings?.length ?? 0) > 0 || manifest.sendsTyping === true;
    if (takesSettings) {
      this.store.changed.on(({ patch }) => {
        const typing = manifest.sendsTyping === true && patch.general?.typingIndicators !== undefined;
        if (typing || (patch.services && Object.hasOwn(patch.services, id))) adapter.applySettings(this.settingValues(manifest, id));
      });
    }
    if (manifest.holdsMedia) {
      this.store.changed.on(({ patch }) => {
        if (patch.general?.mediaAutoLoad !== undefined || (patch.services && Object.hasOwn(patch.services, id))) this.viewSettings(id);
      });
    }
    adapter.onNotification((n) => {
      if (n.inView && this.isFront(id)) return;
      this.notify(id, n, false);
    });
    adapter.onIncomingCall((call) => {
      if (this.isFront(id)) return;
      const railKey = `dm:${call.conversationKey}`;
      const n: PlatformNotification = { title: "Incoming call", body: `${call.from} is calling you on ${def.name}`, target: call.conversationKey };
      if (railKey.length <= MAX_KEY) n.railKey = railKey;
      this.notify(id, n, true);
    });
    adapter.onSettingsStatusChanged(() => this.refreshSettings());
    const start: ShellCommand = { type: "start", instance: id, module: def.module, name: def.name, url: def.url };
    if (takesSettings) start.settings = this.settingValues(manifest, id);
    this.send(start);
    if (manifest.holdsMedia) this.viewSettings(id);
  }

  /**
   * A web-client service: the service's own web app, which native code shows in a WebView of its own with
   * nothing injected. Its unread count comes from the page title, as on the desktop (GenericWebAdapter);
   * it has no notifications and no DMs here. Its address is https (platforms.json takes no other).
   */
  private async startWebService(def: PlatformDef, manifest: ModuleManifest): Promise<void> {
    const adapter = new GenericWebAdapter(def);
    this.webAdapters.set(def.id, adapter);
    this.services.set(def.id, adapter);
    this.manifests.set(def.id, manifest);
    this.defs.set(def.id, def);
    await this.registry.add(adapter, def.name, { label: manifest.label, color: manifest.color });
    this.send({ type: "start", instance: def.id, module: def.module, name: def.name, url: def.url });
  }

  /** Whether the user is looking at this service's view right now. */
  private isFront(id: string): boolean {
    return this.appVisible && !this.drawer && this.screen.page === "service" && this.screen.instance === id;
  }

  private notify(id: string, n: PlatformNotification, urgent: boolean): void {
    if (!this.notificationsOn(id)) return;
    const name = this.defs.get(id)!.name;
    // While streaming, a notification says that something happened, not who said what; each names its service.
    const shown = this.streaming()
      ? { title: urgent ? "Incoming call" : "New message", body: urgent ? `Someone is calling you on ${name}` : `On ${name}` }
      : { title: clip(`${n.title} · ${name}`, MAX_TEXT), body: clip(n.body, MAX_BODY_TEXT) };
    const command: ShellCommand = { type: "notify", instance: id, ...shown, target: n.target };
    if (n.railKey) command.railKey = n.railKey;
    if (urgent) command.urgent = true;
    this.send(command);
  }

  private async handle(event: NativeEvent): Promise<void> {
    switch (event.type) {
      case "engine":
        this.adapters.get(event.instance)?.handle(event.event);
        return;
      case "health": {
        const { state, restarts, lastExit } = event;
        this.adapters.get(event.instance)?.setEngineHealth(lastExit === undefined ? { state, responsive: true, restarts } : { state, responsive: true, restarts, lastExit });
        this.refreshSettings();
        return;
      }
      case "title":
        this.webAdapters.get(event.instance)?.updateTitle(event.title);
        return;
      case "appVisible":
        this.appVisible = event.visible;
        this.syncVisible();
        return;
      case "back":
        this.back();
        return;
      case "openNotification": {
        const { instance, target, railKey } = event;
        const n: PlatformNotification = railKey === undefined ? { title: "", body: "", target } : { title: "", body: "", target, railKey };
        try {
          const shown = await this.registry.openNotification(instance, n);
          if (shown) this.show(shown);
        } catch (error) {
          console.warn(`[${instance}] could not open a notification: ${(error as Error).message}`);
        }
        return;
      }
    }
  }

  // What the page asks for ------------------------------------------------------------------------------

  /** A tap on a drawer entry: groups only expand or collapse; anything else opens in its service. */
  async open(key: string): Promise<void> {
    try {
      const shown = await this.registry.open(key);
      if (shown) this.show(shown);
    } catch (error) {
      console.warn(`[drawer] could not open ${key}: ${(error as Error).message}`);
    }
  }

  /**
   * Opens or closes the unified Messages list. Closing goes back to the service shown last, as the
   * settings page does.
   */
  setMessagesOpen(open: boolean): void {
    this.drawer = false;
    if (open) return this.setScreen({ page: "messages" });
    if (this.lastService) this.show(this.lastService);
    else this.setScreen({ page: "home" });
  }

  /** A tap in the Messages list: the conversation opens in its service's chat view. Only keys the list holds. */
  async openConversation(key: string): Promise<void> {
    if (!this.registry.conversations().some((c) => c.key === key)) return;
    await this.open(key);
  }

  /** Shows a service's chat view. */
  show(id: string): void {
    if (!this.services.has(id)) return;
    this.lastService = id;
    this.drawer = false;
    this.setScreen({ page: "service", instance: id });
  }

  setDrawer(open: boolean): void {
    if (open === this.drawer) return;
    this.drawer = open;
    this.changed();
  }

  setSettingsOpen(open: boolean): void {
    this.drawer = false;
    if (open) {
      this.setScreen({ page: "settings" });
      this.controller.refresh(true);
      return;
    }
    if (this.lastService) this.show(this.lastService);
    else this.setScreen({ page: "home" });
  }

  settingsReady(): void {
    this.controller.refresh(true);
  }

  async settingsAction(action: unknown): Promise<void> {
    if (isSettingsAction(action)) await this.controller.handle(action);
  }

  /** Back: closes the drawer, then the settings page; else native code leaves the app. */
  back(): void {
    if (this.drawer) return this.setDrawer(false);
    if ((this.screen.page === "settings" || this.screen.page === "messages") && this.lastService) return this.setSettingsOpen(false);
    this.send({ type: "backUnhandled" });
  }

  private setScreen(screen: Screen): void {
    this.screen = screen;
    this.changed();
  }

  private refreshSettings(): void {
    if (this.screen.page === "settings") this.controller.refresh();
  }

  /** Something on screen changed: tell native code what to show, the engines whether they are seen, and the page what to draw. */
  private changed(): void {
    if (!this.running) return;
    const instance = this.screen.page === "service" ? this.screen.instance : null;
    const layout = JSON.stringify([instance, instance !== null && this.drawer]);
    if (layout !== this.lastLayout) {
      this.lastLayout = layout;
      this.send({ type: "layout", instance, overlay: instance !== null && this.drawer });
    }
    this.syncVisible();
    const { mentions, unread } = this.registry.totals();
    const conversations = this.registry.conversations();
    if (mentions !== this.lastBadge) {
      this.lastBadge = mentions;
      this.send({ type: "badge", count: Math.min(mentions, 1_000_000) });
    }
    this.refreshSettings();
    this.ui.render({
      rail: this.registry.state(),
      screen: this.screen,
      drawer: this.drawer,
      title: TITLES[this.screen.page] ?? this.defs.get(instance!)!.name,
      mentions,
      unread,
      services: [...this.defs.values()].map((def) => {
        const manifest = this.manifests.get(def.id)!;
        return { id: def.id, name: def.name, label: manifest.label, color: manifest.color };
      }),
      // While streaming, the list says who wrote, never what (as on the desktop).
      messages: { conversations: this.streaming() ? conversations.map(({ preview: _preview, ...c }) => c) : conversations, activeKey: this.registry.activeKeyValue },
      messagesBadge: { unread: conversations.some((c) => c.unread), mentions: conversations.reduce((sum, c) => sum + c.mentions, 0) },
    });
  }

  /** Engines learn whether their view is on screen, as on the desktop; only when it changes. */
  private syncVisible(): void {
    for (const [id, adapter] of this.adapters) {
      const visible = this.appVisible && this.screen.page === "service" && this.screen.instance === id;
      if (this.visibleSent.get(id) === visible) continue;
      this.visibleSent.set(id, visible);
      adapter.setVisible(visible);
    }
  }
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
