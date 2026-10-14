import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluxerGateway, type GatewaySocket } from "../../../src/main/fluxer/gateway";

class FakeSocket implements GatewaySocket {
  sent: { op: number; d: unknown }[] = [];
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

  receive(payload: unknown): void {
    for (const l of this.listeners.message ?? []) l({ data: typeof payload === "string" ? payload : JSON.stringify(payload) } as never);
  }

  serverClose(code: number): void {
    for (const l of this.listeners.close ?? []) l({ code } as never);
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const handlers = { dispatch: vi.fn(), status: vi.fn(), authFailed: vi.fn() };
  const gateway = new FluxerGateway(
    "wss://gateway.example",
    "flx_token",
    (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    handlers,
    "linux",
  );
  gateway.connect();
  const current = () => sockets.at(-1)!;
  const hello = (interval = 1000) => current().receive({ op: 10, d: { heartbeat_interval: interval } });
  const ready = (seq = 1) => current().receive({ op: 0, s: seq, t: "READY", d: { session_id: "sess" } });
  return { gateway, sockets, handlers, current, hello, ready };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FluxerGateway", () => {
  it("connects with version 1 JSON and identifies honestly", () => {
    const { sockets, handlers, hello } = setup();
    expect(sockets[0]!.url).toBe("wss://gateway.example/?v=1&encoding=json");
    expect(handlers.status).toHaveBeenCalledWith("connecting");
    hello();
    expect(sockets[0]!.sent[0]).toEqual({
      op: 2,
      d: { token: "flx_token", properties: { os: "linux", browser: "Multicord", device: "Multicord" } },
    });
  });

  it("heartbeats with the last sequence and passes dispatches on", () => {
    const { current, handlers, hello, ready } = setup();
    hello(1000);
    ready(1);
    expect(handlers.status).toHaveBeenLastCalledWith("ready");
    expect(handlers.dispatch).toHaveBeenCalledWith("READY", { session_id: "sess" });
    current().receive({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "1" } });

    vi.advanceTimersByTime(500); // first beat after interval * jitter
    expect(current().sent.at(-1)).toEqual({ op: 1, d: 2 });
    current().receive({ op: 11 });
    vi.advanceTimersByTime(1000);
    expect(current().sent.at(-1)).toEqual({ op: 1, d: 2 });

    current().receive({ op: 1 }); // server-requested beat
    expect(current().sent.at(-1)).toEqual({ op: 1, d: 2 });
  });

  it("ignores junk frames and events without a name", () => {
    const { current, handlers, hello } = setup();
    current().receive("not json");
    current().receive({ no: "op" });
    current().receive({ op: 0, s: 5 });
    current().receive({ op: 99 });
    hello();
    current().receive({ op: 10, d: null }); // default interval
    expect(handlers.dispatch).not.toHaveBeenCalled();
  });

  it("reconnects zombies and resumes the session", () => {
    const { sockets, current, hello, ready } = setup();
    hello(1000);
    ready(3);
    vi.advanceTimersByTime(500); // beat, no ACK
    vi.advanceTimersByTime(1000); // still no ACK: zombie
    expect(sockets[0]!.closed).toBe(4000);
    vi.advanceTimersByTime(1000); // backoff
    expect(sockets).toHaveLength(2);
    hello();
    expect(current().sent[0]).toEqual({ op: 6, d: { token: "flx_token", session_id: "sess", seq: 3 } });
    current().receive({ op: 0, s: 4, t: "RESUMED", d: {} });
  });

  it("follows Reconnect requests and re-identifies after Invalid Session", () => {
    const { sockets, current, hello, ready, handlers } = setup();
    hello();
    ready();
    current().receive({ op: 7 });
    vi.advanceTimersByTime(1000);
    hello();
    expect(current().sent[0]!.op).toBe(6);
    current().receive({ op: 9, d: false });
    expect(current().sent.at(-1)!.op).toBe(2);
    expect(sockets).toHaveLength(2);
    expect(handlers.status).toHaveBeenCalledWith("reconnecting");
  });

  it("backs off on drops and ignores events from old sockets", () => {
    const { sockets, handlers, hello } = setup();
    hello();
    const old = sockets[0]!;
    old.serverClose(1006);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.serverClose(1006);
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    old.receive({ op: 0, s: 1, t: "READY", d: {} });
    old.serverClose(1006);
    expect(handlers.dispatch).not.toHaveBeenCalled();
  });

  it("stops and reports when authentication fails", () => {
    const { sockets, handlers, hello } = setup();
    hello();
    sockets[0]!.serverClose(4004);
    expect(handlers.authFailed).toHaveBeenCalled();
    expect(handlers.status).toHaveBeenLastCalledWith("closed");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("does not retry on fatal close codes", () => {
    const { sockets, handlers } = setup();
    sockets[0]!.serverClose(4012);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(handlers.authFailed).not.toHaveBeenCalled();
  });

  it("disconnects cleanly and stays down", () => {
    const { gateway, sockets, handlers, hello } = setup();
    hello();
    gateway.disconnect();
    expect(sockets[0]!.closed).toBe(1000);
    expect(handlers.status).toHaveBeenLastCalledWith("closed");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("caps the backoff", () => {
    const { sockets } = setup();
    for (let i = 0; i < 8; i++) {
      sockets.at(-1)!.serverClose(1006);
      vi.advanceTimersByTime(30_000);
    }
    expect(sockets).toHaveLength(9);
  });
});
