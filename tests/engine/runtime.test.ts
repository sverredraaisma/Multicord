import { describe, expect, it, vi } from "vitest";
import { bridgeFetch, bridgeSecrets, engineInfo, fileSource, lockHosts, pickFiles, serveAdapter, ssoSignIn, type ServedAdapter } from "../../src/engine/runtime";
import { createEngineBridge, type EngineBridge, type EngineIpc } from "../../src/preload/engine";
import type { AccountRef, DirectConversation, HomeBadge, IncomingCall, PlatformNotification, RailServer } from "../../src/shared/adapter";
import { BaseAdapter } from "../../src/shared/baseAdapter";
import { ENGINE_IPC, type EngineCommand, type EngineSocketEvent, type HttpResponse } from "../../src/shared/engine";
import type { AccountStatus, ServiceSettingStatus } from "../../src/shared/settings";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createEngineBridge", () => {
  it("routes each method over its own channel and delivers payloads", async () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc: EngineIpc = {
      send: vi.fn(),
      on: vi.fn((channel, listener) => void listeners.set(channel, listener)),
      invoke: vi.fn(async () => "answer"),
    };
    const bridge = createEngineBridge(ipc);
    await expect(bridge.request({ type: "info" })).resolves.toBe("answer");
    expect(ipc.invoke).toHaveBeenCalledWith(ENGINE_IPC.invoke, { type: "info" });
    bridge.emit({ type: "homeBadge", badge: { unread: true, mentions: 1 } });
    expect(ipc.send).toHaveBeenCalledWith(ENGINE_IPC.event, { type: "homeBadge", badge: { unread: true, mentions: 1 } });
    bridge.render({ a: 1 });
    expect(ipc.send).toHaveBeenCalledWith(ENGINE_IPC.render, { a: 1 });

    const onCommand = vi.fn();
    const onAction = vi.fn();
    const onSocket = vi.fn();
    bridge.onCommand(onCommand);
    bridge.onAction(onAction);
    bridge.onSocket(onSocket);
    listeners.get(ENGINE_IPC.command)!({}, { type: "signOut" });
    listeners.get(ENGINE_IPC.action)!({}, { do: "it" });
    expect(onCommand).toHaveBeenCalledWith({ type: "signOut" });
    expect(onAction).toHaveBeenCalledWith({ do: "it" });
    listeners.get(ENGINE_IPC.socket)!({}, { type: "open", id: "1" });
    expect(onSocket).toHaveBeenCalledWith({ type: "open", id: "1" });
  });
});

function fakeBridge() {
  let command: (c: EngineCommand) => void = () => {};
  let action: (a: unknown) => void = () => {};
  let socket: (e: EngineSocketEvent) => void = () => {};
  const bridge = {
    request: vi.fn(),
    emit: vi.fn(),
    render: vi.fn(),
    onCommand: (cb) => void (command = cb),
    onAction: (cb) => void (action = cb),
    onSocket: (cb) => void (socket = cb),
  } satisfies EngineBridge;
  return { bridge, command: (c: EngineCommand) => command(c), action: (a: unknown) => action(a), socket: (e: unknown) => socket(e as EngineSocketEvent) };
}

describe("engineInfo and bridgeSecrets", () => {
  it("requests info", async () => {
    const { bridge } = fakeBridge();
    bridge.request.mockResolvedValue({ id: "fluxer" });
    await expect(engineInfo(bridge)).resolves.toEqual({ id: "fluxer" });
    expect(bridge.request).toHaveBeenCalledWith({ type: "info" });
  });

  it("maps secrets to requests", async () => {
    const { bridge } = fakeBridge();
    bridge.request.mockResolvedValueOnce("s").mockResolvedValue("ignored");
    const secrets = bridgeSecrets(bridge);
    await expect(secrets.load("k")).resolves.toBe("s");
    await expect(secrets.save("k", "v")).resolves.toBeUndefined();
    await expect(secrets.delete("k")).resolves.toBeUndefined();
    expect(bridge.request.mock.calls).toEqual([[{ type: "secretLoad", key: "k" }], [{ type: "secretSave", key: "k", value: "v" }], [{ type: "secretDelete", key: "k" }]]);
  });
});

