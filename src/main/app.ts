import fs from "node:fs";
import path from "node:path";
import {
  app,
  BaseWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  session,
  shell,
  Tray,
  WebContentsView,
  type IpcMainEvent,
  type Session,
} from "electron";
import {
  IPC,
  isPickerChoice,
  isRailKey,
  isRailOrder,
  isTooltipRequest,
  type PickerChoice,
  type PickerRequest,
} from "../shared/ipc";
import type { PlatformAdapter } from "../shared/adapter";
import { isSettingsAction, SETTINGS_IPC, type SettingsViewState } from "../shared/settings";
import { CredentialStore } from "./credentials";
import type { GatewaySocket } from "./fluxer/gateway";
import { computeLayout, tooltipBounds } from "./layout";
import { configurableModules, findModule, MODULES } from "./modules/index";
import type { PlatformModule, ShellServices } from "./modules/types";
import { loadPlatforms } from "./platforms";
import { PlatformRegistry } from "./registry";
import { createDisplayMediaHandler } from "./screenShare";
import { SettingsController } from "./settingsController";
import { SettingsStore } from "./settingsStore";
import { decideWindowOpen, isPermissionAllowed } from "./sessionPolicy";
import { toChromeUserAgent } from "./userAgent";
import { parseWindowState, serializeWindowState } from "./windowState";

export const APP_NAME = "Multicord";
/** In memory only: the settings page keeps nothing. */
const SETTINGS_PARTITION = "multicord-settings";

export interface ShellPaths {
  /** Directory holding the built JS, HTML and icon. */
  dist: string;
  /** Where platforms.json and window-state.json live. */
  userData: string;
}

