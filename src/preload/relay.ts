// The socket relay's preload: it opens an engine's bridged WebSockets in
// Chromium's network stack and pipes their frames to the main process. It
// exposes nothing to its page and does only what the main process asks,
// which checked every URL first (src/main/webSockets.ts).

import { MAX_CLOSE_REASON, MAX_SOCKET_FRAME } from "../shared/engine";
import { RELAY_IPC, type RelayCommand, type RelayEvent } from "../shared/relay";

/** The IPC the relay preload uses. */
export interface RelayIpc {
  send(channel: string, payload: unknown): void;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

/** The parts of a page's WebSocket the relay uses. */
export interface RelayWebSocket {
  binaryType: string;
  readonly bufferedAmount: number;
  /** The subprotocol the server chose; "" for none. */
  readonly protocol: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
}

/** How often a socket with frames waiting reports what is left. */
export const DRAIN_POLL_MS = 100;
/** The close code for a frame that was too large, as a WebSocket would report it. */
const TOO_BIG = 1009;

const sizeOf = (data: string | Uint8Array): number => (typeof data === "string" ? data.length : data.byteLength);

export function startRelay(ipc: RelayIpc, create: (url: string, protocols?: string[]) => RelayWebSocket = (url, protocols) => new WebSocket(url, protocols) as unknown as RelayWebSocket): void {
  const sockets = new Map<string, RelayWebSocket>();
  const draining = new Set<string>();
  const emit = (event: RelayEvent): void => ipc.send(RELAY_IPC.event, event);

  /** Reports what a socket still holds until it has sent everything. */
  const drain = (id: string): void => {
    if (draining.has(id)) return;
    draining.add(id);
    const tick = (): void => {
      const socket = sockets.get(id);
      if (!socket) return void draining.delete(id);
      emit({ type: "buffered", id, amount: socket.bufferedAmount });
      if (socket.bufferedAmount > 0) setTimeout(tick, DRAIN_POLL_MS);
      else draining.delete(id);
    };
    setTimeout(tick, DRAIN_POLL_MS);
  };

  const open = (id: string, url: string, protocols: string[] | undefined): void => {
    if (sockets.has(id)) return;
    let socket: RelayWebSocket;
    try {
      socket = create(url, protocols);
    } catch {
      return emit({ type: "close", id, code: 1006, reason: "" });
    }
    sockets.set(id, socket);
    const live = (): boolean => sockets.get(id) === socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (!live()) return;
      emit(socket.protocol ? { type: "open", id, protocol: socket.protocol } : { type: "open", id });
    });
    socket.addEventListener("message", ({ data }) => {
      if (!live()) return;
      const frame = typeof data === "string" ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : undefined;
      if (frame === undefined) return;
      if (sizeOf(frame) <= MAX_SOCKET_FRAME) return emit({ type: "message", id, data: frame });
      sockets.delete(id);
      socket.close();
      emit({ type: "close", id, code: TOO_BIG, reason: "Frame too large" });
    });
    // A server's reason should fit a close frame; a longer one is cut to what the engine accepts.
    socket.addEventListener("close", ({ code, reason }) => {
      if (!live()) return;
      sockets.delete(id);
      emit({ type: "close", id, code, reason: reason.slice(0, MAX_CLOSE_REASON) });
    });
  };

  ipc.on(RELAY_IPC.command, (_event, payload) => {
    const command = payload as RelayCommand;
    switch (command.type) {
      case "open":
        return open(command.id, command.url, command.protocols);
      case "send": {
        const socket = sockets.get(command.id);
        if (!socket) return;
        socket.send(command.data);
        emit({ type: "buffered", id: command.id, amount: socket.bufferedAmount, sent: sizeOf(command.data) });
        if (socket.bufferedAmount > 0) drain(command.id);
        return;
      }
      case "close": {
        const socket = sockets.get(command.id);
        sockets.delete(command.id);
        try {
          socket?.close(command.code, command.reason);
        } catch {
          // Closed already, or a code the main process let through: the socket is forgotten either way.
        }
        return;
      }
    }
  });
  emit({ type: "ready" });
}