describe("lockHosts", () => {
  it("asks the shell to narrow the engine's hosts", async () => {
    const { bridge } = fakeBridge();
    bridge.request.mockResolvedValue(["a.example"]);
    await expect(lockHosts(bridge, ["a.example"])).resolves.toBeUndefined();
    expect(bridge.request).toHaveBeenCalledWith({ type: "lockHosts", hosts: ["a.example"] });
  });
});

describe("ssoSignIn", () => {
  it("asks the shell for a login token, and refuses an answer without one", async () => {
    const { bridge } = fakeBridge();
    const url = "https://hs.x.org/_matrix/client/v3/login/sso/redirect";
    bridge.request.mockResolvedValueOnce({ loginToken: "syl_t" });
    await expect(ssoSignIn(bridge, url)).resolves.toBe("syl_t");
    expect(bridge.request).toHaveBeenCalledWith({ type: "ssoSignIn", url });
    for (const answer of [{ loginToken: "" }, {}, undefined]) {
      bridge.request.mockResolvedValueOnce(answer);
      await expect(ssoSignIn(bridge, url)).rejects.toThrow("no login token");
    }
  });
});

describe("bridgeFetch", () => {
  const setup = (response: HttpResponse = { status: 200, headers: { "x-a": "1" }, body: new Uint8Array([104, 105]) }) => {
    const { bridge } = fakeBridge();
    bridge.request.mockResolvedValue(response);
    return { bridge, fetch: bridgeFetch(bridge), sent: () => bridge.request.mock.calls[0]![0] };
  };

  it("sends a GET for a string URL and returns a Response", async () => {
    const { fetch, sent } = setup();
    const res = await fetch("https://x.test/a");
    expect(sent()).toEqual({ type: "http", request: { url: "https://x.test/a", method: "GET", headers: {} } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-a")).toBe("1");
    expect(await res.text()).toBe("hi");
  });

  it("accepts a Request, URL, and uppercases the method", async () => {
    const a = setup();
    await a.fetch(new Request("https://x.test/r"));
    expect(a.sent().request.url).toBe("https://x.test/r");
    const b = setup();
    await b.fetch(new URL("https://x.test/u"), { method: "patch" });
    expect(b.sent().request).toMatchObject({ url: "https://x.test/u", method: "PATCH" });
  });

  it("reads headers from objects and Headers", async () => {
    const a = setup();
    await a.fetch("https://x.test/", { headers: { "X-One": "1" } });
    expect(a.sent().request.headers).toEqual({ "x-one": "1" });
    const b = setup();
    await b.fetch("https://x.test/", { headers: new Headers({ "X-Two": "2" }) });
    expect(b.sent().request.headers).toEqual({ "x-two": "2" });
  });

  it("passes string, Uint8Array and ArrayBuffer bodies", async () => {
    const bytes = new Uint8Array([1, 2]);
    const a = setup();
    await a.fetch("https://x.test/", { method: "POST", body: "text" });
    expect(a.sent().request.body).toBe("text");
    const b = setup();
    await b.fetch("https://x.test/", { method: "POST", body: bytes });
    expect(b.sent().request.body).toBe(bytes);
    const c = setup();
    await c.fetch("https://x.test/", { method: "POST", body: bytes.buffer });
    expect(c.sent().request.body).toEqual(bytes);
    expect(c.sent().request.body).toBeInstanceOf(Uint8Array);
  });

  it("rejects unsupported bodies", async () => {
    const { fetch, bridge } = setup();
    await expect(fetch("https://x.test/", { method: "POST", body: new Blob(["x"]) })).rejects.toThrow(TypeError);
    await expect(fetch("https://x.test/", { method: "POST", body: new FormData() })).rejects.toThrow("Unsupported request body");
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it.each([204, 205, 304])("returns a null body for %i", async (status) => {
    const { fetch } = setup({ status, headers: {}, body: new Uint8Array([1]) });
    const res = await fetch("https://x.test/");
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
  });
});

describe("fileSource", () => {
  it("reads a file the shell handed over through its handle", async () => {
    const { bridge } = fakeBridge();
    const file = fileSource(bridge, { handle: "h2", name: "fav.gif", size: 4, type: "image/gif" });
    expect(file).toMatchObject({ filename: "fav.gif", size: 4, contentType: "image/gif" });
    bridge.request.mockResolvedValueOnce(new Uint8Array([1]));
    await expect(file.read(0, 1)).resolves.toEqual(new Uint8Array([1]));
    expect(bridge.request).toHaveBeenLastCalledWith({ type: "readFile", handle: "h2", start: 0, end: 1 });
  });
});

describe("pickFiles", () => {
  it("maps picked files to sources that read through their handle", async () => {
    const { bridge } = fakeBridge();
    bridge.request.mockResolvedValueOnce([{ handle: "h1", name: "a.png", size: 10, type: "image/png" }]);
    const [file] = await pickFiles(bridge);
    expect(file).toMatchObject({ filename: "a.png", size: 10, contentType: "image/png" });
    bridge.request.mockResolvedValueOnce(new Uint8Array([9]));
    await expect(file!.read(2, 5)).resolves.toEqual(new Uint8Array([9]));
    expect(bridge.request).toHaveBeenLastCalledWith({ type: "readFile", handle: "h1", start: 2, end: 5 });
  });
});

const ref: AccountRef = { platform: "fake", instance: "fake", accountId: "a" };
const server = (key: string, over: Partial<RailServer> = {}): RailServer => ({ key, account: ref, name: key, unread: false, mentions: 0, ...over });
const dm = (key: string): DirectConversation => ({ key, account: ref, title: key, lastActivity: 1, unread: false, mentions: 0 });

class FakeAdapter extends BaseAdapter implements ServedAdapter {
  readonly capabilities = { directMessages: true, messagePreviews: false, voice: false, screenShare: false };
  openServer = vi.fn(async (_key: string) => {});
  openConversation = vi.fn(async (_key: string) => {});
  openHome = vi.fn(async () => {});
  toggleGroup = vi.fn(async (_key: string) => {});
  setVisible = vi.fn((_visible: boolean) => {});
  signOut = vi.fn(async () => {});
  handleAction = vi.fn(async (_action: unknown) => {});
  accountStatus = vi.fn((): AccountStatus => ({ state: "signed-in", name: "me" }));
  homeBadge = vi.fn((): HomeBadge => ({ unread: true, mentions: 1 }));
  constructor() {
    super("fake", ref);
  }
  pushServers(s: RailServer[]) {
    this.setServers(s);
  }
  pushDirects(d: DirectConversation[]) {
    this.directsChanged.emit(d);
  }
  pushNotification(n: PlatformNotification) {
    this.notifications.emit(n);
  }
  pushCall(c: IncomingCall) {
    this.incomingCalls.emit(c);
  }
}

describe("serveAdapter events", () => {
  it("emits servers without account fields, including group children", () => {
    const { bridge } = fakeBridge();
    const adapter = new FakeAdapter();
    serveAdapter(bridge, adapter, vi.fn());
    adapter.pushServers([server("a", { iconUrl: "https://x.test/i.png" }), server("g", { kind: "group", children: [server("c")] })]);
    expect(bridge.emit).toHaveBeenCalledWith({
      type: "servers",
      servers: [
        { key: "a", name: "a", unread: false, mentions: 0, iconUrl: "https://x.test/i.png" },
        { key: "g", name: "g", unread: false, mentions: 0, kind: "group", children: [{ key: "c", name: "c", unread: false, mentions: 0 }] },
      ],
    });
  });

  it("emits directs without account, notifications and calls", () => {
    const { bridge } = fakeBridge();
    const adapter = new FakeAdapter();
    serveAdapter(bridge, adapter, vi.fn());
    adapter.pushDirects([dm("d")]);
    expect(bridge.emit).toHaveBeenCalledWith({ type: "directs", directs: [{ key: "d", title: "d", lastActivity: 1, unread: false, mentions: 0 }] });
    const notification = { title: "t", body: "b", target: "x" };
    const call = { conversationKey: "c", from: "f", video: false };
    adapter.pushNotification(notification);
    adapter.pushCall(call);
    expect(bridge.emit).toHaveBeenCalledWith({ type: "notification", notification });
    expect(bridge.emit).toHaveBeenCalledWith({ type: "call", call });
  });
});

describe("serveAdapter sync", () => {
  it("emits account and badge only when they change", () => {
    const { bridge } = fakeBridge();
    const adapter = new FakeAdapter();
    const { sync } = serveAdapter(bridge, adapter, vi.fn());
    sync();
    sync();
    expect(bridge.emit.mock.calls).toEqual([
      [{ type: "account", account: { state: "signed-in", name: "me" } }],
      [{ type: "homeBadge", badge: { unread: true, mentions: 1 } }],
    ]);
    adapter.accountStatus.mockReturnValue({ state: "signed-out" });
    adapter.homeBadge.mockReturnValue({ unread: false, mentions: 0 });
    sync();
    expect(bridge.emit).toHaveBeenCalledTimes(4);
  });

  it("syncs after servers and directs change", () => {
    const { bridge } = fakeBridge();
    const adapter = new FakeAdapter();
    serveAdapter(bridge, adapter, vi.fn());
    adapter.pushServers([]);
    adapter.pushDirects([]);
    expect(bridge.emit.mock.calls.map(([e]) => e.type)).toEqual(["servers", "account", "homeBadge", "directs"]);
  });

  it("defaults to an unknown account and skips a missing badge", () => {
    const { bridge } = fakeBridge();
    const adapter = new FakeAdapter() as ServedAdapter;
    adapter.accountStatus = undefined;
    adapter.homeBadge = undefined;
    serveAdapter(bridge, adapter, vi.fn()).sync();
    expect(bridge.emit.mock.calls).toEqual([[{ type: "account", account: { state: "unknown" } }]]);
  });
});

describe("serveAdapter commands", () => {
  const setup = () => {
    const f = fakeBridge();
    const adapter = new FakeAdapter();
    const log = vi.fn();
    serveAdapter(f.bridge, adapter, log);
    return { ...f, adapter, log };
  };

  it("routes every command to the adapter", async () => {
    const { command, adapter } = setup();
    command({ type: "openHome" });
    command({ type: "openServer", key: "s" });
    command({ type: "openConversation", key: "c" });
    command({ type: "toggleGroup", key: "g" });
    command({ type: "visible", visible: true });
    command({ type: "signOut" });
    await flush();
    expect(adapter.openHome).toHaveBeenCalledOnce();
    expect(adapter.openServer).toHaveBeenCalledWith("s");
    expect(adapter.openConversation).toHaveBeenCalledWith("c");
    expect(adapter.toggleGroup).toHaveBeenCalledWith("g");
    expect(adapter.setVisible).toHaveBeenCalledWith(true);
    expect(adapter.signOut).toHaveBeenCalledOnce();
  });

  it("does not throw when optional adapter methods are absent", async () => {
    const f = fakeBridge();
    const log = vi.fn();
    const adapter: ServedAdapter = new FakeAdapter();
    for (const m of ["openHome", "toggleGroup", "setVisible", "signOut", "handleAction"] as const) adapter[m] = undefined;
    serveAdapter(f.bridge, adapter, log);
    for (const c of [{ type: "openHome" }, { type: "toggleGroup", key: "g" }, { type: "visible", visible: true }, { type: "signOut" }] as const) f.command(c);
    f.action({});
    await flush();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs adapter errors, stringifying non-Errors", async () => {
    const { command, action, adapter, log } = setup();
    adapter.openServer.mockRejectedValue(new Error("boom"));
    adapter.openConversation.mockImplementation(() => {
      throw new Error("sync boom");
    });
    adapter.signOut.mockRejectedValue("plain");
    adapter.handleAction.mockRejectedValue(42);
    command({ type: "openServer", key: "s" });
    command({ type: "openConversation", key: "c" });
    command({ type: "signOut" });
    action({});
    await flush();
    expect(log.mock.calls.map(([m]) => m).sort()).toEqual(["action: 42", "open conversation: sync boom", "open server: boom", "sign out: plain"]);
  });

  it("passes view actions to handleAction", async () => {
    const { action, adapter } = setup();
    action({ do: "x" });
    await flush();
    expect(adapter.handleAction).toHaveBeenCalledWith({ do: "x" });
  });

  it("hands Settings values and actions to the adapter, and reports its settings status when it changes", async () => {
    const f = fakeBridge();
    const adapter = new FakeAdapter() as FakeAdapter & ServedAdapter;
    let status: ServiceSettingStatus = { forget: { text: "Remembered: a.org" } };
    adapter.settingsStatus = () => status;
    adapter.applySettings = vi.fn();
    adapter.runSettingAction = vi.fn(async () => void (status = { forget: { text: "None", disabled: true } }));
    const log = vi.fn();
    const { sync } = serveAdapter(f.bridge, adapter, log);
    sync();
    sync();
    expect(f.bridge.emit.mock.calls.filter(([e]) => e.type === "settingsStatus")).toEqual([[{ type: "settingsStatus", status: { forget: { text: "Remembered: a.org" } } }]]);
    f.command({ type: "settings", values: { typing: false } });
    f.command({ type: "settingAction", key: "forget" });
    await flush();
    expect(adapter.applySettings).toHaveBeenCalledWith({ typing: false });
    expect(adapter.runSettingAction).toHaveBeenCalledWith("forget");
    expect(f.bridge.emit).toHaveBeenLastCalledWith({ type: "settingsStatus", status: { forget: { text: "None", disabled: true } } });
    // A failed action is logged, and what it changed before failing is still reported.
    adapter.runSettingAction = vi.fn(async () => {
      status = {};
      throw new Error("no");
    });
    f.command({ type: "settingAction", key: "forget" });
    await flush();
    expect(log).toHaveBeenCalledWith("setting forget: no");
    expect(f.bridge.emit).toHaveBeenLastCalledWith({ type: "settingsStatus", status: {} });
  });

  it("reports the adapter's checks of its service when they change", () => {
    const f = fakeBridge();
    const adapter = new FakeAdapter() as FakeAdapter & ServedAdapter;
    let checks = [{ name: "API", ok: true }];
    adapter.health = () => checks;
    const { sync } = serveAdapter(f.bridge, adapter);
    sync();
    sync();
    checks = [{ name: "API", ok: false }];
    sync();
    expect(f.bridge.emit.mock.calls.filter(([e]) => e.type === "health")).toEqual([[{ type: "health", checks: [{ name: "API", ok: true }] }], [{ type: "health", checks: [{ name: "API", ok: false }] }]]);
  });

  it("ignores Settings commands an adapter has no use for, and reports no status for it", async () => {
    const f = fakeBridge();
    const log = vi.fn();
    serveAdapter(f.bridge, new FakeAdapter(), log).sync();
    f.command({ type: "settings", values: {} });
    f.command({ type: "settingAction", key: "forget" });
    await flush();
    expect(log).not.toHaveBeenCalled();
    expect(f.bridge.emit.mock.calls.map(([e]) => e.type)).not.toContain("settingsStatus");
    expect(f.bridge.emit.mock.calls.map(([e]) => e.type)).not.toContain("health");
  });

  it("logs to console.warn by default", async () => {
    const f = fakeBridge();
    const adapter = new FakeAdapter();
    adapter.handleAction.mockRejectedValue(new Error("x"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serveAdapter(f.bridge, adapter);
    f.action({});
    await flush();
    expect(warn).toHaveBeenCalledWith("action: x");
    warn.mockRestore();
  });
});
