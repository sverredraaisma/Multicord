import { bridgeWebSocket, type SocketBridge } from "../engine/runtime";

/** WebSocket's ready states, as the constructor carries them. */
const STATES = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

/**
 * Phones only (mobile/android's view bridge): the chat view's WebSocket
 * becomes one the phone opens and relays, as it does an engine's
 * (bridgeWebSocket): wss only, to hosts the view's engine may reach now,
 * public addresses only (checked when it connects), within the engine
 * socket caps, and only while the engine reports a call. LiveKit's
 * signalling is what uses it; the view's page has no network of its own
 * for WebSockets (its CSP allows none). The page is ours, so replacing the
 * global is safe: it happens before anything runs that could open one.
 */
export function relayWebSockets(win: typeof globalThis, relay: SocketBridge): void {
  const open = bridgeWebSocket(relay);
  // A page's WebSocket must be called with new; returning the relayed socket from the constructor makes it the instance.
  function RelayWebSocket(this: unknown, url: string | URL, protocols?: string | string[]): object {
    if (new.target === undefined) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
    return open(String(url), protocols);
  }
  Object.assign(RelayWebSocket, STATES);
  Object.defineProperty(win, "WebSocket", { value: RelayWebSocket, writable: true, configurable: true, enumerable: false });
}
