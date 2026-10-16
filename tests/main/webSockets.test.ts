import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { relayHost, serveRelay, SocketRelay, type RelayContents } from "../../src/main/webSockets";
import { RELAY_IPC } from "../../src/shared/relay";

class FakeContents extends EventEmitter implements RelayContents {
  send = vi.fn();
  close = vi.fn();
  loadURL = vi.fn(async (_url: string) => {});
}

function relay(load?: () => Promise<void>) {
  const pages: FakeContents[] = [];
  const socketRelay = new SocketRelay({
    spawn: () => {
      const page = new FakeContents();
      if (load) page.loadURL.mockImplementation(load);
      pages.push(page);
      return page;
    },
    url: "multicord-engine://demo.relay/relay.html",
  });
  const commands = (page = pages.at(-1)!) => page.send.mock.calls.map(([channel, command]) => (expect(channel).toBe(RELAY_IPC.command), command));
  return { socketRelay, pages, commands };
}

const events = () => ({ open: vi.fn(), message: vi.fn(), close: vi.fn() });

describe("relay page", () => {
  it("is served on a host no engine id can have, with no script and a strict CSP", async () => {
    expect(relayHost("fluxer")).toBe("fluxer.relay");
    const page = serveRelay("multicord-engine://fluxer.relay/relay.html");
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("<script");
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; connect-src wss:");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(serveRelay("multicord-engine://fluxer.relay/").status).toBe(200);
    expect(serveRelay("multicord-engine://fluxer.relay/engine.js").status).toBe(404);
  });
});

