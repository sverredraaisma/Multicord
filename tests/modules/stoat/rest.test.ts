import { describe, expect, it, vi } from "vitest";
import { discoverInstance, StoatApiError, StoatRest, type StoatInstance } from "../../../src/modules/stoat/rest";
import type { FileSource } from "../../../src/engine/runtime";
import { ANA, ME_ID, message, ulid } from "./fixtures";

const INSTANCE: StoatInstance = { api: "https://stoat.test/api", ws: "wss://events.stoat.test", autumn: "https://cdn.stoat.test" };

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string };

function fakeFetch(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const reply = replies.length > 1 ? replies.shift()! : replies[0] ?? { status: 204 };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: new Headers(reply.headers),
      json: async () => (reply.raw !== undefined ? JSON.parse(reply.raw) : reply.body),
    } as Response;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function rest(...replies: Reply[]) {
  const { fetch, calls } = fakeFetch(...replies);
  const sleep = vi.fn(async (_ms: number) => {});
  const client = new StoatRest(INSTANCE, { fetch, sleep, minIntervalMs: 5 });
  return { client, calls, sleep };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe("discoverInstance", () => {
  it("reads the events and file servers from the API root", async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { revolt: "0.15.7", ws: "wss://events.stoat.chat/", features: { autumn: { enabled: true, url: "https://cdn.stoatusercontent.com" } } } });
    expect(await discoverInstance("https://stoat.chat/app", fetch)).toEqual({
      api: "https://stoat.chat/api",
      ws: "wss://events.stoat.chat",
      autumn: "https://cdn.stoatusercontent.com",
    });
    expect(calls[0]!.url).toBe("https://stoat.chat/api/");
  });

  it("works without a file server", async () => {
    const off = fakeFetch({ status: 200, body: { ws: "wss://chat.example/ws", features: { autumn: { enabled: false, url: "https://f.example" } } } });
    expect(await discoverInstance("https://chat.example", off.fetch)).toEqual({ api: "https://chat.example/api", ws: "wss://chat.example/ws", autumn: undefined });
    const plain = fakeFetch({ status: 200, body: { ws: "wss://chat.example/ws", features: { autumn: { url: "http://f.example" } } } });
    expect((await discoverInstance("https://chat.example", plain.fetch)).autumn).toBeUndefined();
    const none = fakeFetch({ status: 200, body: { ws: "wss://chat.example/ws" } });
    expect((await discoverInstance("https://chat.example", none.fetch)).autumn).toBeUndefined();
  });

  it("rejects what is not a Stoat instance", async () => {
    await expect(discoverInstance("https://x.example", fakeFetch({ status: 404 }).fetch)).rejects.toThrow("Instance discovery failed (HTTP 404)");
    await expect(discoverInstance("https://x.example", fakeFetch({ status: 200, raw: "<html>" }).fetch)).rejects.toThrow("This does not look like a Stoat instance");
    await expect(discoverInstance("https://x.example", fakeFetch({ status: 200, body: { ws: "https://not-a-socket" } }).fetch)).rejects.toThrow("does not look like");
    await expect(discoverInstance("https://x.example", fakeFetch({ status: 200, body: { ws: "::" } }).fetch)).rejects.toThrow("does not look like");
  });
});

describe("StoatRest requests", () => {
  it("sends the session token and JSON, spacing requests out", async () => {
    const { client, calls, sleep } = rest({ status: 200, body: [] });
    await client.request("GET", "/sync/unreads");
    expect(headersOf(calls[0]!.init)).toEqual({});
    client.token = "tok";
    await client.request("POST", "/x", { a: 1 }, { "Idempotency-Key": "k" });
    expect(calls[1]).toEqual({ url: "https://stoat.test/api/x", init: { method: "POST", headers: { "X-Session-Token": "tok", "Content-Type": "application/json", "Idempotency-Key": "k" }, body: '{"a":1}' } });
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it("uses a 100 ms gap and real timers by default", async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch({ status: 204 });
    const client = new StoatRest(INSTANCE, { fetch });
    let done = false;
    void client.request("GET", "/x").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    vi.useRealTimers();
  });

  it("retries rate-limited requests after the advertised wait", async () => {
    const { client, sleep } = rest(
      { status: 429, headers: { "x-ratelimit-reset-after": "1500" } },
      { status: 429, body: { retry_after: 250.5 } },
      { status: 200, body: { ok: true } },
    );
    expect(await client.request("GET", "/x")).toEqual({ ok: true });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5, 1500, 5, 251, 5]);

    const capped = rest({ status: 429, headers: { "x-ratelimit-reset-after": "999999" } }, { status: 429 }, { status: 429 });
    await expect(capped.client.request("GET", "/x")).rejects.toMatchObject({ status: 429, type: "HTTP_429" });
    expect(capped.sleep.mock.calls.map(([ms]) => ms)).toEqual([5, 60_000, 5, 1000, 5]);
  });

  it("turns API errors into readable messages and keeps going", async () => {
    const { client } = rest({ status: 401, body: { type: "InvalidCredentials" } }, { status: 400, body: { type: "Weird" } }, { status: 500, raw: "oops" }, { status: 204 });
    await expect(client.request("POST", "/a")).rejects.toEqual(new StoatApiError(401, "InvalidCredentials", "Wrong email or password."));
    const weird = await client.request("POST", "/a").catch((e: StoatApiError) => e);
    expect(weird).toMatchObject({ status: 400, type: "Weird", message: "Request failed (Weird)" });
    await expect(client.request("POST", "/a")).rejects.toMatchObject({ type: "HTTP_500" });
    expect(await client.request("POST", "/a")).toBeUndefined();
  });
});

