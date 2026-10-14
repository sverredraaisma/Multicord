import { isRecord } from "./types";

/** The parts of a WebSocket the gateway uses (Node's global WebSocket fits). */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

export type SocketFactory = (url: string) => GatewaySocket;

export type GatewayStatus = "connecting" | "ready" | "reconnecting" | "closed";

export interface GatewayHandlers {
  dispatch(event: string, data: unknown): void;
  status(status: GatewayStatus): void;
  /** The token was rejected; the caller must log in again. */
  authFailed(): void;
}

const Op = { Dispatch: 0, Heartbeat: 1, Identify: 2, Resume: 6, Reconnect: 7, InvalidSession: 9, Hello: 10, HeartbeatAck: 11 };
const AUTH_FAILED = 4004;
/** Identify flag: deliver threads, forum and media channels and their events. */
const CHANNEL_THREADS = 1 << 2;
/** Close codes where reconnecting cannot help. */
const FATAL = new Set([4010, 4011, 4012]);
const MAX_BACKOFF_MS = 30_000;

/**
 * One gateway session (API v1, JSON, uncompressed). Identifies honestly as
 * Multicord; resumes after drops while the server keeps the session (60 s).
 */
export class FluxerGateway {
  private socket: GatewaySocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private firstBeat: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private acked = true;
  private seq: number | null = null;
  private sessionId: string | undefined;
  private ready = false;
  private attempts = 0;
  private stopped = true;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly createSocket: SocketFactory,
    private readonly handlers: GatewayHandlers,
    private readonly platform: string = process.platform,
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.retry);
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "logout");
    this.handlers.status("closed");
  }

  private open(): void {
    this.ready = false;
    this.handlers.status(this.sessionId ? "reconnecting" : "connecting");
    const socket = this.createSocket(`${this.url}/?v=1&encoding=json`);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (socket === this.socket) this.onMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (socket === this.socket) this.onClose(event.code);
    });
  }

  /**
   * Sends a command (e.g. op 4 voice state, op 14 lazy request) on a ready
   * session; dropped otherwise, as commands before Identify close the socket.
   */
  command(op: number, d: unknown): void {
    if (this.ready) this.send(op, d);
  }

  private send(op: number, d: unknown): void {
    this.socket?.send(JSON.stringify({ op, d }));
  }

  private onMessage(raw: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isRecord(payload) || typeof payload.op !== "number") return;
    switch (payload.op) {
      case Op.Hello: {
        const interval = isRecord(payload.d) && typeof payload.d.heartbeat_interval === "number" ? payload.d.heartbeat_interval : 41_250;
        this.startHeartbeat(interval);
        if (this.sessionId) this.send(Op.Resume, { token: this.token, session_id: this.sessionId, seq: this.seq });
        else this.identify();
        break;
      }
      case Op.HeartbeatAck:
        this.acked = true;
        break;
      case Op.Heartbeat:
        this.send(Op.Heartbeat, this.seq);
        break;
      case Op.Dispatch:
        this.onDispatch(payload);
        break;
      case Op.Reconnect:
        this.reconnect();
        break;
      case Op.InvalidSession:
        // The socket stays open; start a fresh session on it.
        this.ready = false;
        this.sessionId = undefined;
        this.seq = null;
        this.identify();
        break;
    }
  }

  private onDispatch(payload: Record<string, unknown>): void {
    if (typeof payload.s === "number") this.seq = payload.s;
    if (typeof payload.t !== "string") return;
    if (payload.t === "READY" && isRecord(payload.d) && typeof payload.d.session_id === "string") {
      this.sessionId = payload.d.session_id;
    }
    if (payload.t === "READY" || payload.t === "RESUMED") {
      this.attempts = 0;
      this.ready = true;
      this.handlers.status("ready");
    }
    this.handlers.dispatch(payload.t, payload.d);
  }

  private identify(): void {
    this.send(Op.Identify, {
      token: this.token,
      properties: { os: this.platform, browser: "Multicord", device: "Multicord" },
      flags: CHANNEL_THREADS,
    });
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat();
    this.acked = true;
    const beat = (): void => {
      if (!this.acked) {
        // No ACK since the last beat: the connection is a zombie.
        this.reconnect();
        return;
      }
      this.acked = false;
      this.send(Op.Heartbeat, this.seq);
    };
    this.firstBeat = setTimeout(() => {
      beat();
      this.heartbeat = setInterval(beat, interval);
    }, Math.floor(interval * Math.random()));
  }

  private stopHeartbeat(): void {
    clearTimeout(this.firstBeat);
    clearInterval(this.heartbeat);
  }

  /** Drops the socket and opens a new one, resuming if possible. */
  private reconnect(): void {
    this.ready = false;
    const socket = this.socket;
    this.socket = undefined;
    this.stopHeartbeat();
    socket?.close(4000, "reconnect");
    this.scheduleOpen();
  }

  private onClose(code: number): void {
    this.ready = false;
    this.socket = undefined;
    this.stopHeartbeat();
    if (code === AUTH_FAILED) {
      this.stopped = true;
      this.handlers.status("closed");
      this.handlers.authFailed();
      return;
    }
    if (FATAL.has(code)) {
      this.stopped = true;
      this.handlers.status("closed");
      return;
    }
    this.scheduleOpen();
  }

  private scheduleOpen(): void {
    if (this.stopped) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts);
    this.attempts++;
    this.handlers.status("reconnecting");
    this.retry = setTimeout(() => this.open(), delay);
  }
}
