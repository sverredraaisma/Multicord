import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { dialog, ipcMain, session, WebContentsView, type BaseWindow, type Session, type WebContents } from "electron";
import type { DirectConversation, HealthCheck, HomeBadge, PlatformAdapter, RailServer } from "../shared/adapter";
import { BaseAdapter } from "../shared/baseAdapter";
import { Emitter } from "../shared/emitter";
import {
  ENGINE_IPC,
  ENGINE_SCHEME,
  isEngineEvent,
  isEngineRequest,
  type EngineCommand,
  type EngineEvent,
  type EngineInfo,
  type EngineRequest,
  type EngineServer,
  type PickedFile,
} from "../shared/engine";
import { isNativeAction, NATIVE_IPC } from "../shared/native";
import type { AccountStatus } from "../shared/settings";
import type { SecretStore } from "./credentials";
import { contentTypeFor, readRange } from "./files";
import { checkUrl, performHttp, type UrlPolicy } from "./netPolicy";
import type { PlatformDef } from "./platforms";

/**
 * The main process's stand-in for a module running in an engine: it keeps
 * the last validated rail data, account and badge the engine reported, and
 * turns shell calls into engine commands.
 */
export class EngineAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  private status: AccountStatus = { state: "unknown" };
  private badge: HomeBadge = { unread: false, mentions: 0 };
  private directs: DirectConversation[] = [];
  private engine: EngineHealth = { state: "starting", responsive: true, restarts: 0 };
  private readonly accountChanged = new Emitter<AccountStatus>();
  readonly openHome?: () => Promise<void>;

  constructor(
    id: string,
    instance: string,
    readonly capabilities: PlatformAdapter["capabilities"],
    private readonly send: (command: EngineCommand) => void,
    home: boolean,
  ) {
    super(id, { platform: id, instance, accountId: "default" });
    if (home) this.openHome = async () => this.send({ type: "openHome" });
  }

  /** Applies an event the host has already validated. */
  handle(event: EngineEvent): void {
    switch (event.type) {
      case "servers":
        return this.setServers(event.servers.map((s) => this.toRail(s)));
      case "directs":
        this.directs = event.directs.map((d) => ({ ...d, account: this.account }));
        return this.directsChanged.emit(this.directs);
      case "notification":
        return this.notifications.emit(event.notification);
      case "call":
        return this.incomingCalls.emit(event.call);
      case "account":
        this.status = event.account;
        return this.accountChanged.emit(event.account);
      case "homeBadge":
        this.badge = event.badge;
        // The rail reads the home badge when servers change.
        return this.serversChanged.emit(this.servers);
    }
  }

  /** The host's view of the engine process, for Settings > Diagnostics. */
  setEngineHealth(health: EngineHealth): void {
    this.engine = health;
  }

  health(): HealthCheck[] {
    const { state, responsive, restarts, lastExit } = this.engine;
    const exits = restarts > 0 ? ` It has restarted ${restarts} time${restarts === 1 ? "" : "s"}${lastExit ? ` (last: ${lastExit})` : ""}.` : "";
    const running: HealthCheck = { name: "Engine running", ok: state === "running" };
    if (state === "stopped") running.detail = `Stopped after crashing repeatedly; restart Multicord to try again. Nothing from this service arrives.${exits}`;
    else if (state === "starting") running.detail = `Starting; messages and notifications arrive once it runs.${exits}`;
    else if (exits) running.detail = exits.trim();
    if (state !== "running") return [running];
    const busy = { name: "Engine responsive", ok: false, detail: "The engine is busy; messages and notifications are delayed." };
    return [running, responsive ? { name: busy.name, ok: true } : busy];
  }

  private toRail(server: EngineServer): RailServer {
    const { children, ...rest } = server;
    const rail: RailServer = { ...rest, account: this.account };
    if (children) rail.children = children.map((c) => this.toRail(c));
    return rail;
  }

  override async listDirectConversations(): Promise<DirectConversation[]> {
    return this.directs;
  }

  homeBadge(): HomeBadge {
    return this.badge;
  }

  accountStatus(): AccountStatus {
    return this.status;
  }

  onAccountChanged(cb: (account: AccountStatus) => void): () => void {
    return this.accountChanged.on(cb);
  }

  async signOut(): Promise<void> {
    this.send({ type: "signOut" });
  }

  async openServer(key: string): Promise<void> {
    this.send({ type: "openServer", key });
  }

  async openConversation(key: string): Promise<void> {
    this.send({ type: "openConversation", key });
  }

  async toggleGroup(key: string): Promise<void> {
    this.send({ type: "toggleGroup", key });
  }

  setVisible(visible: boolean): void {
    this.send({ type: "visible", visible });
  }
}

/** How an engine process is doing. */
export interface EngineHealth {
  state: "starting" | "running" | "stopped";
  responsive: boolean;
  restarts: number;
  /** Why the engine last stopped, as Electron reported it. */
  lastExit?: string;
}

