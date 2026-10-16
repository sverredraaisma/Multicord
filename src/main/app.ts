import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BaseWindow,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  WebContentsView,
  type IpcMainEvent,
  type Session,
} from "electron";
import { autoUpdater } from "electron-updater";
import {
  IPC,
  type MessagesState,
  isPickerChoice,
  isRailKey,
  isRailOrder,
  isTooltipRequest,
  type PickerChoice,
  type PickerRequest,
} from "../shared/ipc";
import type { ActivityUpdate, HealthCheck, PlatformAdapter, PlatformNotification } from "../shared/adapter";
import { ENGINE_SCHEME } from "../shared/engine";
import { FAVOURITES_IPC, isFavouritesAction, MEDIA_SCHEME, type FavouritesState } from "../shared/favourites";
import { isSettingsAction, mediaAutoLoadLimit, serviceSettings, serviceSettingValues, SETTINGS_IPC, stepZoom, TYPING_SETTING, typingIndicators, zoomShortcut, type SettingsViewState } from "../shared/settings";
import { CredentialStore } from "./credentials";
import { EngineHub, engineStoragePartition } from "./engineHost";
import { downloadMedia, FavouritesStore } from "./favourites";
import { checkUrl, createAddressGuard, isPrivateHost } from "./netPolicy";
import { createServiceReach } from "./serviceReach";
import { filterShellRequests, installHardening } from "./hardening";
import { computeLayout, splitContent, tooltipBounds } from "../core/layout";
import { configurableModules, findModule, MODULES } from "./modules/index";
import type { PlatformModule, ShellServices } from "./modules/types";
import { loadPlatforms, type PlatformDef } from "./platforms";
import { PlatformRegistry } from "../core/registry";
import { BADGE_SIZE, badgeBitmap } from "./badge";
import { createDisplayMediaHandler } from "./screenShare";
import { SettingsController } from "./settingsController";
import { SettingsStore } from "./settingsStore";
import { HealthWatch } from "./healthWatch";
import { loadVenmic, SystemAudio } from "./systemAudio";
import { GlobalPushToTalk, loadKeyHook } from "./pushToTalk";
import { createRichPresence } from "./richPresence";
import { createGameDetector, DETECTED_SOURCE } from "./gameDetection";
import { GlobalShortcuts, inputModifiers } from "./shortcuts";
import { inputKeyCode } from "../shared/keys";
import { listProcesses, StreamerWatch } from "./streamer";
import { Updater } from "./updater";
import { decideWindowOpen, isPermissionAllowed, isPlatformPage } from "./sessionPolicy";
import { toChromeUserAgent } from "./userAgent";
import { parseWindowState, serializeWindowState } from "./windowState";

export const APP_NAME = "Multicord";
/** In memory only: the shell's own pages keep nothing. */
const SETTINGS_PARTITION = "multicord-settings";
const MESSAGES_PARTITION = "multicord-messages";
/** Downloads for the favourites: in memory, cookie-less, and nothing else uses it. */
const FAVOURITES_PARTITION = "multicord-favourites";

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

/**
 * Platform sessions: permissions only for the platform's own pages, and
 * notifications as the user's settings say at the time they are asked for.
 */
export function configureSession(
  ses: Session,
  platformUrl: string,
  notificationsAllowed: () => boolean = () => true,
  /** Multicord's own page shown in the view (native modules), which gets the platform's permissions too. */
  ownPage?: string,
): void {
  const page = (url: string | undefined): boolean => isPlatformPage(url, platformUrl) || (ownPage !== undefined && url !== undefined && url.split(/[?#]/)[0] === ownPage);
  const allowed = (permission: string, url: string | undefined): boolean =>
    page(url) && isPermissionAllowed(permission) && (permission !== "notifications" || notificationsAllowed());
  ses.setUserAgent(toChromeUserAgent(ses.getUserAgent(), APP_NAME));
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed(permission, details.requestingUrl)));
  // Checks name the frame's URL in details; its origin alone says nothing for file: pages.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => allowed(permission, details?.requestingUrl ?? requestingOrigin));
}

/**
 * A shell page's own session. Only the settings page gets a permission
 * ("media", for device tests); the Messages page gets none.
 */
function configurePageSession(ses: Session, allowed: readonly string[]): void {
  filterShellRequests(ses);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.includes(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));
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
  /** Created when the Messages page is first opened. */
  messagesView(): WebContentsView | undefined;
  setMessagesOpen(open: boolean): void;
  /** Opens an app link (e.g. discord://) in the module that declares its scheme; false if none does. */
  openLink(url: string): Promise<boolean>;
  show(): void;
  setQuitting(): void;
  layout(): void;
}