describe("StoatRest sign-in", () => {
  it("logs in with email and password, naming the session Multicord", async () => {
    const { client, calls } = rest({ status: 200, body: { result: "Success", _id: "s", user_id: ME_ID, token: "tok", name: "Multicord" } });
    expect(await client.login("a@b.c", "pw")).toEqual({ token: "tok", userId: ME_ID });
    expect(calls[0]!.url).toBe("https://stoat.test/api/auth/session/login");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ email: "a@b.c", password: "pw", friendly_name: "Multicord" });
  });

  it("asks for a second factor and answers it with the ticket", async () => {
    const { client, calls } = rest(
      { status: 200, body: { result: "MFA", ticket: "t1", allowed_methods: ["Password", "Recovery", "Totp"] } },
      { status: 200, body: { result: "MFA", ticket: "t2", allowed_methods: "x" } },
      { status: 200, body: { result: "Success", token: "tok" } },
    );
    expect(await client.login("a@b.c", "pw")).toEqual({ mfa: true, ticket: "t1", totp: true, recovery: true });
    expect(await client.login("a@b.c", "pw")).toEqual({ mfa: true, ticket: "t2", totp: false, recovery: false });
    expect(await client.loginMfa("t1", { totp_code: "123456" })).toEqual({ token: "tok", userId: undefined });
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ mfa_ticket: "t1", mfa_response: { totp_code: "123456" }, friendly_name: "Multicord" });
  });

  it("reports disabled accounts and odd answers", async () => {
    const { client } = rest({ status: 200, body: { result: "Disabled", user_id: ME_ID } }, { status: 200, body: { result: "Success", token: "" } }, { status: 200 });
    await expect(client.login("a", "b")).rejects.toThrow("This account is disabled.");
    await expect(client.login("a", "b")).rejects.toThrow("Unexpected login response");
    await expect(client.login("a", "b")).rejects.toThrow("Unexpected login response");
  });

  it("deletes the session on logout", async () => {
    const { client, calls } = rest({ status: 204 });
    client.token = "tok";
    await client.logout();
    expect(calls[0]).toMatchObject({ url: "https://stoat.test/api/auth/session/logout", init: { method: "POST", headers: { "X-Session-Token": "tok" } } });
  });
});

