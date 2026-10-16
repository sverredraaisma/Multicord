import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineBridge } from "../../../src/preload/engine";
import { startSpacebarEngine } from "../../../src/modules/spacebar/engine";
import type { EngineCommand, EngineRequest } from "../../../src/shared/engine";
import { DISCOVERY } from "./fixtures";

function fakeBridge(token?: string) {
  const json = (body: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) });
  const bridge = {
    request: vi.fn(async (request: EngineRequest) => {
      switch (request.type) {
        case "info":
          return { id: "spacebar-native", name: "Spacebar", url: "https://spacebar.chat", os: "linux", settings: { typing: true } };
        case "socketOpen":
          return { id: "1" };
        case "secretLoad":
          return token;
        case "http":
          return request.request.url.endsWith("/.well-known/spacebar/client") ? json(DISCOVERY) : json({});
        default:
          return undefined;
      }
    }),
    emit: vi.fn(),
    render: vi.fn(),
    onCommand: (_cb: (c: EngineCommand) => void) => undefined,
    onAction: vi.fn(),
    onSocket: vi.fn(),
  };
  return bridge as unknown as EngineBridge & typeof bridge;
}

afterEach(() => vi.unstubAllGlobals());

describe("Spacebar engine", () => {
  it("discovers the instance through the bridge, locks its hosts and shows the login screen", async () => {
    const bridge = fakeBridge();
    const adapter = await startSpacebarEngine(bridge, vi.fn());
    expect(bridge.request).toHaveBeenCalledWith({ type: "http", request: expect.objectContaining({ url: "https://spacebar.chat/.well-known/spacebar/client", method: "GET" }) });
    expect(bridge.request).toHaveBeenCalledWith({ type: "lockHosts", hosts: ["api.sb", "gw.sb", "cdn.sb"] });
    expect(bridge.render).toHaveBeenLastCalledWith(expect.objectContaining({ screen: "login", platform: "Spacebar" }));
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-out" } });
    // Files are picked and opened through the bridge.
    const files = (adapter as unknown as { deps: { files: { pick(): Promise<unknown[]>; open(file: unknown): { filename: string } } } }).deps.files;
    await files.pick().catch(() => undefined);
    expect(bridge.request).toHaveBeenLastCalledWith({ type: "pickFiles" });
    expect(files.open({ handle: "h", name: "fav.gif", size: 1, type: "image/gif" }).filename).toBe("fav.gif");
  });

  it("resumes a saved session over a WebSocket the shell opens", async () => {
    const bridge = fakeBridge("saved");
    await startSpacebarEngine(bridge);
    expect(bridge.request).toHaveBeenCalledWith({ type: "socketOpen", url: "wss://gw.sb/?encoding=json&v=9" });
    expect(bridge.onSocket).toHaveBeenCalled();
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-in" } });
  });
});
