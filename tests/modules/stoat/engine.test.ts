import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineBridge } from "../../../src/preload/engine";
import { startStoatEngine } from "../../../src/modules/stoat/engine";
import type { EngineCommand, EngineRequest } from "../../../src/shared/engine";

const CONFIG = { ws: "wss://events.stoat.chat", features: { autumn: { enabled: true, url: "https://cdn.stoatusercontent.com" } } };

function fakeBridge(token?: string) {
  const json = (body: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) });
  let command: (c: EngineCommand) => void = () => {};
  const bridge = {
    request: vi.fn(async (request: EngineRequest) => {
      switch (request.type) {
        case "info":
          return { id: "stoat-native", name: "Stoat", url: "https://stoat.chat", os: "linux" };
        case "secretLoad":
          return token;
        case "http":
          return request.request.url === "https://stoat.chat/api/" ? json(CONFIG) : json({});
        case "pickFiles":
          return [{ handle: "h1", name: "a.png", size: 3, type: "image/png" }];
        default:
          return undefined;
      }
    }),
    emit: vi.fn(),
    render: vi.fn(),
    onCommand: (cb: (c: EngineCommand) => void) => void (command = cb),
    onAction: vi.fn(),
  };
  return { bridge: bridge as unknown as EngineBridge & typeof bridge, command: (c: EngineCommand) => command(c) };
}

afterEach(() => vi.unstubAllGlobals());

describe("Stoat engine", () => {
  it("reads the instance through the bridge and shows the sign-in screen", async () => {
    const { bridge } = fakeBridge();
    await startStoatEngine(bridge, vi.fn());
    expect(bridge.request).toHaveBeenCalledWith({ type: "http", request: expect.objectContaining({ url: "https://stoat.chat/api/", method: "GET" }) });
    expect(bridge.render).toHaveBeenLastCalledWith(expect.objectContaining({ screen: "login", platform: "Stoat", identity: "email" }));
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-out" } });
    expect(bridge.emit).toHaveBeenCalledWith({ type: "homeBadge", badge: { unread: false, mentions: 0 } });
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
    const { bridge } = fakeBridge("saved");
    await startStoatEngine(bridge);
    expect(urls).toEqual([expect.stringMatching(/^wss:\/\/events\.stoat\.chat\?version=1&format=json&/)]);
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-in" } });
  });

  it("picks files through the bridge", async () => {
    const { bridge } = fakeBridge();
    const adapter = await startStoatEngine(bridge, vi.fn());
    const pick = (adapter as unknown as { deps: { files: { pick(): Promise<{ filename: string }[]> } } }).deps.files.pick;
    expect((await pick()).map((f) => f.filename)).toEqual(["a.png"]);
  });
});
