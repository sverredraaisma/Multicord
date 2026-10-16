// What GramJS gets in place of the `websocket` package (scripts/build.mjs
// aliases it for the Telegram engine only). GramJS opens its MTProto
// sockets with that package's browser build: `new w3cwebsocket(url,
// "binary")`, which is the page's own WebSocket. Here they are sockets the
// shell opens and relays (bridgeWebSocket), so the engine's page connects
// to nothing but itself. The engine's entry hands over its bridge once, at
// start; the module keeps it to itself.

import { bridgeWebSocket, type BridgedWebSocket } from "../../engine/runtime";
import type { EngineBridge } from "../../preload/engine";

let open: ((url: string, protocols?: string | string[]) => BridgedWebSocket) | undefined;

/** Opens GramJS's sockets through this bridge from now on; once, when the engine starts. */
export function useSocketBridge(bridge: EngineBridge): void {
  if (open) throw new Error("GramJS's sockets have a bridge already");
  open = bridgeWebSocket(bridge);
}

/** As the websocket package's browser build: `new w3cwebsocket(url, protocols)` gives the socket. */
export function w3cwebsocket(url: string, protocols?: string | string[]): BridgedWebSocket {
  if (!open) throw new Error("GramJS's sockets have no bridge: the engine has not started");
  return open(url, protocols);
}
