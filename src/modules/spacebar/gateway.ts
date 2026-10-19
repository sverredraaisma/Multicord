import { isRecord } from "./types";

/** The parts of a WebSocket the gateway uses (the engine page's WebSocket fits). */
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
  /** The token was rejected; the caller must sign in again. */
  authFailed(): void;
}

const Op = { Dispatch: 0, Heartbeat: 1, Identify: 2, VoiceStateUpdate: 4, Resume: 6, Reconnect: 7, InvalidSession: 9, Hello: 10, HeartbeatAck: 11 };
const AUTH_FAILED = 4004;
/** Close codes where reconnecting cannot help (Discord's, which Spacebar keeps). */
const FATAL = new Set([4010, 4011, 4012, 4013, 4014]);
const MAX_BACKOFF_MS = 30_000;

/**
 * One gateway session (JSON, uncompressed), in Discord's protocol as Spacebar
 * speaks it. Identifies honestly as Multicord; resumes after drops while the
 * server keeps the session.
 */
export class SpacebarGateway {
  private socket: GatewaySocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private firstBeat: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private acked = true;
  private seq: number | null = null;
  private sessionId: string | undefined;
  private attempts = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly createSocket: SocketFactory,
    private readonly handlers: GatewayHandlers,
    private readonly platform: string = "unknown",
  ) {}

  connect(): void {
    this.open();
  }

  /** The session's id once READY: a voice server's identify names it. */
  get session(): string | undefined {
    return this.sessionId;
  }

  /**
   * Joins, changes or leaves a call (op 4 Voice State Update, as Spacebar's
   * src/gateway/opcodes/VoiceStateUpdate.ts takes it): a channel, or null
   * for both to leave. Dropped while the socket is down, as a page's would be.
   */
  voiceState(d: { guild_id: string | null; channel_id: string | null; self_mute: boolean; self_deaf: boolean; self_video: boolean }): void {
    this.send(Op.VoiceStateUpdate, d);
  }

  disconnect(): void {
    clearTimeout(this.retry);
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "logout");
    this.handlers.status("closed");
  }

  private open(): void {
    this.handlers.status(this.sessionId ? "reconnecting" : "connecting");
    // Spacebar reads only `encoding` (and an optional `compress`, left out: messages come as plain JSON).
    const socket = this.createSocket(`${this.url}/?encoding=json&v=9`);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (socket === this.socket) this.onMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (socket === this.socket) this.onClose(event.code);
    });
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
        const interval = isRecord(payload.d) && typeof payload.d.heartbeat_interval === "number" && payload.d.heartbeat_interval >= 1000 ? payload.d.heartbeat_interval : 30_000;
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
        this.sessionId = undefined;
        this.seq = null;
        this.identify();
        break;
    }
  }

  private onDispatch(payload: Record<string, unknown>): void {
    if (typeof payload.s === "number") this.seq = payload.s;
    if (typeof payload.t !== "string") return;
    if (payload.t === "READY" && isRecord(payload.d) && typeof payload.d.session_id === "string") this.sessionId = payload.d.session_id;
    if (payload.t === "READY" || payload.t === "RESUMED") {
      this.attempts = 0;
      this.handlers.status("ready");
    }
    this.handlers.dispatch(payload.t, payload.d);
  }

  private identify(): void {
    this.send(Op.Identify, { token: this.token, properties: { os: this.platform, browser: "Multicord", device: "Multicord" }, compress: false });
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
    const socket = this.socket;
    this.socket = undefined;
    this.stopHeartbeat();
    socket?.close(4000, "reconnect");
    this.scheduleOpen();
  }

  private onClose(code: number): void {
    this.socket = undefined;
    this.stopHeartbeat();
    if (code === AUTH_FAILED || FATAL.has(code)) {
      this.handlers.status("closed");
      if (code === AUTH_FAILED) this.handlers.authFailed();
      return;
    }
    this.scheduleOpen();
  }

  private scheduleOpen(): void {
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts);
    this.attempts++;
    this.handlers.status("reconnecting");
    this.retry = setTimeout(() => this.open(), delay);
  }
}