/** Crashes in a row before an engine is left stopped. */
export const MAX_CRASHES = 5;
/** An engine that ran this long before crashing starts a fresh count. */
const STABLE_MS = 60_000;
/** Restart delay after the nth crash in a row: 2 s, doubling, at most 30 s. */
export function restartDelay(crashes: number): number {
  return Math.min(2000 * 2 ** (crashes - 1), 30_000);
}

/** What the host needs to run one module instance in an engine. */
export interface EngineSpec {
  def: PlatformDef;
  /** The engine bundle, served as <scheme>://<engine>/engine.js. */
  engine: string;
  /** When set, the only hosts the engine may reach. */
  hosts?: readonly string[];
  home: boolean;
  capabilities: PlatformAdapter["capabilities"];
  /** The module's own view; it gets the engine's display state and sends user actions. */
  view: WebContentsView;
  secrets: SecretStore;
}

interface Running {
  spec: EngineSpec;
  adapter: EngineAdapter;
  engine: WebContentsView;
  /** The HTTP bridge's own in-memory session: no cookies shared with anything else. */
  http: Session;
  /** Files the user picked for this engine, by handle. */
  files: Map<string, { path: string; size: number }>;
  ready: boolean;
  health: EngineHealth;
  /** Crashes since the engine last ran stably, and when it last became ready. */
  crashes: number;
  readyAt: number;
  /** Messages for the engine, held until it has loaded. */
  queue: { channel: string; payload: unknown }[];
}

