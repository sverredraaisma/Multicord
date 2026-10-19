// Engine-side helpers: what a module engine builds on. They turn the narrow
// bridge into familiar shapes (fetch, a secret store, file sources) and
// serve an ordinary PlatformAdapter to the shell.

import type { EngineBridge } from "../preload/engine";
import type { DirectConversation, PlatformAdapter, RailServer } from "../shared/adapter";
import { isEngineSocketEvent, isSocketProtocols, MAX_CLOSE_REASON, type EngineDirect, type EngineInfo, type EngineRequest, type EngineServer, type EngineSocketEvent, type HttpRequest, type HttpResponse, type PickedFile } from "../shared/engine";
import type { AccountStatus } from "../shared/settings";

/** A file to upload, read in ranges so it never has to sit in memory whole. */
export interface FileSource {
  filename: string;
  size: number;
  contentType: string;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface AsyncSecretStore {
  load(key: string): Promise<string | undefined>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function engineInfo(bridge: EngineBridge): Promise<EngineInfo> {
  return bridge.request({ type: "info" }) as Promise<EngineInfo>;
}

export function bridgeSecrets(bridge: EngineBridge): AsyncSecretStore {
  return {
    load: (key) => bridge.request({ type: "secretLoad", key }) as Promise<string | undefined>,
    save: async (key, value) => void (await bridge.request({ type: "secretSave", key, value })),
    delete: async (key) => void (await bridge.request({ type: "secretDelete", key })),
  };
}

/**
 * fetch over the shell's HTTP bridge, which checks every URL against the
 * module's allowed hosts and sends no cookies.
 */
export function bridgeFetch(bridge: EngineBridge): typeof fetch {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name] = value));
    const request: HttpRequest = { url, method: (init.method ?? "GET").toUpperCase(), headers };
    if (typeof init.body === "string") request.body = init.body;
    else if (init.body instanceof Uint8Array) request.body = init.body;
    else if (init.body instanceof ArrayBuffer) request.body = new Uint8Array(init.body);
    else if (init.body != null) throw new TypeError("Unsupported request body");
    const response = (await bridge.request({ type: "http", request })) as HttpResponse;
    // Null-body statuses must not carry a body in a Response.
    const empty = response.status === 204 || response.status === 205 || response.status === 304;
    return new Response(empty ? null : new Uint8Array(response.body), { status: response.status, headers: response.headers });
  };
}

/**
 * Locks the engine to these hosts from now on (e.g. its instance's API, events
 * and file hosts, once discovered). The shell only ever narrows a lock, so
 * code that later runs in the engine cannot reach anywhere else.
 */
export async function lockHosts(bridge: EngineBridge, hosts: string[]): Promise<void> {
  await bridge.request({ type: "lockHosts", hosts });
}

/**
 * Lets the engine's WebSockets (only those) reach one more host: its call's
 * voice server, named once the user joined a call. The shell allows it only
 * for a module that declares `voiceHost`, while signed in, once, and on the
 * registrable domain of a host the engine is locked to; it rejects otherwise.
 */
export async function addVoiceHost(bridge: EngineBridge, host: string): Promise<void> {
  await bridge.request({ type: "addVoiceHost", host });
}

/**
 * Signs in through the homeserver's single sign-on (Matrix's m.login.sso):
 * the shell opens `url` (the homeserver's SSO redirect) in the browser and
 * receives the login token that comes back. Works only right after the user
 * submitted a sign-in step in the module's view.
 */
export async function ssoSignIn(bridge: EngineBridge, url: string): Promise<string> {
  const answer = (await bridge.request({ type: "ssoSignIn", url })) as { loginToken?: unknown };
  if (typeof answer?.loginToken !== "string" || answer.loginToken === "") throw new Error("Single sign-on brought no login token");
  return answer.loginToken;
}

/** The events a BridgedWebSocket dispatches, by type, shaped as a page's WebSocket events as far as modules read them. */
export interface BridgedSocketEvents {
  open: { type: "open" };
  message: { type: "message"; data: string | ArrayBuffer };
  error: { type: "error" };
  close: { type: "close"; code: number; reason: string; wasClean: boolean };
}