describe("StoatRest messages", () => {
  it("fetches history newest first with authors and returns it oldest first", async () => {
    const { client, calls } = rest(
      { status: 200, body: { messages: [message(3, ulid(5)), message(2, ulid(5)), { bad: 1 }], users: [ANA, null] } },
      { status: 200, body: [message(1, ulid(5))] },
      { status: 200, body: { messages: "x" } },
    );
    const page = await client.messages(ulid(5));
    expect(page.messages.map((m) => m.id)).toEqual([ulid(2), ulid(3)]);
    expect(page.users.map((u) => u.username)).toEqual(["ana"]);
    expect(calls[0]!.url).toBe(`https://stoat.test/api/channels/${ulid(5)}/messages?limit=50&include_users=true&sort=Latest`);
    expect((await client.messages(ulid(5), ulid(2))).messages.map((m) => m.id)).toEqual([ulid(1)]);
    expect(calls[1]!.url).toContain(`&before=${ulid(2)}`);
    expect(await client.messages(ulid(5))).toEqual({ messages: [], users: [] });
  });

  it("sends messages with an idempotency key, replies and attachments", async () => {
    const { client, calls } = rest({ status: 200, body: message(9, ulid(5), { author: ME_ID }) });
    expect((await client.sendMessage(ulid(5), "hi", "n1"))!.id).toBe(ulid(9));
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ content: "hi" });
    expect(headersOf(calls[0]!.init)["Idempotency-Key"]).toBe("n1");
    await client.sendMessage(ulid(5), "", "n2", ulid(8), ["file1"]);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ replies: [{ id: ulid(8), mention: false }], attachments: ["file1"] });
  });

  it("edits, deletes, reacts and acks", async () => {
    const { client, calls } = rest({ status: 200, body: message(9, ulid(5), { content: "new" }) }, { status: 204 });
    expect((await client.editMessage(ulid(5), ulid(9), "new"))!.content).toBe("new");
    await client.deleteMessage(ulid(5), ulid(9));
    await client.react(ulid(5), ulid(9), "👍", true);
    await client.react(ulid(5), ulid(9), ulid(50), false);
    await client.ack(ulid(5), ulid(9));
    expect(calls.map((c) => `${c.init.method} ${c.url.replace("https://stoat.test/api", "")}`)).toEqual([
      `PATCH /channels/${ulid(5)}/messages/${ulid(9)}`,
      `DELETE /channels/${ulid(5)}/messages/${ulid(9)}`,
      `PUT /channels/${ulid(5)}/messages/${ulid(9)}/reactions/%F0%9F%91%8D`,
      `DELETE /channels/${ulid(5)}/messages/${ulid(9)}/reactions/${ulid(50)}`,
      `PUT /channels/${ulid(5)}/ack/${ulid(9)}`,
    ]);
  });

  it("fetches unread state and synced settings", async () => {
    const { client, calls } = rest(
      { status: 200, body: [{ _id: { channel: ulid(5), user: ME_ID }, last_id: ulid(9) }, "x"] },
      { status: 200, body: { notifications: [1, "{}"] } },
      { status: 200, body: "nope" },
      { status: 200, body: [] },
    );
    expect(await client.unreads()).toEqual([{ channelId: ulid(5), lastId: ulid(9), mentions: [] }]);
    expect(await client.settings(["notifications"])).toEqual({ notifications: [1, "{}"] });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ keys: ["notifications"] });
    expect(await client.unreads()).toEqual([]);
    expect(await client.settings(["x"])).toEqual({});
  });
});

describe("StoatRest uploads", () => {
  function file(size: number, name = "cat.png", type = "image/png"): FileSource & { reads: [number, number][] } {
    const reads: [number, number][] = [];
    return {
      filename: name,
      size,
      contentType: type,
      reads,
      read: async (start, end) => {
        reads.push([start, end]);
        return new Uint8Array(end - start).fill(7);
      },
    };
  }

  it("posts the file to Autumn as multipart form data", async () => {
    const { client, calls } = rest({ status: 200, body: { id: "file1" } });
    client.token = "tok";
    const source = file(3);
    expect(await client.upload(source)).toBe("file1");
    const { url, init } = calls[0]!;
    expect(url).toBe("https://cdn.stoat.test/attachments");
    const type = headersOf(init)["Content-Type"]!;
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(type)![1]!;
    expect(headersOf(init)["X-Session-Token"]).toBe("tok");
    const text = new TextDecoder().decode(init.body as Uint8Array);
    expect(text).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cat.png"\r\nContent-Type: image/png\r\n\r\n\x07\x07\x07\r\n--${boundary}--\r\n`,
    );
  });

  it("reads large files in pieces and cleans up names and types", async () => {
    const { client, calls } = rest({ status: 200, body: { id: "file2" } });
    const big = file(8 * 1024 * 1024 + 2, 'a"b\r\n.txt', "text/plain; charset=utf-8");
    await client.upload(big);
    expect(big.reads).toEqual([
      [0, 8 * 1024 * 1024],
      [8 * 1024 * 1024, 8 * 1024 * 1024 + 2],
    ]);
    const head = new TextDecoder().decode((calls[0]!.init.body as Uint8Array).subarray(0, 200));
    expect(head).toContain('filename="a_b__.txt"');
    expect(head).toContain("Content-Type: application/octet-stream");
  });

  it("refuses without a file server and checks the answer", async () => {
    const none = new StoatRest({ ...INSTANCE, autumn: undefined }, { fetch: fakeFetch().fetch, sleep: async () => {} });
    await expect(none.upload(file(1))).rejects.toThrow("This instance does not accept files.");
    const { client } = rest({ status: 200, body: { id: "../x" } }, { status: 200, body: "x" });
    await expect(client.upload(file(1))).rejects.toThrow("Unexpected upload response");
    await expect(client.upload(file(1))).rejects.toThrow("Unexpected upload response");
  });
});
