import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineBridge } from "../../../src/preload/engine";
import { startNerimityEngine } from "../../../src/modules/nerimity/engine";
import type { EngineCommand, EngineRequest } from "../../../src/shared/engine";

function fakeBridge(token?: string) {
  const bridge = {
    request: vi.fn(async (request: EngineRequest) => {
      switch (request.type) {
        case "info":
          return { id: "nerimity-native", name: "Nerimity", url: "https://nerimity.com", os: "linux", settings: { typing: true } };
        case "secretLoad":
          return token;
        case "http":
          return { status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("Nerimity CDN Online.") };
        default:
          return undefined;
      }
    }),
    emit: vi.fn(),
    render: vi.fn(),
    onCommand: (_cb: (c: EngineCommand) => void) => undefined,
    onAction: vi.fn(),
  };
  return bridge as unknown as EngineBridge & typeof bridge;
}

afterEach(() => vi.unstubAllGlobals());

describe("Nerimity engine", () => {
  it("locks its hosts through the bridge and shows the sign-in form", async () => {
    const bridge = fakeBridge();
    const adapter = await startNerimityEngine(bridge, vi.fn());
    expect(bridge.request).toHaveBeenCalledWith({ type: "lockHosts", hosts: ["nerimity.com", "cdn.nerimity.com"] });
    expect(bridge.request).toHaveBeenCalledWith({ type: "http", request: expect.objectContaining({ url: "https://cdn.nerimity.com/", method: "GET" }) });
    expect(bridge.render).toHaveBeenLastCalledWith(expect.objectContaining({ screen: "prompt", platform: "Nerimity" }));
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-out" } });
    // Files are picked and opened through the bridge.
    const files = (adapter as unknown as { deps: { files: { pick(): Promise<unknown[]>; open(file: unknown): { filename: string } } } }).deps.files;
    await files.pick().catch(() => undefined);
    expect(bridge.request).toHaveBeenLastCalledWith({ type: "pickFiles" });
    expect(files.open({ handle: "h", name: "fav.gif", size: 1, type: "image/gif" }).filename).toBe("fav.gif");
  });

  it("resumes a saved session over the page's WebSocket", async () => {
    const urls: string[] = [];
    class StubSocket {
      constructor(url: string) {
        urls.push(url);
      }
      send() {}
      close() {}
      addEventListener() {}
    }
    vi.stubGlobal("WebSocket", StubSocket);
    const bridge = fakeBridge("saved");
    await startNerimityEngine(bridge);
    expect(urls).toEqual(["wss://nerimity.com/socket.io/?EIO=4&transport=websocket"]);
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-in" } });
  });
});
