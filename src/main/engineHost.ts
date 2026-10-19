import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { dialog, ipcMain, session, shell, WebContentsView, type BaseWindow, type Session, type WebContents } from "electron";
import { crashesInARow, EngineAdapter, engineStoragePartition, isEngineId, MAX_CRASHES, restartDelay, type EngineHealth } from "../core/engineAdapter";
import { EngineSockets, type RelaySocket, type RelaySocketEvents } from "../core/engineSockets";
import { voiceHostAllowed } from "../core/publicSuffix";
import type { PlatformDef } from "../core/platforms";
import type { PlatformAdapter } from "../shared/adapter";
import { ENGINE_IPC, ENGINE_SCHEME, isEngineEvent, isEngineRequest, type EngineInfo, type EngineRequest, type PickedFile } from "../shared/engine";
import { MEDIA_SCHEME } from "../shared/favourites";
import { isNativeAction, NATIVE_IPC, type NativeAction } from "../shared/native";
import type { ServiceSettingValues } from "../shared/settings";
import type { SecretStore } from "./credentials";
import { contentTypeFor, readRange } from "./files";
import { checkUrl, createAddressGuard, isPrivateHost, narrowHosts, performHttp, type UrlPolicy } from "./netPolicy";
import { isSsoUrl, receiveLoginToken } from "./ssoLoopback";
import { RELAY_IPC } from "../shared/relay";
import { relayHost, serveRelay, SocketRelay, type RelayContents } from "./webSockets";

/** What the host needs to run one module instance in an engine. */
export interface EngineSpec {
  def: PlatformDef;
  /** The engine bundle, served as <scheme>://<engine>/engine.js. */
  engine: string;
  /** When set, the only hosts the engine may reach. */
  hosts?: readonly string[];
  /** Keep the engine's web storage on disk (see ModuleManifest.storage); otherwise it lives in memory. */
  persistent?: boolean;
  /** The engine may add one voice host for its WebSockets once signed in (ModuleManifest.voiceHost). */
  voiceHost?: boolean;
  home: boolean;
  capabilities: PlatformAdapter["capabilities"];
  /** The module's own view; it gets the engine's display state and sends user actions. */
  view: WebContentsView;
  secrets: SecretStore;
  /** For a module that declares settings: the instance's values now, given to the engine with its info. */
  settings?: () => ServiceSettingValues;
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
  /** When the user last asked to attach files in the module's view; 0 when they have not. */
  attachAskedAt: number;
  /** When the user last submitted a sign-in step in the module's view; 0 when they have not. */
  signInAskedAt: number;
  /** The single sign-on waiting for its token, if any: a new one cancels it. */
  sso?: AbortController;
  /** The hosts the engine may reach now: the module's, or narrower once the engine locks itself. */
  allowed: { hosts?: readonly string[]; voiceHost?: string };
  /** Messages for the engine, held until it has loaded. */
  queue: { channel: string; payload: unknown }[];
  /** The WebSockets the shell opened for the engine (bridgeWebSocket). */
  sockets: EngineSockets;
  /** The hidden page that opens them in Chromium's network stack. */
  relay: SocketRelay;
  /** A restart waiting out its back-off after a crash, if any. */
  pending?: ReturnType<typeof setTimeout>;
}

