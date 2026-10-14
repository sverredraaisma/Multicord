// In-memory stand-in for the parts of Electron the main process uses.
import { EventEmitter } from "node:events";
import os from "node:os";
import { vi } from "vitest";

type Handler = (...args: never[]) => unknown;

export class FakeWebContents extends EventEmitter {
  send = vi.fn();
  loadURL = vi.fn(async (_url: string) => {});
  loadFile = vi.fn(async (_file: string) => {});
  close = vi.fn();
  reload = vi.fn();
  setZoomFactor = vi.fn();
  windowOpenHandler?: (details: { url: string }) => { action: string };

  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.windowOpenHandler = handler;
  }
}

export class WebContentsView {
  static instances: WebContentsView[] = [];
  webContents = new FakeWebContents();
  bounds?: { x: number; y: number; width: number; height: number };
  visible = true;

  constructor(readonly options: { webPreferences: Record<string, unknown> }) {
    WebContentsView.instances.push(this);
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
  }

  setBackgroundColor = vi.fn();

  setVisible(visible: boolean): void {
    this.visible = visible;
  }
}

export class BaseWindow extends EventEmitter {
  static instances: BaseWindow[] = [];
  children: WebContentsView[] = [];
  contentView = {
    addChildView: (view: WebContentsView) => this.children.push(view),
    removeChildView: (view: WebContentsView) => {
      this.children = this.children.filter((c) => c !== view);
    },
  };
  contentBounds = { x: 0, y: 0, width: 1000, height: 700 };
  maximize = vi.fn();
  hide = vi.fn();
  show = vi.fn();
  focus = vi.fn();
  restore = vi.fn();
  flashFrame = vi.fn();
  setTitle = vi.fn();
  isMaximized = vi.fn(() => false);
  isMinimized = vi.fn(() => false);
  isFocused = vi.fn(() => false);

  constructor(readonly options: Record<string, unknown>) {
    super();
    BaseWindow.instances.push(this);
  }

  getContentBounds() {
    return this.contentBounds;
  }

  getNormalBounds() {
    return { x: 10, y: 20, width: 1100, height: 750 };
  }
}

export class FakeSession {
  setUserAgent = vi.fn();
  clearStorageData = vi.fn(async () => {});
  setSpellCheckerEnabled = vi.fn();
  protocolHandlers = new Map<string, (request: { url: string }) => unknown>();
  protocol = { handle: vi.fn((scheme: string, handler: (request: { url: string }) => unknown) => void this.protocolHandlers.set(scheme, handler)) };
  beforeRequest?: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void;
  webRequest = {
    onBeforeRequest: vi.fn((listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) => {
      this.beforeRequest = listener;
    }),
  };
  fetch = vi.fn(async (_url: string, _init?: unknown) => new Response("ok"));
  permissionRequestHandler?: Handler;
  permissionCheckHandler?: Handler;
  displayMediaRequestHandler?: Handler;

  constructor(readonly partition: string) {}

  getUserAgent(): string {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Multicord/0.1.0 Chrome/140.0.0.0 Electron/44.7.2 Safari/537.36";
  }

  setPermissionRequestHandler(handler: Handler): void {
    this.permissionRequestHandler = handler;
  }

  setPermissionCheckHandler(handler: Handler): void {
    this.permissionCheckHandler = handler;
  }

  setDisplayMediaRequestHandler(handler: Handler): void {
    this.displayMediaRequestHandler = handler;
  }
}

const sessions = new Map<string, FakeSession>();

export const session = {
  defaultSession: new FakeSession("default"),
  fromPartition: (partition: string): FakeSession => {
    let ses = sessions.get(partition);
    if (!ses) {
      ses = new FakeSession(partition);
      sessions.set(partition, ses);
    }
    return ses;
  },
};

export class Tray extends EventEmitter {
  static instances: Tray[] = [];
  setToolTip = vi.fn();
  menu?: { template: { label?: string; click?: () => void }[] };

  constructor(readonly icon: unknown) {
    super();
    Tray.instances.push(this);
  }

  setContextMenu(menu: { template: { label?: string; click?: () => void }[] }): void {
    this.menu = menu;
  }
}

export const Menu = { buildFromTemplate: (template: unknown[]) => ({ template }) };
export const nativeImage = { createFromPath: (path: string) => ({ path }) };
export const protocol = { registerSchemesAsPrivileged: vi.fn() };
export const shell = { openExternal: vi.fn(async (_url: string) => {}) };
export const desktopCapturer = { getSources: vi.fn(async (_options: unknown) => [] as unknown[]) };
export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: (plain: string) => Buffer.from(plain).reverse(),
  decryptString: (encrypted: Buffer) => Buffer.from(encrypted).reverse().toString(),
};

class FakeIpcMain extends EventEmitter {
  handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for ${channel}`);
    this.handlers.set(channel, handler);
  }
  /** Test helper: what ipcRenderer.invoke would get back. */
  async invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler(event, ...args);
  }
}
export const ipcMain = new FakeIpcMain();

class FakeApp extends EventEmitter {
  requestSingleInstanceLock = vi.fn(() => true);
  quit = vi.fn();
  setName = vi.fn();
  setBadgeCount = vi.fn();
  getPath = vi.fn((_name: string) => os.tmpdir());
  whenReady = vi.fn(() => Promise.resolve());
  getVersion = vi.fn(() => "0.1.0");
  relaunch = vi.fn();
  setLoginItemSettings = vi.fn();
  getAppPath = vi.fn(() => "/app");
  setAsDefaultProtocolClient = vi.fn(() => true);
  isDefaultProtocolClient = vi.fn(() => false);
  removeAsDefaultProtocolClient = vi.fn(() => true);
  isPackaged = false;
}
export const app = new FakeApp();

export function resetElectron(): void {
  WebContentsView.instances = [];
  BaseWindow.instances = [];
  Tray.instances = [];
  Notification.instances = [];
  Notification.isSupported.mockImplementation(() => true);
  sessions.clear();
  session.defaultSession = new FakeSession("default");
  ipcMain.removeAllListeners();
  ipcMain.handlers.clear();
  app.removeAllListeners();
  app.requestSingleInstanceLock.mockImplementation(() => true);
  vi.clearAllMocks();
}

export class Notification extends EventEmitter {
  static instances: Notification[] = [];
  static isSupported = vi.fn(() => true);
  show = vi.fn();

  constructor(readonly options: { title: string; body: string }) {
    super();
    Notification.instances.push(this);
  }
}

export const dialog = {
  showOpenDialog: vi.fn(async (_window: unknown, _options: unknown) => ({ canceled: true, filePaths: [] as string[] })),
};
