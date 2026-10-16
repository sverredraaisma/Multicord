import { isRecord } from "./types";

/** The parts of a WebSocket the event connection uses (the browser's WebSocket fits). */
export interface EventSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

export type SocketFactory = (url: string) => EventSocket;

export type EventsStatus = "connecting" | "ready" | "reconnecting" | "closed";

export interface EventsHandlers {
  /** One event, by its type; Bulk events arrive unpacked. */
  dispatch(type: string, data: Record<string, unknown>): void;
  status(status: EventsStatus): void;
  /** The token was rejected or the session ended; the caller must sign in again. */
  authFailed(): void;
}

/** Commands a client may send once authenticated. */
export type ClientCommand = { type: "BeginTyping"; channel: string } | { type: "EndTyping"; channel: string };

/** What Ready should carry. Members are left out: large servers have many, and messages bring their authors. */
const READY_FIELDS = ["users", "servers", "channels", "emojis", "channel_unreads", "voice_states"];
const AUTH_ERRORS = new Set(["InvalidSession", "NotAuthenticated", "UnknownUser"]);
export const PING_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_BULK = 1000;

/**
 * One connection to Bonfire, Stoat's events WebSocket (protocol version 1,
 * JSON). Authenticates once the socket opens and pings to keep it alive;
 * Bonfire has no resume, so after a drop it reconnects and gets a fresh Ready.
 */
export class StoatEvents {
  private socket: EventSocket | undefined;
  private pinger: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private ponged = true;
  private ready = false;
  private attempts = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly createSocket: SocketFactory,
    private readonly handlers: EventsHandlers,
  ) {}

  connect(): void {
    this.open(false);
  }

  disconnect(): void {
    this.ready = false;
    clearTimeout(this.retry);
    clearInterval(this.pinger);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "logout");
    this.handlers.status("closed");
  }

  /** Sends a command on an authenticated connection; dropped otherwise. */
  command(command: ClientCommand): void {
    if (this.ready) this.send(command);
  }

  private open(again: boolean): void {
    this.ready = false;
    this.handlers.status(again ? "reconnecting" : "connecting");
    const query = new URLSearchParams([["version", "1"], ["format", "json"], ...READY_FIELDS.map((f) => ["ready", f])]);
    // No slash before the query: self-hosted instances proxy exactly /ws.
    const socket = this.createSocket(`${this.url}?${query}`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      // The token goes in the first message rather than the URL, which proxies may log.
      this.send({ type: "Authenticate", token: this.token });
      this.startPings();
    });
    socket.addEventListener("message", (event) => {
      if (socket === this.socket) this.onMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (socket === this.socket) this.onClose();
    });
  }

  private send(payload: unknown): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private onMessage(raw: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return;
    }
    this.onEvent(payload, 0);
  }

  private onEvent(payload: unknown, depth: number): void {
    if (!isRecord(payload) || typeof payload.type !== "string") return;
    switch (payload.type) {
      case "Bulk":
        if (depth === 0 && Array.isArray(payload.v)) for (const event of payload.v.slice(0, MAX_BULK)) this.onEvent(event, 1);
        return;
      case "Pong":
        this.ponged = true;
        return;
      case "Authenticated":
        return;
      case "Logout":
        return this.authFailed();
      case "Error": {
        const type = isRecord(payload.data) ? payload.data.type : payload.data;
        if (typeof type === "string" && AUTH_ERRORS.has(type)) this.authFailed();
        return;
      }
      case "Ready":
        this.attempts = 0;
        this.ready = true;
        this.handlers.status("ready");
        break;
    }
    this.handlers.dispatch(payload.type, payload);
  }

  private authFailed(): void {
    this.ready = false;
    clearInterval(this.pinger);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "session ended");
    this.handlers.status("closed");
    this.handlers.authFailed();
  }

  private startPings(): void {
    clearInterval(this.pinger);
    this.ponged = true;
    this.pinger = setInterval(() => {
      if (!this.ponged) {
        // No Pong since the last Ping: the connection is a zombie.
        this.reconnect();
        return;
      }
      this.ponged = false;
      this.send({ type: "Ping", data: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private reconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(4000, "reconnect");
    this.onClose();
  }

  /** The current socket closed; a stopped connection has already let go of its socket, so this only runs while live. */
  private onClose(): void {
    this.ready = false;
    this.socket = undefined;
    clearInterval(this.pinger);
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts);
    this.attempts++;
    this.handlers.status("reconnecting");
    this.retry = setTimeout(() => this.open(true), delay);
  }
}