type BridgedSocketEvent = BridgedSocketEvents[keyof BridgedSocketEvents];
type SocketListener = (event: BridgedSocketEvent) => void;

/** What a bridged WebSocket needs of its bridge: socket requests, and the socket events coming back. */
export type SocketBridge = Pick<EngineBridge, "request" | "onSocket">;

/**
 * A WebSocket the shell opens and relays for the engine (bridgeWebSocket).
 * It behaves as a page's WebSocket does, as far as modules use one: the
 * same ready states, open, message, error and close events (as listeners
 * or as on* handlers), send() and close(). Binary messages arrive as
 * ArrayBuffers.
 */
export class BridgedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = BridgedWebSocket.CONNECTING;
  /** Binary messages arrive as ArrayBuffers only; a page may set it so (LiveKit does), never to blob. */
  binaryType: "arraybuffer" = "arraybuffer";
  /** The subprotocol the server chose, once open; "" for none. */
  protocol = "";
  /** No extensions are negotiated through the bridge. */
  readonly extensions = "";
  /** What waits to be sent is the shell's to count (MAX_SOCKET_QUEUE); never reported here. */
  readonly bufferedAmount = 0;
  /** Handlers as a page's WebSocket has them; each runs after the listeners for its event. */
  onopen: ((event: BridgedSocketEvents["open"]) => void) | null = null;
  onmessage: ((event: BridgedSocketEvents["message"]) => void) | null = null;
  onerror: ((event: BridgedSocketEvents["error"]) => void) | null = null;
  onclose: ((event: BridgedSocketEvents["close"]) => void) | null = null;
  private id: string | undefined;
  private closeAsked: { code?: number; reason?: string } | undefined;
  private readonly listeners = new Map<string, Set<SocketListener>>();
  /** Listeners added with { once: true }: each runs for one event, then goes. */
  private readonly once = new WeakSet<SocketListener>();

  constructor(
    readonly url: string,
    private readonly bridge: SocketBridge,
  ) {}

  addEventListener<K extends keyof BridgedSocketEvents>(type: K, listener: (event: BridgedSocketEvents[K]) => void, options?: boolean | { once?: boolean }): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    if (set.has(listener as SocketListener)) return;
    set.add(listener as SocketListener);
    if (typeof options === "object" && options.once) this.once.add(listener as SocketListener);
    else this.once.delete(listener as SocketListener);
  }

  removeEventListener<K extends keyof BridgedSocketEvents>(type: K, listener: (event: BridgedSocketEvents[K]) => void): void {
    this.listeners.get(type)?.delete(listener as SocketListener);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState === BridgedWebSocket.CONNECTING) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
    // As a page's WebSocket: frames after closing are dropped.
    if (this.readyState !== BridgedWebSocket.OPEN) return;
    const frame =
      typeof data === "string" ? data
      : data instanceof ArrayBuffer ? new Uint8Array(data.slice(0))
      : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    this.bridge.request({ type: "socketSend", id: this.id!, data: frame }).catch(() => this.fail());
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) throw new DOMException(`The close code must be 1000 or between 3000 and 4999; ${code} is neither.`, "InvalidAccessError");
    if (reason !== undefined && new TextEncoder().encode(reason).byteLength > MAX_CLOSE_REASON) throw new DOMException("The close reason must not be longer than 123 bytes.", "SyntaxError");
    if (this.readyState >= BridgedWebSocket.CLOSING) return;
    this.readyState = BridgedWebSocket.CLOSING;
    this.closeAsked = { code, reason };
    if (this.id !== undefined) this.askClose();
  }

  /** The shell opened the socket under this id. */
  attached(id: string): void {
    this.id = id;
    if (this.closeAsked) this.askClose();
  }

  /** What the shell reports about this socket. */
  receive(event: EngineSocketEvent): void {
    switch (event.type) {
      case "open":
        if (this.readyState !== BridgedWebSocket.CONNECTING) return;
        this.readyState = BridgedWebSocket.OPEN;
        this.protocol = event.protocol ?? "";
        return this.dispatch({ type: "open" });
      case "message": {
        if (this.readyState !== BridgedWebSocket.OPEN) return;
        const { data } = event;
        return this.dispatch({ type: "message", data: typeof data === "string" ? data : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) });
      }
      case "close":
        return this.closed(event.code, event.reason);
    }
  }

  /** The socket could not open, or broke: an error, then a close as for a lost connection. */
  fail(): void {
    if (this.id !== undefined && this.readyState !== BridgedWebSocket.CLOSED) void this.bridge.request({ type: "socketClose", id: this.id }).catch(() => {});
    this.closed(1006, "");
  }

  private askClose(): void {
    const { code, reason } = this.closeAsked!;
    const request: EngineRequest = { type: "socketClose", id: this.id! };
    if (code !== undefined) request.code = code;
    if (reason !== undefined) request.reason = reason;
    // The shell answers with a close event; a socket it no longer knows is closed already.
    void this.bridge.request(request).catch(() => this.closed(code ?? 1005, reason ?? ""));
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === BridgedWebSocket.CLOSED) return;
    this.readyState = BridgedWebSocket.CLOSED;
    if (code === 1006) this.dispatch({ type: "error" });
    this.dispatch({ type: "close", code, reason, wasClean: code !== 1006 });
  }

  private dispatch(event: BridgedSocketEvent): void {
    const set = this.listeners.get(event.type);
    for (const listener of [...(set ?? [])]) {
      if (this.once.has(listener)) set!.delete(listener);
      listener(event);
    }
    (this[`on${event.type}`] as SocketListener | null)?.call(this, event);
  }
}

