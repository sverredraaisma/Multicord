import { describe, expect, it, vi } from "vitest";
import { EngineSockets, type RelaySocketEvents } from "../../src/core/engineSockets";
import { MAX_SOCKET_FRAME, MAX_SOCKET_QUEUE, MAX_SOCKETS, type EngineSocketEvent } from "../../src/shared/engine";

function setup(check: (url: string) => Promise<string | undefined> = async () => undefined) {
  const opened: { url: string; events: RelaySocketEvents; socket: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; bufferedAmount: number } }[] = [];
  const emitted: EngineSocketEvent[] = [];
  const sockets = new EngineSockets({
    check,
    connect: (url, events) => {
      const socket = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
      opened.push({ url, events, socket });
      return socket;
    },
    emit: (event) => emitted.push(event),
  });
  return { sockets, opened, emitted };
}

describe("bridged sockets, the shell's side", () => {
  it("opens allowed sockets and relays frames both ways", async () => {
    const { sockets, opened, emitted } = setup();
    const { id } = await sockets.open("wss://gateway.example/");
    expect(opened[0]!.url).toBe("wss://gateway.example/");
    expect(() => sockets.send(id, "early")).toThrow("No such open socket");
    opened[0]!.events.open();
    sockets.send(id, "hello");
    sockets.send(id, new Uint8Array([1, 2]));
    expect(opened[0]!.socket.send.mock.calls).toEqual([["hello"], [new Uint8Array([1, 2])]]);
    opened[0]!.events.message("hi");
    opened[0]!.events.message(new Uint8Array([3]));
    opened[0]!.events.close(1006, "");
    expect(emitted).toEqual([
      { type: "open", id },
      { type: "message", id, data: "hi" },
      { type: "message", id, data: new Uint8Array([3]) },
      { type: "close", id, code: 1006, reason: "" },
    ]);
    expect(sockets.size).toBe(0);
    // Gone: nothing more reaches the engine, and it cannot send.
    opened[0]!.events.message("late");
    opened[0]!.events.open();
    opened[0]!.events.close(1000, "");
    expect(emitted).toHaveLength(4);
    expect(() => sockets.send(id, "x")).toThrow("No such open socket");
  });

  it("gives each socket an id of its own", async () => {
    const { sockets } = setup();
    const a = await sockets.open("wss://a.example/");
    const b = await sockets.open("wss://b.example/");
    expect(a.id).not.toBe(b.id);
  });

  it("refuses what the policy refuses, and when the host cannot connect", async () => {
    const { sockets, opened } = setup(async (url) => (url.includes("evil") ? "evil.example is not one of this module's hosts" : undefined));
    await expect(sockets.open("wss://evil.example/")).rejects.toThrow("Socket refused: evil.example is not one of this module's hosts");
    expect(opened).toHaveLength(0);
    expect(sockets.size).toBe(0);
    const failing = new EngineSockets({
      check: async () => {
        throw new Error("lookup failed");
      },
      connect: vi.fn(),
      emit: vi.fn(),
    });
    await expect(failing.open("wss://a.example/")).rejects.toThrow("Socket refused: lookup failed");
    const throwing = new EngineSockets({
      check: async () => undefined,
      connect: () => {
        throw new SyntaxError("Invalid URL");
      },
      emit: vi.fn(),
    });
    await expect(throwing.open("wss://a.example/")).rejects.toThrow("Socket refused: Invalid URL");
    expect(throwing.size).toBe(0);
  });

  it("keeps an engine to MAX_SOCKETS at a time, counting those still being checked", async () => {
    const waiting: (() => void)[] = [];
    const { sockets } = setup(() => new Promise((resolve) => waiting.push(() => resolve(undefined))));
    const pending = Array.from({ length: MAX_SOCKETS }, (_, i) => sockets.open(`wss://h${i}.example/`));
    await expect(sockets.open("wss://one-more.example/")).rejects.toThrow(`at most ${MAX_SOCKETS} sockets`);
    for (const release of waiting) release();
    await Promise.all(pending);
    expect(sockets.size).toBe(MAX_SOCKETS);
  });

  it("closes a socket whose incoming frame is too large", async () => {
    const { sockets, opened, emitted } = setup();
    const { id } = await sockets.open("wss://a.example/");
    opened[0]!.events.open();
    opened[0]!.events.message("x".repeat(MAX_SOCKET_FRAME));
    opened[0]!.events.message(new Uint8Array(MAX_SOCKET_FRAME + 1));
    expect(opened[0]!.socket.close).toHaveBeenCalledWith();
    expect(emitted.at(-1)).toEqual({ type: "close", id, code: 1009, reason: "Frame too large" });
    expect(sockets.size).toBe(0);
  });

  it("refuses to queue more than MAX_SOCKET_QUEUE for sending", async () => {
    const { sockets, opened } = setup();
    const { id } = await sockets.open("wss://a.example/");
    opened[0]!.events.open();
    opened[0]!.socket.bufferedAmount = MAX_SOCKET_QUEUE - 2;
    sockets.send(id, "ab");
    expect(() => sockets.send(id, new Uint8Array(3))).toThrow("send queue is full");
    expect(opened[0]!.socket.send).toHaveBeenCalledTimes(1);
  });

  it("closes on the engine's word, telling it as a WebSocket would", async () => {
    const { sockets, opened, emitted } = setup();
    const a = await sockets.open("wss://a.example/");
    const b = await sockets.open("wss://b.example/");
    sockets.close(a.id, 4000, "bye");
    sockets.close(b.id);
    sockets.close("unknown");
    expect(opened[0]!.socket.close).toHaveBeenCalledWith(4000, "bye");
    expect(opened[1]!.socket.close).toHaveBeenCalledWith(undefined, undefined);
    expect(emitted).toEqual([
      { type: "close", id: a.id, code: 4000, reason: "bye" },
      { type: "close", id: b.id, code: 1000, reason: "" },
    ]);
  });

  it("drops a socket closed while it was still being checked", async () => {
    let release!: () => void;
    const { sockets, opened, emitted } = setup(() => new Promise((resolve) => (release = () => resolve(undefined))));
    const pending = sockets.open("wss://a.example/");
    // The id is not the engine's to know yet, but the relay copes if it is named.
    sockets.close("1");
    release();
    await expect(pending).rejects.toThrow("closed before it opened");
    expect(opened).toHaveLength(0);
    expect(emitted).toEqual([{ type: "close", id: "1", code: 1000, reason: "" }]);
  });

  it("closes everything quietly when the engine goes away", async () => {
    let release!: () => void;
    const { sockets, opened, emitted } = setup();
    const a = await sockets.open("wss://a.example/");
    opened[0]!.events.open();
    const slow = new EngineSockets({ check: () => new Promise((resolve) => (release = () => resolve(undefined))), connect: vi.fn(), emit: vi.fn() });
    const pending = slow.open("wss://b.example/");
    sockets.closeAll();
    slow.closeAll();
    release();
    await expect(pending).rejects.toThrow("closed before it opened");
    expect(opened[0]!.socket.close).toHaveBeenCalledWith();
    expect(sockets.size).toBe(0);
    opened[0]!.events.close(1005, "");
    expect(emitted).toEqual([{ type: "open", id: a.id }]);
  });
});