const defaultServices = (): ShellServices => ({ secrets: safeStorage });

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
  const favourites = createFavourites(paths.userData);
  const general = () => settingsStore.get().general;
  /** Notifications from this service: on in general and not turned off for it. */
  const notificationsOn = (id: string): boolean => general().notifications && serviceSettings(settingsStore.get(), id).notifications;
  /** One service's values for the settings its module declares, checked against them: stored values are untrusted. */
  const settingValues = (manifest: PlatformModule["manifest"], id: string) => {
    const values = serviceSettingValues(manifest.settings, serviceSettings(settingsStore.get(), id).options);
    // The shell's own setting, beside the module's: whether this service sends typing indicators.
    if (manifest.sendsTyping) values[TYPING_SETTING] = typingIndicators(settingsStore.get(), id);
    return values;
  };
  /** Modules that get settings values: those declaring fields, and those sending typing indicators. */
  const takesSettings = (manifest: PlatformModule["manifest"]): boolean => (manifest.settings?.length ?? 0) > 0 || manifest.sendsTyping === true;
  let activePlatform = platforms[0]!.id;
  /** What the content area shows: a platform, the settings page, or the Messages list beside a conversation. */
  let mode: "platform" | "settings" | "messages" = "platform";
  let settingsView: WebContentsView | undefined;
  let messagesView: WebContentsView | undefined;
  /** The platform whose conversation is open beside the Messages list. */
  let messagesTarget: string | undefined;
  const front = (): string | undefined => (mode === "platform" ? activePlatform : mode === "messages" ? messagesTarget : undefined);
  let quitting = false;
  registry.setGrouping(general().railGrouping);
  // A Flatpak cannot replace itself; it updates by installing a newer bundle.
  const updater = new Updater(autoUpdater, app.isPackaged && !process.env.FLATPAK_ID);
  const streamer = new StreamerWatch(() => listProcesses(platform));
  /** Streamer mode: message content stays out of notifications and previews. */
  const streaming = (): boolean => general().streamerMode === "on" || (general().streamerMode === "auto" && streamer.active);
  if (general().streamerMode === "auto") streamer.start();

  /** Platform views and our own pages share the zoom setting and its keyboard shortcuts. */
  const contentViews = new Set<WebContentsView>();
  const platformSessions: Session[] = [];
  const prepareContentView = (view: WebContentsView): void => {
    contentViews.add(view);
    const applyZoom = (): void => view.webContents.setZoomFactor(general().zoom);
    applyZoom();
    view.webContents.on("did-finish-load", applyZoom);
    view.webContents.on("before-input-event", (event, input) => {
      const step = zoomShortcut(input);
      if (step === undefined) return;
      event.preventDefault();
      settingsStore.update({ general: { zoom: step === 0 ? 1 : stepZoom(general().zoom, step) } });
    });
  };

  const layout = (): void => {
    const { width, height } = window.getContentBounds();
    const { rail, content } = computeLayout(width, height);
    railView.setBounds(rail);
    const { list, conversation } = splitContent(content);
    const shownPlatform = front();
    for (const [id, view] of views) {
      const shown = id === shownPlatform;
      view.setBounds(mode === "messages" ? conversation : content);
      view.setVisible(shown);
      adapters.get(id)?.setVisible?.(shown);
    }
    settingsView?.setBounds(content);
    settingsView?.setVisible(mode === "settings");
    // Until a conversation is picked, the list has the whole content area.
    messagesView?.setBounds(messagesTarget ? list : content);
    messagesView?.setVisible(mode === "messages");
  };

  // Linux screen-share sound: venmic, leaving out every process of ours.
  const systemAudio = new SystemAudio(loadVenmic, () => app.getAppMetrics().map((m) => m.pid));
  ipcMain.on(IPC.screenAudioEnd, (event) => {
    if ([...views.values()].some((view) => view.webContents === event.sender)) systemAudio.stop();
  });

  /** Screen share goes through our picker, as the web clients have none of their own here. */
  const handleScreenShare = (ses: Session): void =>
    ses.setDisplayMediaRequestHandler(
      createDisplayMediaHandler({
        getSources: () => desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } }),
        pick: (request) => showPicker(window, paths.dist, request),
        platform,
        osRelease: os.release(),
        systemAudio: platform === "linux" ? systemAudio : undefined,
      }),
    );

  /** Each running platform's module manifest. */
  const manifests = new Map<string, PlatformModule["manifest"]>();
  /** The module of a native view, as its favourites say where things come from. */
  const moduleOf = (id: string): FavouritesState["module"] | undefined => {
    const manifest = manifests.get(id);
    return manifest?.engine ? { name: manifest.name, label: manifest.label, color: manifest.color } : undefined;
  };
  const sendFavourites = (id: string, view: WebContentsView): void => {
    const module = moduleOf(id);
    if (module) view.webContents.send(FAVOURITES_IPC.state, favourites.state(module));
  };
  favourites.changed.on(() => {
    for (const [id, view] of views) sendFavourites(id, view);
  });
  // A native view's favourites actions; the view must be one of ours, and it may send only into its own engine.
  ipcMain.on(FAVOURITES_IPC.action, (event, action) => {
    const id = [...views].find(([, view]) => view.webContents === event.sender)?.[0];
    const module = id === undefined ? undefined : moduleOf(id);
    if (!module || !isFavouritesAction(action)) return;
    // A native view exists only once its engine does.
    const hub = engines!;
    void favourites.handle(action, {
      source: { platform: module.name, label: module.label, color: module.color },
      hosts: hub.hostsFor(event.sender),
      share: (file, replyTo) => void hub.shareFile(event.sender, { path: file.path, size: file.size, name: file.name, type: file.mime }, replyTo),
    });
  });
  let engines: EngineHub | undefined;
  /** A native module: its logic runs in a sandboxed engine and renders in our chat view. */
  const startEngineModule = (manifest: PlatformModule["manifest"], def: PlatformDef, view: WebContentsView, ses: Session) => {
    engines ??= new EngineHub({ dist: paths.dist, os: platform, window });
    // Our own page: links open in the browser, never in the app, including links to the platform's own site.
    const openOutside = (url: string): void => {
      if (decideWindowOpen(url, "file:///") === "external") void shell.openExternal(url);
    };
    view.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      openOutside(url);
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: "deny" };
    });
    if (manifest.screenShare) handleScreenShare(ses);
    // Favourites reach this view, our own page, and never its engine (whose session has no such scheme).
    ses.protocol.handle(MEDIA_SCHEME, (request) => favourites.serve(request.url));
    view.webContents.on("did-finish-load", () => sendFavourites(def.id, view));
    const engine = engines.add({
      def,
      engine: manifest.engine!,
      hosts: manifest.hosts,
      persistent: manifest.storage === true,
      home: manifest.home === true,
      capabilities: manifest.capabilities ?? { directMessages: false, messagePreviews: false, voice: false, screenShare: false },
      view,
      secrets: credentials.scope(def.id),
      ...(takesSettings(manifest) ? { settings: () => settingValues(manifest, def.id) } : {}),
    });
    return {
      adapter: engine.adapter,
      start: () => {
        void view.webContents.loadFile(path.join(paths.dist, "native.html"));
        engine.start();
      },
    };
  };

  for (const def of platforms) {
    const module = findModule(def.module, modules);
    if (!module) {
      console.warn(`[platforms] ${def.id}: unknown module "${def.module}"`);
      continue;
    }
    const ses = session.fromPartition(def.partition);
    const native = module.manifest.engine !== undefined;
    configureSession(ses, def.url, () => notificationsOn(def.id), native ? pathToFileURL(path.join(paths.dist, "native.html")).href : undefined);
    ses.setSpellCheckerEnabled(general().spellcheck);
    platformSessions.push(ses);
    const { preload } = module.manifest;
    const view = secureView(preload && path.join(paths.dist, preload), def.partition);
    prepareContentView(view);
    view.webContents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url, def.url);
      if (decision === "external") void shell.openExternal(url);
      return { action: decision === "allow" ? "allow" : "deny" };
    });
    views.set(def.id, view);
    window.contentView.addChildView(view);
    // A reloaded page starts out full width; tell it whether it sits beside the Messages list.
    view.webContents.on("did-finish-load", () => view.webContents.send(IPC.viewCompact, mode === "messages"));

    const host = new URL(def.url).hostname;
    const { adapter, start } = module.load
      ? module.load({
          def,
          view,
          session: ses,
          window,
          dist: paths.dist,
          platform,
          secrets: credentials.scope(def.id),
          enableScreenShare: () => handleScreenShare(ses),
          settings: () => settingValues(module.manifest, def.id),
          // Checks of the service go through a session of their own, in memory: never the page's cookies.
          ...(isPrivateHost(host) ? {} : { reach: createServiceReach(() => session.fromPartition(`service-check-${def.id}`), host) }),
        })
      : startEngineModule(module.manifest, def, view, ses);
    adapters.set(def.id, adapter);
    manifests.set(def.id, module.manifest);
    await registry.add(adapter, def.name, { label: module.manifest.label, color: module.manifest.color });
    // Each service gets its own values only, whenever they change.
    if (takesSettings(module.manifest)) {
      settingsStore.changed.on(({ patch }) => {
        const typing = module.manifest.sendsTyping === true && patch.general?.typingIndicators !== undefined;
        if (typing || (patch.services && Object.hasOwn(patch.services, def.id))) adapter.applySettings?.(settingValues(module.manifest, def.id));
      });
    }
    if (module.manifest.usesVoiceSettings) {
      const sendVoice = (): void => view.webContents.send(SETTINGS_IPC.voice, settingsStore.get().voice);
      view.webContents.on("did-finish-load", sendVoice);
      settingsStore.changed.on(({ patch }) => {
        if (patch.voice) sendVoice();
      });
    }
    // Only this service's own limit reaches its view; the engine never sees settings of other services.
    if (module.manifest.holdsMedia) {
      const sendLimit = (): void => view.webContents.send(SETTINGS_IPC.mediaAutoLoad, mediaAutoLoadLimit(settingsStore.get(), def.id));
      view.webContents.on("did-finish-load", sendLimit);
      settingsStore.changed.on(({ patch }) => {
        if (patch.general?.mediaAutoLoad !== undefined || (patch.services && Object.hasOwn(patch.services, def.id))) sendLimit();
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

  let lastMessages = "";
  const publishMessages = (force = false): void => {
    if (!messagesView) return;
    // In streamer mode the page learns who wrote, never what: previews stay here.
    const conversations = streaming() ? registry.conversations().map(({ preview: _preview, ...c }) => c) : registry.conversations();
    const state: MessagesState = { conversations, activeKey: registry.activeKeyValue };
    const serialized = JSON.stringify(state);
    if (!force && serialized === lastMessages) return;
    lastMessages = serialized;
    messagesView.webContents.send(IPC.messagesState, state);
  };

  let lastMentions = 0;
  const publish = (): void => {
    const conversations = registry.conversations();
    const messagesBadge = {
      unread: conversations.some((c) => c.unread),
      mentions: conversations.reduce((sum, c) => sum + c.mentions, 0),
    };
    railView.webContents.send(IPC.railState, {
      ...registry.state(),
      settingsOpen: mode === "settings",
      messagesOpen: mode === "messages",
      messagesBadge,
    });
    publishMessages();
    const { mentions } = registry.totals();
    window.setTitle(mentions > 0 ? `(${mentions}) ${APP_NAME}` : APP_NAME);
    app.setBadgeCount(mentions);
    // Windows has no badge count; an overlay on the taskbar button says it there.
    if (platform === "win32" && mentions !== lastMentions) {
      const overlay = mentions > 0 ? nativeImage.createFromBitmap(badgeBitmap(mentions), { width: BADGE_SIZE, height: BADGE_SIZE }) : null;
      window.setOverlayIcon(overlay, mentions > 0 ? `${mentions} unread mentions` : "");
    }
    if (mentions > lastMentions && !window.isFocused()) window.flashFrame(true);
    lastMentions = mentions;
  };
  registry.onChange(publish);

  const show = (): void => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  /** Switches the content area; platform pages learn whether they sit beside the Messages list. */
  const setMode = (next: typeof mode): void => {
    const compact = next === "messages";
    if (compact !== (mode === "messages")) for (const view of views.values()) view.webContents.send(IPC.viewCompact, compact);
    mode = next;
    layout();
    publish();
  };

  /** Shows a platform's view in front, leaving the settings and Messages pages. */
  const showPlatform = (id: string): void => {
    activePlatform = id;
    setMode("platform");
  };

  /** A shell page in the content area, above the platform views and below the tooltip overlay. */
  const pageView = (page: string, preload: string, partition: string, permissions: readonly string[]): WebContentsView => {
    configurePageSession(session.fromPartition(partition), permissions);
    const view = secureView(path.join(paths.dist, preload), partition);
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.contentView.removeChildView(tooltipView);
    window.contentView.addChildView(view);
    window.contentView.addChildView(tooltipView);
    void view.webContents.loadFile(path.join(paths.dist, page));
    prepareContentView(view);
    return view;
  };

  const settings = new SettingsController({
    platformsFile: path.join(paths.userData, "platforms.json"),
    modules,
    store: settingsStore,
    adapters,
    secretsPersistent: () => credentials.persistent,
    launchAtLoginSupported: platform !== "linux",
    version: app.getVersion(),
    streaming,
    updates: {
      get status() {
        return updater.status;
      },
      check: () => updater.check(),
      install: () => {
        // Quitting for the update: the window must really close.
        quitting = true;
        updater.install();
      },
    },
    get linkSchemes() {
      return linkSchemes;
    },
    shortcutErrors: () => shortcutErrors,
    pushToTalkError: () => pushToTalkError,
    openService: showPlatform,
    clearSession: async (id) => {
      await session.fromPartition(`persist:${id}`).clearStorageData();
      await session.fromPartition(engineStoragePartition(id, true)).clearStorageData();
      views.get(id)?.webContents.reload();
    },
    forgetSecrets: (id) => credentials.deletePrefix(`${id}:`),
    copyText: (text) => clipboard.writeText(text),
    os: `${platform} ${os.release()}`,
    restart: () => {
      quitting = true;
      app.relaunch();
      app.quit();
    },
    publish: (state: SettingsViewState) => settingsView?.webContents.send(SETTINGS_IPC.state, state),
    favourites,
  });
  favourites.changed.on(() => {
    if (mode === "settings") settings.refresh();
  });

  // App links: only when the user opts in, as an installed app may own the scheme.
  const linkSchemes = [...new Set([...manifests.values()].flatMap((m) => m.protocols ?? []))];
  const registerLinks = (on: boolean): void => {
    // Unpackaged (development) runs need the app path, as with launch at login.
    const args = app.isPackaged ? [] : [app.getAppPath()];
    for (const scheme of linkSchemes) {
      if (on) app.setAsDefaultProtocolClient(scheme, process.execPath, args);
      else if (app.isDefaultProtocolClient(scheme, process.execPath, args)) app.removeAsDefaultProtocolClient(scheme, process.execPath, args);
    }
  };
  registerLinks(general().openLinks);
  const openLink = async (url: string): Promise<boolean> => {
    if (!general().openLinks) return false;
    let scheme: string;
    try {
      scheme = new URL(url).protocol.slice(0, -1);
    } catch {
      return false;
    }
    for (const [id, adapter] of adapters) {
      if (!manifests.get(id)?.protocols?.includes(scheme) || !adapter.openLink) continue;
      if (await adapter.openLink(url).catch(() => false)) {
        show();
        showPlatform(id);
        return true;
      }
    }
    return false;
  };

  updater.changed.on(() => {
    if (mode === "settings") settings.refresh();
  });

  // Global shortcuts: voice ones go to every module that runs calls, in the way its page understands.
  const runShortcut = (action: "toggleMute" | "toggleDeafen" | "showApp"): void => {
    if (action === "showApp") {
      if (window.isVisible() && window.isFocused()) window.hide();
      else show();
      return;
    }
    for (const [id, view] of views) {
      const manifest = manifests.get(id);
      if (manifest?.usesVoiceSettings) view.webContents.send(SETTINGS_IPC.voiceCommand, action);
      const keys = manifest?.voiceKeys?.[action];
      if (!keys) continue;
      const modifiers = inputModifiers(keys, platform);
      view.webContents.sendInputEvent({ type: "keyDown", keyCode: keys.keyCode, modifiers });
      view.webContents.sendInputEvent({ type: "keyUp", keyCode: keys.keyCode, modifiers });
    }
  };
  // Rich Presence: local apps' and detected games' activities go to every module that can show them.
  const rpcApps = new Map<string, string>();
  const showActivity = (update: ActivityUpdate): void => {
    if (update.source !== DETECTED_SOURCE) {
      if (update.activity) rpcApps.set(update.source, update.activity.application_id);
      else rpcApps.delete(update.source);
    }
    for (const adapter of adapters.values()) adapter.setActivity?.(update);
  };
  const richPresence = createRichPresence(platform, showActivity);
  const games = createGameDetector(platform, () => listProcesses(platform), showActivity, (id) => [...rpcApps.values()].includes(id));
  const applyRichPresence = (on: boolean): void => {
    if (!on) {
      games.stop();
      return richPresence.stop();
    }
    games.start();
    void richPresence.start().then((listening) => {
      if (!listening) console.warn("[rich presence] every discord-ipc path is taken; not listening");
    });
  };
  applyRichPresence(general().richPresence);

  // Push to talk in the background: Multicord's own calls talk, and pages with their own push to talk get the key.
  const talk = (down: boolean): void => {
    const code = settingsStore.get().voice.pushToTalk;
    const keyCode = code ? inputKeyCode(code) : undefined;
    for (const [id, view] of views) {
      const manifest = manifests.get(id);
      if (manifest?.usesVoiceSettings) view.webContents.send(SETTINGS_IPC.voiceCommand, down ? "talkStart" : "talkStop");
      // While focused, the page hears the key itself.
      if (manifest?.forwardPushToTalk && keyCode && !window.isFocused()) view.webContents.sendInputEvent({ type: down ? "keyDown" : "keyUp", keyCode });
    }
  };
  const pushToTalk = new GlobalPushToTalk(loadKeyHook, talk);
  let pushToTalkError: string | undefined;
  const applyPushToTalk = (): void => {
    const { pushToTalk: code, pushToTalkGlobal } = settingsStore.get().voice;
    pushToTalkError = pushToTalk.apply(code, pushToTalkGlobal);
  };
  applyPushToTalk();
  app.on("will-quit", () => pushToTalk.stop());

  const shortcuts = new GlobalShortcuts(globalShortcut, runShortcut);
  let shortcutErrors = shortcuts.apply(settingsStore.get().shortcuts);
  updater.setAutomatic(general().autoUpdate);

  settingsStore.changed.on(({ settings: next, patch }) => {
    if (patch.shortcuts) shortcutErrors = shortcuts.apply(next.shortcuts);
    if (patch.voice?.pushToTalk !== undefined || patch.voice?.pushToTalkGlobal !== undefined) applyPushToTalk();
    if (patch.general?.autoUpdate !== undefined) updater.setAutomatic(next.general.autoUpdate);
    if (patch.general?.openLinks !== undefined) registerLinks(next.general.openLinks);
    if (patch.general?.richPresence !== undefined) applyRichPresence(next.general.richPresence);
    if (patch.general?.railGrouping !== undefined) registry.setGrouping(next.general.railGrouping);
    if (patch.general?.streamerMode !== undefined) {
      if (next.general.streamerMode === "auto") streamer.start();
      else streamer.stop();
      publishMessages();
    }
    if (patch.general?.zoom !== undefined) for (const view of contentViews) view.webContents.setZoomFactor(next.general.zoom);
    if (patch.general?.spellcheck !== undefined) for (const ses of platformSessions) ses.setSpellCheckerEnabled(next.general.spellcheck);
    if (patch.general?.launchAtLogin === undefined || platform === "linux") return;
    // Unpackaged (development) runs need the app path, or Electron starts without the app.
    app.setLoginItemSettings({ openAtLogin: next.general.launchAtLogin, ...(app.isPackaged ? {} : { args: [app.getAppPath()] }) });
  });
  // Account states change as platforms connect; keep an open settings page current.
  registry.onChange(() => {
    if (mode === "settings") settings.refresh();
  });
  for (const adapter of adapters.values()) {
    adapter.onSettingsStatusChanged?.(() => {
      if (mode === "settings") settings.refresh();
    });
  }
  streamer.changed.on(() => {
    publishMessages();
    if (mode === "settings") settings.refresh();
  });

  const setSettingsOpen = (open: boolean): void => {
    if (open && !settingsView) settingsView = pageView("settings.html", "preload-settings.js", SETTINGS_PARTITION, ["media"]);
    setMode(open ? "settings" : "platform");
    if (open) settings.refresh(true);
  };

  const setMessagesOpen = (open: boolean): void => {
    if (open && !messagesView) messagesView = pageView("messages.html", "preload-messages.js", MESSAGES_PARTITION, []);
    setMode(open ? "messages" : "platform");
    if (open) publishMessages(true);
  };

  ipcMain.on(IPC.railMessages, (event, open) => {
    if (event.sender === railView.webContents && typeof open === "boolean") setMessagesOpen(open);
  });
  ipcMain.on(IPC.messagesReady, (event) => {
    if (messagesView && event.sender === messagesView.webContents) publishMessages(true);
  });
  ipcMain.on(IPC.messagesOpen, async (event, key) => {
    if (!messagesView || event.sender !== messagesView.webContents || !isRailKey(key)) return;
    if (!registry.conversations().some((c) => c.key === key)) return;
    try {
      const target = await registry.open(key);
      if (!target) return;
      messagesTarget = target;
      layout();
    } catch (error) {
      console.warn(`[messages] could not open ${key}: ${(error as Error).message}`);
    }
  });

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

  // Every platform's notifications, Discord's relayed from its page, go through here.
  // Shown notifications stay referenced so their click handlers survive GC.
  const shownNotifications = new Set<Notification>();
  const notify = (id: string, n: PlatformNotification, urgent = false): void => {
    if (!notificationsOn(id) || !Notification.isSupported()) return;
    const name = platforms.find((p) => p.id === id)?.name ?? id;
    // While streaming, a notification may say that something happened, not who said what.
    // Every notification names its service, so one service cannot pass for another.
    const shown = streaming() ? { title: urgent ? "Incoming call" : "New message", body: urgent ? `Someone is calling you on ${name}` : `On ${name}` } : { title: `${n.title} · ${name}`, body: n.body };
    const note = new Notification(urgent ? { ...shown, urgency: "critical", timeoutType: "never" } : shown);
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
  };
  for (const [id, adapter] of adapters) {
    adapter.onNotification((n) => {
      if (n.inView && window.isFocused() && front() === id) return;
      notify(id, n);
    });
    // The platform rings in its own view only while that view is in front; otherwise we ring.
    adapter.onIncomingCall((call) => {
      if (window.isFocused() && front() === id) return;
      window.flashFrame(true);
      const name = platforms.find((p) => p.id === id)?.name ?? id;
      notify(id, { title: "Incoming call", body: `${call.from} is calling you on ${name}`, target: call.conversationKey, railKey: `dm:${call.conversationKey}` }, true);
    });
  }

  // Integration points that stop working (e.g. Discord's hooks after a Discord update) are reported once.
  const healthWatch = new HealthWatch({
    checks: () => {
      const all = new Map<string, { signedIn: boolean; checks: HealthCheck[] }>();
      for (const [id, adapter] of adapters) {
        const checks = adapter.health?.() ?? [];
        if (checks.length > 0) all.set(id, { signedIn: adapter.accountStatus?.().state === "signed-in", checks });
      }
      return all;
    },
    onBroken: (id, broken) => {
      const name = platforms.find((p) => p.id === id)?.name ?? id;
      console.warn(`[${id}] stopped working: ${broken.map((c) => c.name).join(", ")}`);
      if (!notificationsOn(id) || !Notification.isSupported()) return;
      const note = new Notification({ title: `Part of ${name} stopped working`, body: `${broken.map((c) => c.name).join(", ")}. Settings > Diagnostics has the details.` });
      shownNotifications.add(note);
      note.on("close", () => shownNotifications.delete(note));
      note.on("click", () => {
        shownNotifications.delete(note);
        show();
        setSettingsOpen(true);
      });
      note.show();
    },
  });
  healthWatch.start();

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
    messagesView: () => messagesView,
    setMessagesOpen,
    openLink,
    show,
    setQuitting: () => {
      quitting = true;
    },
    layout,
  };
}

/**
 * The favourites store, downloading through a session of its own: https
 * only, every hop's address public (names checked by what they resolve to),
 * no cookies and no permissions.
 */
function createFavourites(userData: string): FavouritesStore {
  const ses = session.fromPartition(FAVOURITES_PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const publicAddress = createAddressGuard(async (host) => (await ses.resolveHost(host)).endpoints.map((e) => e.address));
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (checkUrl(details.url, { schemes: ["https:"] }) !== undefined) return callback({ cancel: true });
    void publicAddress(details.url).then((ok) => callback({ cancel: !ok }));
  });
  return new FavouritesStore(path.join(userData, "favourites"), {
    download: (url, hosts) => downloadMedia((target, init) => ses.fetch(target, init), url, { schemes: ["https:"], hosts }),
  });
}