/**
 * WebSockets through the shell, for an engine that may not open its own
 * (on a phone, where the shell holds the connections). The shell opens
 * each socket with the engine's host policy (wss only, its hosts or lock,
 * public addresses) and relays frames both ways, within MAX_SOCKETS sockets,
 * MAX_SOCKET_FRAME a frame and MAX_SOCKET_QUEUE waiting to be sent.
 * Returns a factory for a module's socket factory: `(url, protocols?) =>
 * socket`, with subprotocols as a page's WebSocket takes them.
 */
export function bridgeWebSocket(bridge: SocketBridge): (url: string, protocols?: string | string[]) => BridgedWebSocket {
  const sockets = new Map<string, BridgedWebSocket>();
  bridge.onSocket((event) => {
    if (!isEngineSocketEvent(event)) return;
    const socket = sockets.get(event.id);
    if (event.type === "close") sockets.delete(event.id);
    socket?.receive(event);
  });
  return (url, protocols = []) => {
    const offered = typeof protocols === "string" ? [protocols] : [...protocols];
    // As a page's WebSocket: names that are no tokens, or repeated, throw at once.
    if (offered.length > 0 && !isSocketProtocols(offered)) throw new DOMException(`Invalid subprotocols: ${String(protocols)}`, "SyntaxError");
    const socket = new BridgedWebSocket(url, bridge);
    bridge.request(offered.length > 0 ? { type: "socketOpen", url, protocols: offered } : { type: "socketOpen", url }).then(
      (answer) => {
        const { id } = answer as { id: string };
        sockets.set(id, socket);
        socket.attached(id);
      },
      () => socket.fail(),
    );
    return socket;
  };
}

/** The files a module may send: those the user picks, and those the shell hands it (sendFile actions). */
export interface EngineFiles {
  pick(): Promise<FileSource[]>;
  /** Opens a file the shell handed over in a sendFile action. */
  open?(file: PickedFile): FileSource;
}

/** A file the shell handed the engine (picked, or shared in a sendFile action), read through its handle. */
export function fileSource(bridge: EngineBridge, file: PickedFile): FileSource {
  return {
    filename: file.name,
    size: file.size,
    contentType: file.type,
    read: (start, end) => bridge.request({ type: "readFile", handle: file.handle, start, end }) as Promise<Uint8Array>,
  };
}

