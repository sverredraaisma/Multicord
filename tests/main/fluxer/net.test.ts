import { describe, expect, it, vi } from "vitest";
import { discoverInstance } from "../../../src/main/fluxer/discovery";
import { FluxerApiError, FluxerRest } from "../../../src/main/fluxer/rest";

type Reply = { status: number; body?: unknown };

/** A fetch that answers with queued replies and records each request. */
function fakeFetch(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift() ?? { status: 500 };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => {
        if (reply.body === undefined) throw new Error("no body");
        return reply.body;
      },
    } as Response;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const OFFICIAL = {
  endpoints: {
    api: "https://web.fluxer.app/api",
    api_public: "https://api.fluxer.app/",
    gateway: "wss://gateway.fluxer.app",
    media: "https://fluxerusercontent.com",
  },
  features: { account_identity: "email" },
};

describe("discoverInstance", () => {
  it("uses the public API, gateway and media endpoints as published", async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: OFFICIAL });
    expect(await discoverInstance("https://fluxer.app", fetch)).toEqual({
      api: "https://api.fluxer.app/v1",
      gateway: "wss://gateway.fluxer.app",
      media: "https://fluxerusercontent.com",
      identity: "email",
      presignedUploads: true,
    });
    expect(calls[0]!.url).toBe("https://fluxer.app/.well-known/fluxer");
  });

  it("falls back to the api endpoint and reads username identity", async () => {
    const body = {
      endpoints: { ...OFFICIAL.endpoints, api_public: undefined },
      features: { account_identity: "username", presigned_attachment_uploads: false },
    };
    const { fetch } = fakeFetch({ status: 200, body });
    expect(await discoverInstance("https://self.example", fetch)).toMatchObject({
      api: "https://web.fluxer.app/api/v1",
      identity: "username",
      presignedUploads: false,
    });
  });

  it("rejects failed or incomplete discovery", async () => {
    await expect(discoverInstance("https://x.example", fakeFetch({ status: 404 }).fetch)).rejects.toThrow("HTTP 404");
    for (const body of [
      {},
      { endpoints: { ...OFFICIAL.endpoints, gateway: "https://not-a-socket" } },
      { endpoints: { ...OFFICIAL.endpoints, media: "http://insecure" } },
      { endpoints: { ...OFFICIAL.endpoints, api_public: "not a url", api: 5 } },
      [],
    ]) {
      await expect(discoverInstance("https://x.example", fakeFetch({ status: 200, body }).fetch)).rejects.toThrow("incomplete");
    }
  });
});

function rest(...replies: Reply[]) {
  const net = fakeFetch(...replies);
  const sleep = vi.fn(async (_ms: number) => {});
  const solveCaptcha = vi.fn(async () => ({ counter: 7, derivedKey: "00ab", time: 1 }));
  const client = new FluxerRest("https://api.example/v1", { fetch: net.fetch, sleep, solveCaptcha });
  return { client, sleep, solveCaptcha, ...net };
}

