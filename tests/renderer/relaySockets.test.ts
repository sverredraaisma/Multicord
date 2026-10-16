// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { BridgedWebSocket } from "../../src/engine/runtime";
import { relayWebSockets } from "../../src/renderer/relaySockets";
import type { EngineRequest, EngineSocketEvent } from "../../src/shared/engine";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function relay() {
  let deliver: (event: EngineSocketEvent) => void = () => {};
  const request = vi.fn(async (request: EngineRequest): Promise<unknown> => (request.type === "socketOpen" ? { id: "1" } : undefined));
  const win = {} as typeof globalThis;
  relayWebSockets(win, { request, onSocket: (cb) => void (deliver = cb) });
  type Ctor = new (url: string | URL, protocols?: string | string[]) => BridgedWebSocket;
  return { win, Socket: win.WebSocket as unknown as Ctor & { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }, request, deliver: (event: EngineSocketEvent) => deliver(event) };
}

describe("the chat view's WebSockets on a phone", () => {
  it("replaces the page's WebSocket with one the phone opens", async () => {
    const { Socket, request } = relay();
    expect([Socket.CONNECTING, Socket.OPEN, Socket.CLOSING, Socket.CLOSED]).toEqual([0, 1, 2, 3]);
    const socket = new Socket(new URL("wss://sfu.example/rtc?access_token=t"), []);
    expect(socket).toBeInstanceOf(BridgedWebSocket);
    expect(socket.url).toBe("wss://sfu.example/rtc?access_token=t");
    expect(request).toHaveBeenCalledWith({ type: "socketOpen", url: "wss://sfu.example/rtc?access_token=t" });
    expect(() => (Socket as unknown as (url: string) => unknown)("wss://sfu.example/")).toThrow("new");
    await flush();
  });

  it("works as LiveKit's signalling uses a WebSocket", async () => {
    const { Socket, request, deliver } = relay();
    const ws = new Socket("wss://sfu.example/rtc", []);
    ws.binaryType = "arraybuffer";
    const seen: unknown[] = [];
    const failed = vi.fn();
    ws.addEventListener("error", failed);
    ws.onopen = () => seen.push(["open", ws.protocol, ws.extensions, ws.readyState === Socket.OPEN]);
    ws.onmessage = (event) => seen.push(["message", new Uint8Array(event.data as ArrayBuffer).join()]);
    ws.addEventListener("close", (event) => seen.push(["close", event.code, event.wasClean]), { once: true });
    await flush();
    deliver({ type: "open", id: "1" });
    ws.removeEventListener("error", failed);
    ws.send(new Uint8Array([1, 2]));
    expect(request).toHaveBeenLastCalledWith({ type: "socketSend", id: "1", data: new Uint8Array([1, 2]) });
    deliver({ type: "message", id: "1", data: new Uint8Array([3, 4]) });
    ws.close(1000, "Close method called on signal client");
    expect(request).toHaveBeenLastCalledWith({ type: "socketClose", id: "1", code: 1000, reason: "Close method called on signal client" });
    deliver({ type: "close", id: "1", code: 1000, reason: "" });
    expect(seen).toEqual([["open", "", "", true], ["message", "3,4"], ["close", 1000, true]]);
    expect(ws.readyState).toBe(Socket.CLOSED);
    expect(failed).not.toHaveBeenCalled();
  });

  it("errors and closes a socket the phone refuses", async () => {
    const { Socket, request } = relay();
    request.mockRejectedValueOnce(new Error("Socket refused: no call in progress"));
    const ws = new Socket("wss://sfu.example/rtc");
    const seen: string[] = [];
    ws.onerror = () => seen.push("error");
    ws.onclose = (event) => seen.push(`close ${event.code}`);
    await flush();
    expect(seen).toEqual(["error", "close 1006"]);
  });
});
