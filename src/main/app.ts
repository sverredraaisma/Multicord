import fs from "node:fs";
import path from "node:path";
import {
  app,
  BaseWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  WebContentsView,
  type IpcMainEvent,
  type Session,
} from "electron";
import { IPC, isDiscordState, isPickerChoice, isRailKey, type PickerChoice, type PickerRequest } from "../shared/ipc";
import { DiscordAdapter } from "./adapters/discordAdapter";
import { GenericWebAdapter } from "./adapters/genericWebAdapter";
import { computeLayout } from "./layout";
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
  views: Map<string, WebContentsView>;
  registry: PlatformRegistry;
  show(): void;
  setQuitting(): void;
  layout(): void;
}

export async function createShell(paths: ShellPaths, platform: NodeJS.Platform = process.platform): Promise<ShellHandle> {
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
  let activePlatform = platforms[0]!.id;
  let quitting = false;

  const layout = (): void => {
    const { width, height } = window.getContentBounds();
    const { rail, content } = computeLayout(width, height);
    railView.setBounds(rail);
    for (const [id, view] of views) {
      view.setBounds(content);
      view.setVisible(id === activePlatform);
    }
  };

  for (const def of platforms) {
    const ses = session.fromPartition(def.partition);
    configureSession(ses);
    const view = secureView(def.kind === "discord" ? path.join(paths.dist, "preload-discord.js") : undefined, def.partition);
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
      ses.setDisplayMediaRequestHandler(
        createDisplayMediaHandler({
          getSources: () =>
            desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } }),
          pick: (request) => showPicker(window, paths.dist, request),
          platform,
        }),
      );
      await registry.add(adapter, def.name);
    } else {
      const adapter = new GenericWebAdapter(def);
      view.webContents.on("page-title-updated", (_event, title) => adapter.updateTitle(title));
      await registry.add(adapter, def.name);
    }
    void view.webContents.loadURL(def.url);
  }

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
    views,
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
