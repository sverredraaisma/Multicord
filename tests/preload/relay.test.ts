import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAIN_POLL_MS, startRelay, type RelayWebSocket } from "../../src/preload/relay";
import { MAX_CLOSE_REASON, MAX_SOCKET_FRAME } from "../../src/shared/engine";
import { RELAY_IPC } from "../../src/shared/relay";

class FakeSocket extends EventEmitter implements RelayWebSocket {
  binaryType = "blob";
  bufferedAmount = 0;
  protocol = "";
  send = vi.fn();
  close = vi.fn();
  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    super();
  }
  addEventListener(type: string, listener: (event: { data: unknown } & { code: number; reason: string }) => void): void {
    this.on(type, listener);
  }
}

function start(create?: (url: string, protocols?: string[]) => RelayWebSocket) {
  const ipc = new EventEmitter();
  const sent: unknown[] = [];
  const sockets: FakeSocket[] = [];
  startRelay(
    {
      send: (channel, payload) => {
        expect(channel).toBe(RELAY_IPC.event);
        sent.push(payload);
      },
      on: (channel, listener) => void ipc.on(channel, listener),
    },
    create ??
      ((url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        return socket;
      }),
  );
  const command = (payload: unknown) => ipc.emit(RELAY_IPC.command, {}, payload);
  return { sent, sockets, command };
}

afterEach(() => vi.useRealTimers());

describe("socket relay preload", () => {
  it("says it is ready, then opens sockets and reports their frames and close", () => {
    const { sent, sockets, command } = start();
    expect(sent).toEqual([{ type: "ready" }]);
    command({ type: "open", id: "1", url: "wss://gw.example/" });
    // An id already open is not opened twice.
    command({ type: "open", id: "1", url: "wss://gw.example/" });
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    expect(socket.url).toBe("wss://gw.example/");
    expect(socket.binaryType).toBe("arraybuffer");
    socket.emit("open");
    socket.emit("message", { data: "hi" });
    socket.emit("message", { data: new Uint8Array([1, 2]).buffer });
    socket.emit("message", { data: { neither: true } });
    socket.emit("close", { code: 4000, reason: "x".repeat(200) });
    // Once closed, the socket's late events go nowhere.
    socket.emit("open");
    socket.emit("message", { data: "late" });
    socket.emit("close", { code: 1000, reason: "" });
    expect(sent.slice(1)).toEqual([
      { type: "open", id: "1" },
      { type: "message", id: "1", data: "hi" },
      { type: "message", id: "1", data: new Uint8Array([1, 2]) },
      { type: "close", id: "1", code: 4000, reason: "x".repeat(MAX_CLOSE_REASON) },
    ]);
  });

  it("offers the subprotocols asked for, and reports the one the server chose", () => {
    const { sent, sockets, command } = start();
    command({ type: "open", id: "1", url: "wss://gw.example/", protocols: ["binary"] });
    expect(sockets[0]!.protocols).toEqual(["binary"]);
    sockets[0]!.protocol = "binary";
    sockets[0]!.emit("open");
    expect(sent.at(-1)).toEqual({ type: "open", id: "1", protocol: "binary" });
  });

  it("opens the page's own WebSocket by default", () => {
    const created: FakeSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends FakeSocket {
        constructor(url: string, protocols?: string[]) {
          super(url, protocols);
          created.push(this);
        }
      },
    );
    const ipc = new EventEmitter();
    startRelay({ send: () => {}, on: (channel, listener) => void ipc.on(channel, listener) });
    ipc.emit(RELAY_IPC.command, {}, { type: "open", id: "1", url: "wss://gw.example/" });
    ipc.emit(RELAY_IPC.command, {}, { type: "open", id: "2", url: "wss://gw.example/", protocols: ["binary"] });
    vi.unstubAllGlobals();
    expect(created.map((s) => [s.url, s.protocols])).toEqual([
      ["wss://gw.example/", undefined],
      ["wss://gw.example/", ["binary"]],
    ]);
  });

  it("closes a socket whose frame is too large", () => {
    const { sent, sockets, command } = start();
    command({ type: "open", id: "1", url: "wss://gw.example/" });
    sockets[0]!.emit("message", { data: new ArrayBuffer(MAX_SOCKET_FRAME + 1) });
    expect(sockets[0]!.close).toHaveBeenCalledWith();
    expect(sent.at(-1)).toEqual({ type: "close", id: "1", code: 1009, reason: "Frame too large" });
  });

  it("reports a socket it could not create as closed", () => {
    const { sent, command } = start(() => {
      throw new SyntaxError("bad url");
    });
    command({ type: "open", id: "1", url: "wss://gw.example/" });
    expect(sent.at(-1)).toEqual({ type: "close", id: "1", code: 1006, reason: "" });
  });

  it("sends frames and reports what waits until it has drained", () => {
    vi.useFakeTimers();
    const { sent, sockets, command } = start();
    command({ type: "open", id: "1", url: "wss://gw.example/" });
    const socket = sockets[0]!;
    command({ type: "send", id: "1", data: "abc" });
    expect(socket.send).toHaveBeenCalledWith("abc");
    expect(sent.at(-1)).toEqual({ type: "buffered", id: "1", amount: 0, sent: 3 });
    socket.bufferedAmount = 5;
    command({ type: "send", id: "1", data: new Uint8Array(5) });
    command({ type: "send", id: "1", data: "" });
    expect(sent.slice(-2)).toEqual([
      { type: "buffered", id: "1", amount: 5, sent: 5 },
      { type: "buffered", id: "1", amount: 5, sent: 0 },
    ]);
    socket.bufferedAmount = 2;
    vi.advanceTimersByTime(DRAIN_POLL_MS);
    expect(sent.at(-1)).toEqual({ type: "buffered", id: "1", amount: 2 });
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(DRAIN_POLL_MS);
    expect(sent.at(-1)).toEqual({ type: "buffered", id: "1", amount: 0 });
    const count = sent.length;
    vi.advanceTimersByTime(DRAIN_POLL_MS * 3);
    expect(sent.length).toBe(count);
    // A socket closed while it drains stops reporting.
    socket.bufferedAmount = 9;
    command({ type: "send", id: "1", data: "x" });
    command({ type: "close", id: "1" });
    const closed = sent.length;
    vi.advanceTimersByTime(DRAIN_POLL_MS * 3);
    expect(sent.length).toBe(closed);
    // Frames for sockets it does not have are dropped.
    command({ type: "send", id: "1", data: "x" });
    expect(socket.send).toHaveBeenCalledTimes(4);
  });

  it("closes sockets as asked, and forgets them even when closing throws", () => {
    const { sent, sockets, command } = start();
    command({ type: "open", id: "1", url: "wss://gw.example/" });
    command({ type: "close", id: "1", code: 4000, reason: "done" });
    expect(sockets[0]!.close).toHaveBeenCalledWith(4000, "done");
    sockets[0]!.emit("close", { code: 4000, reason: "done" });
    command({ type: "open", id: "2", url: "wss://gw.example/" });
    sockets[1]!.close.mockImplementation(() => {
      throw new Error("InvalidAccessError");
    });
    command({ type: "close", id: "2", code: 1000 });
    sockets[1]!.emit("close", { code: 1000, reason: "" });
    command({ type: "close", id: "3" });
    expect(sent.filter((e) => (e as { type: string }).type === "close")).toEqual([]);
  });
});
