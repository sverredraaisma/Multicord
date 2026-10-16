import { describe, expect, it, vi } from "vitest";
import { crashesInARow, EngineAdapter, isEngineId, MAX_CRASHES, restartDelay, STABLE_MS } from "../../src/core/engineAdapter";

const capabilities = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

describe("EngineAdapter", () => {
  it("keeps what the engine reports and turns shell calls into commands", async () => {
    const send = vi.fn();
    const adapter = new EngineAdapter("demo", "demo.example", capabilities, send, true);
    const servers = vi.fn();
    const directs = vi.fn();
    const notes = vi.fn();
    const calls = vi.fn();
    const accounts = vi.fn();
    adapter.onServersChanged(servers);
    adapter.onDirectsChanged(directs);
    adapter.onNotification(notes);
    adapter.onIncomingCall(calls);
    adapter.onAccountChanged(accounts);

    adapter.handle({ type: "servers", servers: [{ key: "g", name: "G", unread: false, mentions: 0, kind: "group", children: [{ key: "1", name: "One", unread: true, mentions: 1 }] }] });
    const account = { platform: "demo", instance: "demo.example", accountId: "default" };
    expect(await adapter.listServers()).toEqual([
      { key: "g", name: "G", unread: false, mentions: 0, kind: "group", account, children: [{ key: "1", name: "One", unread: true, mentions: 1, account }] },
    ]);
    adapter.handle({ type: "directs", directs: [{ key: "5", title: "Ana", lastActivity: 1, unread: true, mentions: 1 }] });
    expect(await adapter.listDirectConversations()).toEqual([{ key: "5", title: "Ana", lastActivity: 1, unread: true, mentions: 1, account }]);
    expect(directs).toHaveBeenCalled();
    adapter.handle({ type: "notification", notification: { title: "Ana", body: "hi", target: "5" } });
    adapter.handle({ type: "call", call: { conversationKey: "5", from: "Ana", video: false } });
    expect(notes).toHaveBeenCalledWith({ title: "Ana", body: "hi", target: "5" });
    expect(calls).toHaveBeenCalledWith({ conversationKey: "5", from: "Ana", video: false });
    expect(adapter.accountStatus()).toEqual({ state: "unknown" });
    adapter.handle({ type: "account", account: { state: "signed-in", name: "me" } });
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: "me" });
    expect(accounts).toHaveBeenCalledWith({ state: "signed-in", name: "me" });
    servers.mockClear();
    adapter.handle({ type: "homeBadge", badge: { unread: true, mentions: 2 } });
    expect(adapter.homeBadge()).toEqual({ unread: true, mentions: 2 });
    expect(servers).toHaveBeenCalled(); // so the rail picks the badge up

    await adapter.openHome!();
    await adapter.openServer("1");
    await adapter.openConversation("5");
    await adapter.toggleGroup("g");
    adapter.setVisible(true);
    await adapter.signOut();
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: "openHome" },
      { type: "openServer", key: "1" },
      { type: "openConversation", key: "5" },
      { type: "toggleGroup", key: "g" },
      { type: "visible", visible: true },
      { type: "signOut" },
    ]);
    expect(adapter.mode).toBe("native");
    expect(new EngineAdapter("x", "x", capabilities, send, false).openHome).toBeUndefined();
  });

  it("adds the module's own checks of its service after the engine's, while the engine runs", () => {
    const adapter = new EngineAdapter("demo", "demo.example", capabilities, vi.fn(), false);
    adapter.handle({ type: "health", checks: [{ name: "API", ok: true, extra: 1 } as never, { name: "Gateway", ok: false, detail: "Down" }] });
    expect(adapter.health().map((c) => c.name)).toEqual(["Engine running"]);
    adapter.setEngineHealth({ state: "running", responsive: true, restarts: 0 });
    expect(adapter.health()).toEqual([
      { name: "Engine running", ok: true },
      { name: "Engine responsive", ok: true },
      { name: "API", ok: true },
      { name: "Gateway", ok: false, detail: "Down" },
    ]);
  });

  it("passes Settings values and actions on as commands, and keeps the settings status the engine reports", async () => {
    const send = vi.fn();
    const adapter = new EngineAdapter("demo", "demo.example", capabilities, send, false);
    const changed = vi.fn();
    adapter.onSettingsStatusChanged(changed);
    expect(adapter.settingsStatus()).toEqual({});
    adapter.handle({ type: "settingsStatus", status: { forget: { text: "Remembered: a.org" } } });
    expect(adapter.settingsStatus()).toEqual({ forget: { text: "Remembered: a.org" } });
    expect(changed).toHaveBeenCalledOnce();
    adapter.applySettings({ typing: false });
    await adapter.runSettingAction("forget");
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: "settings", values: { typing: false } },
      { type: "settingAction", key: "forget" },
    ]);
  });
});


describe("engine lifecycle", () => {
  it("backs off between restarts, and counts crashes afresh after a stable run", () => {
    expect([1, 2, 3, 4, 5, 6].map(restartDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    expect(MAX_CRASHES).toBe(5);
    const running = { state: "running" as const, responsive: true, restarts: 0 };
    expect(crashesInARow(3, running, STABLE_MS)).toBe(1);
    expect(crashesInARow(3, running, STABLE_MS - 1)).toBe(4);
    // Still starting: it never ran, however long ago it last became ready.
    expect(crashesInARow(3, { ...running, state: "starting" }, STABLE_MS * 10)).toBe(4);
  });

  it("says how often the engine restarted, with why it last stopped where known", () => {
    const adapter = new EngineAdapter("demo", "demo.example", capabilities, vi.fn(), false);
    adapter.setEngineHealth({ state: "running", responsive: true, restarts: 2 });
    expect(adapter.health()[0]).toEqual({ name: "Engine running", ok: true, detail: "It has restarted 2 times." });
    adapter.setEngineHealth({ state: "running", responsive: true, restarts: 1, lastExit: "oom" });
    expect(adapter.health()[0]!.detail).toBe("It has restarted 1 time (last: oom).");
  });

  it("accepts engine ids the build and the host agree on", () => {
    expect(isEngineId("matrix")).toBe(true);
    expect(isEngineId("a-1")).toBe(true);
    expect(isEngineId("")).toBe(false);
    expect(isEngineId("Matrix")).toBe(false);
    expect(isEngineId("../x")).toBe(false);
    expect(isEngineId("x".repeat(33))).toBe(false);
  });
});
