import fs from "node:fs";
import path from "node:path";
import {
  app,
  BaseWindow,
  desktopCapturer,
  dialog,
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
  isDiscordState,
  isPickerChoice,
  isRailKey,
  isTooltipRequest,
  type PickerChoice,
  type PickerRequest,
} from "../shared/ipc";
import type { PlatformAdapter } from "../shared/adapter";
import { isNativeAction, NATIVE_IPC } from "../shared/native";
import { DiscordAdapter } from "./adapters/discordAdapter";
import { FluxerAdapter } from "./adapters/fluxerAdapter";
import { GenericWebAdapter } from "./adapters/genericWebAdapter";
import { CredentialStore, type SecretBox } from "./credentials";
import { uploadSource } from "./files";
import type { GatewaySocket, SocketFactory } from "./fluxer/gateway";
import { computeLayout, tooltipBounds } from "./layout";
import { loadPlatforms } from "./platforms";
import { PlatformRegistry } from "./registry";
import { createDisplayMediaHandler } from "./screenShare";
import { decideWindowOpen, isPermissionAllowed } from "./sessionPolicy";
import { toChromeUserAgent } from "./userAgent";
import { parseWindowState, serializeWindowState } from "./windowState";

export const APP_NAME = "Multicord";

export interface ShellPaths {
  /** Directory holding the built JS, HTML and icon. */
  dist: string;
  /** Where platforms.json and window-state.json live. */
  userData: string;
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

export function configureSession(ses: Session): void {
  ses.setUserAgent(toChromeUserAgent(ses.getUserAgent(), APP_NAME));
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(isPermissionAllowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => isPermissionAllowed(permission));
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
  show(): void;
  setQuitting(): void;
  layout(): void;
}

/** Network and secret-store access for native adapters; replaceable in tests. */
export interface ShellServices {
  fetch: typeof fetch;
  createSocket: SocketFactory;
  secrets: SecretBox;
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
): Promise<ShellHandle> {
  const { platforms, errors } = loadPlatforms(() => readOptional(path.join(paths.userData, "platforms.json")));
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
  const views = new Map<string, WebContentsView>();
  const adapters = new Map<string, PlatformAdapter>();
  const credentials = new CredentialStore(path.join(paths.userData, "credentials.json"), services.secrets);
  let activePlatform = platforms[0]!.id;
  let quitting = false;

  const layout = (): void => {
    const { width, height } = window.getContentBounds();
    const { rail, content } = computeLayout(width, height);
    railView.setBounds(rail);
    for (const [id, view] of views) {
      view.setBounds(content);
      view.setVisible(id === activePlatform);
      adapters.get(id)?.setVisible?.(id === activePlatform);
    }
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
    const ses = session.fromPartition(def.partition);
    configureSession(ses);
    const preload = { discord: "preload-discord.js", fluxer: "preload-native.js", web: undefined }[def.kind];
    const view = secureView(preload && path.join(paths.dist, preload), def.partition);
    view.webContents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url, def.url);
      if (decision === "external") void shell.openExternal(url);
      return { action: decision === "allow" ? "allow" : "deny" };
    });
    views.set(def.id, view);
    window.contentView.addChildView(view);

    if (def.kind === "discord") {
      const adapter = new DiscordAdapter((target) => view.webContents.send(IPC.discordNavigate, target));
      ipcMain.on(IPC.discordState, (event, state) => {
        if (event.sender === view.webContents && isDiscordState(state)) adapter.update(state);
      });
      handleScreenShare(ses);
      adapters.set(def.id, adapter);
      await registry.add(adapter, def.name);
      void view.webContents.loadURL(def.url);
    } else if (def.kind === "fluxer") {
      const adapter = new FluxerAdapter({
        def,
        fetch: services.fetch,
        createSocket: services.createSocket,
        secrets: credentials,
        render: (state) => view.webContents.send(NATIVE_IPC.state, state),
        platform,
        files: {
          pick: async () => {
            const result = await dialog.showOpenDialog(window, { title: "Attach files", properties: ["openFile", "multiSelections"] });
            return result.canceled ? [] : result.filePaths;
          },
          open: uploadSource,
        },
      });
      ipcMain.on(NATIVE_IPC.action, (event, action) => {
        if (event.sender !== view.webContents || !isNativeAction(action)) return;
        adapter.handleAction(action).catch((error: Error) => console.warn(`[${def.id}] ${error.message}`));
      });
      // Our own page: links in messages open in the browser, never in the app.
      view.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        if (decideWindowOpen(url, "file:///") === "external") void shell.openExternal(url);
      });
      handleScreenShare(ses); // for Fluxer voice
      adapters.set(def.id, adapter);
      await registry.add(adapter, def.name);
      void view.webContents.loadFile(path.join(paths.dist, "native.html"));
      void adapter.start();
    } else {
      const adapter = new GenericWebAdapter(def);
      view.webContents.on("page-title-updated", (_event, title) => adapter.updateTitle(title));
      adapters.set(def.id, adapter);
      await registry.add(adapter, def.name);
      void view.webContents.loadURL(def.url);
    }
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
    railView.webContents.send(IPC.railState, registry.state());
    const { mentions } = registry.totals();
    window.setTitle(mentions > 0 ? `(${mentions}) ${APP_NAME}` : APP_NAME);
    app.setBadgeCount(mentions);
    if (mentions > lastMentions && !window.isFocused()) window.flashFrame(true);
    lastMentions = mentions;
  };
  registry.onChange(publish);

  ipcMain.on(IPC.railReady, (event) => {
    if (event.sender === railView.webContents) publish();
  });
  ipcMain.on(IPC.railOpen, async (event, key) => {
    if (event.sender !== railView.webContents || !isRailKey(key)) return;
    try {
      const target = await registry.open(key);
      if (target) {
        activePlatform = target;
        layout();
      }
    } catch (error) {
      console.warn(`[rail] could not open ${key}: ${(error as Error).message}`);
    }
  });

  window.on("resize", layout);
  window.on("close", (event) => {
    fs.mkdirSync(paths.userData, { recursive: true });
    fs.writeFileSync(stateFile, serializeWindowState(window.getNormalBounds(), window.isMaximized()));
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });

  const show = (): void => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  // Native adapters' notifications; Discord's own page shows its notifications itself.
  // Shown notifications stay referenced so their click handlers survive GC.
  const shownNotifications = new Set<Notification>();
  for (const [id, adapter] of adapters) {
    adapter.onNotification((n) => {
      if (n.inView && window.isFocused() && activePlatform === id) return;
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
            if (!target) return;
            activePlatform = target;
            layout();
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