const ENGINE_ID = /^[a-z0-9-]{1,32}$/;
/** Picked-file handles kept per engine; the oldest are forgotten first. */
export const MAX_FILE_HANDLES = 200;
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self' wss:",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
].join("; ");
const ENGINE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>engine</title></head><body><script src="engine.js"></script></body></html>`;

/** Serves an engine's page and bundle; nothing else exists on its origin. */
export async function serveEngine(dist: string, engine: string, url: string): Promise<Response> {
  const headers = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" };
  const parsed = new URL(url);
  if (parsed.host !== engine) return new Response("Not found", { status: 404, headers });
  switch (parsed.pathname) {
    case "/":
    case "/engine.html":
      return new Response(ENGINE_PAGE, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
    case "/engine.js":
    case "/engine.js.map": {
      const file = path.join(dist, "engines", `${engine}.js${parsed.pathname.endsWith(".map") ? ".map" : ""}`);
      try {
        return new Response(await readFile(file), { headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" } });
      } catch {
        return new Response("Not found", { status: 404, headers });
      }
    }
    default:
      return new Response("Not found", { status: 404, headers });
  }
}

/**
 * Runs module engines. Each engine is a hidden WebContentsView with the
 * sandbox on, no Node, its own in-memory session that may reach only the
 * module's hosts, and a page served from its own origin. The engine talks
 * to the shell only through ENGINE_IPC, which this hub validates and binds
 * to that one engine: its own secrets, its own files, its own view.
 */
export class EngineHub {
  private readonly byEngine = new Map<WebContents, Running>();
  private readonly byView = new Map<WebContents, Running>();

  constructor(
    private readonly deps: { dist: string; os: string; window: BaseWindow },
  ) {
    ipcMain.handle(ENGINE_IPC.invoke, (event, request) => {
      const running = this.byEngine.get(event.sender);
      if (!running) throw new Error("Not an engine");
      if (!isEngineRequest(request)) throw new Error("Malformed engine request");
      return this.answer(running, request);
    });
    ipcMain.on(ENGINE_IPC.event, (event, payload) => {
      const running = this.byEngine.get(event.sender);
      if (running && isEngineEvent(payload)) running.adapter.handle(payload);
    });
    ipcMain.on(ENGINE_IPC.render, (event, state) => {
      const running = this.byEngine.get(event.sender);
      if (running && typeof state === "object" && state !== null) running.spec.view.webContents.send(NATIVE_IPC.state, state);
    });
    ipcMain.on(NATIVE_IPC.action, (event, action) => {
      const running = this.byView.get(event.sender);
      if (running && isNativeAction(action)) this.deliver(running, ENGINE_IPC.action, action);
    });
  }

  add(spec: EngineSpec): { adapter: EngineAdapter; engine: WebContentsView; start(): void } {
    if (!ENGINE_ID.test(spec.engine)) throw new Error(`Invalid engine id: ${spec.engine}`);
    const partition = `engine-${spec.def.id}`; // in memory: the engine keeps nothing on disk
    const ses = session.fromPartition(partition);
    this.lockDown(ses, spec);
    const engine = new WebContentsView({
      webPreferences: {
        preload: path.join(this.deps.dist, "preload-engine.js"),
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // Engines keep gateway connections alive while hidden.
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    engine.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    engine.webContents.on("will-navigate", (event) => event.preventDefault());

    // The bridge uses a session of its own: the engine session only lets the engine itself open WebSockets.
    const http = session.fromPartition(`${partition}-http`);
    http.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // net.fetch follows redirects itself, so every hop is checked here as well.
    const httpPolicy: UrlPolicy = { schemes: ["https:"], hosts: spec.hosts };
    http.webRequest.onBeforeRequest((details, callback) => callback({ cancel: checkUrl(details.url, httpPolicy) !== undefined }));
    const running: Running = {
      spec,
      adapter: undefined!,
      engine,
      http,
      files: new Map(),
      ready: false,
      health: { state: "starting", responsive: true, restarts: 0 },
      crashes: 0,
      readyAt: 0,
      queue: [],
    };
    running.adapter = new EngineAdapter(spec.def.id, new URL(spec.def.url).host, spec.capabilities, (command) => this.deliver(running, ENGINE_IPC.command, command), spec.home);
    this.byEngine.set(engine.webContents, running);
    this.byView.set(spec.view.webContents, running);

    const report = (change: Partial<EngineHealth>): void => {
      running.health = { ...running.health, ...change };
      running.adapter.setEngineHealth(running.health);
    };
    engine.webContents.on("did-start-loading", () => (running.ready = false));
    engine.webContents.on("unresponsive", () => report({ responsive: false }));
    engine.webContents.on("responsive", () => report({ responsive: true }));
    // A crashing engine restarts with growing delays, and is left stopped if it keeps crashing.
    engine.webContents.on("render-process-gone", (_event, details) => {
      running.ready = false;
      running.crashes = Date.now() - running.readyAt >= STABLE_MS && running.health.state === "running" ? 1 : running.crashes + 1;
      if (running.crashes > MAX_CRASHES) {
        console.warn(`[engine ${spec.def.id}] stopped (${details.reason}); crashed ${MAX_CRASHES} times in a row, not restarting`);
        report({ state: "stopped", responsive: true, lastExit: details.reason });
        return;
      }
      console.warn(`[engine ${spec.def.id}] stopped (${details.reason}); restarting`);
      report({ state: "starting", responsive: true, restarts: running.health.restarts + 1, lastExit: details.reason });
      setTimeout(() => void engine.webContents.reload(), restartDelay(running.crashes));
    });
    const start = (): void => void engine.webContents.loadURL(`${ENGINE_SCHEME}://${spec.engine}/engine.html`);
    return { adapter: running.adapter, engine, start };
  }

  /** The engine session: no permissions, no navigation, and network only to the module's hosts. */
  private lockDown(ses: Session, spec: EngineSpec): void {
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.protocol.handle(ENGINE_SCHEME, (request) => serveEngine(this.deps.dist, spec.engine, request.url));
    // HTTP goes through the bridge; engines open only WebSockets themselves.
    const socketPolicy: UrlPolicy = { schemes: ["wss:"], hosts: spec.hosts };
    ses.webRequest.onBeforeRequest((details, callback) => {
      const { protocol } = new URL(details.url);
      const own = protocol === `${ENGINE_SCHEME}:` || protocol === "blob:" || protocol === "data:";
      callback({ cancel: !own && checkUrl(details.url, socketPolicy) !== undefined });
    });
  }

  /** Sends to the engine, or holds the message until it has loaded. */
  private deliver(running: Running, channel: string, payload: unknown): void {
    if (running.ready) running.engine.webContents.send(channel, payload);
    else running.queue.push({ channel, payload });
  }

  private async answer(running: Running, request: EngineRequest): Promise<unknown> {
    const { spec } = running;
    switch (request.type) {
      case "info": {
        // The engine asks first thing once loaded: from now on it can receive.
        running.ready = true;
        running.readyAt = Date.now();
        running.health = { ...running.health, state: "running", responsive: true };
        running.adapter.setEngineHealth(running.health);
        for (const { channel, payload } of running.queue.splice(0)) running.engine.webContents.send(channel, payload);
        const info: EngineInfo = { id: spec.def.id, name: spec.def.name, url: spec.def.url, os: this.deps.os };
        return info;
      }
      case "secretLoad":
        return spec.secrets.load(request.key);
      case "secretSave":
        return spec.secrets.save(request.key, request.value);
      case "secretDelete":
        return spec.secrets.delete(request.key);
      case "http":
        return performHttp((url, init) => running.http.fetch(url, init), request.request, { schemes: ["https:"], hosts: spec.hosts }, "follow");
      case "pickFiles":
        return this.pickFiles(running);
      case "readFile": {
        const file = running.files.get(request.handle);
        if (!file) throw new Error("Unknown file");
        return readRange(file.path, request.start, Math.min(request.end, file.size));
      }
    }
  }

  private async pickFiles(running: Running): Promise<PickedFile[]> {
    const result = await dialog.showOpenDialog(this.deps.window, { title: "Attach files", properties: ["openFile", "multiSelections"] });
    if (result.canceled) return [];
    const picked: PickedFile[] = [];
    for (const filePath of result.filePaths) {
      const { size } = await stat(filePath);
      const handle = randomUUID();
      running.files.set(handle, { path: filePath, size });
      if (running.files.size > MAX_FILE_HANDLES) running.files.delete(running.files.keys().next().value!);
      const name = path.basename(filePath);
      picked.push({ handle, name, size, type: contentTypeFor(name) });
    }
    return picked;
  }
}
