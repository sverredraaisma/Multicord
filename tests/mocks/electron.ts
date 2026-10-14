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
export const shell = { openExternal: vi.fn(async (_url: string) => {}) };
export const desktopCapturer = { getSources: vi.fn(async (_options: unknown) => [] as unknown[]) };
export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: (plain: string) => Buffer.from(plain).reverse(),
  decryptString: (encrypted: Buffer) => Buffer.from(encrypted).reverse().toString(),
};

class FakeIpcMain extends EventEmitter {}
export const ipcMain = new FakeIpcMain();

class FakeApp extends EventEmitter {
  requestSingleInstanceLock = vi.fn(() => true);
  quit = vi.fn();
  setName = vi.fn();
  setBadgeCount = vi.fn();
  getPath = vi.fn((_name: string) => os.tmpdir());
  whenReady = vi.fn(() => Promise.resolve());
}
export const app = new FakeApp();

export function resetElectron(): void {
  WebContentsView.instances = [];
  BaseWindow.instances = [];
  Tray.instances = [];
  sessions.clear();
  ipcMain.removeAllListeners();
  app.removeAllListeners();
  app.requestSingleInstanceLock.mockImplementation(() => true);
  vi.clearAllMocks();
}
