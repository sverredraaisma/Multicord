import { MAX_SOCKET_FRAME, MAX_SOCKET_QUEUE, MAX_SOCKETS, type EngineSocketEvent } from "../shared/engine";

/** One socket the host opened, as the relay uses it. */
export interface RelaySocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** What is waiting to be sent, as for MAX_SOCKET_QUEUE. */
  readonly bufferedAmount: number;
}

/** What the host reports of a socket it opened. */
export interface RelaySocketEvents {
  /** `protocol`: the subprotocol the server chose, if any. */
  open(protocol?: string): void;
  message(data: string | Uint8Array): void;
  /** Once, when the socket is closed for good or could not connect. */
  close(code: number, reason: string): void;
}

export interface EngineSocketsDeps {
  /** Why the engine may not open a socket to `url` now (its scheme, host or address), or undefined. */
  check(url: string): Promise<string | undefined>;
  /** Opens a socket the relay has allowed, offering the server these subprotocols. */
  connect(url: string, events: RelaySocketEvents, protocols?: string[]): RelaySocket;
  /** Sends the engine what happened on one of its sockets. */
  emit(event: EngineSocketEvent): void;
}

/** The close code the engine hears when a frame was too large, as a WebSocket would report it. */
const TOO_BIG = 1009;

const sizeOf = (data: string | Uint8Array): number => (typeof data === "string" ? data.length : data.byteLength);

/**
 * The shell's side of one engine's bridged WebSockets (bridgeWebSocket in
 * engine/runtime.ts). The shell opens each socket itself, only where the
 * engine's policy allows, and relays frames both ways: at most MAX_SOCKETS
 * at a time, frames within MAX_SOCKET_FRAME, and no more than
 * MAX_SOCKET_QUEUE waiting to be sent. The engine names sockets only by the
 * ids this relay gave out, so it can never reach another engine's.
 */
export class EngineSockets {
  private readonly sockets = new Map<string, { socket?: RelaySocket; open: boolean }>();
  private next = 0;

  constructor(private readonly deps: EngineSocketsDeps) {}

  get size(): number {
    return this.sockets.size;
  }

  async open(url: string, protocols?: string[]): Promise<{ id: string }> {
    if (this.sockets.size >= MAX_SOCKETS) throw new Error(`An engine may have at most ${MAX_SOCKETS} sockets open`);
    const id = String(++this.next);
    const entry: { socket?: RelaySocket; open: boolean } = { open: false };
    this.sockets.set(id, entry);
    let refused: string | undefined;
    try {
      refused = await this.deps.check(url);
    } catch (error) {
      refused = (error as Error).message;
    }
    if (this.sockets.get(id) !== entry) throw new Error("The socket was closed before it opened");
    if (refused) {
      this.sockets.delete(id);
      throw new Error(`Socket refused: ${refused}`);
    }
    const live = () => this.sockets.get(id) === entry;
    try {
      entry.socket = this.deps.connect(url, {
        open: (protocol) => {
          if (!live()) return;
          entry.open = true;
          // Only a subprotocol the engine offered, as a page's WebSocket would allow.
          this.deps.emit(protocol && protocols?.includes(protocol) ? { type: "open", id, protocol } : { type: "open", id });
        },
        message: (data) => {
          if (!live()) return;
          if (sizeOf(data) <= MAX_SOCKET_FRAME) return this.deps.emit({ type: "message", id, data });
          this.sockets.delete(id);
          // Without a code: a WebSocket may send only 1000 and 3000-4999 itself.
          entry.socket!.close();
          this.deps.emit({ type: "close", id, code: TOO_BIG, reason: "Frame too large" });
        },
        close: (code, reason) => {
          if (!live()) return;
          this.sockets.delete(id);
          this.deps.emit({ type: "close", id, code, reason });
        },
      }, protocols);
    } catch (error) {
      this.sockets.delete(id);
      throw new Error(`Socket refused: ${(error as Error).message}`);
    }
    return { id };
  }

  send(id: string, data: string | Uint8Array): void {
    const entry = this.sockets.get(id);
    if (!entry?.open) throw new Error("No such open socket");
    const socket = entry.socket!;
    if (socket.bufferedAmount + sizeOf(data) > MAX_SOCKET_QUEUE) throw new Error("The socket's send queue is full");
    socket.send(data);
  }

  /** Closes one of the engine's sockets; the engine hears of it as a close event. */
  close(id: string, code?: number, reason?: string): void {
    const entry = this.sockets.get(id);
    if (!entry) return;
    this.sockets.delete(id);
    entry.socket?.close(code, reason);
    this.deps.emit({ type: "close", id, code: code ?? 1000, reason: reason ?? "" });
  }

  /** Closes every socket without telling the engine, e.g. when it reloads or goes away. */
  closeAll(): void {
    const entries = [...this.sockets.values()];
    this.sockets.clear();
    for (const { socket } of entries) socket?.close();
  }
}
