import { describe, expect, it, vi } from "vitest";
import type { EngineBridge } from "../../../src/preload/engine";
import { startMatrixEngine } from "../../../src/modules/matrix/engine";
import type { MatrixApi } from "../../../src/modules/matrix/api";
import type { MatrixClientOptions } from "../../../src/modules/matrix/client";
import type { MatrixOAuth } from "../../../src/modules/matrix/oauth";
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
    expect(urls).toEqual([
      "https://x.org/.well-known/matrix/client",
      "https://x.org/_matrix/client/v3/login",
      // No OAuth 2.0 account server here: only the password prompt.
      "https://x.org/_matrix/client/v1/auth_metadata",
      "https://x.org/_matrix/client/unstable/org.matrix.msc2965/auth_metadata",
      "https://x.org/_matrix/client/unstable/org.matrix.msc2965/auth_issuer",
      // The call services the server names, so the host lock can include them.
      "https://x.org/.well-known/matrix/client",
    ]);
    expect(bridge.render).toHaveBeenLastCalledWith(expect.objectContaining({ screen: "prompt", platform: "Matrix", prompt: expect.objectContaining({ id: "login" }) }));
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-out" } });
    // Once the homeserver is known, the engine keeps to it.
    expect(bridge.request).toHaveBeenCalledWith({ type: "lockHosts", hosts: ["x.org"] });
  });

  it("resumes a stored session with the given API and reports the account", async () => {
    const { bridge } = fakeBridge({ session: SESSION });
    const api = {
      check: vi.fn(async () => {}),
      sync: vi.fn(() => new Promise(() => {})),
      rtcFoci: vi.fn(async () => []),
      rtcTransports: vi.fn(async () => []),
    } as unknown as MatrixApi;
    const createApi = vi.fn(() => api);
    await startMatrixEngine(bridge, { createApi });
    expect(createApi).toHaveBeenCalledWith(expect.any(Function), { refresh: expect.any(Function) });
    expect(api.check).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "tok" }));
    expect(bridge.request).toHaveBeenCalledWith({ type: "lockHosts", hosts: ["x.org", "hs.x.org"] });
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-in", name: "@me:x.org" } });
    expect(bridge.render).toHaveBeenLastCalledWith({ screen: "connecting", platform: "Matrix", status: "Loading your chats…" });
  });
});

describe("Matrix engine wiring", () => {
  it("passes encryption on, and lets the client refresh OAuth tokens through the adapter", async () => {
    const { bridge } = fakeBridge({ session: SESSION });
    const api = { check: vi.fn(async () => {}), sync: vi.fn(() => new Promise(() => {})), rtcFoci: vi.fn(async () => []), rtcTransports: vi.fn(async () => []) } as unknown as MatrixApi;
    let options: MatrixClientOptions | undefined;
    const createApi = vi.fn((_fetch: typeof fetch, o: MatrixClientOptions) => ((options = o), api));
    const oauth = { discover: vi.fn() } as unknown as MatrixOAuth;
    const createOAuth = vi.fn(() => oauth);
    const crypto = { open: vi.fn(() => new Promise<never>(() => {})), deleteStore: vi.fn() };
    const adapter = await startMatrixEngine(bridge, { createApi, createOAuth, crypto });
    expect(createOAuth).toHaveBeenCalledWith(expect.any(Function));
    await vi.waitFor(() => expect(crypto.open).toHaveBeenCalled());
    const refresh = vi.spyOn(adapter, "refreshSession").mockResolvedValue();
    const session = { baseUrl: "https://hs.x.org", accessToken: "t", userId: "@me:x.org", deviceId: "D", ownDevice: true };
    await options!.refresh!(session);
    expect(refresh).toHaveBeenCalledWith(session);
  });
});

describe("Matrix files", () => {
  it("picks files through the bridge", async () => {
    const { bridge } = fakeBridge({ session: SESSION });
    const original = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation((async (request: EngineRequest) => (request.type === "pickFiles" ? [{ handle: "h1", name: "a.png", size: 3, type: "image/png" }] : original(request))) as typeof original);
    const api = { check: vi.fn(async () => {}), sync: vi.fn(() => new Promise(() => {})), rtcFoci: vi.fn(async () => []), rtcTransports: vi.fn(async () => []) } as unknown as MatrixApi;
    const adapter = await startMatrixEngine(bridge, { createApi: () => api });
    const pick = (adapter as unknown as { deps: { files: { pick(): Promise<{ filename: string; contentType: string }[]> } } }).deps.files.pick;
    expect(await pick()).toMatchObject([{ filename: "a.png", contentType: "image/png" }]);
  });
});

describe("Matrix host lock", () => {
  it("names hosts once, and carries on when the shell refuses a lock", async () => {
    const { hostsOf } = await import("../../../src/modules/matrix/adapter");
    expect(hostsOf("https://X.org/a", undefined, "https://x.org/b", "https://account.x.org/token")).toEqual(["x.org", "account.x.org"]);
    const { bridge } = fakeBridge({ session: SESSION });
    const original = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (request: EngineRequest) => {
      if (request.type === "lockHosts") throw new Error("A host lock can only narrow what the engine may reach");
      return original(request);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = { check: vi.fn(async () => {}), sync: vi.fn(() => new Promise(() => {})), rtcFoci: vi.fn(async () => []), rtcTransports: vi.fn(async () => []) } as unknown as MatrixApi;
    await startMatrixEngine(bridge, { createApi: () => api });
    expect(api.check).toHaveBeenCalled();
    warn.mockRestore();
  });
});
