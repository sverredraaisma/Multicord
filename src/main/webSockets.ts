// The sockets the shell opens for engines that bridge their WebSockets
// (core/engineSockets.ts).
//
// They open in Chromium's network stack, not on the main process's Node
// WebSocket, which ignores the system's proxy settings and certificate
// store and sends no Origin. Electron has no main-process WebSocket on
// Chromium's stack (net covers HTTP only), so each engine gets a relay: a
// hidden page of the shell's own, sandboxed, with no Node and a preload
// that exposes nothing to its page (preload/relay.ts). It runs in the
// engine's own session, so its sockets go through the same proxy,
// certificates and network checks as the engine's own did, but on an origin
// of its own (<engine>.relay, which no engine id can be) that the engine
// cannot frame, open or reach. The relay is a dumb pipe: it opens only what
// the main process asks, after EngineSockets checked it against the
// engine's policy, and the main process takes its reports only from that
// one page.

import type { RelaySocket, RelaySocketEvents } from "../core/engineSockets";
import { isRelayEvent, RELAY_IPC, type RelayCommand } from "../shared/relay";

/** The host of an engine's relay page; engine ids have no dots, so it is never an engine's. */
export const relayHost = (engine: string): string => `${engine}.relay`;

const RELAY_CSP = ["default-src 'none'", "connect-src wss:"].join("; ");
const RELAY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>relay</title></head><body></body></html>`;

/** Serves the relay page: no script of its own, only the preload. */
export function serveRelay(url: string): Response {
  const headers = { "Content-Security-Policy": RELAY_CSP, "X-Content-Type-Options": "nosniff" };
  const { pathname } = new URL(url);
  if (pathname !== "/" && pathname !== "/relay.html") return new Response("Not found", { status: 404, headers });
  return new Response(RELAY_PAGE, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}

/** The relay page's WebContents, as SocketRelay uses it. */
export interface RelayContents {
  send(channel: string, payload: unknown): void;
  loadURL(url: string): Promise<void>;
  close(): void;
  on(event: "destroyed" | "render-process-gone", listener: () => void): unknown;
}

const sizeOf = (data: string | Uint8Array): number => (typeof data === "string" ? data.length : data.byteLength);

/**
 * One engine's relay. The page starts with the first socket and stays for
 * the engine's life; if it goes away its sockets break (1006) and the next
 * socket starts a new page.
 */
export class SocketRelay {
  private contents: RelayContents | undefined;
  private ready = false;
  private queue: RelayCommand[] = [];
  private readonly sockets = new Map<string, { events: RelaySocketEvents; inFlight: number; buffered: number }>();
  private next = 0;

  constructor(private readonly deps: { spawn(): RelayContents; url: string }) {}

  /** Whether `contents` is this relay's page now. */
  owns(contents: unknown): boolean {
    return contents !== undefined && contents === this.contents;
  }

  /** Opens a socket the main process has checked, offering these subprotocols. */
  open(url: string, events: RelaySocketEvents, protocols?: string[]): RelaySocket {
    const id = String(++this.next);
    const entry = { events, inFlight: 0, buffered: 0 };
    this.sockets.set(id, entry);
    this.command(protocols ? { type: "open", id, url, protocols } : { type: "open", id, url });
    return {
      send: (data) => {
        entry.inFlight += sizeOf(data);
        this.command({ type: "send", id, data });
      },
      close: (code, reason) => {
        if (!this.sockets.delete(id)) return;
        const command: RelayCommand = { type: "close", id };
        if (code !== undefined) command.code = code;
        if (reason !== undefined) command.reason = reason;
        this.command(command);
      },
      get bufferedAmount() {
        return entry.inFlight + entry.buffered;
      },
    };
  }

  /** A report from a renderer; taken only from this relay's page. */
  receive(from: unknown, payload: unknown): void {
    if (!this.owns(from) || !isRelayEvent(payload)) return;
    if (payload.type === "ready") {
      this.ready = true;
      for (const command of this.queue.splice(0)) this.contents!.send(RELAY_IPC.command, command);
      return;
    }
    const entry = this.sockets.get(payload.id);
    if (!entry) return;
    switch (payload.type) {
      case "open":
        return entry.events.open(payload.protocol);
      case "message":
        return entry.events.message(payload.data);
      case "close":
        this.sockets.delete(payload.id);
        return entry.events.close(payload.code, payload.reason);
      case "buffered":
        entry.inFlight = Math.max(0, entry.inFlight - (payload.sent ?? 0));
        entry.buffered = payload.amount;
        return;
    }
  }

  /** Closes the page and with it every socket, e.g. when the engine goes away. */
  dispose(): void {
    const contents = this.contents;
    this.gone();
    contents?.close();
  }

  private command(command: RelayCommand): void {
    if (!this.contents) this.start();
    if (this.ready) this.contents!.send(RELAY_IPC.command, command);
    else this.queue.push(command);
  }

  private start(): void {
    const contents = this.deps.spawn();
    this.contents = contents;
    this.ready = false;
    const crashed = (): void => {
      if (this.contents === contents) this.dispose();
    };
    contents.on("render-process-gone", crashed);
    contents.on("destroyed", () => {
      if (this.contents === contents) this.gone();
    });
    contents.loadURL(this.deps.url).catch(crashed);
  }

  /** The page is gone: its sockets broke. */
  private gone(): void {
    this.contents = undefined;
    this.ready = false;
    this.queue = [];
    const entries = [...this.sockets.values()];
    this.sockets.clear();
    for (const { events } of entries) events.close(1006, "");
  }
}
