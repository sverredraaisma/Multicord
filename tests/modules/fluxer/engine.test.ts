import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineBridge } from "../../../src/preload/engine";
import { startFluxerEngine } from "../../../src/modules/fluxer/engine";
import type { EngineCommand, EngineRequest } from "../../../src/shared/engine";

const DISCOVERY = {
  endpoints: { api_public: "https://api.fx", gateway: "wss://gw.fx", media: "https://media.fx" },
  features: { account_identity: "email" },
};

function fakeBridge(token?: string) {
  const json = (body: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) });
  let command: (c: EngineCommand) => void = () => {};
  const bridge = {
    request: vi.fn(async (request: EngineRequest) => {
      switch (request.type) {
        case "info":
          return { id: "fluxer", name: "Fluxer", url: "https://fluxer.app", os: "linux" };
        case "secretLoad":
          return token;
        case "http":
          return request.request.url.endsWith("/.well-known/fluxer") ? json(DISCOVERY) : json({});
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

describe("Fluxer engine", () => {
  it("discovers the instance through the bridge and shows the login screen", async () => {
    const { bridge } = fakeBridge();
    await startFluxerEngine(bridge, vi.fn());
    expect(bridge.request).toHaveBeenCalledWith({ type: "http", request: expect.objectContaining({ url: "https://fluxer.app/.well-known/fluxer", method: "GET" }) });
    expect(bridge.render).toHaveBeenLastCalledWith(expect.objectContaining({ screen: "login", platform: "Fluxer" }));
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-out" } });
    expect(bridge.emit).toHaveBeenCalledWith({ type: "homeBadge", badge: { unread: false, mentions: 0 } });
  });

  it("resumes a saved session over the page's WebSocket, telling Fluxer the OS", async () => {
    const sent: string[] = [];
    const urls: string[] = [];
    class StubSocket {
      constructor(url: string) {
        urls.push(url);
      }
      send(data: string) {
        sent.push(data);
      }
      close() {}
      addEventListener() {}
    }
    vi.stubGlobal("WebSocket", StubSocket);
    const { bridge } = fakeBridge("flx_saved");
    await startFluxerEngine(bridge);
    expect(urls).toEqual(["wss://gw.fx/?v=1&encoding=json"]);
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-in" } });
  });
});