/** Picked-file handles kept per engine; the oldest are forgotten first. */
export const MAX_FILE_HANDLES = 200;
/** How long after the user's attach click the engine may open the file dialog. */
export const ATTACH_WINDOW_MS = 10_000;
/** How long after the user submits a sign-in step the engine may start single sign-on in the browser. */
export const SIGN_IN_WINDOW_MS = 10_000;
/** The engine page's CSP: it connects only to itself; its sockets come from its relay page. */
const CSP = ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self'", "worker-src 'self' blob:", "img-src 'self' data: blob:"].join("; ");
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
  private readonly byId = new Map<string, Running>();

  constructor(
    private readonly deps: {
      dist: string;
      os: string;
      window: BaseWindow;
      /** Opens the sockets engines bridge; the engine's relay page unless given. */
      openSocket?: (url: string, events: RelaySocketEvents, protocols?: string[]) => RelaySocket;
    },
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
    // Each relay takes reports only from its own page.
    ipcMain.on(RELAY_IPC.event, (event, payload) => {
      for (const running of this.byEngine.values()) running.relay.receive(event.sender, payload);
    });
    ipcMain.on(ENGINE_IPC.render, (event, state) => {
      const running = this.byEngine.get(event.sender);
      if (running && typeof state === "object" && state !== null) running.spec.view.webContents.send(NATIVE_IPC.state, state);
    });
    ipcMain.on(NATIVE_IPC.action, (event, action) => {
      const running = this.byView.get(event.sender);
      if (!running || !isNativeAction(action)) return;
      // The file dialog opens only for an attach the user just asked for in this view.
      if (action.type === "attach") running.attachAskedAt = Date.now();
      // The browser opens for single sign-on only for a sign-in step the user just submitted in this view.
      if (action.type === "prompt") running.signInAskedAt = Date.now();
      this.deliver(running, ENGINE_IPC.action, action);
    });
  }

  add(spec: EngineSpec): { adapter: EngineAdapter; engine: WebContentsView; start(): void } {
    if (!isEngineId(spec.engine)) throw new Error(`Invalid engine id: ${spec.engine}`);
    // In memory unless the module keeps storage; either way the instance's own.
    const partition = engineStoragePartition(spec.def.id, spec.persistent === true);
    const ses = session.fromPartition(partition);
    const allowed: Running["allowed"] = { hosts: spec.hosts };
    // Engines reach the network only over bridged WebSockets: wss to their hosts, at public addresses.
    // and its one voice host, if it added one (sockets only: never HTTP, nor the view).
    const socketPolicy: UrlPolicy = {
      schemes: ["wss:"],
      get hosts() {
        return allowed.hosts && allowed.voiceHost ? [...allowed.hosts, allowed.voiceHost] : allowed.hosts;
      },
    };
    const socketAddress = createAddressGuard(async (host) => (await ses.resolveHost(host)).endpoints.map((e) => e.address));
    // Sockets in the engine's session come from its relay page alone.
    this.lockDown(ses, spec, socketPolicy, socketAddress, (contents) => running.relay.owns(contents));
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
    const http = session.fromPartition(`engine_http_${spec.def.id}`);
    http.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // net.fetch follows redirects itself, so every hop is checked here as well.
    const httpPolicy: UrlPolicy = {
      schemes: ["https:"],
      get hosts() {
        return allowed.hosts;
      },
    };
    // Names are checked by what they resolve to as well: a public name can point at the local network.
    const publicAddress = createAddressGuard(async (host) => (await http.resolveHost(host)).endpoints.map((e) => e.address));
    const decide = (url: string, policy: UrlPolicy, local: boolean, callback: (response: { cancel: boolean }) => void): void => {
      if (local) return callback({ cancel: false });
      if (checkUrl(url, policy) !== undefined) return callback({ cancel: true });
      void publicAddress(url).then((ok) => callback({ cancel: !ok }));
    };
    http.webRequest.onBeforeRequest((details, callback) => decide(details.url, httpPolicy, false, callback));
    // The module's view shows what the engine renders (images, a call's server): it may reach no more than the engine.
    const viewPolicy: UrlPolicy = {
      schemes: ["https:", "wss:"],
      get hosts() {
        return allowed.hosts;
      },
    };
    spec.view.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const { protocol } = new URL(details.url);
      // Our own page and its data, and favourites the shell serves to this view (never to the engine).
      const local = protocol === "file:" || protocol === "data:" || protocol === "blob:" || protocol === "devtools:" || protocol === `${MEDIA_SCHEME}:`;
      decide(details.url, viewPolicy, local, callback);
    });
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
      allowed,
      attachAskedAt: 0,
      signInAskedAt: 0,
      queue: [],
      relay: new SocketRelay({ spawn: () => this.spawnRelay(partition), url: `${ENGINE_SCHEME}://${relayHost(spec.engine)}/relay.html` }),
      sockets: new EngineSockets({
        check: async (url) => checkUrl(url, socketPolicy) ?? ((await socketAddress(url)) ? undefined : "it resolves to a local or private address"),
        connect: (url, events, protocols) => (this.deps.openSocket ? this.deps.openSocket(url, events, protocols) : running.relay.open(url, events, protocols)),
        emit: (event) => this.deliver(running, ENGINE_IPC.socket, event),
      }),
    };
    running.adapter = new EngineAdapter(
      spec.def.id,
      new URL(spec.def.url).host,
      spec.capabilities,
      (command) => this.deliver(running, ENGINE_IPC.command, command),
      spec.home,
      "click Restart beside it in Settings to try again",
    );
    this.byEngine.set(engine.webContents, running);
    this.byId.set(spec.def.id, running);
    this.byView.set(spec.view.webContents, running);

    const report = (change: Partial<EngineHealth>): void => {
      running.health = { ...running.health, ...change };
      running.adapter.setEngineHealth(running.health);
    };
    // A reloading, crashed or closed engine's bridged sockets close with it.
    engine.webContents.on("did-start-loading", () => {
      running.ready = false;
      running.sockets.closeAll();
    });
    engine.webContents.on("destroyed", () => {
      running.sockets.closeAll();
      running.relay.dispose();
    });
    engine.webContents.on("unresponsive", () => report({ responsive: false }));
    engine.webContents.on("responsive", () => report({ responsive: true }));
    // A crashing engine restarts with growing delays, and is left stopped if it keeps crashing.
    engine.webContents.on("render-process-gone", (_event, details) => {
      running.ready = false;
      running.sockets.closeAll();
      running.crashes = crashesInARow(running.crashes, running.health, Date.now() - running.readyAt);
      if (running.crashes > MAX_CRASHES) {
        console.warn(`[engine ${spec.def.id}] stopped (${details.reason}); crashed ${MAX_CRASHES} times in a row, not restarting`);
        report({ state: "stopped", responsive: true, lastExit: details.reason });
        return;
      }
      console.warn(`[engine ${spec.def.id}] stopped (${details.reason}); restarting`);
      report({ state: "starting", responsive: true, restarts: running.health.restarts + 1, lastExit: details.reason });
      running.pending = setTimeout(() => {
        running.pending = undefined;
        void engine.webContents.reload();
      }, restartDelay(running.crashes));
    });
    const start = (): void => void engine.webContents.loadURL(`${ENGINE_SCHEME}://${spec.engine}/engine.html`);
    return { adapter: running.adapter, engine, start };
  }

  /**
   * Starts an engine again because the user asked (Settings, Restart): one
   * left stopped after crashing repeatedly, or one that runs but seems stuck.
   * It gets a fresh crash count; the app and the other engines keep running.
   * Its sockets close and its picked files and pending asks are forgotten, as
   * on a reload. False when no engine runs for `id`.
   */
  restart(id: string): boolean {
    const running = this.byId.get(id);
    if (!running) return false;
    console.warn(`[engine ${id}] restarting at the user's request`);
    clearTimeout(running.pending);
    running.pending = undefined;
    running.sso?.abort();
    running.sockets.closeAll();
    running.files.clear();
    running.attachAskedAt = 0;
    running.signInAskedAt = 0;
    running.ready = false;
    running.crashes = 0;
    running.readyAt = 0;
    running.health = { ...running.health, state: "starting", responsive: true };
    running.adapter.setEngineHealth(running.health);
    void running.engine.webContents.loadURL(`${ENGINE_SCHEME}://${running.spec.engine}/engine.html`);
    return true;
  }

  /** The engine session: no permissions, no navigation, and network only to the module's hosts. */
  private lockDown(ses: Session, spec: EngineSpec, socketPolicy: UrlPolicy, publicAddress: (url: string) => Promise<boolean>, mayOpenSockets: (contents: unknown) => boolean): void {
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    // The engine's page, and on a host of its own the page of its socket relay.
    ses.protocol.handle(ENGINE_SCHEME, async (request) => (new URL(request.url).host === relayHost(spec.engine) ? serveRelay(request.url) : serveEngine(this.deps.dist, spec.engine, request.url)));
    // HTTP goes through the bridge; WebSockets through the relay page.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const { protocol } = new URL(details.url);
      const own = protocol === `${ENGINE_SCHEME}:` || protocol === "blob:" || protocol === "data:";
      if (own) return callback({ cancel: false });
      if (!mayOpenSockets(details.webContents) || checkUrl(details.url, socketPolicy) !== undefined) return callback({ cancel: true });
      void publicAddress(details.url).then((ok) => callback({ cancel: !ok }));
    });
  }

  /**
   * The page that opens an engine's bridged sockets (main/webSockets.ts):
   * hidden, sandboxed, no Node, in the engine's session but on an origin of
   * its own, with a preload that exposes nothing to its page.
   */
  private spawnRelay(partition: string): RelayContents {
    const relay = new WebContentsView({
      webPreferences: {
        preload: path.join(this.deps.dist, "preload-relay.js"),
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // Its sockets stay open and drain while hidden.
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    relay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    relay.webContents.on("will-navigate", (event) => event.preventDefault());
    return relay.webContents;
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
        if (spec.settings) info.settings = spec.settings();
        return info;
      }
      case "secretLoad":
        return spec.secrets.load(request.key);
      case "secretSave":
        return spec.secrets.save(request.key, request.value);
      case "secretDelete":
        return spec.secrets.delete(request.key);
      case "http":
        // Never cookies: the bridge's session is the engine's alone, and it keeps none either way.
        return performHttp((url, init) => running.http.fetch(url, { ...init, credentials: "omit" }), request.request, { schemes: ["https:"], hosts: running.allowed.hosts }, "follow");
      case "lockHosts": {
        const hosts = narrowHosts(running.allowed.hosts, request.hosts);
        if (!hosts) throw new Error("A host lock can only narrow what the engine may reach");
        running.allowed.hosts = hosts;
        // A voice host stays only while it is on the domain of a host still allowed.
        if (running.allowed.voiceHost && !voiceHostAllowed(hosts, running.allowed.voiceHost)) delete running.allowed.voiceHost;
        return hosts;
      }
      case "addVoiceHost":
        return this.addVoiceHost(running, request.host);
      case "pickFiles":
        return this.pickFiles(running);
      case "ssoSignIn":
        return this.ssoSignIn(running, request.url);
      case "socketOpen":
        return running.sockets.open(request.url, request.protocols);
      case "socketSend":
        return running.sockets.send(request.id, request.data);
      case "socketClose":
        return running.sockets.close(request.id, request.code, request.reason);
      case "readFile": {
        const file = running.files.get(request.handle);
        if (!file) throw new Error("Unknown file");
        return readRange(file.path, request.start, Math.min(request.end, file.size));
      }
    }
  }

  /**
   * One more host for the engine's WebSockets (never its HTTP, nor its
   * view): its call's voice server, which the platform names only once the
   * user joins a call. Only for a module that declares it, only while the
   * engine says the user is signed in, one host per instance, and only one
   * with the registrable domain of a host the engine is locked to
   * (voiceHostAllowed()). An engine not locked reaches it already.
   */
  private addVoiceHost(running: Running, host: string): string {
    const { allowed } = running;
    if (!running.spec.voiceHost) throw new Error("This module adds no voice host");
    if (running.adapter.accountStatus().state !== "signed-in") throw new Error("A voice host is added only while signed in");
    if (allowed.voiceHost !== undefined) {
      if (allowed.voiceHost === host) return host;
      throw new Error("This service has added its voice host already");
    }
    if (!allowed.hosts) return host;
    if (isPrivateHost(host) || !voiceHostAllowed(allowed.hosts, host)) throw new Error(`${host} is not on the domain of this service's hosts`);
    allowed.voiceHost = host;
    return host;
  }

  /** The hosts a module's view may load from, as its engine may reach them now; undefined for any public host. */
  hostsFor(view: WebContents): readonly string[] | undefined {
    return this.byView.get(view)?.allowed.hosts;
  }

  /**
   * Hands the engine behind `view` a file of the shell's (a favourite, or a
   * sticker sent as a picture) to send into its open conversation. It reads
   * it through a handle, as it reads picked files; false when `view` is no
   * engine's view.
   */
  shareFile(view: WebContents, file: { path: string; size: number; name: string; type: string }, replyTo?: string): boolean {
    const running = this.byView.get(view);
    if (!running) return false;
    const handle = this.addFile(running, file.path, file.size);
    const action: NativeAction = { type: "sendFile", file: { handle, name: file.name, size: file.size, type: file.type } };
    if (replyTo) action.replyTo = replyTo;
    this.deliver(running, ENGINE_IPC.action, action);
    return true;
  }

  private addFile(running: Running, filePath: string, size: number): string {
    const handle = randomUUID();
    running.files.set(handle, { path: filePath, size });
    if (running.files.size > MAX_FILE_HANDLES) running.files.delete(running.files.keys().next().value!);
    return handle;
  }

  /**
   * Single sign-on for the engine: only right after the user submitted a
   * sign-in step in its view, once per submit, to a homeserver SSO address
   * on a host the engine may reach. The token comes back to this engine
   * alone, as the answer to its request; a new sign-on cancels one waiting.
   */
  private async ssoSignIn(running: Running, url: string): Promise<{ loginToken: string }> {
    if (Date.now() - running.signInAskedAt > SIGN_IN_WINDOW_MS) throw new Error("Single sign-on starts only when the user signs in");
    running.signInAskedAt = 0;
    const refused = isSsoUrl(url) ? checkUrl(url, { schemes: ["https:"], hosts: running.allowed.hosts }) : "it is no single sign-on address";
    if (refused) throw new Error(`Single sign-on refused: ${refused}`);
    running.sso?.abort();
    const controller = new AbortController();
    running.sso = controller;
    try {
      return { loginToken: await receiveLoginToken(url, { open: (address) => shell.openExternal(address) }, controller.signal) };
    } finally {
      if (running.sso === controller) running.sso = undefined;
    }
  }

  private async pickFiles(running: Running): Promise<PickedFile[]> {
    // Only right after the user asked, once per ask: an engine cannot pop file dialogs on its own.
    if (Date.now() - running.attachAskedAt > ATTACH_WINDOW_MS) throw new Error("Files can only be picked when the user asks to attach");
    running.attachAskedAt = 0;
    const result = await dialog.showOpenDialog(this.deps.window, { title: `Attach files to ${running.spec.def.name}`, properties: ["openFile", "multiSelections"] });
    if (result.canceled) return [];
    const picked: PickedFile[] = [];
    for (const filePath of result.filePaths) {
      const { size } = await stat(filePath);
      const handle = this.addFile(running, filePath, size);
      const name = path.basename(filePath);
      picked.push({ handle, name, size, type: contentTypeFor(name) });
    }
    return picked;
  }
}
