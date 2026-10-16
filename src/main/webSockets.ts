// The sockets the shell opens for engines that bridge their WebSockets
// (core/engineSockets.ts), on the WebSocket the main process's Node has.

import type { RelaySocket, RelaySocketEvents } from "../core/engineSockets";
import { MAX_CLOSE_REASON } from "../shared/engine";

/** The parts of a WebSocket used here; Node's global WebSocket fits. */
export interface HostWebSocket {
  binaryType: string;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
}

/**
 * Opens a socket for an engine. It carries no cookies and follows no
 * redirects; the relay has checked the URL already.
 */
export function openHostSocket(url: string, events: RelaySocketEvents, create: (url: string) => HostWebSocket = (u) => new WebSocket(u) as unknown as HostWebSocket): RelaySocket {
  const socket = create(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => events.open());
  socket.addEventListener("message", ({ data }) => {
    if (typeof data === "string") events.message(data);
    else if (data instanceof ArrayBuffer) events.message(new Uint8Array(data));
  });
  // A server's reason should fit a close frame; a longer one is cut to what the engine accepts.
  socket.addEventListener("close", ({ code, reason }) => events.close(code, reason.slice(0, MAX_CLOSE_REASON)));
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
  };
}
