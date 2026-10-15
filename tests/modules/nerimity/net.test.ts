import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES, NerimityApiError, NerimityRest } from "../../../src/modules/nerimity/rest";
import { NerimitySocket, type EventSocket, type SocketHandlers } from "../../../src/modules/nerimity/socket";
import type { FileSource } from "../../../src/engine/runtime";
import { ANA, message } from "./fixtures";

class FakeSocket implements EventSocket {
  sent: string[] = [];
  closed: number[] = [];
  private listeners: Record<string, ((event: never) => void)[]> = {};
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.closed.push(code);
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  receive(data: unknown): void {
    for (const l of this.listeners.message ?? []) l({ data } as never);
  }
  serverClose(): void {
    for (const l of this.listeners.close ?? []) l({ code: 1006 } as never);
  }
  /** The socket.io events it sent, as [name, data]. */
  events(): unknown[] {
    return this.sent.filter((s) => s.startsWith("42")).map((s) => JSON.parse(s.slice(2)));
  }
}

function setupSocket() {
  const sockets: FakeSocket[] = [];
  const handlers = { event: vi.fn(), status: vi.fn(), queue: vi.fn(), authFailed: vi.fn() } satisfies SocketHandlers;
  const client = new NerimitySocket(
    "https://nerimity.com",
    "tok",
    (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    handlers,
  );
  const last = () => sockets.at(-1)!;
  /** Engine.IO open, socket.io connect and sign-in. */
  const handshake = (socket = last()) => {
    socket.receive('0{"sid":"e1","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    socket.receive('40{"sid":"s1"}');
    socket.receive(`42${JSON.stringify(["user:authenticated", { user: ANA }])}`);
  };
  return { client, sockets, handlers, last, handshake };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Nerimity socket", () => {
  it("speaks Engine.IO and socket.io over a plain WebSocket and signs in", () => {
    const { client, sockets, handlers, last, handshake } = setupSocket();
    client.connect();
    expect(sockets[0]!.url).toBe("wss://nerimity.com/socket.io/?EIO=4&transport=websocket");
    expect(handlers.status).toHaveBeenLastCalledWith("connecting");
    // Nothing is emitted before sign-in.
    client.emit("notification:dismiss", { channelId: "1" });
    handshake();
    expect(last().sent.slice(0, 2)).toEqual(["40", '42["user:authenticate",{"token":"tok"}]']);
    expect(handlers.status).toHaveBeenLastCalledWith("ready");
    expect(handlers.event).toHaveBeenCalledWith("user:authenticated", { user: ANA });
    // A second connect packet does not sign in again.
    last().receive("40");
    expect(last().events()).toHaveLength(1);
    // Events, with or without an ack id; pings are answered.
    last().receive(`42${JSON.stringify(["message:created", { message: message("5", "9") }])}`);
    last().receive('4212["channel:typing",{"userId":"2"}]');
    expect(handlers.event).toHaveBeenCalledWith("message:created", { message: message("5", "9") });
    expect(handlers.event).toHaveBeenCalledWith("channel:typing", { userId: "2" });
    last().receive("2");
    expect(last().sent.at(-1)).toBe("3");
    client.emit("notification:dismiss", { channelId: "1" });
    expect(last().events().at(-1)).toEqual(["notification:dismiss", { channelId: "1" }]);
    // What it does not understand is left alone: binary frames and their events, bad JSON, empty frames, other packets.
    for (const frame of [new Uint8Array([1]), "", "451-[\"server:members_fetched\",{\"_placeholder\":true,\"num\":0}]", "42{bad", '42[5]', "6", "43[]"]) last().receive(frame);
    expect(handlers.event).toHaveBeenCalledTimes(3);
    client.disconnect();
    expect(last().closed).toEqual([1000]);
    expect(handlers.status).toHaveBeenLastCalledWith("closed");
  });

  it("reports its place in the sign-in queue", () => {
    const { client, handlers, last } = setupSocket();
    client.connect();
    last().receive("0");
    last().receive("40");
    last().receive('42["user:auth_queue_position",{"pos":3}]');
    last().receive('42["user:auth_queue_position",{"pos":-1}]');
    last().receive('42["message:created",{}]');
    expect(handlers.queue).toHaveBeenCalledTimes(1);
    expect(handlers.queue).toHaveBeenCalledWith(3);
    // Events before sign-in are not passed on.
    expect(handlers.event).not.toHaveBeenCalled();
  });

  it("reconnects with backoff when the connection drops, goes quiet or is ended", async () => {
    const { client, sockets, handlers, last, handshake } = setupSocket();
    client.connect();
    handshake();
    last().serverClose();
    expect(handlers.status).toHaveBeenLastCalledWith("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    expect(handlers.status).toHaveBeenLastCalledWith("reconnecting");
    // A close from the old socket changes nothing now.
    sockets[0]!.serverClose();
    sockets[0]!.receive("2");
    expect(sockets[0]!.sent.filter((s) => s === "3")).toHaveLength(0);
    // The second attempt waits longer; silence past ping interval and timeout counts as a drop.
    // (A timeout under a second counts as one.)
    last().receive('0{"pingInterval":1000,"pingTimeout":500}');
    await vi.advanceTimersByTimeAsync(1999);
    expect(last().closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(last().closed).toEqual([4000]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    // Signing in resets the backoff; an Engine.IO close, a namespace disconnect or error reconnect too.
    handshake();
    last().receive("1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(4);
    last().receive("0");
    last().receive("41");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(5);
    last().receive('44{"message":"no"}');
    await vi.advanceTimersByTimeAsync(4000);
    expect(sockets).toHaveLength(6);
    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(6);
  });

  it("stops when the server refuses the session, but tries again after a sign-in timeout", async () => {
    const { client, sockets, handlers, last } = setupSocket();
    client.connect();
    last().receive("0");
    last().receive("40");
    last().receive('42["user:authenticate_error",{"message":"Authentication timed out"}]');
    expect(handlers.authFailed).not.toHaveBeenCalled();
    last().receive("41");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    last().receive('42["user:authenticate_error",{"message":"Invalid token."}]');
    expect(handlers.authFailed).toHaveBeenCalledWith("Invalid token.");
    expect(handlers.status).toHaveBeenLastCalledWith("closed");
    expect(last().closed).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    // Without a message, it still says it was refused.
    const other = setupSocket();
    other.client.connect();
    other.last().receive('42["user:authenticate_error",null]');
    expect(other.handlers.authFailed).toHaveBeenCalledWith("Sign-in refused.");
  });
});

type Reply = { status: number; body?: unknown; text?: string } | Error;

function fakeFetch(routes: Record<string, Reply | ((init: RequestInit) => Reply)>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[`${init.method} ${url}`];
    const reply = typeof route === "function" ? route(init) : (route ?? { status: 404, body: { message: "Not found" } });
    if (reply instanceof Error) throw reply;
    const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return { ok: reply.status < 300, status: reply.status, text: async () => text } as Response;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const API = "https://nerimity.com/api";
const json = (init: RequestInit) => JSON.parse(String(init.body)) as unknown;

function file(name: string, bytes: number[], type = "image/png"): FileSource {
  const data = new Uint8Array(bytes);
  return { filename: name, size: data.length, contentType: type, read: async (start, end) => data.slice(start, end) };
}

describe("Nerimity REST", () => {
  it("signs in with an email or username:tag, and checks a token", async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${API}/users/login`]: { status: 200, body: { token: "tok" } },
      [`GET ${API}/users`]: { status: 200, body: { user: ANA, posts: [] } },
      [`DELETE ${API}/users/logout`]: { status: 200, body: { status: true } },
    });
    const rest = new NerimityRest(API, { fetch, sleep: async () => {} });
    expect(await rest.login("me@x.org", "pw")).toBe("tok");
    expect(await rest.login("me:0001", "pw")).toBe("tok");
    expect(calls.map((c) => json(c.init))).toEqual([
      { email: "me@x.org", password: "pw" },
      { usernameAndTag: "me:0001", password: "pw" },
    ]);
    expect(calls[0]!.init.headers).toEqual({ "Content-Type": "application/json" });
    rest.token = "tok";
    expect((await rest.me())?.username).toBe("ana");
    expect(calls.at(-1)!.init.headers).toEqual({ Authorization: "tok" });
    await rest.logout();
    expect(calls.at(-1)!.init.method).toBe("DELETE");
  });

  it("says why a request failed, in the server's words where it gave some", async () => {
    const { fetch } = fakeFetch({
      [`POST ${API}/users/login`]: { status: 400, body: { message: "Invalid email address.", path: "email" } },
      [`GET ${API}/users`]: { status: 200, body: { nope: true } },
      [`DELETE ${API}/users/logout`]: { status: 403, text: "Name is required!" },
      [`POST ${API}/channels/9/typing`]: { status: 500, text: "" },
      [`POST ${API}/channels/9/cdn/token`]: { status: 400, body: { error: "Ticket message cannot be edited." } },
    });
    const rest = new NerimityRest(API, { fetch, sleep: async () => {} });
    await expect(rest.login("me@x", "pw")).rejects.toThrow("Invalid email address.");
    expect(await rest.me()).toBeUndefined();
    await expect(rest.logout()).rejects.toThrow("Name is required!");
    await expect(rest.typing("9")).rejects.toThrow("Request failed (HTTP 500)");
    const error = await rest.cdnToken("9").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NerimityApiError);
    expect(error).toMatchObject({ status: 400, message: "Ticket message cannot be edited." });
    // An answer without a token is no sign-in.
    const odd = fakeFetch({ [`POST ${API}/users/login`]: { status: 200, body: {} }, [`POST ${API}/channels/9/cdn/token`]: { status: 200, body: {} } });
    const oddRest = new NerimityRest(API, { fetch: odd.fetch, sleep: async () => {} });
    await expect(oddRest.login("me@x", "pw")).rejects.toThrow("Unexpected sign-in response");
    await expect(oddRest.cdnToken("9")).rejects.toThrow("The server gave no upload token");
    // Bodies without a message, a body that is not text, and an answer that is not an object.
    const bare = fakeFetch({ [`POST ${API}/channels/1/typing`]: { status: 502, body: {} }, [`POST ${API}/channels/2/typing`]: { status: 502, body: 5 }, [`GET ${API}/users`]: { status: 200, body: [] } });
    const bareRest = new NerimityRest(API, { fetch: bare.fetch, sleep: async () => {} });
    await expect(bareRest.typing("1")).rejects.toThrow("Request failed (HTTP 502)");
    await expect(bareRest.typing("2")).rejects.toThrow("Request failed (HTTP 502)");
    expect(await bareRest.me()).toBeUndefined();
    const unreadable = vi.fn(async () => ({ ok: false, status: 503, text: () => Promise.reject(new Error("cut off")) }) as unknown as Response);
    await expect(new NerimityRest(API, { fetch: unreadable, sleep: async () => {} }).typing("1")).rejects.toThrow("Request failed (HTTP 503)");
  });

  it("waits out rate limits, then gives up", async () => {
    let limited = 0;
    const sleeps: number[] = [];
    const { fetch, calls } = fakeFetch({
      [`POST ${API}/channels/9/typing`]: () => (limited++ < 1 ? { status: 429, body: { message: "Slow down!", ttl: 2500 } } : { status: 204 }),
      [`POST ${API}/channels/8/typing`]: { status: 429, body: { message: "Slow down!" } },
    });
    const rest = new NerimityRest(API, { fetch, sleep: async (ms) => void sleeps.push(ms), minIntervalMs: 10 });
    await rest.typing("9");
    expect(sleeps).toEqual([10, 2500, 10]);
    await expect(rest.typing("8")).rejects.toThrow("Slow down!");
    expect(calls.filter((c) => c.url.endsWith("/8/typing"))).toHaveLength(3);
    // The default pause is real time; a failing request does not block the next.
    vi.useRealTimers();
    const real = new NerimityRest(API, { fetch: fakeFetch({ [`POST ${API}/channels/9/typing`]: new Error("offline") }).fetch, minIntervalMs: 1 });
    await expect(real.typing("9")).rejects.toThrow("offline");
    const ok = new NerimityRest(API, { fetch: fakeFetch({ [`POST ${API}/channels/9/typing`]: { status: 204 } }).fetch, minIntervalMs: 1 });
    await ok.typing("9");
  });

  it("pages history and sends, edits and deletes messages", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${API}/channels/9/messages?limit=50`]: { status: 200, body: [message("4", "9"), message("5", "9"), { bad: 1 }] },
      [`GET ${API}/channels/9/messages?limit=50&before=4`]: { status: 200, body: [] },
      [`POST ${API}/channels/9/messages`]: { status: 200, body: message("6", "9") },
      [`PATCH ${API}/channels/9/messages/6`]: { status: 200, body: message("6", "9", { content: "new", editedAt: 1 }) },
      [`DELETE ${API}/channels/9/messages/6`]: { status: 200, body: { message: "Message deleted!" } },
    });
    const rest = new NerimityRest(API, { fetch, sleep: async () => {} });
    expect((await rest.messages("9")).map((m) => m.id)).toEqual(["4", "5"]);
    expect(await rest.messages("9", "4")).toEqual([]);
    expect((await rest.sendMessage("9", "hi", "4"))?.id).toBe("6");
    expect(json(calls.at(-1)!.init)).toEqual({ content: "hi", replyToMessageIds: ["4"], mentionReplies: true });
    await rest.sendMessage("9", "  ", undefined, "77");
    expect(json(calls.at(-1)!.init)).toEqual({ nerimityCdnFileId: "77" });
    expect((await rest.editMessage("9", "6", "new"))?.edited).toBe(true);
    expect(json(calls.at(-1)!.init)).toEqual({ content: "new" });
    await rest.deleteMessage("9", "6");
    expect(calls.at(-1)!.init.method).toBe("DELETE");
  });

  it("adds and removes reactions, naming custom emoji by id and file kind", async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${API}/channels/9/messages/6/reactions`]: (init) => ({ status: 200, body: { ...(json(init) as object), count: 2, reactedByUserId: "1" } }),
      [`POST ${API}/channels/9/messages/6/reactions/remove`]: { status: 200, body: { name: "👍", count: 0 } },
    });
    const rest = new NerimityRest(API, { fetch, sleep: async () => {} });
    expect(await rest.react("9", "6", { name: "party", emojiId: "130", webp: true }, true)).toEqual({ name: "party", emojiId: "130", gif: false, webp: true, count: 2, reacted: false });
    expect(json(calls.at(-1)!.init)).toEqual({ name: "party", emojiId: "130", gif: false, webp: true });
    expect(await rest.react("9", "6", { name: "👍" }, false)).toMatchObject({ name: "👍", count: 0 });
    expect(json(calls.at(-1)!.init)).toEqual({ name: "👍" });
  });

  it("uploads a file to the CDN with an upload token", async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${API}/channels/9/cdn/token`]: { status: 200, body: { token: "cdn-tok" } },
      ["POST https://cdn.nerimity.com/attachments/9"]: { status: 200, body: { fileId: "555" } },
      ["POST https://cdn.bad/attachments/9"]: { status: 200, body: { fileId: "../x" } },
    });
    const rest = new NerimityRest(API, { fetch, sleep: async () => {} });
    rest.token = "tok";
    const token = await rest.cdnToken("9");
    expect(await rest.upload("https://cdn.nerimity.com", "9", token, file("a b.png", [1, 2, 3]))).toBe("555");
    const upload = calls.at(-1)!;
    expect(upload.init.headers).toEqual({ Authorization: "cdn-tok", "Content-Type": "image/png", "File-Name": "a%20b.png" });
    expect([...(upload.init.body as Uint8Array)]).toEqual([1, 2, 3]);
    // An unknown type goes as bytes; an odd answer is refused.
    await expect(rest.upload("https://cdn.bad", "9", token, file("x", [1], "weird"))).rejects.toThrow("The CDN gave no file id");
    expect((calls.at(-1)!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    // Too large never leaves.
    const big: FileSource = { filename: "big", size: MAX_UPLOAD_BYTES + 1, contentType: "video/mp4", read: vi.fn() };
    await expect(rest.upload("https://cdn.nerimity.com", "9", token, big)).rejects.toThrow("Nerimity takes files up to 50 MB.");
    expect(big.read).not.toHaveBeenCalled();
  });
});