function parseJson(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function secureView(preload?: string, partition?: string): WebContentsView {
  return new WebContentsView({
    webPreferences: { preload, partition, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
}

/** Platform sessions; notifications follow the user's setting at the time they are asked for. */
export function configureSession(ses: Session, notificationsAllowed: () => boolean = () => true): void {
  const allowed = (permission: string): boolean =>
    isPermissionAllowed(permission) && (permission !== "notifications" || notificationsAllowed());
  ses.setUserAgent(toChromeUserAgent(ses.getUserAgent(), APP_NAME));
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed(permission));
}

/** The settings page's own session: it may use the microphone and camera for device tests, nothing else. */
function configureSettingsSession(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media"));
  ses.setPermissionCheckHandler((_wc, permission) => permission === "media");
}

/** Shows our screen share picker as an overlay and resolves with the user's choice. */
export function showPicker(window: BaseWindow, dist: string, request: PickerRequest): Promise<PickerChoice | null> {
  const view = secureView(path.join(dist, "preload-shell.js"));
  const { width, height } = window.getContentBounds();
  view.setBounds({ x: 0, y: 0, width, height });
  window.contentView.addChildView(view);
  view.webContents.once("did-finish-load", () => view.webContents.send(IPC.pickerSources, request));
  void view.webContents.loadFile(path.join(dist, "picker.html"));

  return new Promise((resolve) => {
    const onChoose = (event: IpcMainEvent, choice: unknown): void => {
      if (event.sender !== view.webContents || !isPickerChoice(choice)) return;
      ipcMain.removeListener(IPC.pickerChoose, onChoose);
      window.contentView.removeChildView(view);
      view.webContents.close();
      resolve(choice);
    };
    ipcMain.on(IPC.pickerChoose, onChoose);
  });
}

export interface ShellHandle {
  window: BaseWindow;
  railView: WebContentsView;
  tooltipView: WebContentsView;
  views: Map<string, WebContentsView>;
  adapters: Map<string, PlatformAdapter>;
  registry: PlatformRegistry;
  settings: SettingsController;
  settingsStore: SettingsStore;
  /** Created when the settings page is first opened. */
  settingsView(): WebContentsView | undefined;
  setSettingsOpen(open: boolean): void;
  show(): void;
  setQuitting(): void;
  layout(): void;
}

const defaultServices = (): ShellServices => ({
  fetch: globalThis.fetch,
  createSocket: (url) => new WebSocket(url) as unknown as GatewaySocket,
  secrets: safeStorage,
});

export async function createShell(
  paths: ShellPaths,
  platform: NodeJS.Platform = process.platform,
  services: ShellServices = defaultServices(),
  modules: readonly PlatformModule[] = MODULES,
): Promise<ShellHandle> {
  const { platforms, errors } = loadPlatforms(
    () => readOptional(path.join(paths.userData, "platforms.json")),
    configurableModules(modules),
  );
  for (const error of errors) console.warn(`[platforms] ${error}`);

  const stateFile = path.join(paths.userData, "window-state.json");
  const saved = parseWindowState(readOptional(stateFile));
  const window = new BaseWindow({
    title: APP_NAME,
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: "#1e1f22",
  });
  if (saved.maximized) window.maximize();

  const railView = secureView(path.join(paths.dist, "preload-shell.js"));
  railView.webContents.on("will-navigate", (event) => event.preventDefault());
  window.contentView.addChildView(railView);

  const registry = new PlatformRegistry();
  // The server order is the app's own, across platforms; restore it before platforms register.
  const orderFile = path.join(paths.userData, "rail-order.json");
  const savedOrder = parseJson(readOptional(orderFile));
  if (isRailOrder(savedOrder)) registry.setOrder(savedOrder);
  const views = new Map<string, WebContentsView>();
  const adapters = new Map<string, PlatformAdapter>();
  const credentials = new CredentialStore(path.join(paths.userData, "credentials.json"), services.secrets);
  const settingsStore = new SettingsStore(path.join(paths.userData, "settings.json"));
  const general = () => settingsStore.get().general;
  let activePlatform = platforms[0]!.id;
  let settingsOpen = false;
  let settingsView: WebContentsView | undefined;
  let quitting = false;

  const layout = (): void => {
    const { width, height } = window.getContentBounds();
    const { rail, content } = computeLayout(width, height);
    railView.setBounds(rail);
    for (const [id, view] of views) {
      const shown = !settingsOpen && id === activePlatform;
      view.setBounds(content);
      view.setVisible(shown);
      adapters.get(id)?.setVisible?.(shown);
    }
    settingsView?.setBounds(content);
    settingsView?.setVisible(settingsOpen);
  };

  /** Screen share goes through our picker, as the web clients have none of their own here. */
  const handleScreenShare = (ses: Session): void =>
    ses.setDisplayMediaRequestHandler(
      createDisplayMediaHandler({
        getSources: () => desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } }),
        pick: (request) => showPicker(window, paths.dist, request),
        platform,
      }),
    );

  for (const def of platforms) {
    const module = findModule(def.module, modules);
    if (!module) {
      console.warn(`[platforms] ${def.id}: unknown module "${def.module}"`);
      continue;
    }
    const ses = session.fromPartition(def.partition);
    configureSession(ses, () => general().notifications);
    const { preload } = module.manifest;
    const view = secureView(preload && path.join(paths.dist, preload), def.partition);
    view.webContents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url, def.url);
      if (decision === "external") void shell.openExternal(url);
      return { action: decision === "allow" ? "allow" : "deny" };
    });
    views.set(def.id, view);
    window.contentView.addChildView(view);

    const { adapter, start } = module.load({
      def,
      view,
      session: ses,
      window,
      dist: paths.dist,
      platform,
      services,
      secrets: credentials,
      enableScreenShare: () => handleScreenShare(ses),
    });
    adapters.set(def.id, adapter);
    await registry.add(adapter, def.name, { label: module.manifest.label, color: module.manifest.color });
    if (module.manifest.usesVoiceSettings) {
      const sendVoice = (): void => view.webContents.send(SETTINGS_IPC.voice, settingsStore.get().voice);
      view.webContents.on("did-finish-load", sendVoice);
      settingsStore.changed.on(({ patch }) => {
        if (patch.voice) sendVoice();
      });
    }
    start();
  }

  // Added after the platform views so it draws on top of them.
  const tooltipView = secureView(path.join(paths.dist, "preload-shell.js"));
  tooltipView.setBackgroundColor("#00000000");
  tooltipView.setVisible(false);
  tooltipView.webContents.on("will-navigate", (event) => event.preventDefault());
  window.contentView.addChildView(tooltipView);
  void tooltipView.webContents.loadFile(path.join(paths.dist, "tooltip.html"));

  const hideTooltip = (): void => tooltipView.setVisible(false);
  ipcMain.on(IPC.railTooltip, (event, request) => {
    if (event.sender !== railView.webContents || !isTooltipRequest(request)) return;
    if (request === null) return hideTooltip();
    tooltipView.setBounds(tooltipBounds(request.y, window.getContentBounds().height));
    tooltipView.webContents.send(IPC.tooltipShow, request.text);
    tooltipView.setVisible(true);
  });
  window.on("blur", hideTooltip);

  let lastMentions = 0;
  const publish = (): void => {
    railView.webContents.send(IPC.railState, { ...registry.state(), settingsOpen });
    const { mentions } = registry.totals();
    window.setTitle(mentions > 0 ? `(${mentions}) ${APP_NAME}` : APP_NAME);
    app.setBadgeCount(mentions);
    if (mentions > lastMentions && !window.isFocused()) window.flashFrame(true);
    lastMentions = mentions;
  };
  registry.onChange(publish);

  const show = (): void => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  /** Shows a platform's view in front, leaving the settings page. */
  const showPlatform = (id: string): void => {
    activePlatform = id;
    settingsOpen = false;
    layout();
    publish();
  };

  const settings = new SettingsController({
    platformsFile: path.join(paths.userData, "platforms.json"),
    modules,
    store: settingsStore,
    adapters,
    secretsPersistent: () => credentials.persistent,
    launchAtLoginSupported: platform !== "linux",
    version: app.getVersion(),
    openService: showPlatform,
    clearSession: async (id) => {
      await session.fromPartition(`persist:${id}`).clearStorageData();
      views.get(id)?.webContents.reload();
    },
    forgetSecrets: (id) => credentials.deletePrefix(`${id}:`),
    restart: () => {
      quitting = true;
      app.relaunch();
      app.quit();
    },
    publish: (state: SettingsViewState) => settingsView?.webContents.send(SETTINGS_IPC.state, state),
  });

  settingsStore.changed.on(({ settings: next, patch }) => {
    if (patch.general?.launchAtLogin === undefined || platform === "linux") return;
    // Unpackaged (development) runs need the app path, or Electron starts without the app.
    app.setLoginItemSettings({ openAtLogin: next.general.launchAtLogin, ...(app.isPackaged ? {} : { args: [app.getAppPath()] }) });
  });
  // Account states change as platforms connect; keep an open settings page current.
  registry.onChange(() => {
    if (settingsOpen) settings.refresh();
  });

  const setSettingsOpen = (open: boolean): void => {
    if (open && !settingsView) {
      configureSettingsSession(session.fromPartition(SETTINGS_PARTITION));
      settingsView = secureView(path.join(paths.dist, "preload-settings.js"), SETTINGS_PARTITION);
      settingsView.webContents.on("will-navigate", (event) => event.preventDefault());
      settingsView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      // Above the platform views, below the tooltip overlay.
      window.contentView.removeChildView(tooltipView);
      window.contentView.addChildView(settingsView);
      window.contentView.addChildView(tooltipView);
      void settingsView.webContents.loadFile(path.join(paths.dist, "settings.html"));
    }
    settingsOpen = open;
    layout();
    publish();
    if (open) settings.refresh(true);
  };

  ipcMain.on(IPC.railSettings, (event, open) => {
    if (event.sender === railView.webContents && typeof open === "boolean") setSettingsOpen(open);
  });
  ipcMain.on(SETTINGS_IPC.ready, (event) => {
    if (settingsView && event.sender === settingsView.webContents) settings.refresh(true);
  });
  ipcMain.on(SETTINGS_IPC.action, (event, action) => {
    if (!settingsView || event.sender !== settingsView.webContents || !isSettingsAction(action)) return;
    void settings.handle(action);
  });

  ipcMain.on(IPC.railReorder, (event, keys) => {
    if (event.sender !== railView.webContents || !isRailOrder(keys)) return;
    registry.setOrder(keys);
    fs.mkdirSync(paths.userData, { recursive: true });
    fs.writeFileSync(orderFile, JSON.stringify(registry.getOrder()));
  });
  ipcMain.on(IPC.railReady, (event) => {
    if (event.sender === railView.webContents) publish();
  });
  ipcMain.on(IPC.railOpen, async (event, key) => {
    if (event.sender !== railView.webContents || !isRailKey(key)) return;
    try {
      const target = await registry.open(key);
      if (target) showPlatform(target);
    } catch (error) {
      console.warn(`[rail] could not open ${key}: ${(error as Error).message}`);
    }
  });

  window.on("resize", layout);
  window.on("close", (event) => {
    fs.mkdirSync(paths.userData, { recursive: true });
    fs.writeFileSync(stateFile, serializeWindowState(window.getNormalBounds(), window.isMaximized()));
    if (quitting || !general().closeToTray) return;
    event.preventDefault();
    window.hide();
  });

  // Native adapters' notifications; Discord's own page shows its notifications itself.
  // Shown notifications stay referenced so their click handlers survive GC.
  const shownNotifications = new Set<Notification>();
  for (const [id, adapter] of adapters) {
    adapter.onNotification((n) => {
      if (!general().notifications) return;
      if (n.inView && window.isFocused() && activePlatform === id && !settingsOpen) return;
      if (!Notification.isSupported()) return;
      const note = new Notification({ title: n.title, body: n.body });
      shownNotifications.add(note);
      note.on("close", () => shownNotifications.delete(note));
      note.on("click", () => {
        shownNotifications.delete(note);
        show();
        registry
          .openNotification(id, n)
          .then((target) => {
            if (target) showPlatform(target);
          })
          .catch((error: Error) => console.warn(`[${id}] could not open notification: ${error.message}`));
      });
      note.show();
    });
  }

  const tray = new Tray(nativeImage.createFromPath(path.join(paths.dist, "icon.png")));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Show ${APP_NAME}`, click: show },
      {
        label: "Settings",
        click: () => {
          show();
          setSettingsOpen(true);
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", show);

  void railView.webContents.loadFile(path.join(paths.dist, "rail.html"));
  layout();

  return {
    window,
    railView,
    tooltipView,
    views,
    adapters,
    registry,
    settings,
    settingsStore,
    settingsView: () => settingsView,
    setSettingsOpen,
    show,
    setQuitting: () => {
      quitting = true;
    },
    layout,
  };
}

/** Lifecycle: single instance, tray-resident window, quit only from the tray or OS. */
export function startApp(dist: string): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setName(APP_NAME);

  let handle: ShellHandle | undefined;
  app.on("second-instance", () => handle?.show());
  app.on("activate", () => handle?.show());
  app.on("before-quit", () => handle?.setQuitting());

  void app.whenReady().then(async () => {
    handle = await createShell({ dist, userData: app.getPath("userData") });
  });
}
