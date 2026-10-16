import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PING_INTERVAL_MS, StoatEvents, type EventSocket } from "../../../src/modules/stoat/events";

class FakeSocket implements EventSocket {
  sent: Record<string, unknown>[] = [];
  closed: number | undefined;
  private listeners: Record<string, ((event: never) => void)[]> = {};

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.closed = code;
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  open(): void {
    for (const l of this.listeners.open ?? []) l(undefined as never);
  }

  receive(payload: unknown): void {
    for (const l of this.listeners.message ?? []) l({ data: typeof payload === "string" ? payload : JSON.stringify(payload) } as never);
  }

  serverClose(code = 1006): void {
    for (const l of this.listeners.close ?? []) l({ code } as never);
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const handlers = { dispatch: vi.fn(), status: vi.fn(), authFailed: vi.fn() };
  const events = new StoatEvents(
    "wss://events.example",
    "tok",
    (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    handlers,
  );
  events.connect();
  const current = () => sockets.at(-1)!;
  const ready = () => {
    current().open();
    current().receive({ type: "Authenticated" });
    current().receive({ type: "Ready", users: [] });
  };
  return { events, sockets, handlers, current, ready };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("StoatEvents", () => {
  it("connects with protocol 1 JSON, asking Ready for what the client uses", () => {
    const { sockets, handlers } = setup();
    expect(sockets[0]!.url).toBe(
      "wss://events.example?version=1&format=json&ready=users&ready=servers&ready=channels&ready=emojis&ready=channel_unreads&ready=voice_states",
    );
    expect(handlers.status).toHaveBeenCalledWith("connecting");
  });

  it("authenticates once open, in a message rather than the URL", () => {
    const { current, handlers, ready } = setup();
    expect(current().sent).toEqual([]);
    ready();
    expect(current().sent[0]).toEqual({ type: "Authenticate", token: "tok" });
    expect(current().url).not.toContain("tok");
    expect(handlers.status).toHaveBeenLastCalledWith("ready");
    expect(handlers.dispatch).toHaveBeenCalledWith("Ready", { type: "Ready", users: [] });
    expect(handlers.dispatch).not.toHaveBeenCalledWith("Authenticated", expect.anything());
  });

  it("unpacks Bulk events, one level deep, and skips junk", () => {
    const { current, handlers, ready } = setup();
    ready();
    handlers.dispatch.mockClear();
    current().receive({ type: "Bulk", v: [{ type: "Message", _id: "a" }, { type: "Bulk", v: [{ type: "Message", _id: "b" }] }, "junk"] });
    current().receive("not json");
    current().receive({ no: "type" });
    current().receive({ type: "Bulk", v: "x" });
    expect(handlers.dispatch.mock.calls).toEqual([["Message", { type: "Message", _id: "a" }]]);
  });

  it("pings to keep the connection alive and reconnects a silent one", async () => {
    const { current, sockets, handlers, ready } = setup();
    ready();
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(current().sent.at(-1)).toEqual({ type: "Ping", data: expect.any(Number) });
    current().receive({ type: "Pong", data: 1 });
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(current().sent.filter((m) => m.type === "Ping")).toHaveLength(2);
    // No Pong this time: the next tick drops the socket and reconnects.
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(sockets[0]!.closed).toBe(4000);
    expect(handlers.status).toHaveBeenLastCalledWith("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    expect(handlers.status).toHaveBeenLastCalledWith("reconnecting");
    ready();
    expect(handlers.status).toHaveBeenLastCalledWith("ready");
  });

  it("backs off between failed reconnects and resets after Ready", () => {
    const { current, sockets, ready } = setup();
    current().serverClose();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    current().serverClose();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    ready();
    current().serverClose();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(4);
    for (let i = 0; i < 10; i++) {
      current().serverClose();
      vi.advanceTimersByTime(30_000);
    }
    expect(sockets).toHaveLength(14);
  });

  it("ignores a replaced socket's events", () => {
    const { sockets, handlers, current } = setup();
    current().serverClose();
    vi.advanceTimersByTime(1000);
    handlers.status.mockClear();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "Ready" });
    sockets[0]!.serverClose();
    expect(sockets[0]!.sent).toEqual([]);
    expect(handlers.status).not.toHaveBeenCalled();
    expect(handlers.dispatch).not.toHaveBeenCalled();
  });

  it("sends commands only once authenticated", () => {
    const { events, current, ready } = setup();
    events.command({ type: "BeginTyping", channel: "c" });
    current().open();
    expect(current().sent).toEqual([{ type: "Authenticate", token: "tok" }]);
    ready();
    events.command({ type: "EndTyping", channel: "c" });
    expect(current().sent.at(-1)).toEqual({ type: "EndTyping", channel: "c" });
  });

  it("gives up on a rejected token or a remote logout", () => {
    for (const event of [{ type: "Error", data: { type: "InvalidSession" } }, { type: "Error", data: "NotAuthenticated" }, { type: "Logout" }]) {
      const { current, sockets, handlers } = setup();
      current().open();
      current().receive(event);
      expect(handlers.authFailed).toHaveBeenCalledOnce();
      expect(handlers.status).toHaveBeenLastCalledWith("closed");
      expect(sockets[0]!.closed).toBe(1000);
      sockets[0]!.serverClose();
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
    }
  });

  it("passes other errors over", () => {
    const { current, handlers } = setup();
    current().open();
    current().receive({ type: "Error", data: { type: "InternalError" } });
    current().receive({ type: "Error" });
    expect(handlers.authFailed).not.toHaveBeenCalled();
    expect(handlers.dispatch).not.toHaveBeenCalled();
  });

  it("disconnects for good", () => {
    const { events, current, sockets, handlers, ready } = setup();
    ready();
    events.disconnect();
    expect(current().closed).toBe(1000);
    expect(handlers.status).toHaveBeenLastCalledWith("closed");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    events.command({ type: "BeginTyping", channel: "c" });
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: "Authenticate", token: "tok" });
  });
});