describe("FluxerRest", () => {
  it("sends the raw token, JSON bodies and throttles every request", async () => {
    const { client, calls, sleep } = rest({ status: 200, body: { ok: 1 } }, { status: 204 });
    client.token = "flx_secret";
    expect(await client.request("POST", "/x", { a: 1 })).toEqual({ ok: 1 });
    expect(await client.request("GET", "/y")).toBeUndefined();
    expect(calls[0]!.url).toBe("https://api.example/v1/x");
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      headers: { "X-Fluxer-Features": "channel_threads", Authorization: "flx_secret", "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    expect(calls[1]!.init.headers).toEqual({ "X-Fluxer-Features": "channel_threads", Authorization: "flx_secret" });
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("serialises requests even when one fails", async () => {
    const { client, calls } = rest({ status: 500 }, { status: 200, body: 2 });
    const first = client.request("GET", "/a");
    const second = client.request("GET", "/b");
    await expect(first).rejects.toThrow("Request failed (HTTP 500)");
    expect(await second).toBe(2);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["a", "b"]);
  });

  it("retries 429s after retry_after, then gives up", async () => {
    const limited = { status: 429, body: { code: "RATE_LIMITED", message: "Slow down", retry_after: 1.5 } };
    const ok = rest(limited, { status: 429, body: {} }, { status: 200, body: "done" });
    expect(await ok.client.request("GET", "/a")).toBe("done");
    expect(ok.sleep).toHaveBeenCalledWith(1500);
    expect(ok.sleep).toHaveBeenCalledWith(1000);

    const fail = rest(limited, limited, limited);
    const error = await fail.client.request("GET", "/a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FluxerApiError);
    expect(error).toMatchObject({ status: 429, code: "RATE_LIMITED", message: "Slow down" });
  });

  it("logs in with email or username and returns the token", async () => {
    const { client, calls } = rest(
      { status: 200, body: { token: "flx_1", user_id: "1", user: { id: "1", username: "ana" } } },
      { status: 200, body: { token: "flx_2" } },
    );
    expect(await client.login("email", "a@b.c", "pw")).toEqual({ token: "flx_1", user: { id: "1", username: "ana", globalName: undefined, avatar: undefined } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: "a@b.c", password: "pw" });
    expect(await client.login("username", "ana", "pw")).toEqual({ token: "flx_2", user: undefined });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ login: "ana", password: "pw" });
    expect(calls[0]!.init.headers).not.toHaveProperty("Authorization");
  });

  it("solves the captcha and retries with X-Captcha-Token", async () => {
    const challenge = { parameters: { algorithm: "PBKDF2/SHA-256" }, signature: "sig" };
    const required = { status: 400, body: { code: "CAPTCHA_REQUIRED", message: "Captcha", altcha_challenge: challenge } };
    const invalid = { status: 400, body: { code: "INVALID_CAPTCHA", message: "Bad", altcha_challenge: challenge } };
    const { client, calls, solveCaptcha } = rest(required, invalid, { status: 200, body: { token: "flx_ok" } });
    expect(await client.login("email", "a@b.c", "pw")).toMatchObject({ token: "flx_ok" });
    expect(solveCaptcha).toHaveBeenCalledTimes(2);
    const header = (calls[2]!.init.headers as Record<string, string>)["X-Captcha-Token"]!;
    expect(JSON.parse(Buffer.from(header, "base64").toString())).toEqual({
      challenge,
      solution: { counter: 7, derivedKey: "00ab", time: 1 },
    });

    const stubborn = rest(required, required, required);
    await expect(stubborn.client.login("email", "a", "b")).rejects.toMatchObject({ code: "CAPTCHA_REQUIRED" });
    expect(stubborn.solveCaptcha).toHaveBeenCalledTimes(2);
  });

  it("does not solve captchas for other errors", async () => {
    const wrong = rest({ status: 400, body: { code: "INVALID_CREDENTIALS", message: "Wrong password" } });
    await expect(wrong.client.login("email", "a", "b")).rejects.toThrow("Wrong password");
    const noChallenge = rest({ status: 400, body: { code: "CAPTCHA_REQUIRED", message: "Captcha" } });
    await expect(noChallenge.client.login("email", "a", "b")).rejects.toThrow("Captcha");
    expect(wrong.solveCaptcha).not.toHaveBeenCalled();
    expect(noChallenge.solveCaptcha).not.toHaveBeenCalled();
  });

  it("handles MFA tickets and TOTP", async () => {
    const { client, calls } = rest(
      { status: 200, body: { mfa: true, ticket: "t1", totp: true, webauthn: false } },
      { status: 200, body: { mfa: true, ticket: "t2", totp: false } },
      { status: 200, body: { token: "flx_mfa" } },
      { status: 200, body: { nothing: true } },
    );
    expect(await client.login("email", "a", "b")).toEqual({ mfa: true, ticket: "t1", totp: true });
    expect(await client.login("email", "a", "b")).toEqual({ mfa: true, ticket: "t2", totp: false });
    expect(await client.loginTotp("123456", "t1")).toEqual({ token: "flx_mfa", user: undefined });
    expect(calls[2]!.url).toBe("https://api.example/v1/auth/login/mfa/totp");
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ code: "123456", ticket: "t1" });
    await expect(client.loginTotp("1", "t")).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });

  it("wraps message, ack and logout endpoints", async () => {
    const author = { id: "1", username: "ana" };
    const { client, calls } = rest(
      { status: 200, body: [{ id: "3", channel_id: "9", author }, { bad: 1 }, { id: "2", channel_id: "9", author }] },
      { status: 200, body: { not: "a list" } },
      { status: 200, body: { id: "4", channel_id: "9", author, content: "hi" } },
      { status: 200, body: [] },
      { status: 204 },
    );
    expect((await client.messages("9")).map((m) => m.id)).toEqual(["2", "3"]);
    expect(calls[0]!.url).toBe("https://api.example/v1/channels/9/messages?limit=50");
    expect(await client.messages("9", "2")).toEqual([]);
    expect(calls[1]!.url).toBe("https://api.example/v1/channels/9/messages?limit=50&before=2");
    expect(await client.sendMessage("9", "hi", "n1")).toMatchObject({ id: "4", content: "hi" });
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ content: "hi", nonce: "n1" });
    await client.ack("9", "4");
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ read_states: [{ channel_id: "9", message_id: "4" }] });
    await client.logout();
    expect(calls[4]!.url).toBe("https://api.example/v1/auth/logout");
  });

  it("uses real timers by default", async () => {
    vi.useFakeTimers();
    const net = fakeFetch({ status: 200, body: 1 });
    const client = new FluxerRest("https://api.example/v1", { fetch: net.fetch, minIntervalMs: 5 });
    const pending = client.request("GET", "/a");
    await vi.advanceTimersByTimeAsync(5);
    expect(await pending).toBe(1);
    vi.useRealTimers();
  });
});
