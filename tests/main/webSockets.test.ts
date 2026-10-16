import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openHostSocket, type HostWebSocket } from "../../src/main/webSockets";
import { MAX_CLOSE_REASON } from "../../src/shared/engine";

class FakeSocket extends EventEmitter implements HostWebSocket {
  binaryType = "blob";
  bufferedAmount = 7;
  send = vi.fn();
  close = vi.fn();
  addEventListener(type: string, listener: (event: { data: unknown } & { code: number; reason: string }) => void): void {
    this.on(type, listener);
  }
}

describe("host sockets", () => {
  it("relays a socket's frames as text or bytes, and its close", () => {
    const fake = new FakeSocket();
    const events = { open: vi.fn(), message: vi.fn(), close: vi.fn() };
    const socket = openHostSocket("wss://gw.example/", events, (url) => {
      expect(url).toBe("wss://gw.example/");
      return fake;
    });
    expect(fake.binaryType).toBe("arraybuffer");
    fake.emit("open");
    expect(events.open).toHaveBeenCalled();
    fake.emit("message", { data: "hi" });
    fake.emit("message", { data: new Uint8Array([1, 2]).buffer });
    fake.emit("message", { data: { neither: true } });
    expect(events.message.mock.calls).toEqual([["hi"], [new Uint8Array([1, 2])]]);
    fake.emit("close", { code: 1006, reason: "x".repeat(200) });
    expect(events.close).toHaveBeenCalledWith(1006, "x".repeat(MAX_CLOSE_REASON));

    socket.send("out");
    socket.close(1000, "bye");
    expect(fake.send).toHaveBeenCalledWith("out");
    expect(fake.close).toHaveBeenCalledWith(1000, "bye");
    expect(socket.bufferedAmount).toBe(7);
  });
});