/** An app link (scheme://...) among command-line arguments; web links and file paths are not. */
export function findAppLink(argv: readonly string[]): string | undefined {
  return argv.find((arg) => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) && !/^(https?|file):/i.test(arg));
}

/** Lifecycle: single instance, tray-resident window, quit only from the tray or OS. */
/**
 * Chromium features to turn on for this OS: on Linux, global shortcuts go
 * through the desktop portal, the only way they work under Wayland.
 */
export function chromiumFeatures(platform: NodeJS.Platform): string[] {
  return platform === "linux" ? ["GlobalShortcutsPortal"] : [];
}

export function startApp(dist: string): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setName(APP_NAME);
  const features = chromiumFeatures(process.platform);
  if (features.length > 0) app.commandLine.appendSwitch("enable-features", features.join(","));
  // Engine pages get a standard, secure origin of their own; this must happen before the app is ready.
  // Favourites are served to native views under a scheme of their own; stream lets videos play from it.
  protocol.registerSchemesAsPrivileged([
    { scheme: ENGINE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);

  let handle: ShellHandle | undefined;
  /** An app link that arrived before the shell was ready. */
  let pendingLink: string | undefined;
  const openLink = (url: string): void => {
    if (handle) void handle.openLink(url);
    else pendingLink = url;
  };
  app.on("second-instance", (_event, argv: string[] = []) => {
    handle?.show();
    const link = findAppLink(argv);
    if (link) openLink(link);
  });
  // macOS delivers links as an event instead of arguments.
  app.on("open-url", (event, url: string) => {
    event.preventDefault();
    openLink(url);
  });
  app.on("activate", () => handle?.show());
  app.on("before-quit", () => handle?.setQuitting());
  app.on("will-quit", () => globalShortcut.unregisterAll());

  void app.whenReady().then(async () => {
    installHardening();
    handle = await createShell({ dist, userData: app.getPath("userData") });
    const link = pendingLink ?? findAppLink(process.argv);
    pendingLink = undefined;
    if (link) void handle.openLink(link);
  });
}
