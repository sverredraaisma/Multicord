import { isRecord } from "./types";

/** The parts of a WebSocket the client uses (the engine page's WebSocket fits). */
export interface EventSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

export type SocketFactory = (url: string) => EventSocket;

export type SocketStatus = "connecting" | "ready" | "reconnecting" | "closed";

export interface SocketHandlers {
  /** A server event after sign-in, and user:authenticated itself. */
  event(name: string, data: unknown): void;
  status(status: SocketStatus): void;
  /** Waiting in the server's sign-in queue: how many are ahead, 0 once through. */
  queue(position: number): void;
  /** The server refused the session (an invalid token, a suspension); no reconnecting helps. */
  authFailed(message: string): void;
}

/** Engine.IO's ping timing until the server's open packet gives its own. */
const DEFAULT_PING = { interval: 25_000, timeout: 20_000 };
const MAX_BACKOFF_MS = 30_000;
/** The server's own error for a socket that did not sign in within 30 s; reconnecting helps. */
const AUTH_TIMEOUT = "Authentication timed out";

/**
 * One connection to Nerimity's socket.io server, in its websocket transport
 * only: Engine.IO v4 framing (0 open, 2 ping, 3 pong, 4 message) carrying
 * socket.io packets (0 connect, 1 disconnect, 2 event) on the default
 * namespace, spoken over the page's plain WebSocket. It signs in with
 * user:authenticate as Nerimity's own client does, uncompressed. Binary
 * events (the zstd-compressed ones) are left out. Reconnects with backoff.
 */
export class NerimitySocket {
  private socket: EventSocket | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private ping = DEFAULT_PING;
  private attempts = 0;
  private connected = false;
  private signedIn = false;
  /** The socket.io session id of the connection now, from its connect packet; joining a call names it. */
  id: string | undefined;

  constructor(
    /** The site's origin, e.g. https://nerimity.com. */
    private readonly origin: string,
    /** Signs in each connection; replaced when the server hands out a new one. */
    public token: string,
    private readonly createSocket: SocketFactory,
    private readonly handlers: SocketHandlers,
  ) {}

  connect(): void {
    this.open();
  }

  disconnect(): void {
    clearTimeout(this.retry);
    this.drop(1000, "logout");
    this.handlers.status("closed");
  }

  /** Emits a client event (notification:dismiss) once signed in; dropped otherwise, as there is no one to hear it. */
  emit(event: string, data: unknown): void {
    if (this.signedIn) this.socket?.send(`42${JSON.stringify([event, data])}`);
  }

  private open(): void {
    this.handlers.status(this.attempts > 0 ? "reconnecting" : "connecting");
    const url = new URL("/socket.io/", this.origin);
    url.protocol = "wss:";
    url.search = "?EIO=4&transport=websocket";
    const socket = this.createSocket(url.href);
    this.socket = socket;
    this.connected = false;
    this.signedIn = false;
    socket.addEventListener("message", (event) => {
      if (socket === this.socket) this.onFrame(event.data);
    });
    socket.addEventListener("close", () => {
      if (socket === this.socket) this.reconnect();
    });
  }

  private onFrame(raw: unknown): void {
    // Binary frames carry attachments of binary events, which this client does not ask for.
    if (typeof raw !== "string" || raw === "") return;
    this.keepAlive();
    switch (raw[0]) {
      case "0": {
        const open = parseJson(raw.slice(1));
        if (isRecord(open) && typeof open.pingInterval === "number" && typeof open.pingTimeout === "number") {
          this.ping = { interval: Math.max(1000, open.pingInterval), timeout: Math.max(1000, open.pingTimeout) };
          this.keepAlive();
        }
        this.socket!.send("40");
        return;
      }
      case "2":
        this.socket!.send("3");
        return;
      case "1":
        this.reconnect();
        return;
      case "4":
        this.onPacket(raw.slice(1));
        return;
    }
  }

  /** A socket.io packet on the default namespace. */
  private onPacket(packet: string): void {
    switch (packet[0]) {
      case "0": {
        if (this.connected) return;
        this.connected = true;
        const connect = parseJson(packet.slice(1));
        this.id = isRecord(connect) && typeof connect.sid === "string" && /^[A-Za-z0-9_-]{3,64}$/.test(connect.sid) ? connect.sid : undefined;
        this.socket!.send(`42${JSON.stringify(["user:authenticate", { token: this.token }])}`);
        return;
      }
      case "1":
      case "4":
        // The server ended the namespace, or refused it.
        this.reconnect();
        return;
      case "2": {
        // An event: 2[name, data], perhaps with an ack id before the array.
        const event = parseJson(packet.slice(1).replace(/^\d+/, ""));
        if (Array.isArray(event) && typeof event[0] === "string") this.onEvent(event[0], event[1]);
        return;
      }
    }
  }

  private onEvent(name: string, data: unknown): void {
    switch (name) {
      case "user:auth_queue_position":
        if (isRecord(data) && typeof data.pos === "number" && data.pos >= 0) this.handlers.queue(data.pos);
        return;
      case "user:authenticate_error": {
        const message = isRecord(data) && typeof data.message === "string" && data.message !== "" ? data.message.slice(0, 200) : "Sign-in refused.";
        // The server disconnects after this; only a timeout is worth another try.
        if (message === AUTH_TIMEOUT) return;
        clearTimeout(this.retry);
        this.drop(1000, "refused");
        this.handlers.status("closed");
        this.handlers.authFailed(message);
        return;
      }
      case "user:authenticated":
        this.signedIn = true;
        this.attempts = 0;
        this.handlers.status("ready");
        break;
    }
    if (this.signedIn) this.handlers.event(name, data);
  }

  /** The server pings every interval; silence beyond interval + timeout means the connection is gone. */
  private keepAlive(): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.reconnect(), this.ping.interval + this.ping.timeout);
  }

  private drop(code: number, reason: string): void {
    clearTimeout(this.watchdog);
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.signedIn = false;
    this.id = undefined;
    socket?.close(code, reason);
  }

  /** Drops the socket and opens a new one after a growing delay. */
  private reconnect(): void {
    this.drop(4000, "reconnect");
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts);
    this.attempts++;
    this.handlers.status("reconnecting");
    this.retry = setTimeout(() => this.open(), delay);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
