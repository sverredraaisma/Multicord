import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgedWebSocket } from "../../../src/engine/runtime";
import type { EngineBridge } from "../../../src/preload/engine";
import type { EngineRequest, EngineSocketEvent } from "../../../src/shared/engine";

type Shim = typeof import("../../../src/modules/telegram/websocket");
let shim: Shim;

beforeEach(async () => {
  // Each test starts as a fresh engine page does: no bridge yet.
  vi.resetModules();
  shim = await import("../../../src/modules/telegram/websocket");
});

function fakeBridge() {
  let socket: (event: EngineSocketEvent) => void = () => {};
  const bridge = {
    request: vi.fn(async (request: EngineRequest) => (request.type === "socketOpen" ? { id: "1" } : undefined)),
    onSocket: (cb: (event: EngineSocketEvent) => void) => void (socket = cb),
  };
  return { bridge: bridge as unknown as EngineBridge & typeof bridge, shell: (event: EngineSocketEvent) => socket(event) };
}

/** GramJS's own call: `new w3cwebsocket(url, "binary")`. */
const construct = (url: string, protocols: string) => new (shim.w3cwebsocket as unknown as new (url: string, protocols: string) => BridgedWebSocket)(url, protocols);

describe("GramJS's websocket shim", () => {
  it("opens GramJS's sockets through the bridge, with its subprotocol", async () => {
    const { bridge, shell } = fakeBridge();
    shim.useSocketBridge(bridge);
    const socket = construct("wss://venus.web.telegram.org:443/apiws", "binary");
    // A bridged socket (of the freshly loaded runtime, so not this file's class).
    expect(socket.constructor.name).toBe("BridgedWebSocket");
    expect(socket.readyState).toBe(BridgedWebSocket.CONNECTING);
    expect(bridge.request).toHaveBeenCalledWith({ type: "socketOpen", url: "wss://venus.web.telegram.org:443/apiws", protocols: ["binary"] });
    const opened = new Promise((resolve) => (socket.onopen = resolve));
    await Promise.resolve();
    shell({ type: "open", id: "1", protocol: "binary" });
    await opened;
    expect(socket.protocol).toBe("binary");
  });

  it("takes its bridge once, and opens nothing before it has one", () => {
    expect(() => construct("wss://venus.web.telegram.org:443/apiws", "binary")).toThrow("no bridge");
    shim.useSocketBridge(fakeBridge().bridge);
    expect(() => shim.useSocketBridge(fakeBridge().bridge)).toThrow("a bridge already");
  });
});