describe("SocketRelay", () => {
  it("starts its page with the first socket and sends commands once the page is ready", () => {
    const { socketRelay, pages, commands } = relay();
    expect(pages).toHaveLength(0);
    const e = events();
    const socket = socketRelay.open("wss://gw.example/", e);
    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    expect(page.loadURL).toHaveBeenCalledWith("multicord-engine://demo.relay/relay.html");
    expect(socketRelay.owns(page)).toBe(true);
    expect(socketRelay.owns(undefined)).toBe(false);
    expect(page.send).not.toHaveBeenCalled();
    // Reports from any other page, or malformed ones, are ignored.
    socketRelay.receive(new FakeContents(), { type: "ready" });
    socketRelay.receive(page, { type: "nonsense" });
    expect(page.send).not.toHaveBeenCalled();
    socketRelay.receive(page, { type: "ready" });
    expect(commands()).toEqual([{ type: "open", id: "1", url: "wss://gw.example/" }]);

    socketRelay.receive(page, { type: "open", id: "1" });
    expect(e.open).toHaveBeenCalled();
    socketRelay.receive(page, { type: "message", id: "1", data: "hi" });
    socketRelay.receive(page, { type: "message", id: "1", data: new Uint8Array([1]) });
    expect(e.message.mock.calls).toEqual([["hi"], [new Uint8Array([1])]]);
    socket.send("hello");
    expect(commands().at(-1)).toEqual({ type: "send", id: "1", data: "hello" });
    socket.close(4000, "done");
    expect(commands().at(-1)).toEqual({ type: "close", id: "1", code: 4000, reason: "done" });
    // A closed socket hears nothing more, and closing it again does nothing.
    socketRelay.receive(page, { type: "message", id: "1", data: "late" });
    expect(e.message).toHaveBeenCalledTimes(2);
    const sent = page.send.mock.calls.length;
    socket.close();
    expect(page.send.mock.calls.length).toBe(sent);
    expect(e.close).not.toHaveBeenCalled();
  });

  it("offers the subprotocols asked for, and reports the one the server chose", () => {
    const { socketRelay, pages, commands } = relay();
    const e = events();
    socketRelay.open("wss://gw.example/", e, ["binary"]);
    socketRelay.receive(pages[0], { type: "ready" });
    expect(commands()).toEqual([{ type: "open", id: "1", url: "wss://gw.example/", protocols: ["binary"] }]);
    socketRelay.receive(pages[0], { type: "open", id: "1", protocol: "binary" });
    expect(e.open).toHaveBeenCalledWith("binary");
  });

  it("closes a socket without a code or reason when none is given", () => {
    const { socketRelay, pages, commands } = relay();
    const socket = socketRelay.open("wss://gw.example/", events());
    socket.close();
    socketRelay.receive(pages[0], { type: "ready" });
    expect(commands()).toEqual([
      { type: "open", id: "1", url: "wss://gw.example/" },
      { type: "close", id: "1" },
    ]);
  });

  it("reports a socket the server closed", () => {
    const { socketRelay, pages } = relay();
    const e = events();
    socketRelay.open("wss://gw.example/", e);
    socketRelay.receive(pages[0], { type: "ready" });
    socketRelay.receive(pages[0], { type: "close", id: "1", code: 1006, reason: "" });
    expect(e.close).toHaveBeenCalledWith(1006, "");
    socketRelay.receive(pages[0], { type: "open", id: "1" });
    expect(e.open).not.toHaveBeenCalled();
  });

  it("counts what waits to be sent: in flight to the page, and held by the socket", () => {
    const { socketRelay, pages } = relay();
    const socket = socketRelay.open("wss://gw.example/", events());
    const page = pages[0]!;
    socketRelay.receive(page, { type: "ready" });
    socket.send("abcd");
    socket.send(new Uint8Array(6));
    expect(socket.bufferedAmount).toBe(10);
    socketRelay.receive(page, { type: "buffered", id: "1", amount: 4, sent: 4 });
    expect(socket.bufferedAmount).toBe(10);
    socketRelay.receive(page, { type: "buffered", id: "1", amount: 3, sent: 6 });
    expect(socket.bufferedAmount).toBe(3);
    socketRelay.receive(page, { type: "buffered", id: "1", amount: 0 });
    expect(socket.bufferedAmount).toBe(0);
    socketRelay.receive(page, { type: "buffered", id: "1", amount: 0, sent: 99 });
    expect(socket.bufferedAmount).toBe(0);
  });

  it("breaks every socket when its page crashes, and starts a new page for the next", () => {
    const { socketRelay, pages, commands } = relay();
    const first = events();
    socketRelay.open("wss://gw.example/", first);
    pages[0]!.emit("render-process-gone");
    expect(first.close).toHaveBeenCalledWith(1006, "");
    expect(pages[0]!.close).toHaveBeenCalled();
    expect(socketRelay.owns(pages[0])).toBe(false);
    // The old page's later reports go nowhere.
    socketRelay.receive(pages[0], { type: "ready" });
    pages[0]!.emit("destroyed");
    const second = events();
    socketRelay.open("wss://gw.example/2", second);
    expect(pages).toHaveLength(2);
    socketRelay.receive(pages[1], { type: "ready" });
    expect(commands()).toEqual([{ type: "open", id: "2", url: "wss://gw.example/2" }]);
    expect(second.close).not.toHaveBeenCalled();
  });

  it("breaks every socket when its page is destroyed or does not load", async () => {
    const { socketRelay, pages } = relay();
    const first = events();
    socketRelay.open("wss://gw.example/", first);
    pages[0]!.emit("destroyed");
    expect(first.close).toHaveBeenCalledWith(1006, "");
    expect(pages[0]!.close).not.toHaveBeenCalled();
    pages[0]!.emit("render-process-gone");
    expect(pages[0]!.close).not.toHaveBeenCalled();

    const failing = relay(async () => {
      throw new Error("ERR_FAILED");
    });
    const second = events();
    failing.socketRelay.open("wss://gw.example/", second);
    await vi.waitFor(() => expect(second.close).toHaveBeenCalledWith(1006, ""));
    expect(failing.pages[0]!.close).toHaveBeenCalled();
  });

  it("closes its page and every socket when disposed", () => {
    const { socketRelay, pages } = relay();
    socketRelay.dispose();
    const e = events();
    socketRelay.open("wss://gw.example/", e);
    socketRelay.dispose();
    expect(pages[0]!.close).toHaveBeenCalled();
    expect(e.close).toHaveBeenCalledWith(1006, "");
  });
});
