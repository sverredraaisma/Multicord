// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordNotificationRelay } from "../../src/preload/discord/notificationRelay";
import { discordScreenAudio } from "../../src/preload/discord/screenAudio";
import { discordActivityBridge } from "../../src/preload/discord/activityBridge";
import { startDiscordPreload, type PreloadIpc } from "../../src/preload/discord/index";
import { ACTIVITY_EVENT, IPC, NOTIFY_CLICK_EVENT, NOTIFY_EVENT } from "../../src/shared/ipc";

type W = Record<string, unknown> & { Notification: any };
const w = window as unknown as W;
let original: unknown;
const cleanups: (() => void)[] = [];

class FakeNotification {
  static permission = "granted";
  static requestPermission = vi.fn(async () => "granted");
}

beforeEach(() => {
  vi.useFakeTimers();
  original = w.Notification;
  w.Notification = FakeNotification;
});

afterEach(() => {
  vi.useRealTimers();
  w.Notification = original;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function relayed(): { id: string; title: string; body: string }[] {
  const received: { id: string; title: string; body: string }[] = [];
  const listener = (e: Event) => received.push(JSON.parse((e as CustomEvent<string>).detail));
  document.addEventListener(NOTIFY_EVENT, listener);
  cleanups.push(() => document.removeEventListener(NOTIFY_EVENT, listener));
  return received;
}

describe("Discord notification relay", () => {
  it("hands Discord's notifications to the shell instead of showing them", () => {
    const received = relayed();
    discordNotificationRelay(NOTIFY_EVENT, NOTIFY_CLICK_EVENT, 10);
    expect(w.Notification.permission).toBe("granted");
    w.Notification.requestPermission();
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    const note = new w.Notification("Ana", { body: "hi", tag: "t", icon: "i", data: { x: 1 } });
    expect(received).toEqual([{ id: "1", title: "Ana", body: "hi" }]);
    expect(note).toMatchObject({ title: "Ana", body: "hi", tag: "t", icon: "i", data: { x: 1 } });
    const shown = vi.fn();
    note.onshow = shown;
    vi.advanceTimersByTime(0);
    expect(shown).toHaveBeenCalled();
    new w.Notification(undefined, undefined);
    expect(received[1]).toEqual({ id: "2", title: "", body: "" });
  });

  it("runs Discord's click handlers when the shell's notification is clicked", () => {
    discordNotificationRelay(NOTIFY_EVENT, NOTIFY_CLICK_EVENT, 1);
    const first = new w.Notification("A");
    const second = new w.Notification("B");
    const onclick = vi.fn();
    const listener = vi.fn();
    second.onclick = onclick;
    second.addEventListener("click", listener);
    const removed = vi.fn();
    second.addEventListener("click", removed);
    second.removeEventListener("click", removed);
    second.removeEventListener("show", removed); // never added
    first.onclick = vi.fn();
    document.dispatchEvent(new CustomEvent(NOTIFY_CLICK_EVENT, { detail: "2" }));
    expect(onclick).toHaveBeenCalled();
    expect(listener).toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    document.dispatchEvent(new CustomEvent(NOTIFY_CLICK_EVENT, { detail: "1" })); // forgotten: only one is kept
    expect(first.onclick).not.toHaveBeenCalled();
    document.dispatchEvent(new CustomEvent(NOTIFY_CLICK_EVENT, { detail: 2 }));
    expect(onclick).toHaveBeenCalledOnce();
    const closed = vi.fn();
    second.onclose = closed;
    second.close();
    expect(closed).toHaveBeenCalled();
  });

  it("installs once, and not where there are no notifications", () => {
    discordNotificationRelay(NOTIFY_EVENT, NOTIFY_CLICK_EVENT, 10);
    const relay = w.Notification;
    discordNotificationRelay(NOTIFY_EVENT, NOTIFY_CLICK_EVENT, 10);
    expect(w.Notification).toBe(relay);
    w.Notification = undefined;
    discordNotificationRelay(NOTIFY_EVENT, NOTIFY_CLICK_EVENT, 10);
    expect(w.Notification).toBeUndefined();
  });

  it("is self-contained, so it survives serialization into the main world", () => {
    const received = relayed();
    const serialized = new Function(`return (${discordNotificationRelay.toString()})`)() as typeof discordNotificationRelay;
    serialized(NOTIFY_EVENT, NOTIFY_CLICK_EVENT, 10);
    new w.Notification("Ana", { body: "hi" });
    expect(received).toHaveLength(1);
  });
});

describe("relay through the preload", () => {
  function fakeIpc() {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc: PreloadIpc & { emit(channel: string, payload: unknown): void } = {
      send: vi.fn(),
      on: (channel, listener) => listeners.set(channel, listener),
      emit: (channel, payload) => listeners.get(channel)?.(null, payload),
    };
    return ipc;
  }

  it("passes valid notifications to main and clicks back to the page", () => {
    const ipc = fakeIpc();
    const run = vi.fn();
    startDiscordPreload(ipc, document, window, run);
    expect(run).toHaveBeenCalledWith(discordNotificationRelay, [NOTIFY_EVENT, NOTIFY_CLICK_EVENT, 200]);
    expect(run).toHaveBeenCalledWith(discordScreenAudio, []);
    const fire = (detail: unknown) => document.dispatchEvent(new CustomEvent(NOTIFY_EVENT, { detail }));
    fire("{broken");
    fire(JSON.stringify({ id: "x", title: "A", body: "" }));
    fire(42);
    expect(ipc.send).not.toHaveBeenCalledWith(IPC.discordNotification, expect.anything());
    fire(JSON.stringify({ id: "3", title: "Ana", body: "hi" }));
    expect(ipc.send).toHaveBeenCalledWith(IPC.discordNotification, { id: "3", title: "Ana", body: "hi" });

    const clicks: unknown[] = [];
    document.addEventListener(NOTIFY_CLICK_EVENT, (e) => clicks.push((e as CustomEvent).detail));
    ipc.emit(IPC.discordNotificationClick, "3");
    ipc.emit(IPC.discordNotificationClick, "<script>");
    ipc.emit(IPC.discordNotificationClick, 3);
    expect(clicks).toEqual(["3"]);
  });

  it("passes checked Rich Presence updates to the page", () => {
    const ipc = fakeIpc();
    const run = vi.fn();
    startDiscordPreload(ipc, document, window, run);
    expect(run).toHaveBeenCalledWith(discordActivityBridge, [ACTIVITY_EVENT]);
    const seen: unknown[] = [];
    document.addEventListener(ACTIVITY_EVENT, (e) => seen.push(JSON.parse((e as CustomEvent).detail)));
    const update = { source: "rpc-2", pid: 7, activity: { application_id: "42", type: 0, flags: 0, name: "Game" } };
    ipc.emit(IPC.discordActivity, update);
    ipc.emit(IPC.discordActivity, { source: "evil", activity: null });
    expect(seen).toEqual([update]);
  });
});

describe("discordActivityBridge", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__multicordActivity;
    delete (window as unknown as Record<string, unknown>).webpackChunkdiscord_app;
  });

  const fire = (detail: unknown) => document.dispatchEvent(new CustomEvent("test:activity", { detail }));

  it("dispatches activities through Discord's own dispatcher", () => {
    const dispatch = vi.fn();
    const dispatcher = { dispatch, subscribe: () => {}, _actionHandlers: {} };
    const chunks: unknown[] & { push(...items: unknown[]): number } = [] as never;
    chunks.push = (chunk: any) => {
      chunk[2]({ c: { a: { exports: null }, b: { exports: { other: { dispatch() {} } } }, c: { exports: { Z: dispatcher } } } });
      return Array.prototype.push.call(chunks, chunk);
    };
    (window as any).webpackChunkdiscord_app = chunks;
    const serialized = new Function(`return (${discordActivityBridge.toString()})`)() as typeof discordActivityBridge;
    serialized("test:activity");
    serialized("test:activity"); // only once
    fire("{broken");
    fire(JSON.stringify({ source: "rpc-1", pid: 3, activity: { name: "Game" } }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "LOCAL_ACTIVITY_UPDATE", socketId: "rpc-1", pid: 3, activity: { name: "Game" } });
    dispatch.mockImplementation(() => {
      throw new Error("rejected");
    });
    expect(() => fire(JSON.stringify({ source: "rpc-1", activity: null }))).not.toThrow();
  });

  it("does nothing until Discord's modules are there", () => {
    discordActivityBridge("test:activity");
    fire(JSON.stringify({ source: "rpc-1", activity: null }));
    (window as any).webpackChunkdiscord_app = { push: (chunk: any) => chunk[2]({}) };
    fire(JSON.stringify({ source: "rpc-1", activity: null }));
  });
});