/** Lets the user pick files through the shell; each is read through its handle. */
export async function pickFiles(bridge: EngineBridge): Promise<FileSource[]> {
  const picked = (await bridge.request({ type: "pickFiles" })) as PickedFile[];
  return picked.map((file) => fileSource(bridge, file));
}

/** An adapter an engine serves: the PlatformAdapter contract plus the view's actions. */
export interface ServedAdapter extends PlatformAdapter {
  handleAction?(action: unknown): Promise<void>;
}

function toEngineServer(server: RailServer): EngineServer {
  const { account: _account, children, ...rest } = server;
  const out: EngineServer = { ...rest };
  if (children) out.children = children.map(toEngineServer);
  return out;
}

function toEngineDirect({ account: _account, ...rest }: DirectConversation): EngineDirect {
  return rest;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Serves an adapter to the shell: its rail data, notifications and calls go
 * out as events, and shell commands and view actions come in. Returns
 * `sync`, which reports account and home badge changes; call it after
 * anything that may change them (e.g. after each render).
 */
export function serveAdapter(bridge: EngineBridge, adapter: ServedAdapter, log: (message: string) => void = console.warn): { sync(): void } {
  let lastAccount = "";
  let lastBadge = "";
  let lastSettings = "{}";
  let lastHealth = "[]";
  const sync = (): void => {
    const checks = adapter.health?.();
    const checksJson = JSON.stringify(checks ?? []);
    if (checks && checksJson !== lastHealth) {
      lastHealth = checksJson;
      bridge.emit({ type: "health", checks });
    }
    const status = adapter.settingsStatus?.();
    const statusJson = JSON.stringify(status ?? {});
    if (status && statusJson !== lastSettings) {
      lastSettings = statusJson;
      bridge.emit({ type: "settingsStatus", status });
    }
    const account: AccountStatus = adapter.accountStatus?.() ?? { state: "unknown" };
    const accountJson = JSON.stringify(account);
    if (accountJson !== lastAccount) {
      lastAccount = accountJson;
      bridge.emit({ type: "account", account });
    }
    const badge = adapter.homeBadge?.();
    const badgeJson = JSON.stringify(badge);
    if (badge && badgeJson !== lastBadge) {
      lastBadge = badgeJson;
      bridge.emit({ type: "homeBadge", badge });
    }
  };

  adapter.onServersChanged((servers) => {
    bridge.emit({ type: "servers", servers: servers.map(toEngineServer) });
    sync();
  });
  adapter.onDirectsChanged((directs) => {
    bridge.emit({ type: "directs", directs: directs.map(toEngineDirect) });
    sync();
  });
  adapter.onNotification((notification) => bridge.emit({ type: "notification", notification }));
  adapter.onIncomingCall((call) => bridge.emit({ type: "call", call }));

  const attempt = (what: string, task: () => Promise<void> | void): void => {
    void Promise.resolve()
      .then(task)
      .catch((error: unknown) => log(`${what}: ${messageOf(error)}`));
  };
  bridge.onCommand((command) => {
    switch (command.type) {
      case "openHome":
        return attempt("open home", () => adapter.openHome?.());
      case "openServer":
        return attempt("open server", () => adapter.openServer(command.key));
      case "openConversation":
        return attempt("open conversation", () => adapter.openConversation(command.key));
      case "toggleGroup":
        return attempt("toggle group", () => adapter.toggleGroup?.(command.key));
      case "visible":
        return adapter.setVisible?.(command.visible);
      case "signOut":
        return attempt("sign out", () => adapter.signOut?.());
      case "settings":
        return attempt("apply settings", () => {
          adapter.applySettings?.(command.values);
          sync();
        });
      case "settingAction":
        return attempt(`setting ${command.key}`, async () => {
          try {
            await adapter.runSettingAction?.(command.key);
          } finally {
            sync();
          }
        });
    }
  });
  bridge.onAction((action) => attempt("action", () => adapter.handleAction?.(action)));
  return { sync };
}
