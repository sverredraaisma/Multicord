import { describe, expect, it, vi } from "vitest";
import type { EngineBridge } from "../../../src/preload/engine";
import { startMatrixEngine } from "../../../src/modules/matrix/engine";
import type { MatrixApi } from "../../../src/modules/matrix/api";
import type { EngineCommand, EngineRequest, HttpResponse } from "../../../src/shared/engine";

const SESSION = JSON.stringify({ baseUrl: "https://hs.x.org", accessToken: "tok", userId: "@me:x.org", deviceId: "D", ownDevice: true });

function fakeBridge(secrets: Record<string, string> = {}, http: (url: string) => HttpResponse = () => ({ status: 404, headers: {}, body: new Uint8Array() })) {
  let command: (c: EngineCommand) => void = () => {};
  const bridge = {
    request: vi.fn(async (request: EngineRequest) => {
      switch (request.type) {
        case "info":
          return { id: "matrix-native", name: "Matrix", url: "https://x.org", os: "linux" };
        case "secretLoad":
          return secrets[request.key];
        case "http":
          return http(request.request.url);
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

const body = (value: unknown): HttpResponse => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(value)) });

describe("Matrix engine", () => {
  it("talks to the homeserver over the bridge and asks to sign in", async () => {
    const { bridge } = fakeBridge({}, (url) => (url.endsWith("/_matrix/client/v3/login") ? body({ flows: [{ type: "m.login.password" }] }) : { status: 404, headers: {}, body: new Uint8Array() }));
    await startMatrixEngine(bridge);
    const urls = bridge.request.mock.calls.flatMap(([r]) => (r.type === "http" ? [r.request.url] : []));
    expect(urls).toEqual(["https://x.org/.well-known/matrix/client", "https://x.org/_matrix/client/v3/login"]);
    expect(bridge.render).toHaveBeenLastCalledWith(expect.objectContaining({ screen: "prompt", platform: "Matrix", prompt: expect.objectContaining({ id: "login" }) }));
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-out" } });
  });

  it("resumes a stored session with the given API and reports the account", async () => {
    const { bridge } = fakeBridge({ session: SESSION });
    const api = {
      whoami: vi.fn(async () => ({ userId: "@me:x.org" })),
      sync: vi.fn(() => new Promise(() => {})),
    } as unknown as MatrixApi;
    const createApi = vi.fn(() => api);
    await startMatrixEngine(bridge, { createApi });
    expect(createApi).toHaveBeenCalledWith(expect.any(Function));
    expect(api.whoami).toHaveBeenCalledWith("https://hs.x.org", "tok");
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-in", name: "@me:x.org" } });
    expect(bridge.render).toHaveBeenLastCalledWith({ screen: "connecting", platform: "Matrix", status: "Loading your chats…" });
  });
});
