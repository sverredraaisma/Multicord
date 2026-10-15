import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectConversation, IncomingCall, PlatformNotification } from "../../../src/shared/adapter";
import {
  MatrixError,
  type MatrixApi,
  type MxCryptoSync,
  type MxEncryptedEvent,
  type MxEncryption,
  type MxCallMember,
  type MxDownload,
  type MxEvent,
  type MxLiveKitGrant,
  type MxLiveKitTokenRequest,
  type MxRtcTransport,
  type MxOAuthSession,
  type MxOpenIdToken,
  type MxPage,
  type MxRoomUpdate,
  type MxSession,
  type MxSync,
} from "../../../src/modules/matrix/api";
import {
  ALGORITHM_NOTICE,
  CALL_JOIN_TIMEOUT_MS,
  ENCRYPTED_CALL_NOTICE,
  OTHER_SERVER_LABEL,
  RING_WINDOW_MS,
  TOKEN_CALL_NOTICE,
  AVATAR_LIMIT,
  ENCRYPTED_NOTICE,
  ENCRYPTED_TEXT,
  MatrixAdapter,
  type MatrixAdapterDeps,
  messageText,
  MAX_MEDIA_BYTES,
  MAX_REACTIONS,
  PAGE_SIZE,
  REQUEST_ENTRY,
  parseSession,
  SYNC_TIMEOUT_MS,
  TOKEN_NOTICE,
  TOO_LARGE,
  UNVERIFIED_LABEL,
} from "../../../src/modules/matrix/adapter";
import type { DeviceRef, E2ee, E2eeOptions, E2eeStatus, RecoveryResult, RoomEncryption, SecureToDevice } from "../../../src/modules/matrix/crypto";
import type { Verification, VerificationState } from "../../../src/modules/matrix/verification";
import { OAuthError, type DeviceGrant, type DevicePoll, type OAuthServer, type OAuthTokens } from "../../../src/modules/matrix/oauth";
import { parseEvent } from "../../../src/modules/matrix/events";
import { MAX_DIRECTS } from "../../../src/shared/engine";
import { encryptAttachment } from "./attachments";
import type { NativeAction, NativeViewState } from "../../../src/shared/native";

const ME = "@me:x.org";
const BO = "@bo:x.org";
const ANA = "@ana:x.org";
const BASE = "https://hs.x.org";
const SESSION: MxSession = { baseUrl: BASE, accessToken: "tok", userId: ME, deviceId: "D", ownDevice: true };
const SESSION_JSON = JSON.stringify(SESSION);
const OPENID: MxOpenIdToken = { access_token: "oid", token_type: "Bearer", matrix_server_name: "x.org", expires_in: 3600 };

const flush = async () => {
  for (let i = 0; i < 500; i++) await Promise.resolve();
};

const msg = (id: string, sender: string, text: string, ts: number, extra: Partial<Extract<MxEvent, { kind: "message" }>> = {}): MxEvent => ({
  kind: "message",
  id: `$${id}`,
  sender,
  ts,
  content: { msgtype: "m.text", text },
  ...extra,
});
const enc = (id: string, sender: string, ts: number): MxEvent => ({ kind: "encrypted", id: `$${id}`, sender, ts });
const room = (roomId: string, extra: Partial<MxRoomUpdate> = {}): MxRoomUpdate => ({ roomId, state: { members: {} }, timeline: [], limited: false, ...extra });
let batch = 0;
const sync = (extra: Partial<MxSync> = {}): MxSync => ({ nextBatch: `s${++batch}`, joined: [], left: [], ...extra });

/** A DM with Bo, a named room and an encrypted room. */
const initialSync = (): MxSync =>
  sync({
    directs: { [BO]: ["!dm:x.org"] },
    joined: [
      room("!dm:x.org", {
        state: { members: { [BO]: { name: "Bo", membership: "join", avatar: "mxc://x.org/bo" }, [ME]: { name: "Me", membership: "join" } } },
        timeline: [msg("d1", BO, "hello *there*", 1000), msg("d2", ME, "hi Bo", 2000)],
        prevBatch: "p-dm",
        unread: { notifications: 2, highlights: 0 },
      }),
      room("!lounge:x.org", {
        state: { name: "Lounge", members: { [ANA]: { name: "Ana", membership: "join" } } },
        timeline: [msg("l1", ANA, "welcome", 500)],
        prevBatch: "p-l",
        unread: { notifications: 1, highlights: 1 },
      }),
      room("!sec:x.org", {
        state: { name: "Secret", encrypted: true, members: {} },
        timeline: [enc("s1", ANA, 300), msg("s2", ME, "before encryption", 200)],
      }),
    ],
  });

class FakeMatrixApi implements MatrixApi {
  flows = { password: true };
  private readonly queue: (MxSync | Error)[] = [];
  private waiting: { resolve(s: MxSync): void; reject(e: Error): void } | undefined;

  discover = vi.fn(async (_url: string) => BASE);
  loginFlows = vi.fn(async (_base: string) => this.flows);
  login = vi.fn(async (_base: string, _user: string, _password: string): Promise<MxSession> => SESSION);
  whoami = vi.fn(async (_base: string, _token: string): Promise<{ userId: string; deviceId?: string }> => ({ userId: ME, deviceId: "D" }));
  sync = vi.fn((_session: MxSession, _since: string | undefined, _timeout: number): Promise<MxSync> => {
    const next = this.queue.shift();
    if (next) return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  });
  messages = vi.fn(async (_s: MxSession, _room: string, _from: string, _limit: number): Promise<MxPage> => ({ events: [], state: { members: {} } }));
  check = vi.fn(async (_s: MxSession) => {});
  encryption = vi.fn(async (_s: MxSession, _room: string): Promise<MxEncryption | undefined> => undefined);
  members = vi.fn(async (_s: MxSession, _room: string): Promise<string[]> => [ME, BO]);
  accountData = vi.fn(async (_s: MxSession, _type: string): Promise<Record<string, unknown> | undefined> => undefined);
  request = vi.fn(async (_s: MxSession, _method: string, _path: string, _body?: unknown, _query?: Record<string, string>): Promise<Record<string, unknown>> => ({}));
  send = vi.fn(async (_s: MxSession, _room: string, _content: Record<string, unknown>) => `$sent${this.send.mock.calls.length}`);
  redact = vi.fn(async (_s: MxSession, _room: string, _id: string) => {});
  markRead = vi.fn(async (_s: MxSession, _room: string, _id: string) => {});
  thumbnail = vi.fn(async (_s: MxSession, _mxc: string): Promise<string | undefined> => undefined);
  download = vi.fn(async (_s: MxSession, _mxc: string, _max: number): Promise<MxDownload | undefined> => undefined);
  logout = vi.fn(async (_s: MxSession) => {});
  rtcFoci = vi.fn(async (_url: string): Promise<string[]> => []);
  rtcTransports = vi.fn(async (_s: MxSession): Promise<MxRtcTransport[]> => []);
  supports = vi.fn(async (_s: MxSession, _feature: string) => false);
  openIdToken = vi.fn(async (_s: MxSession): Promise<MxOpenIdToken> => OPENID);
  sendState = vi.fn(async (_s: MxSession, _room: string, _type: string, _key: string, _content: Record<string, unknown>) => `$state${this.sendState.mock.calls.length}`);
  sendDelayedState = vi.fn(async (_s: MxSession, _room: string, _type: string, _key: string, _content: Record<string, unknown>, _delay: number) => "delay1");
  updateDelayed = vi.fn(async (_s: MxSession, _id: string, _action: "restart" | "send" | "cancel") => {});
  liveKitGrant = vi.fn(async (_url: string, _room: string, _device: string, _token: MxOpenIdToken): Promise<MxLiveKitGrant> => ({ url: "wss://sfu.call.x.org", jwt: "jwt1" }));
  sendSticky = vi.fn(async (_s: MxSession, _room: string, _type: string, _content: Record<string, unknown>, _sticky: number) => `$sticky${this.sendSticky.mock.calls.length}`);
  sendDelayedSticky = vi.fn(async (_s: MxSession, _room: string, _type: string, _content: Record<string, unknown>, _delay: number, _sticky: number) => "delay-s1");
  liveKitToken = vi.fn(async (_s: MxSession, request: MxLiveKitTokenRequest): Promise<MxLiveKitGrant> => ({ url: request.sfu, jwt: "jwt-hs" }));

  /** Answers the pending (or next) /sync. */
  push(next: MxSync | Error): void {
    const waiting = this.waiting;
    if (!waiting) return void this.queue.push(next);
    this.waiting = undefined;
    if (next instanceof Error) waiting.reject(next);
    else waiting.resolve(next);
  }
}

function setup(secretsInit: Record<string, string> = {}, realDelay = false, extra: Partial<MatrixAdapterDeps> = {}) {
  const api = new FakeMatrixApi();
  const secrets = new Map(Object.entries(secretsInit));
  const renders: NativeViewState[] = [];
  const directs: DirectConversation[][] = [];
  const notifications: PlatformNotification[] = [];
  const delay = vi.fn(async (_ms: number) => {});
  const adapter = new MatrixAdapter({
    def: { id: "matrix-native", name: "Matrix", url: "https://x.org" },
    secrets: {
      load: async (k) => secrets.get(k),
      save: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    render: (state) => renders.push(state),
    api,
    delay: realDelay ? undefined : delay,
    ...extra,
  });
  adapter.onDirectsChanged((d) => directs.push(d));
  adapter.onNotification((n) => notifications.push(n));
  const act = (action: NativeAction) => adapter.handleAction(action);
  const answer = (id: string, values: Record<string, string> = {}) => act({ type: "prompt", id, values });
  const last = () => renders.at(-1)!;
  const prompt = () => {
    const state = last();
    if (state.screen !== "prompt") throw new Error(`expected prompt, got ${state.screen}`);
    return state;
  };
  const chat = () => {
    const state = last();
    if (state.screen !== "chat") throw new Error(`expected chat, got ${state.screen}`);
    return state;
  };
  const item = (name: string) => chat().sidebar.find((i) => i.name === name)!;
  const open = async (name: string) => {
    await act({ type: "select", channelId: item(name).id });
    await flush();
  };
  const messages = () => chat().channel!.messages;
  const live = async (next: MxSync | Error) => {
    api.push(next);
    await flush();
  };
  return { adapter, api, secrets, renders, directs, notifications, delay, act, answer, last, prompt, chat, item, open, messages, live };
}

/** An adapter that resumed a stored session and finished its first sync. */
async function signedIn(first: MxSync = initialSync(), session = SESSION) {
  const ctx = setup({ session: JSON.stringify(session) });
  ctx.api.push(first);
  await ctx.adapter.start();
  await flush();
  return ctx;
}

afterEach(() => vi.useRealTimers());

describe("stored sessions", () => {
  it("parses only sessions we wrote", () => {
    expect(parseSession(SESSION_JSON)).toEqual(SESSION);
    expect(parseSession(undefined)).toBeUndefined();
    expect(parseSession("{nope")).toBeUndefined();
    expect(parseSession(JSON.stringify({ ...SESSION, baseUrl: "http://x" }))).toBeUndefined();
    expect(parseSession(JSON.stringify({ ...SESSION, baseUrl: 1 }))).toBeUndefined();
    expect(parseSession(JSON.stringify({ ...SESSION, accessToken: "" }))).toBeUndefined();
    expect(parseSession(JSON.stringify({ ...SESSION, accessToken: 1 }))).toBeUndefined();
    expect(parseSession(JSON.stringify({ ...SESSION, userId: "me" }))).toBeUndefined();
    expect(parseSession(JSON.stringify({ ...SESSION, deviceId: 1 }))).toBeUndefined();
    expect(parseSession(JSON.stringify({ ...SESSION, ownDevice: "yes" }))).toBeUndefined();
  });

  it("shows emotes and media labels in message text", () => {
    expect(messageText({ msgtype: "m.emote", text: "waves" })).toBe("* waves");
    expect(messageText({ msgtype: "m.image", text: "", media: "📷 Image" })).toBe("📷 Image");
    expect(messageText({ msgtype: "m.image", text: "look", media: "📷 Image" })).toBe("look\n📷 Image");
  });
});

describe("starting", () => {
  it("looks up the homeserver and asks for a password", async () => {
    const ctx = setup();
    await ctx.adapter.start();
    expect(ctx.renders[0]).toEqual({ screen: "connecting", platform: "Matrix", status: "Looking up x.org…" });
    expect(ctx.api.discover).toHaveBeenCalledWith("https://x.org");
    expect(ctx.api.loginFlows).toHaveBeenCalledWith(BASE);
    expect(ctx.prompt().prompt).toMatchObject({ id: "login", title: "Sign in to x.org", fields: [{ name: "user" }, { name: "password" }], cancel: "Use an access token instead" });
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("asks for an access token when the homeserver offers no password sign-in", async () => {
    const ctx = setup();
    ctx.api.flows = { password: false };
    await ctx.adapter.start();
    const { prompt } = ctx.prompt();
    expect(prompt).toMatchObject({ id: "token", fields: [{ name: "token", type: "password" }] });
    expect(prompt.description).toContain("x.org does not offer password sign-in");
    expect(prompt.description).toContain("Settings > Help & About");
    expect(prompt.cancel).toBeUndefined();
  });

  it("offers to try again when the homeserver cannot be reached", async () => {
    const ctx = setup();
    ctx.api.loginFlows.mockRejectedValueOnce(new Error("offline"));
    await ctx.adapter.start();
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "retry", fields: [], submit: "Try again" }, error: "Could not reach a Matrix homeserver at x.org: offline" });
    await ctx.answer("retry");
    expect(ctx.prompt().prompt.id).toBe("login");
    expect(ctx.prompt().error).toBeUndefined();
  });

  it("resumes a stored session and syncs", async () => {
    const ctx = setup({ session: SESSION_JSON });
    await ctx.adapter.start();
    expect(ctx.api.check).toHaveBeenCalledWith(SESSION);
    expect(ctx.renders.map((r) => r.screen === "connecting" && r.status)).toEqual(["Connecting to x.org…", "Loading your chats…"]);
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-in", name: ME });
    expect(ctx.api.sync).toHaveBeenCalledWith(SESSION, undefined, 0);
    await ctx.live(initialSync());
    expect(ctx.chat()).toMatchObject({ title: "x.org", me: ME, channel: null, voice: null });
    expect(ctx.api.sync).toHaveBeenLastCalledWith(SESSION, `s${batch}`, SYNC_TIMEOUT_MS);
  });

  it("signs in again when the stored session has ended", async () => {
    const ctx = setup({ session: SESSION_JSON });
    ctx.api.check.mockRejectedValueOnce(new MatrixError(401, "M_UNKNOWN_TOKEN", "gone"));
    await ctx.adapter.start();
    expect(ctx.secrets.has("session")).toBe(false);
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "login" }, error: "Your Matrix session has ended. Sign in again." });
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("keeps the stored session when the homeserver is unreachable, and retries", async () => {
    const ctx = setup({ session: SESSION_JSON });
    ctx.api.check.mockRejectedValueOnce("offline");
    await ctx.adapter.start();
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "retry" }, error: "Could not reach x.org: offline" });
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-in" });
    expect(ctx.secrets.has("session")).toBe(true);
    ctx.api.push(initialSync());
    await ctx.answer("retry");
    await flush();
    expect(ctx.chat().sidebar.length).toBeGreaterThan(0);
  });

  it("ignores a stored session it cannot read", async () => {
    const ctx = setup({ session: "garbage" });
    await ctx.adapter.start();
    expect(ctx.api.whoami).not.toHaveBeenCalled();
    expect(ctx.prompt().prompt.id).toBe("login");
  });
});

describe("signing in", () => {
  async function atLogin(passwordLogin = true) {
    const ctx = setup();
    ctx.api.flows = { password: passwordLogin };
    await ctx.adapter.start();
    return ctx;
  }

  it("signs in with a password and stores the session", async () => {
    const ctx = await atLogin();
    ctx.api.push(initialSync());
    await ctx.answer("login", { user: "  me ", password: "pw" });
    await flush();
    expect(ctx.api.login).toHaveBeenCalledWith(BASE, "me", "pw");
    expect(JSON.parse(ctx.secrets.get("session")!)).toEqual(SESSION);
    expect(ctx.chat().me).toBe(ME);
  });

  it("needs a username", async () => {
    const ctx = await atLogin();
    await ctx.answer("login", { password: "pw" });
    expect(ctx.prompt()).toMatchObject({ busy: false, error: "Enter your username, e.g. @alice:matrix.org or alice." });
    await ctx.answer("login", { user: "u".repeat(256), password: "pw" });
    expect(ctx.api.login).not.toHaveBeenCalled();
    await ctx.answer("login", { user: "me" });
    expect(ctx.api.login).toHaveBeenCalledWith(BASE, "me", "");
  });

  it.each([
    ["M_FORBIDDEN", "That username or password is not right."],
    ["M_LIMIT_EXCEEDED", "Too many attempts. Wait a while and try again."],
    ["M_USER_DEACTIVATED", "This account has been deactivated."],
    ["M_WEIRD", "server says no"],
  ])("explains %s", async (code, text) => {
    const ctx = await atLogin();
    ctx.api.login.mockRejectedValueOnce(new MatrixError(403, code, "server says no"));
    await ctx.answer("login", { user: "me", password: "bad" });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "login" }, busy: false, error: text });
    expect(ctx.secrets.has("session")).toBe(false);
  });

  it("shows busy while signing in and ignores answers meanwhile or for other steps", async () => {
    const ctx = await atLogin();
    let finish!: (s: MxSession) => void;
    ctx.api.login.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pending = ctx.answer("login", { user: "me", password: "pw" });
    expect(ctx.prompt().busy).toBe(true);
    await ctx.answer("login", { user: "me", password: "pw" });
    await ctx.answer("token", { token: "abc" });
    expect(ctx.api.login).toHaveBeenCalledTimes(1);
    expect(ctx.api.whoami).not.toHaveBeenCalled();
    finish(SESSION);
    await pending;
    expect(ctx.last()).toMatchObject({ screen: "connecting", status: "Loading your chats…" });
  });

  it("switches between password and access token", async () => {
    const ctx = await atLogin();
    await ctx.act({ type: "cancelPrompt", id: "login" });
    expect(ctx.prompt().prompt).toMatchObject({ id: "token", cancel: "Use a password instead" });
    expect(ctx.prompt().prompt.description).not.toContain("does not offer");
    await ctx.act({ type: "cancelPrompt", id: "token" });
    expect(ctx.prompt().prompt.id).toBe("login");
    const renders = ctx.renders.length;
    await ctx.act({ type: "cancelPrompt", id: "retry" });
    expect(ctx.renders).toHaveLength(renders);
  });

  it("stays on the token step when there is no password sign-in", async () => {
    const ctx = await atLogin(false);
    const renders = ctx.renders.length;
    await ctx.act({ type: "cancelPrompt", id: "token" });
    expect(ctx.renders).toHaveLength(renders);
  });

  it("signs in with an access token without taking over its device", async () => {
    const ctx = await atLogin(false);
    ctx.api.push(initialSync());
    await ctx.answer("token", { token: " syt_abc " });
    await flush();
    expect(ctx.api.whoami).toHaveBeenCalledWith(BASE, "syt_abc");
    expect(JSON.parse(ctx.secrets.get("session")!)).toEqual({ baseUrl: BASE, accessToken: "syt_abc", userId: ME, deviceId: "D", ownDevice: false });
    expect(ctx.chat().me).toBe(ME);
  });

  it("stores an empty device id when whoami names none", async () => {
    const ctx = await atLogin(false);
    ctx.api.whoami.mockResolvedValueOnce({ userId: ME });
    await ctx.answer("token", { token: "abc" });
    expect(JSON.parse(ctx.secrets.get("session")!).deviceId).toBe("");
  });

  it("rejects malformed and unknown tokens", async () => {
    const ctx = await atLogin(false);
    await ctx.answer("token", { token: "has space" });
    expect(ctx.prompt().error).toBe("That does not look like an access token.");
    await ctx.answer("token", {});
    expect(ctx.api.whoami).not.toHaveBeenCalled();
    ctx.api.whoami.mockRejectedValueOnce(new MatrixError(401, "M_UNKNOWN_TOKEN", "x"));
    await ctx.answer("token", { token: "abc" });
    expect(ctx.prompt().error).toBe("That access token is not valid (anymore).");
  });
});

describe("syncing", () => {
  it("retries a failing first sync with growing delays", async () => {
    const ctx = setup({ session: SESSION_JSON });
    for (let i = 0; i < 7; i++) ctx.api.push(new Error("offline"));
    await ctx.adapter.start();
    await flush();
    expect(ctx.last()).toEqual({ screen: "connecting", platform: "Matrix", status: "Could not reach x.org: offline. Retrying…" });
    expect(ctx.delay.mock.calls.map(([ms]) => ms)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    await ctx.live(initialSync());
    expect(ctx.chat().error).toBeUndefined();
  });

  it("waits between retries by default", async () => {
    vi.useFakeTimers();
    const ctx = setup({ session: SESSION_JSON }, true);
    ctx.api.push(new Error("offline"));
    await ctx.adapter.start();
    await flush();
    expect(ctx.api.sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(ctx.api.sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.api.sync).toHaveBeenCalledTimes(2);
  });

  it("shows a lost connection in the chat and clears it once back", async () => {
    const ctx = await signedIn();
    await ctx.live(new Error("offline"));
    expect(ctx.chat().error).toBe("Connection lost. Reconnecting…");
    await ctx.live(sync());
    expect(ctx.chat().error).toBeUndefined();
    expect(ctx.delay).toHaveBeenCalledWith(2000);
  });

  it("keeps other errors when the connection comes back", async () => {
    const ctx = await signedIn();
    ctx.api.encryption.mockRejectedValueOnce(new Error("nope"));
    await ctx.open("Bo");
    await ctx.act({ type: "send", content: "x" });
    await ctx.live(sync());
    expect(ctx.chat().error).toBe("Message not sent: nope");
  });

  it("signs out when the server ends the session", async () => {
    const ctx = await signedIn();
    await ctx.live(new MatrixError(401, "M_UNKNOWN_TOKEN", "logged out"));
    expect(ctx.secrets.has("session")).toBe(false);
    expect(ctx.directs.at(-1)).toEqual([]);
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "login" }, error: "Your Matrix session has ended. Sign in again." });
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("drops syncs that finish after signing out", async () => {
    const ctx = await signedIn();
    await ctx.adapter.signOut();
    const renders = ctx.renders.length;
    await ctx.live(sync({ joined: [room("!new:x.org")] }));
    expect(ctx.renders).toHaveLength(renders);
    expect(ctx.api.sync).toHaveBeenCalledTimes(2);
  });

  it("drops sync failures after signing out", async () => {
    const ctx = await signedIn();
    await ctx.adapter.signOut();
    await ctx.live(new Error("late"));
    expect(ctx.delay).not.toHaveBeenCalled();
    expect(ctx.prompt().error).toBeUndefined();
  });

  it("removes rooms the user left", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    await ctx.live(sync({ left: ["!lounge:x.org", "!unknown:x.org"] }));
    expect(ctx.chat().sidebar.map((i) => i.name)).not.toContain("Lounge");
    expect(ctx.chat().channel).toBeNull();
  });

  it("starts over after a gap in the timeline", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    await ctx.live(sync({ joined: [room("!lounge:x.org", { limited: true, prevBatch: "p-new", timeline: [msg("l9", ANA, "later", 9000)] })] }));
    expect(ctx.messages().map((m) => m.content)).toEqual(["later"]);
    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.messages).toHaveBeenCalledWith(SESSION, "!lounge:x.org", "p-new", PAGE_SIZE);
  });
});

describe("listing", () => {
  it("lists DMs from m.direct, newest first, with previews and unread counts", async () => {
    const ctx = await signedIn();
    expect(ctx.directs.at(-1)).toEqual([
      {
        key: "!dm:x.org",
        account: { platform: "matrix-native", instance: "x.org", accountId: "default" },
        title: "Bo",
        lastActivity: 2000,
        unread: true,
        mentions: 2,
        preview: "hi Bo",
      },
    ]);
    expect(await ctx.adapter.listDirectConversations()).toEqual(ctx.directs.at(-1));
  });

  it("shows DMs and other rooms in the sidebar", async () => {
    const ctx = await signedIn();
    expect(ctx.chat().sidebar).toEqual([
      { id: "dms", name: "Direct messages", kind: "category", unread: false, mentions: 0, active: false },
      { id: expect.stringMatching(/^\d+$/), name: "Bo", kind: "dm", unread: true, mentions: 2, active: false },
      { id: "rooms", name: "Rooms", kind: "category", unread: false, mentions: 0, active: false },
      { id: expect.stringMatching(/^\d+$/), name: "Lounge", kind: "text", unread: true, mentions: 1, active: false },
      { id: expect.stringMatching(/^\d+$/), name: "Secret", kind: "text", unread: false, mentions: 0, active: false },
    ]);
  });

  it("leaves out empty groups", async () => {
    const ctx = await signedIn(sync({ joined: [room("!only:x.org", { state: { name: "Only", members: {} } })] }));
    expect(ctx.chat().sidebar.map((i) => i.id)).toEqual(["rooms", expect.any(String)]);
    await ctx.live(sync({ directs: { [BO]: ["!only:x.org"] } }));
    expect(ctx.chat().sidebar.map((i) => i.id)).toEqual(["dms", expect.any(String)]);
  });

  it("counts other rooms in the home badge", async () => {
    const ctx = await signedIn();
    expect(ctx.adapter.homeBadge()).toEqual({ unread: true, mentions: 1 });
    await ctx.live(sync({ joined: [room("!lounge:x.org", { unread: { notifications: 0, highlights: 0 } })] }));
    expect(ctx.adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
  });

  it("names rooms as Matrix does", async () => {
    const ctx = await signedIn(
      sync({
        directs: { [BO]: ["!dmnamed:x.org", "!dmbare:x.org"] },
        joined: [
          room("!dmnamed:x.org", { state: { name: "Our chat", members: { [BO]: { name: "Bo", membership: "join" } } } }),
          room("!dmbare:x.org", { state: { name: "", members: {} } }),
          room("!alias:x.org", { state: { alias: "#a:x.org", members: {} } }),
          room("!heroes:x.org", { heroes: [ME, ANA, BO], state: { members: { [ANA]: { name: "Ana", membership: "join" } } } }),
          room("!empty:x.org"),
          room("!bidi:x.org", { state: { name: "‮", members: {} } }),
          room("!bidi2:x.org", { heroes: ["@‮:x"] }),
        ],
      }),
    );
    const names = ctx.chat().sidebar.filter((i) => i.kind !== "category").map((i) => i.name);
    expect(names).toEqual(["Our chat", BO, "#a:x.org", `Ana, ${BO}`, "Empty room", "Empty room", "@:x"]);
  });

  it("caps the DM list", async () => {
    const ids = Array.from({ length: MAX_DIRECTS + 5 }, (_, i) => `!d${i}:x.org`);
    const ctx = await signedIn(sync({ directs: { [BO]: ids }, joined: ids.map((id) => room(id)) }));
    expect(ctx.directs.at(-1)).toHaveLength(MAX_DIRECTS);
  });
});

describe("avatars", () => {
  it("fetches DM pictures once, from the room or the other person", async () => {
    const first = initialSync();
    first.joined.push(room("!dm2:x.org", { state: { avatar: "mxc://x.org/room", members: {} } }), room("!dm3:x.org"));
    first.directs = { [BO]: ["!dm:x.org"], [ANA]: ["!dm2:x.org", "!dm3:x.org"] };
    const ctx = setup({ session: SESSION_JSON });
    ctx.api.thumbnail.mockImplementation(async (_s, mxc) => (mxc === "mxc://x.org/bo" ? "data:image/png;base64,AA==" : undefined));
    ctx.api.push(first);
    await ctx.adapter.start();
    await flush();
    expect(ctx.api.thumbnail.mock.calls.map(([, mxc]) => mxc)).toEqual(["mxc://x.org/bo", "mxc://x.org/room"]);
    expect(ctx.directs.at(-1)!.find((d) => d.key === "!dm:x.org")!.avatarUrl).toBe("data:image/png;base64,AA==");
    expect(ctx.item("Bo").iconUrl).toBe("data:image/png;base64,AA==");
    await ctx.live(sync());
    expect(ctx.api.thumbnail).toHaveBeenCalledTimes(2);
  });

  it("fetches at most AVATAR_LIMIT pictures, one batch at a time", async () => {
    const ids = Array.from({ length: AVATAR_LIMIT + 5 }, (_, i) => `!d${i}:x.org`);
    const ctx = setup({ session: SESSION_JSON });
    const pending: (() => void)[] = [];
    ctx.api.thumbnail.mockImplementation(() => new Promise((resolve) => pending.push(() => resolve(undefined))));
    ctx.api.push(sync({ directs: { [BO]: ids }, joined: ids.map((id, i) => room(id, { state: { avatar: `mxc://x.org/a${i}`, members: {} } })) }));
    await ctx.adapter.start();
    await flush();
    await ctx.live(sync());
    expect(ctx.api.thumbnail).toHaveBeenCalledTimes(1);
    while (pending.length) {
      pending.shift()!();
      await flush();
    }
    expect(ctx.api.thumbnail).toHaveBeenCalledTimes(AVATAR_LIMIT);
  });

  it("forgets pictures when signing out mid-way", async () => {
    const ctx = setup({ session: SESSION_JSON });
    let finish!: (url: string) => void;
    ctx.api.thumbnail.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.signOut();
    finish("data:image/png;base64,AA==");
    await flush();
    await ctx.answer("login", { user: "me", password: "pw" });
    // The first push answers the old session's pending sync, which is dropped.
    await ctx.live(sync());
    await ctx.live(initialSync());
    expect(ctx.directs.at(-1)![0]!.avatarUrl).toBeUndefined();
  });

  it("survives failing thumbnails", async () => {
    const ctx = setup({ session: SESSION_JSON });
    ctx.api.thumbnail.mockRejectedValue(new Error("x"));
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    expect(ctx.directs.at(-1)![0]!.avatarUrl).toBeUndefined();
  });
});

describe("conversations", () => {
  it("opens a room with its messages", async () => {
    const ctx = await signedIn();
    await ctx.open("Bo");
    const { channel } = ctx.chat();
    expect(channel).toMatchObject({ id: ctx.item("Bo").id, name: "Bo", loading: false, hasOlder: true, typing: [], pending: [], uploading: false });
    expect(channel).not.toHaveProperty("locked");
    expect(ctx.item("Bo").active).toBe(true);
    expect(ctx.messages()).toEqual([
      {
        id: expect.stringMatching(/^\d+$/),
        author: "Bo",
        content: "hello \\*there\\*",
        timestamp: new Date(1000).toISOString(),
        edited: false,
        mine: false,
        canEdit: false,
        canDelete: false,
        reactions: [],
        attachments: [],
      },
      expect.objectContaining({ author: "Me", content: "hi Bo", mine: true, canEdit: true, canDelete: true, source: "hi Bo" }),
    ]);
  });

  it("opens rooms from the shell by room id", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("!lounge:x.org");
    expect(ctx.chat().channel!.name).toBe("Lounge");
    await ctx.adapter.openConversation("!unknown:x.org");
    expect(ctx.chat().channel!.name).toBe("Lounge");
    await ctx.act({ type: "select", channelId: "99999" });
    expect(ctx.chat().channel!.name).toBe("Lounge");
  });

  it("loads history for a room without events, and older pages on request", async () => {
    const ctx = await signedIn(sync({ joined: [room("!r:x.org", { state: { name: "R", members: {} }, prevBatch: "p1" })] }));
    ctx.api.messages.mockResolvedValueOnce({ events: [msg("b", ANA, "b", 20)], state: { members: { [ANA]: { name: "Ana", membership: "join" } } }, end: "p2" });
    await ctx.open("R");
    expect(ctx.api.messages).toHaveBeenCalledWith(SESSION, "!r:x.org", "p1", PAGE_SIZE);
    expect(ctx.messages().map((m) => [m.author, m.content])).toEqual([["Ana", "b"]]);
    expect(ctx.chat().channel!.hasOlder).toBe(true);
    ctx.api.messages.mockResolvedValueOnce({ events: [msg("a", ANA, "a", 10), msg("b", ANA, "b", 20)], state: { members: {} } });
    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.messages).toHaveBeenLastCalledWith(SESSION, "!r:x.org", "p2", PAGE_SIZE);
    expect(ctx.messages().map((m) => m.content)).toEqual(["a", "b"]);
    expect(ctx.chat().channel!.hasOlder).toBe(false);
    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.messages).toHaveBeenCalledTimes(2);
  });

  it("applies edits and redactions found in older pages", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    ctx.api.messages.mockResolvedValueOnce({
      events: [
        msg("old1", ANA, "first", 10),
        msg("old2", ANA, "second", 20),
        msg("e1", ANA, "first, fixed", 30, { replaces: "$old1" }),
        { kind: "redaction", id: "$r", sender: ANA, ts: 40, redacts: "$old2" },
        { kind: "redacted", id: "$gone", sender: ANA, ts: 45 },
        enc("x", ANA, 50),
      ],
      state: { members: {} },
      end: "older",
    });
    await ctx.act({ type: "loadOlder" });
    expect(ctx.messages().map((m) => [m.content, m.edited])).toEqual([
      ["first, fixed", true],
      [ENCRYPTED_TEXT, false],
      ["welcome", false],
    ]);
  });

  it("shows loading while a page comes and loads it once", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    let finish!: (page: MxPage) => void;
    ctx.api.messages.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pending = ctx.act({ type: "loadOlder" });
    expect(ctx.chat().channel!.loading).toBe(true);
    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.messages).toHaveBeenCalledTimes(1);
    finish({ events: [], state: { members: {} } });
    await pending;
    expect(ctx.chat().channel!.loading).toBe(false);
  });

  it("reports history that fails to load", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    ctx.api.messages.mockRejectedValueOnce(new MatrixError(403, "M_FORBIDDEN", "no"));
    await ctx.act({ type: "loadOlder" });
    expect(ctx.chat().error).toBe("Could not load messages: no");
    expect(ctx.chat().channel!.hasOlder).toBe(true);
  });

  it("drops a page that arrives after signing out", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    let finish!: (page: MxPage) => void;
    ctx.api.messages.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pending = ctx.act({ type: "loadOlder" });
    await ctx.adapter.signOut();
    const renders = ctx.renders.length;
    finish({ events: [msg("late", ANA, "late", 1)], state: { members: {} } });
    await pending;
    expect(ctx.renders).toHaveLength(renders);
  });

  it("does nothing on loadOlder without an open room", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.messages).not.toHaveBeenCalled();
  });

  it("shows edits by the sender only, latest first", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    await ctx.live(
      sync({
        joined: [
          room("!lounge:x.org", {
            timeline: [
              msg("e2", ANA, "welcome!!", 700, { replaces: "$l1" }),
              msg("e1", ANA, "welcome!", 600, { replaces: "$l1" }),
              msg("evil", BO, "hacked", 800, { replaces: "$l1" }),
            ],
          }),
        ],
      }),
    );
    expect(ctx.messages()).toEqual([expect.objectContaining({ content: "welcome!!", edited: true })]);
    await ctx.live(sync({ joined: [room("!lounge:x.org", { timeline: [{ kind: "redaction", id: "$r", sender: ANA, ts: 900, redacts: "$e2" }] })] }));
    expect(ctx.messages()[0]!.content).toBe("welcome");
    await ctx.live(sync({ joined: [room("!lounge:x.org", { timeline: [{ kind: "redaction", id: "$r2", sender: ANA, ts: 950, redacts: "$l1" }] })] }));
    expect(ctx.messages()).toEqual([]);
  });

  it("removes redacted messages", async () => {
    const ctx = await signedIn();
    await ctx.open("Bo");
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [{ kind: "redaction", id: "$r", sender: BO, ts: 3000, redacts: "$d1" }] })] }));
    expect(ctx.messages().map((m) => m.content)).toEqual(["hi Bo"]);
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [{ kind: "redacted", id: "$d2", sender: ME, ts: 2000 }] })] }));
    expect(ctx.messages()).toEqual([]);
    expect(ctx.directs.at(-1)![0]).not.toHaveProperty("preview");
  });

  it("shows replies with the original, when it is loaded", async () => {
    const ctx = await signedIn();
    await ctx.open("Bo");
    await ctx.live(
      sync({ joined: [room("!dm:x.org", { timeline: [msg("d3", BO, "yes *really*", 3000, { replyTo: "$d2" }), msg("d4", BO, "?", 3100, { replyTo: "$unknown" })] })] }),
    );
    const [, , reply, orphan] = ctx.messages();
    expect(reply!.reply).toEqual({ author: "Me", content: "hi Bo" });
    expect(orphan).not.toHaveProperty("reply");
  });

  it("marks encrypted messages and locks encrypted rooms", async () => {
    const ctx = await signedIn();
    await ctx.open("Secret");
    expect(ctx.chat().channel!.locked).toBe(ENCRYPTED_NOTICE);
    expect(ctx.messages()).toEqual([
      expect.objectContaining({ content: ENCRYPTED_TEXT.replace("—", "—"), author: ANA, canEdit: false, canDelete: false }),
      expect.objectContaining({ content: "before encryption", mine: true, canEdit: false, canDelete: true }),
    ]);
  });

  it("previews encrypted DMs briefly", async () => {
    const ctx = await signedIn();
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [enc("d9", BO, 5000)] })] }));
    expect(ctx.directs.at(-1)![0]!.preview).toBe("🔒 Encrypted message");
  });

  it("lets only text messages be edited", async () => {
    const ctx = await signedIn();
    await ctx.live(
      sync({ joined: [room("!dm:x.org", { timeline: [msg("img", ME, "", 3000, { content: { msgtype: "m.image", text: "", media: "📷 Image" } })] })] }),
    );
    await ctx.open("Bo");
    expect(ctx.messages().at(-1)).toMatchObject({ content: "📷 Image", canEdit: false, canDelete: true });
    await ctx.act({ type: "edit", messageId: ctx.messages().at(-1)!.id, content: "caption" });
    expect(ctx.api.send).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("sends text after checking the room is not encrypted", async () => {
    const ctx = await signedIn();
    await ctx.open("Bo");
    await ctx.act({ type: "send", content: "hey *you*" });
    expect(ctx.api.encryption).toHaveBeenCalledWith(SESSION, "!dm:x.org");
    expect(ctx.api.send).toHaveBeenCalledWith(SESSION, "!dm:x.org", { msgtype: "m.text", body: "hey *you*", "m.mentions": {} });
    expect(ctx.messages().at(-1)).toMatchObject({ content: "hey \\*you\\*", mine: true, canEdit: true });
    expect(ctx.directs.at(-1)![0]!.preview).toBe("hey *you*");
    // The sync echo of the same event is not shown twice.
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [msg("sent1", ME, "hey *you*", 9000)] })] }));
    expect(ctx.messages()).toHaveLength(3);
  });

  it("sends replies", async () => {
    const ctx = await signedIn();
    await ctx.open("Bo");
    const target = ctx.messages()[0]!.id;
    await ctx.act({ type: "send", content: "re", replyTo: target });
    expect(ctx.api.send.mock.calls[0]![2]).toEqual({ msgtype: "m.text", body: "re", "m.mentions": {}, "m.relates_to": { "m.in_reply_to": { event_id: "$d1" } } });
    expect(ctx.messages().at(-1)!.reply).toEqual({ author: "Bo", content: "hello *there*" });
    await ctx.act({ type: "send", content: "re2", replyTo: "99999" });
    expect(ctx.api.send.mock.calls[1]![2]).not.toHaveProperty("m.relates_to");
  });

  it("never sends into a room known to be encrypted", async () => {
    const ctx = await signedIn();
    await ctx.open("Secret");
    await ctx.act({ type: "send", content: "plaintext" });
    expect(ctx.api.encryption).not.toHaveBeenCalled();
    expect(ctx.api.send).not.toHaveBeenCalled();
    expect(ctx.chat().error).toBe("Message not sent: this room is end-to-end encrypted, which Multicord does not support");
  });

  it("never sends when the server says the room is encrypted", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    ctx.api.encryption.mockResolvedValueOnce({ algorithm: "m.megolm.v1.aes-sha2" });
    await ctx.act({ type: "send", content: "plaintext" });
    expect(ctx.api.send).not.toHaveBeenCalled();
    expect(ctx.chat().channel!.locked).toBe(ENCRYPTED_NOTICE);
    await ctx.act({ type: "send", content: "again" });
    expect(ctx.api.encryption).toHaveBeenCalledTimes(1);
    expect(ctx.api.send).not.toHaveBeenCalled();
  });

  it("locks a room that turns encrypted", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    await ctx.live(sync({ joined: [room("!lounge:x.org", { state: { encrypted: true, members: {} } })] }));
    expect(ctx.chat().channel!.locked).toBe(ENCRYPTED_NOTICE);
    expect(ctx.messages()[0]!.canEdit).toBe(false);
  });

  it("reports failed sends", async () => {
    const ctx = await signedIn();
    await ctx.open("Bo");
    ctx.api.send.mockRejectedValueOnce(new Error("too big"));
    await ctx.act({ type: "send", content: "x" });
    expect(ctx.chat().error).toBe("Message not sent: too big");
  });

  it("ignores sends without an open room or text", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "send", content: "x" });
    await ctx.open("Bo");
    await ctx.act({ type: "send", content: "   " });
    expect(ctx.api.send).not.toHaveBeenCalled();
  });

  it("edits own text messages", async () => {
    const ctx = await signedIn();
    await ctx.open("Bo");
    const mine = ctx.messages()[1]!.id;
    await ctx.act({ type: "edit", messageId: mine, content: "hi Bo!" });
    expect(ctx.api.send).toHaveBeenCalledWith(SESSION, "!dm:x.org", {
      msgtype: "m.text",
      body: "* hi Bo!",
      "m.new_content": { msgtype: "m.text", body: "hi Bo!", "m.mentions": {} },
      "m.relates_to": { rel_type: "m.replace", event_id: "$d2" },
      "m.mentions": {},
    });
    expect(ctx.messages()[1]).toMatchObject({ content: "hi Bo!", edited: true, source: "hi Bo!" });
  });

  it("keeps an emote an emote when editing", async () => {
    const ctx = await signedIn();
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [msg("em", ME, "waves", 3000, { content: { msgtype: "m.emote", text: "waves" } })] })] }));
    await ctx.open("Bo");
    expect(ctx.messages().at(-1)!.content).toBe("\\* waves");
    await ctx.act({ type: "edit", messageId: ctx.messages().at(-1)!.id, content: "bows" });
    expect(ctx.api.send.mock.calls[0]![2]).toMatchObject({ msgtype: "m.emote", "m.new_content": { msgtype: "m.emote", body: "bows" } });
  });

  it("does not edit others' messages, unknown ones, or in encrypted rooms", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "edit", messageId: "1", content: "x" });
    await ctx.open("Bo");
    await ctx.act({ type: "edit", messageId: ctx.messages()[0]!.id, content: "x" });
    await ctx.act({ type: "edit", messageId: "99999", content: "x" });
    await ctx.open("Secret");
    await ctx.act({ type: "edit", messageId: ctx.messages()[0]!.id, content: "x" });
    await ctx.act({ type: "edit", messageId: ctx.messages()[1]!.id, content: "x" });
    expect(ctx.api.send).not.toHaveBeenCalled();
    expect(ctx.chat().error).toBe("Message not edited: this room is end-to-end encrypted, which Multicord does not support");
  });

  it("deletes own messages, also in encrypted rooms", async () => {
    const ctx = await signedIn();
    await ctx.open("Secret");
    await ctx.act({ type: "delete", messageId: ctx.messages()[1]!.id });
    expect(ctx.api.redact).toHaveBeenCalledWith(SESSION, "!sec:x.org", "$s2");
    expect(ctx.messages()).toHaveLength(1);
    await ctx.act({ type: "delete", messageId: ctx.messages()[0]!.id });
    await ctx.act({ type: "delete", messageId: "99999" });
    expect(ctx.api.redact).toHaveBeenCalledTimes(1);
  });

  it("reports failed deletes and ignores them without a room", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "delete", messageId: "1" });
    await ctx.open("Bo");
    ctx.api.redact.mockRejectedValueOnce(new Error("forbidden"));
    await ctx.act({ type: "delete", messageId: ctx.messages()[1]!.id });
    expect(ctx.chat().error).toBe("Message not deleted: forbidden");
    expect(ctx.messages()).toHaveLength(2);
  });
});

const reaction = (id: string, sender: string, target: string, key: string, ts = 5000): MxEvent => ({ kind: "reaction", id: `$${id}`, sender, ts, target, key });

describe("reactions", () => {
  it("shows reactions per key, each person once, without notifying or counting as activity", async () => {
    const ctx = await signedIn();
    const notified = ctx.notifications.length;
    const timeline = [reaction("r1", BO, "$d1", "👍"), reaction("r2", ANA, "$d1", "👍"), reaction("r3", ME, "$d1", "🎉"), reaction("r4", BO, "$d1", "👍"), reaction("r5", BO, "$elsewhere", "👍")];
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline })] }));
    await ctx.open("Bo");
    expect(ctx.messages()[0]!.reactions).toEqual([
      { key: "👍", label: "👍", count: 2, me: false },
      { key: "🎉", label: "🎉", count: 1, me: true },
    ]);
    expect(ctx.messages()[1]!.reactions).toEqual([]);
    expect(ctx.notifications).toHaveLength(notified);
    expect(ctx.directs.at(-1)![0]!.lastActivity).toBe(2000);
  });

  it("takes back reactions that are redacted", async () => {
    const ctx = await signedIn();
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [reaction("r1", BO, "$d1", "👍"), reaction("r2", ANA, "$d1", "😀")] })] }));
    await ctx.open("Bo");
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [{ kind: "redaction", id: "$x", sender: BO, ts: 6000, redacts: "$r1" }, { kind: "redacted", id: "$r2", sender: ANA, ts: 5000 }] })] }));
    expect(ctx.messages()[0]!.reactions).toEqual([]);
  });

  it("adds and takes back its own reaction, unencrypted and once", async () => {
    const ctx = await signedIn();
    await ctx.open("Bo");
    const target = ctx.messages()[0]!.id;
    await ctx.act({ type: "react", messageId: target, emoji: "❤️", add: true });
    expect(ctx.api.send).toHaveBeenCalledWith(SESSION, "!dm:x.org", { "m.relates_to": { rel_type: "m.annotation", event_id: "$d1", key: "❤️" } }, "m.reaction");
    expect(ctx.api.encryption).not.toHaveBeenCalled();
    expect(ctx.messages()[0]!.reactions).toEqual([{ key: "❤️", label: "❤️", count: 1, me: true }]);
    // Its sync echo is the same reaction; adding it again sends nothing.
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [reaction("sent1", ME, "$d1", "❤️")] })] }));
    await ctx.act({ type: "react", messageId: target, emoji: "❤️", add: true });
    expect(ctx.api.send).toHaveBeenCalledTimes(1);
    expect(ctx.messages()[0]!.reactions).toEqual([{ key: "❤️", label: "❤️", count: 1, me: true }]);
    await ctx.act({ type: "react", messageId: target, emoji: "❤️", add: false });
    expect(ctx.api.redact).toHaveBeenCalledWith(SESSION, "!dm:x.org", "$sent1");
    expect(ctx.messages()[0]!.reactions).toEqual([]);
    await ctx.act({ type: "react", messageId: target, emoji: "❤️", add: false });
    expect(ctx.api.redact).toHaveBeenCalledTimes(1);
  });

  it("takes back a reaction made on another device, leaving others' alone", async () => {
    const ctx = await signedIn();
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [reaction("bo", BO, "$d1", "👍"), reaction("mine", ME, "$d1", "👍"), reaction("other", ME, "$d2", "👍")] })] }));
    await ctx.open("Bo");
    await ctx.act({ type: "react", messageId: ctx.messages()[0]!.id, emoji: "👍", add: false });
    expect(ctx.api.redact).toHaveBeenCalledWith(SESSION, "!dm:x.org", "$mine");
    expect(ctx.messages()[0]!.reactions).toEqual([{ key: "👍", label: "👍", count: 1, me: false }]);
    expect(ctx.messages()[1]!.reactions).toEqual([{ key: "👍", label: "👍", count: 1, me: true }]);
  });

  it("reports reactions that fail, keeping what was there", async () => {
    const ctx = await signedIn();
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [reaction("mine", ME, "$d1", "👍")] })] }));
    await ctx.open("Bo");
    const target = ctx.messages()[0]!.id;
    ctx.api.send.mockRejectedValueOnce(new Error("slow down"));
    await ctx.act({ type: "react", messageId: target, emoji: "🎉", add: true });
    expect(ctx.chat().error).toBe("Reaction not sent: slow down");
    ctx.api.redact.mockRejectedValueOnce(new Error("forbidden"));
    await ctx.act({ type: "react", messageId: target, emoji: "👍", add: false });
    expect(ctx.chat().error).toBe("Reaction not removed: forbidden");
    expect(ctx.messages()[0]!.reactions).toEqual([{ key: "👍", label: "👍", count: 1, me: true }]);
  });

  it("reacts nowhere without an open room, a readable message, a usable key or encryption it can take part in", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "react", messageId: "1", emoji: "👍", add: true });
    await ctx.open("Bo");
    await ctx.act({ type: "react", messageId: "99999", emoji: "👍", add: true });
    await ctx.act({ type: "react", messageId: ctx.messages()[0]!.id, emoji: " 👍", add: true });
    await ctx.open("Secret");
    // An encrypted placeholder, and a readable message in a room without encryption here.
    await ctx.act({ type: "react", messageId: ctx.messages()[0]!.id, emoji: "👍", add: true });
    await ctx.act({ type: "react", messageId: ctx.messages()[1]!.id, emoji: "👍", add: true });
    expect(ctx.api.send).not.toHaveBeenCalled();
  });

  it("reacts unencrypted in an encrypted room it can encrypt in, as Element does", async () => {
    const ctx = await withCrypto();
    await ctx.open("Bo");
    await ctx.act({ type: "react", messageId: ctx.messages()[0]!.id, emoji: "👍", add: true });
    expect(ctx.api.send).toHaveBeenCalledWith(SESSION, "!dm:x.org", { "m.relates_to": { rel_type: "m.annotation", event_id: "$c1", key: "👍" } }, "m.reaction");
    expect(ctx.e2ee.encrypt).not.toHaveBeenCalled();
  });

  it("hides encrypted reactions it cannot read, and shows those it can once their keys arrive", async () => {
    const ctx = await withCrypto();
    ctx.e2ee.clear.set("$c3", reaction("c3", BO, "$c1", "🔥"));
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [encRaw("c3", BO, 5000, { sessionId: "S2" }), encRaw("hidden", BO, 5001, { annotates: "$c1" })] })] }));
    await ctx.open("Bo");
    expect(ctx.messages().map((m) => m.id)).toHaveLength(2);
    expect(ctx.messages()[0]!.reactions).toEqual([{ key: "🔥", label: "🔥", count: 1, me: false }]);
    // One that decrypts only later takes its placeholder's place as a reaction.
    ctx.e2ee.clear.set("$c2", reaction("c2", BO, "$c1", "👀"));
    ctx.e2ee.keys(["S1"]);
    await flush();
    expect(ctx.messages()).toHaveLength(1);
    expect(ctx.messages()[0]!.reactions.map((r) => r.key)).toEqual(["🔥", "👀"]);
  });

  it("applies reactions from older pages, and forgets them after a gap", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    ctx.api.messages.mockResolvedValueOnce({
      events: [msg("old", ANA, "old", 10), reaction("ra", ANA, "$old", "👍", 11), reaction("rb", BO, "$l1", "👋", 12), reaction("rc", BO, "$old", "😢", 13), { kind: "redaction", id: "$x", sender: BO, ts: 14, redacts: "$rc" }, encRaw("hidden", BO, 15, { annotates: "$old" })],
      state: { members: {} },
      end: "older",
    });
    await ctx.act({ type: "loadOlder" });
    expect(ctx.messages().map((m) => [m.content, m.reactions.map((r) => r.key)])).toEqual([
      ["old", ["👍"]],
      ["welcome", ["👋"]],
    ]);
    await ctx.live(sync({ joined: [room("!lounge:x.org", { limited: true, prevBatch: "p-new", timeline: [msg("l1", ANA, "welcome", 500)] })] }));
    expect(ctx.messages()[0]!.reactions).toEqual([]);
  });

  it("keeps at most MAX_REACTIONS per room, dropping the oldest", async () => {
    const ctx = await signedIn();
    const timeline = Array.from({ length: MAX_REACTIONS + 1 }, (_, i) => reaction(`r${i}`, `@u${i}:x.org`, i === 0 ? "$d2" : "$d1", "👍"));
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline })] }));
    await ctx.open("Bo");
    expect(ctx.messages()[0]!.reactions[0]!.count).toBe(MAX_REACTIONS);
    expect(ctx.messages()[1]!.reactions).toEqual([]);
  });
});

describe("read state", () => {
  it("marks a room read when opened while visible, once per newest event", async () => {
    const ctx = await signedIn();
    ctx.adapter.setVisible(true);
    await ctx.open("Bo");
    expect(ctx.api.markRead).toHaveBeenCalledWith(SESSION, "!dm:x.org", "$d2");
    expect(ctx.item("Bo")).toMatchObject({ unread: false, mentions: 0 });
    expect(ctx.directs.at(-1)![0]).toMatchObject({ unread: false, mentions: 0 });
    // The server's count from before the receipt: cleared again, no second receipt.
    await ctx.live(sync({ joined: [room("!dm:x.org", { unread: { notifications: 2, highlights: 0 } })] }));
    expect(ctx.api.markRead).toHaveBeenCalledTimes(1);
    expect(ctx.item("Bo").unread).toBe(false);
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [msg("d5", BO, "new", 5000)], unread: { notifications: 1, highlights: 0 } })] }));
    expect(ctx.api.markRead).toHaveBeenLastCalledWith(SESSION, "!dm:x.org", "$d5");
  });

  it("marks the open room read when the view becomes visible", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    expect(ctx.api.markRead).not.toHaveBeenCalled();
    ctx.adapter.setVisible(false);
    ctx.adapter.setVisible(true);
    expect(ctx.api.markRead).toHaveBeenCalledWith(SESSION, "!lounge:x.org", "$l1");
    expect(ctx.adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
  });

  it("clears counts of a room without events and ignores receipt failures", async () => {
    const ctx = await signedIn(sync({ joined: [room("!r:x.org", { state: { name: "R", members: {} }, unread: { notifications: 1, highlights: 1 } })] }));
    ctx.adapter.setVisible(true);
    await ctx.open("R");
    expect(ctx.api.markRead).not.toHaveBeenCalled();
    expect(ctx.item("R").unread).toBe(false);
    ctx.api.markRead.mockRejectedValueOnce(new Error("x"));
    await ctx.live(sync({ joined: [room("!r:x.org", { timeline: [msg("x", ANA, "x", 1)], unread: { notifications: 1, highlights: 0 } })] }));
    expect(ctx.api.markRead).toHaveBeenCalledTimes(1);
  });

  it("does nothing on becoming visible without an open room", async () => {
    const ctx = await signedIn();
    ctx.adapter.setVisible(true);
    expect(ctx.api.markRead).not.toHaveBeenCalled();
  });
});

describe("notifications", () => {
  it("notifies about new DMs from others", async () => {
    const ctx = await signedIn();
    expect(ctx.notifications).toEqual([]);
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [msg("n1", BO, "ping", 5000), msg("n2", ME, "mine", 5001)] })] }));
    expect(ctx.notifications).toEqual([{ title: "Bo", body: "ping", target: "!dm:x.org", railKey: "dm:!dm:x.org", inView: false }]);
    expect(ctx.directs.at(-1)![0]).toMatchObject({ lastActivity: 5001, preview: "mine" });
  });

  it("says when a DM is encrypted, and when it is in view", async () => {
    const ctx = await signedIn();
    ctx.adapter.setVisible(true);
    await ctx.open("Bo");
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [enc("n1", BO, 5000)] })] }));
    expect(ctx.notifications).toEqual([{ title: "Bo", body: ENCRYPTED_TEXT, target: "!dm:x.org", railKey: "dm:!dm:x.org", inView: true }]);
  });

  it("notifies about mentions in rooms", async () => {
    const ctx = await signedIn();
    await ctx.live(
      sync({
        joined: [
          room("!lounge:x.org", {
            timeline: [
              msg("m1", ANA, "hey all", 5000, { mentions: [] }),
              msg("m2", ANA, "hey you", 5001, { mentions: [ME] }),
              msg("m3", ANA, "hello @me:x.org", 5002),
              msg("m4", ANA, "nothing", 5003),
              enc("m5", ANA, 5004),
            ],
          }),
        ],
      }),
    );
    expect(ctx.notifications.map((n) => n.body)).toEqual(["hey you", "hello @me:x.org"]);
    expect(ctx.notifications[0]).toEqual({ title: "Ana in Lounge", body: "hey you", target: "!lounge:x.org", railKey: "home", inView: false });
  });

  it("finds mentions by display name", async () => {
    const ctx = await signedIn(
      sync({ joined: [room("!r:x.org", { state: { name: "R", members: { [ME]: { name: "Captain", membership: "join" } } } })] }),
    );
    await ctx.live(sync({ joined: [room("!r:x.org", { timeline: [msg("x", ANA, "thanks captain", 1)] })] }));
    expect(ctx.notifications).toHaveLength(1);
  });
});

describe("signing out", () => {
  it("logs out its own device and forgets everything", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "logout" });
    expect(ctx.api.logout).toHaveBeenCalledWith(SESSION);
    expect(ctx.secrets.has("session")).toBe(false);
    expect(ctx.directs.at(-1)).toEqual([]);
    expect(ctx.prompt().prompt.id).toBe("login");
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-out" });
    expect(ctx.adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
  });

  it("only forgets a token from another app", async () => {
    const ctx = await signedIn(initialSync(), { ...SESSION, ownDevice: false });
    await ctx.adapter.signOut();
    expect(ctx.api.logout).not.toHaveBeenCalled();
    expect(ctx.secrets.has("session")).toBe(false);
  });

  it("forgets the session even when logging out fails", async () => {
    const ctx = await signedIn();
    ctx.api.logout.mockRejectedValueOnce(new Error("offline"));
    await ctx.adapter.signOut();
    expect(ctx.secrets.has("session")).toBe(false);
  });

  it("signs out from the sign-in screen without a session", async () => {
    const ctx = setup();
    await ctx.adapter.start();
    await ctx.adapter.signOut();
    expect(ctx.api.logout).not.toHaveBeenCalled();
  });
});

describe("shell interface", () => {
  it("renders on ready and openHome, and has no servers", async () => {
    const ctx = await signedIn();
    const renders = ctx.renders.length;
    await ctx.act({ type: "ready" });
    await ctx.adapter.openHome();
    expect(ctx.renders).toHaveLength(renders + 2);
    await expect(ctx.adapter.openServer("x")).rejects.toThrow("Matrix has no server x");
    expect(ctx.adapter.capabilities).toEqual({ directMessages: true, messagePreviews: true, voice: true, screenShare: true });
    expect(ctx.adapter.mode).toBe("native");
  });

  it("ignores actions Matrix does not offer", async () => {
    const ctx = await signedIn();
    const renders = ctx.renders.length;
    for (const action of [{ type: "typing" }, { type: "attach" }] as NativeAction[]) await ctx.act(action);
    expect(ctx.renders).toHaveLength(renders);
  });
});

// --- OAuth 2.0 sign-in ----------------------------------------------------------

const OAUTH_SERVER: OAuthServer = {
  issuer: "https://account.x.org/",
  deviceEndpoint: "https://account.x.org/device",
  tokenEndpoint: "https://account.x.org/token",
  registrationEndpoint: "https://account.x.org/register",
  revocationEndpoint: "https://account.x.org/revoke",
};
const grantOf = (extra: Partial<DeviceGrant> = {}): DeviceGrant => ({
  deviceCode: "dc",
  userCode: "ABC123",
  verificationUri: "https://account.x.org/link",
  expiresAt: Date.now() + 600_000,
  interval: 5000,
  ...extra,
});
const TOKENS = { accessToken: "at", refreshToken: "rt", expiresAt: 5_000_000_000_000 };

function fakeOAuth() {
  return {
    discover: vi.fn(async (_base: string): Promise<OAuthServer | undefined> => OAUTH_SERVER),
    register: vi.fn(async (_server: OAuthServer) => "client1"),
    authorizeDevice: vi.fn(async (_server: OAuthServer, _client: string, _device: string) => grantOf()),
    pollDevice: vi.fn(async (_server: OAuthServer, _client: string, _code: string): Promise<DevicePoll> => ({ state: "done", tokens: TOKENS })),
    refresh: vi.fn(async (_session: MxOAuthSession): Promise<OAuthTokens> => ({ accessToken: "at2", refreshToken: "rt2", expiresAt: 6_000_000_000_000 })),
    revoke: vi.fn(async (_session: MxOAuthSession, _token: string, _hint: string) => {}),
  };
}

async function atOAuth(secretsInit: Record<string, string> = {}) {
  const oauth = fakeOAuth();
  const ctx = setup(secretsInit, false, { oauth });
  await ctx.adapter.start();
  return { ...ctx, oauth };
}

describe("signing in with OAuth 2.0", () => {
  it("offers the browser first and cycles through the other ways", async () => {
    const ctx = await atOAuth();
    expect(ctx.oauth.discover).toHaveBeenCalledWith(BASE);
    expect(ctx.prompt().prompt).toMatchObject({ id: "oauth", title: "Sign in to x.org", fields: [], submit: "Sign in with the browser", cancel: "Use a password instead" });
    expect(ctx.prompt().prompt.description).toContain("account.x.org");
    expect(ctx.prompt().prompt.description).toContain("Encrypted rooms cannot be read");
    await ctx.act({ type: "cancelPrompt", id: "oauth" });
    expect(ctx.prompt().prompt).toMatchObject({ id: "login", cancel: "Use an access token instead" });
    await ctx.act({ type: "cancelPrompt", id: "login" });
    expect(ctx.prompt().prompt).toMatchObject({ id: "token", cancel: "Sign in with the browser instead" });
    expect(ctx.prompt().prompt.description).not.toContain("does not offer password sign-in");
    await ctx.act({ type: "cancelPrompt", id: "token" });
    expect(ctx.prompt().prompt.id).toBe("oauth");
    // Stale or unknown cancels change nothing.
    await ctx.act({ type: "cancelPrompt", id: "login" });
    await ctx.act({ type: "cancelPrompt", id: "retry" });
    expect(ctx.prompt().prompt.id).toBe("oauth");
  });

  it("skips the browser when there is no account server", async () => {
    const oauth = fakeOAuth();
    oauth.discover.mockRejectedValueOnce(new Error("offline"));
    const ctx = setup({}, false, { oauth });
    await ctx.adapter.start();
    expect(ctx.prompt().prompt.id).toBe("login");
  });

  it("offers the browser when the homeserver does not serve the login endpoint, as Synapse with MAS may not", async () => {
    const oauth = fakeOAuth();
    const ctx = setup({}, false, { oauth });
    ctx.api.loginFlows.mockRejectedValueOnce(new MatrixError(404, "M_UNRECOGNIZED", "Unrecognized request"));
    await ctx.adapter.start();
    expect(ctx.prompt().prompt).toMatchObject({ id: "oauth", cancel: "Use an access token instead" });
    // Without an account server it still is unreachable.
    const bare = setup({}, false, { oauth: { ...fakeOAuth(), discover: vi.fn(async () => undefined) } });
    bare.api.loginFlows.mockRejectedValueOnce(new MatrixError(404, "M_UNRECOGNIZED", "Unrecognized request"));
    await bare.adapter.start();
    expect(bare.prompt()).toMatchObject({ prompt: { id: "retry" }, error: "Could not reach a Matrix homeserver at x.org: Unrecognized request" });
    // Nor does an account server help when the homeserver itself is not found.
    const lost = setup({}, false, { oauth: fakeOAuth() });
    lost.api.discover.mockRejectedValueOnce(new Error("The homeserver address must be an https URL"));
    await lost.adapter.start();
    expect(lost.prompt()).toMatchObject({ prompt: { id: "retry" }, error: "Could not reach a Matrix homeserver at x.org: The homeserver address must be an https URL" });
  });

  it("shows a code, waits for the approval and signs in with a device of its own", async () => {
    const ctx = await atOAuth();
    ctx.oauth.pollDevice.mockResolvedValueOnce({ state: "pending" }).mockResolvedValueOnce({ state: "slow_down" });
    ctx.oauth.pollDevice.mockImplementationOnce(async () => {
      expect(ctx.prompt()).toMatchObject({ status: "Waiting for you to approve the sign-in…", prompt: { id: "device", title: "Your code: ABC123", submit: "Get a new code", cancel: "Back" } });
      expect(ctx.prompt().prompt.link).toEqual({ url: "https://account.x.org/link", label: "Open account.x.org" });
      expect(ctx.prompt().prompt.description).toContain("enter the code ABC123");
      return { state: "done", tokens: TOKENS };
    });
    ctx.api.whoami.mockResolvedValueOnce({ userId: ME, deviceId: "SERVERDEV1" });
    await ctx.answer("oauth");
    await flush();
    expect(ctx.renders).toContainEqual({ screen: "connecting", platform: "Matrix", status: "Getting a sign-in code…" });
    expect(ctx.oauth.register).toHaveBeenCalledWith(OAUTH_SERVER);
    const deviceId = ctx.oauth.authorizeDevice.mock.calls[0]![2];
    expect(deviceId).toMatch(/^[A-Z0-9]{10}$/);
    // Slowed down: five seconds more between polls from then on.
    expect(ctx.delay.mock.calls.map(([ms]) => ms)).toEqual([5000, 5000, 10000]);
    expect(ctx.api.whoami).toHaveBeenCalledWith(BASE, "at");
    const stored = JSON.parse(ctx.secrets.get("session")!);
    expect(stored).toEqual({
      baseUrl: BASE,
      accessToken: "at",
      userId: ME,
      deviceId: "SERVERDEV1",
      ownDevice: true,
      oauth: { clientId: "client1", tokenEndpoint: OAUTH_SERVER.tokenEndpoint, revocationEndpoint: OAUTH_SERVER.revocationEndpoint, refreshToken: "rt", expiresAt: TOKENS.expiresAt },
    });
    expect(parseSession(ctx.secrets.get("session"))).toEqual(stored);
    expect(JSON.parse(ctx.secrets.get("oauth-client")!)).toEqual({ issuer: OAUTH_SERVER.issuer, clientId: "client1" });
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-in", name: ME });
  });

  it("uses the requested device id when whoami names none, and the complete link when offered", async () => {
    const ctx = await atOAuth({ "oauth-client": JSON.stringify({ issuer: OAUTH_SERVER.issuer, clientId: "kept" }) });
    ctx.oauth.authorizeDevice.mockResolvedValueOnce(grantOf({ verificationUriComplete: "https://account.x.org/link?code=ABC123" }));
    ctx.oauth.pollDevice.mockImplementationOnce(async () => {
      expect(ctx.prompt().prompt.link!.url).toBe("https://account.x.org/link?code=ABC123");
      return { state: "done", tokens: { accessToken: "at" } };
    });
    ctx.api.whoami.mockResolvedValueOnce({ userId: ME });
    await ctx.answer("oauth");
    await flush();
    expect(ctx.oauth.register).not.toHaveBeenCalled();
    expect(ctx.oauth.authorizeDevice).toHaveBeenCalledWith(OAUTH_SERVER, "kept", expect.any(String));
    const stored = JSON.parse(ctx.secrets.get("session")!);
    expect(stored.deviceId).toBe(ctx.oauth.authorizeDevice.mock.calls[0]![2]);
    expect(stored.oauth).toEqual({ clientId: "kept", tokenEndpoint: OAUTH_SERVER.tokenEndpoint, revocationEndpoint: OAUTH_SERVER.revocationEndpoint });
  });

  it.each([
    ["for another server", JSON.stringify({ issuer: "https://other.org/", clientId: "old" })],
    ["that is not ours", "{nope"],
    ["without an id", JSON.stringify({ issuer: OAUTH_SERVER.issuer, clientId: "" })],
  ])("registers again with a stored client id %s", async (_name, stored) => {
    const ctx = await atOAuth({ "oauth-client": stored });
    await ctx.answer("oauth");
    await flush();
    expect(ctx.oauth.register).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["denied", "The sign-in was declined."],
    ["expired", "The code expired. Get a new one to try again."],
  ] as const)("goes back when the code is %s", async (state, error) => {
    const ctx = await atOAuth();
    ctx.oauth.pollDevice.mockResolvedValueOnce({ state });
    await ctx.answer("oauth");
    await flush();
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "oauth" }, error });
  });

  it("gives up when the code ran out, or the server refuses, and keeps polling through network trouble", async () => {
    const ctx = await atOAuth();
    ctx.oauth.authorizeDevice.mockResolvedValueOnce(grantOf({ expiresAt: Date.now() - 1 }));
    await ctx.answer("oauth");
    await flush();
    expect(ctx.prompt().error).toBe("The code expired. Get a new one to try again.");
    expect(ctx.oauth.pollDevice).not.toHaveBeenCalled();

    ctx.oauth.pollDevice.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new OAuthError("invalid_client", "Unknown client"));
    await ctx.answer("oauth");
    await flush();
    expect(ctx.oauth.pollDevice).toHaveBeenCalledTimes(2);
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "oauth" }, error: "Signing in failed: Unknown client" });
  });

  it("says when a code cannot be had", async () => {
    const ctx = await atOAuth();
    ctx.oauth.register.mockRejectedValueOnce(new OAuthError("unauthorized_client", "This server does not let apps sign in with a code"));
    await ctx.answer("oauth");
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "oauth" }, error: "Could not start signing in: This server does not let apps sign in with a code" });
  });

  it("stops waiting on Back, and starts over with a new code", async () => {
    const ctx = await atOAuth();
    let release!: () => void;
    ctx.delay.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    await ctx.answer("oauth");
    await ctx.act({ type: "cancelPrompt", id: "device" });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "oauth" } });
    release();
    await flush();
    expect(ctx.oauth.pollDevice).not.toHaveBeenCalled();
    expect(ctx.secrets.has("session")).toBe(false);

    // A new code replaces the one on screen; the old one's poll finds itself abandoned.
    let releaseFirst!: () => void;
    ctx.delay.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseFirst = resolve)));
    ctx.oauth.authorizeDevice.mockResolvedValueOnce(grantOf({ userCode: "FIRST1" }));
    await ctx.answer("oauth");
    let releaseSecond!: () => void;
    ctx.delay.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseSecond = resolve)));
    await ctx.answer("device");
    expect(ctx.oauth.authorizeDevice).toHaveBeenCalledTimes(3);
    releaseFirst();
    await flush();
    expect(ctx.oauth.pollDevice).not.toHaveBeenCalled();
    releaseSecond();
    await flush();
    expect(ctx.oauth.pollDevice).toHaveBeenCalledTimes(1);
    expect(ctx.adapter.accountStatus().state).toBe("signed-in");
  });

  it("drops a code abandoned while it was being fetched", async () => {
    const ctx = await atOAuth();
    let resolve!: (grant: DeviceGrant) => void;
    ctx.oauth.authorizeDevice.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const first = ctx.answer("oauth");
    await flush();
    ctx.oauth.authorizeDevice.mockRejectedValueOnce(new Error("later failure"));
    // The view only offers the device screen's buttons once the code is there, but a second answer may race.
    (ctx.adapter as unknown as { step: string }).step = "oauth";
    await ctx.answer("oauth");
    resolve(grantOf());
    await first;
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "oauth" }, error: "Could not start signing in: later failure" });
  });

  it("revokes the tokens of a sign-in abandoned or failed after approval", async () => {
    const ctx = await atOAuth();
    let approve!: (poll: DevicePoll) => void;
    ctx.oauth.pollDevice.mockImplementationOnce(() => new Promise((r) => (approve = r)));
    await ctx.answer("oauth");
    await flush();
    await ctx.act({ type: "cancelPrompt", id: "device" });
    approve({ state: "done", tokens: TOKENS });
    await flush();
    expect(ctx.oauth.revoke).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client1", refreshToken: "rt" }), "rt", "refresh_token");
    expect(ctx.api.whoami).not.toHaveBeenCalled();

    // Back while checking the new token.
    let who!: (value: { userId: string }) => void;
    ctx.api.whoami.mockImplementationOnce(() => new Promise((r) => (who = r)));
    await ctx.answer("oauth");
    await flush();
    await ctx.act({ type: "cancelPrompt", id: "device" });
    who({ userId: ME });
    await flush();
    expect(ctx.oauth.revoke).toHaveBeenCalledTimes(2);
    expect(ctx.secrets.has("session")).toBe(false);

    // The token does not work.
    ctx.oauth.pollDevice.mockResolvedValueOnce({ state: "done", tokens: { accessToken: "bad" } });
    ctx.api.whoami.mockRejectedValueOnce(new MatrixError(401, "M_UNKNOWN_TOKEN", "x"));
    await ctx.answer("oauth");
    await flush();
    expect(ctx.oauth.revoke).toHaveBeenLastCalledWith(expect.anything(), "bad", "access_token");
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "oauth" }, error: "Signing in failed: That access token is not valid (anymore)." });
  });
});

describe("OAuth sessions", () => {
  const OAUTH_SESSION: MxSession = { ...SESSION, oauth: { clientId: "client1", tokenEndpoint: OAUTH_SERVER.tokenEndpoint, revocationEndpoint: OAUTH_SERVER.revocationEndpoint, refreshToken: "rt", expiresAt: 1000 } };

  it("reads only stored OAuth details we wrote", () => {
    const stored = (oauth: unknown) => parseSession(JSON.stringify({ ...SESSION, oauth }));
    expect(stored(OAUTH_SESSION.oauth)).toEqual(OAUTH_SESSION);
    expect(stored({ clientId: "c", tokenEndpoint: "https://a.org/t" })).toEqual({ ...SESSION, oauth: { clientId: "c", tokenEndpoint: "https://a.org/t" } });
    for (const bad of [{ clientId: "" }, { clientId: 1 }, { tokenEndpoint: "http://a.org" }, { revocationEndpoint: "x" }, { refreshToken: "" }, { refreshToken: 5 }, { expiresAt: "soon" }]) {
      expect(stored({ ...OAUTH_SESSION.oauth, ...bad })).toBeUndefined();
    }
  });

  it("refreshes tokens in place and stores them", async () => {
    const oauth = fakeOAuth();
    const ctx = setup({ session: JSON.stringify(OAUTH_SESSION) }, false, { oauth });
    await ctx.adapter.start();
    const session = ctx.api.check.mock.calls[0]![0];
    await ctx.adapter.refreshSession(session);
    expect(oauth.refresh).toHaveBeenCalledWith(session.oauth);
    expect(session).toMatchObject({ accessToken: "at2", oauth: { refreshToken: "rt2", expiresAt: 6_000_000_000_000 } });
    expect(JSON.parse(ctx.secrets.get("session")!).accessToken).toBe("at2");
  });

  it("ends the session when the account server refuses to refresh, and retries network failures later", async () => {
    const oauth = fakeOAuth();
    const ctx = setup({ session: JSON.stringify(OAUTH_SESSION) }, false, { oauth });
    await ctx.adapter.start();
    const session = ctx.api.check.mock.calls[0]![0];
    oauth.refresh.mockRejectedValueOnce(new OAuthError("invalid_grant", "revoked"));
    await expect(ctx.adapter.refreshSession(session)).rejects.toMatchObject({ status: 401, errcode: "M_UNKNOWN_TOKEN" });
    oauth.refresh.mockRejectedValueOnce(new Error("offline"));
    await expect(ctx.adapter.refreshSession(session)).rejects.toThrow("offline");
    await expect(ctx.adapter.refreshSession(SESSION)).rejects.toMatchObject({ status: 401 });
    const plain = setup();
    await expect(plain.adapter.refreshSession(OAUTH_SESSION)).rejects.toMatchObject({ status: 401 });
  });

  it("does not store a refresh that lands after signing out", async () => {
    const oauth = fakeOAuth();
    const ctx = setup({ session: JSON.stringify(OAUTH_SESSION) }, false, { oauth });
    await ctx.adapter.start();
    const session = ctx.api.check.mock.calls[0]![0];
    await ctx.adapter.signOut();
    await ctx.adapter.refreshSession(session);
    expect(ctx.secrets.has("session")).toBe(false);
  });

  it("signs out by revoking the refresh token, or else the access token", async () => {
    const oauth = fakeOAuth();
    const ctx = setup({}, false, { oauth });
    ctx.api.push(initialSync());
    ctx.secrets.set("session", JSON.stringify(OAUTH_SESSION));
    await ctx.adapter.start();
    await flush();
    oauth.revoke.mockRejectedValueOnce(new Error("offline"));
    await ctx.adapter.signOut();
    expect(oauth.revoke).toHaveBeenCalledWith(OAUTH_SESSION.oauth, "rt", "refresh_token");
    expect(ctx.api.logout).not.toHaveBeenCalled();
    expect(ctx.secrets.has("session")).toBe(false);

    const { refreshToken: _r, ...withoutRefresh } = OAUTH_SESSION.oauth!;
    ctx.secrets.set("session", JSON.stringify({ ...OAUTH_SESSION, oauth: withoutRefresh }));
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.signOut();
    expect(oauth.revoke).toHaveBeenLastCalledWith(withoutRefresh, "tok", "access_token");
  });
});

// --- End-to-end encryption ----------------------------------------------------------

const ROOM_ENCRYPTION: MxEncryption = { algorithm: "m.megolm.v1.aes-sha2" };

const EMOJI = [
  { symbol: "🐶", name: "Dog" },
  { symbol: "🐱", name: "Cat" },
  { symbol: "🦁", name: "Lion" },
  { symbol: "🐎", name: "Horse" },
  { symbol: "🦄", name: "Unicorn" },
  { symbol: "🐷", name: "Pig" },
  { symbol: "🐘", name: "Elephant" },
];

class FakeVerification implements Verification {
  current: VerificationState;
  changed: () => void = () => {};
  constructor(readonly outgoing: boolean) {
    this.current = outgoing ? { phase: "waiting", device: "your other device" } : { phase: "incoming", device: "Element (EL)" };
  }
  state = (): VerificationState => this.current;
  set(state: VerificationState): void {
    this.current = state;
    this.changed();
  }
  accept = vi.fn(async () => this.set({ phase: "waiting", device: "Element (EL)" }));
  confirm = vi.fn(async () => this.set({ phase: "confirmed" }));
  cancel = vi.fn(async (mismatch?: boolean) => this.set({ phase: "cancelled", reason: mismatch ? "the emoji did not match" : "you cancelled it", byUs: true }));
  onChange = vi.fn((callback: () => void) => void (this.changed = callback));
}

class FakeE2ee implements E2ee {
  /** What each event decrypts to; events not listed stay encrypted. */
  readonly clear = new Map<string, MxEvent | undefined>();
  keys: (sessions: string[]) => void = () => {};
  receiveSync = vi.fn(async (_sync: MxCryptoSync) => {});
  decrypt = vi.fn(async (_room: string, event: MxEncryptedEvent): Promise<MxEvent | undefined> =>
    this.clear.has(event.id) ? this.clear.get(event.id) : { ...event, problem: "the key has not arrived (yet)" },
  );
  encrypt = vi.fn(async (_room: string, _settings: RoomEncryption, _members: string[], _type: string, _content: Record<string, unknown>) => ({ algorithm: "m.megolm.v1.aes-sha2", ciphertext: "secret" }));
  status = vi.fn(async (): Promise<E2eeStatus> => ({ verified: false, backup: false }));
  recover = vi.fn(async (_input: string): Promise<RecoveryResult> => ({ verified: true, backup: true, imported: 3 }));
  onKeys = vi.fn((callback: (sessions: string[]) => void) => void (this.keys = callback));
  requested: (verification: Verification) => void = () => {};
  statusChanged: () => void = () => {};
  outgoing = new FakeVerification(true);
  requestVerification = vi.fn(async (): Promise<Verification> => this.outgoing);
  onVerification = vi.fn((callback: (verification: Verification) => void) => void (this.requested = callback));
  onStatus = vi.fn((callback: () => void) => void (this.statusChanged = callback));
  sendToDevices = vi.fn(async (_type: string, _targets: DeviceRef[], _content: Record<string, unknown>) => {});
  toDevice = new Map<string, (event: SecureToDevice) => void>();
  onToDevice = vi.fn((type: string, callback: (event: SecureToDevice) => void) => void this.toDevice.set(type, callback));
  close = vi.fn();
}

const encRaw = (id: string, sender: string, ts: number, extra: Partial<MxEncryptedEvent> = {}): MxEncryptedEvent => ({ kind: "encrypted", id: `$${id}`, sender, ts, raw: `{"event_id":"$${id}"}`, sessionId: "S1", ...extra });

/** A signed-in adapter with encryption: a DM with Bo and an encrypted room, both with encrypted events. */
async function withCrypto(options: { session?: MxSession; first?: MxSync; secrets?: Record<string, string> } = {}) {
  const e2ee = new FakeE2ee();
  e2ee.clear.set("$c1", msg("c1", BO, "decrypted hello", 3000));
  const crypto = { open: vi.fn(async (_options: E2eeOptions): Promise<E2ee> => e2ee), deleteStore: vi.fn(async (_name: string) => {}) };
  const log = vi.fn();
  const ctx = setup({ session: JSON.stringify(options.session ?? SESSION), ...options.secrets }, false, { crypto, log });
  ctx.api.push(
    options.first ??
      sync({
        directs: { [BO]: ["!dm:x.org"] },
        joined: [
          room("!dm:x.org", { state: { encrypted: true, encryption: ROOM_ENCRYPTION, members: { [BO]: { name: "Bo", membership: "join" } } }, timeline: [encRaw("c1", BO, 3000), encRaw("c2", BO, 4000)] }),
          room("!sec:x.org", { state: { name: "Secret", encrypted: true, encryption: ROOM_ENCRYPTION, history: "joined", members: {} }, timeline: [msg("p1", ANA, "plain", 100)] }),
        ],
        crypto: { toDevice: "[]", changed: [ME], left: [], oneTimeKeys: { signed_curve25519: 50 } },
      }),
  );
  await ctx.adapter.start();
  await flush();
  return { ...ctx, e2ee, crypto, log };
}

describe("end-to-end encryption", () => {
  it("opens the device's own key store, made once with a random passphrase", async () => {
    const ctx = await withCrypto();
    const options = ctx.crypto.open.mock.calls[0]![0];
    expect(options).toMatchObject({ userId: ME, deviceId: "D", store: { name: "multicord:matrix-native:@me:x.org:D" } });
    expect(options.store!.passphrase.length).toBeGreaterThanOrEqual(32);
    expect(JSON.parse(ctx.secrets.get("crypto-store")!)).toEqual(options.store);
    // Its requests go out as this session.
    await options.http("POST", "/v3/keys/upload", { a: 1 }, { b: "2" });
    expect(ctx.api.request).toHaveBeenCalledWith(SESSION, "POST", "/v3/keys/upload", { a: 1 }, { b: "2" });
    await options.accountData("m.secret_storage.default_key");
    expect(ctx.api.accountData).toHaveBeenCalledWith(SESSION, "m.secret_storage.default_key");
    options.log!("x");
    expect(ctx.log).toHaveBeenCalledWith("x");
    expect(ctx.e2ee.receiveSync).toHaveBeenCalledWith({ toDevice: "[]", changed: [ME], left: [], oneTimeKeys: { signed_curve25519: 50 } });
  });

  it("keeps the store for the same device and deletes another device's", async () => {
    const same = await withCrypto({ secrets: { "crypto-store": JSON.stringify({ name: "multicord:matrix-native:@me:x.org:D", passphrase: "p".repeat(44) }) } });
    expect(same.crypto.open.mock.calls[0]![0].store).toEqual({ name: "multicord:matrix-native:@me:x.org:D", passphrase: "p".repeat(44) });
    expect(same.crypto.deleteStore).not.toHaveBeenCalled();
    const other = await withCrypto({ secrets: { "crypto-store": JSON.stringify({ name: "old-store", passphrase: "p".repeat(44) }) } });
    expect(other.crypto.deleteStore).toHaveBeenCalledWith("old-store");
    expect(JSON.parse(other.secrets.get("crypto-store")!).name).toBe("multicord:matrix-native:@me:x.org:D");
    const junk = await withCrypto({ secrets: { "crypto-store": "{nope" } });
    expect(junk.crypto.deleteStore).not.toHaveBeenCalled();
  });

  it("decrypts the timeline, and says why where it cannot", async () => {
    const ctx = await withCrypto();
    await ctx.open("Bo");
    expect(ctx.messages().map((m) => [m.author, m.content])).toEqual([
      ["Bo", "decrypted hello"],
      ["Bo", "🔒 Unable to decrypt: the key has not arrived (yet)"],
    ]);
    expect(ctx.chat().channel!.locked).toBeUndefined();
    expect(ctx.directs.at(-1)![0]!.preview).toBe("🔒 Encrypted message");
  });

  it("notifies with the decrypted text, and marks unverified devices", async () => {
    const ctx = await withCrypto();
    ctx.e2ee.clear.set("$c3", { ...(msg("c3", BO, "news", 5000) as Extract<MxEvent, { kind: "message" }>), unverified: "Encrypted by a device not verified by its owner." });
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [encRaw("c3", BO, 5000)] })] }));
    expect(ctx.notifications.at(-1)).toMatchObject({ title: "Bo", body: "news" });
    await ctx.open("Bo");
    expect(ctx.messages().at(-1)).toMatchObject({ author: `Bo · ${UNVERIFIED_LABEL}`, content: "news" });
  });

  it("carries on when handing a sync to the crypto state fails, or a decryption throws", async () => {
    const ctx = await withCrypto();
    ctx.e2ee.receiveSync.mockRejectedValueOnce(new Error("keys upload failed"));
    ctx.e2ee.decrypt.mockRejectedValueOnce(new Error("broken"));
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [encRaw("c4", BO, 6000)] })], crypto: { toDevice: "[]", changed: [], left: [], oneTimeKeys: {} } }));
    expect(ctx.log).toHaveBeenCalledWith("Encryption sync: keys upload failed");
    await ctx.open("Bo");
    expect(ctx.messages().at(-1)!.content).toBe("🔒 Unable to decrypt: broken");
  });

  it("decrypts events again when their keys arrive", async () => {
    const ctx = await withCrypto({
      first: sync({
        directs: { [BO]: ["!dm:x.org"] },
        joined: [
          room("!dm:x.org", {
            state: { encrypted: true, encryption: ROOM_ENCRYPTION, members: { [BO]: { name: "Bo", membership: "join" } } },
            timeline: [msg("m0", ME, "original", 500), encRaw("k1", BO, 1000), encRaw("k2", BO, 2000), encRaw("k3", BO, 3000), encRaw("k4", ME, 4000, { sessionId: "S2" }), encRaw("k5", BO, 5000, { raw: undefined })],
          }),
        ],
      }),
    });
    await ctx.open("Bo");
    expect(ctx.messages()).toHaveLength(6);
    ctx.e2ee.decrypt.mockClear();
    ctx.e2ee.clear.set("$k1", msg("k1", BO, "now readable", 1000));
    // An edit, and an event of a type that is not shown.
    ctx.e2ee.clear.set("$k2", msg("k2", ME, "edited", 2000, { replaces: "$m0", sender: ME }));
    ctx.e2ee.clear.set("$k3", undefined);
    ctx.e2ee.keys(["S1"]);
    await flush();
    // Only events of that session, and only those that can be decrypted at all.
    expect(ctx.e2ee.decrypt.mock.calls.map(([, e]) => e.id)).toEqual(["$k1", "$k2", "$k3"]);
    expect(ctx.messages().map((m) => m.content)).toEqual(["edited", "now readable", "🔒 Unable to decrypt: the key has not arrived (yet)", "🔒 Unable to decrypt: the key has not arrived (yet)"]);
    // Still nothing new: no re-render.
    const renders = ctx.renders.length;
    ctx.e2ee.keys(["S9"]);
    await flush();
    expect(ctx.renders).toHaveLength(renders);
  });

  it("leaves out encrypted edits it cannot read, live and in history", async () => {
    const ctx = await withCrypto();
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [encRaw("e1", BO, 7000, { replaces: "$c1" })] })] }));
    ctx.api.messages.mockResolvedValueOnce({ events: [encRaw("h1", BO, 10, { replaces: "$c1" }), encRaw("h2", BO, 20)], state: { members: {} } });
    (ctx.adapter as unknown as { rooms: Map<string, { prevBatch?: string }> }).rooms.get("!dm:x.org")!.prevBatch = "p";
    await ctx.open("Bo");
    await ctx.act({ type: "loadOlder" });
    await flush();
    expect(ctx.messages().map((m) => m.id)).not.toContain(undefined);
    expect(ctx.e2ee.decrypt.mock.calls.map(([, e]) => e.id)).toEqual(expect.arrayContaining(["$e1", "$h1", "$h2"]));
    expect(ctx.messages()).toHaveLength(3);
  });

  it("encrypts messages for the room's members, fetching them once", async () => {
    const ctx = await withCrypto();
    await ctx.open("Secret");
    await ctx.act({ type: "send", content: "hush" });
    expect(ctx.api.encryption).not.toHaveBeenCalled();
    expect(ctx.api.members).toHaveBeenCalledWith(SESSION, "!sec:x.org");
    expect(ctx.e2ee.encrypt).toHaveBeenCalledWith("!sec:x.org", { encryption: ROOM_ENCRYPTION, history: "joined" }, [ME, BO], "m.room.message", { msgtype: "m.text", body: "hush", "m.mentions": {} });
    expect(ctx.api.send).toHaveBeenCalledWith(SESSION, "!sec:x.org", { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "secret" }, "m.room.encrypted");
    expect(ctx.messages().at(-1)).toMatchObject({ content: "hush", mine: true, canEdit: true });

    // Membership changes keep the list current; a gap makes it fetched again.
    await ctx.live(sync({ joined: [room("!sec:x.org", { state: { members: { [ANA]: { membership: "join" }, [BO]: { membership: "leave" } } } })] }));
    await ctx.act({ type: "send", content: "again" });
    expect(ctx.e2ee.encrypt.mock.calls[1]![2]).toEqual([ME, ANA]);
    expect(ctx.api.members).toHaveBeenCalledTimes(1);
    await ctx.live(sync({ joined: [room("!sec:x.org", { limited: true })] }));
    await ctx.act({ type: "send", content: "third" });
    expect(ctx.api.members).toHaveBeenCalledTimes(2);

    // Edits are encrypted too.
    const mine = ctx.messages().find((m) => m.content === "third")!;
    await ctx.act({ type: "edit", messageId: mine.id, content: "3rd" });
    expect(ctx.e2ee.encrypt.mock.calls.at(-1)![4]).toMatchObject({ "m.new_content": { body: "3rd" }, "m.relates_to": { rel_type: "m.replace" } });
    expect(ctx.api.send).toHaveBeenLastCalledWith(SESSION, "!sec:x.org", expect.anything(), "m.room.encrypted");
  });

  it("keeps the room's current members over the older state a history page brings", async () => {
    const ctx = await withCrypto();
    await ctx.open("Secret");
    await ctx.act({ type: "send", content: "hush" });
    await ctx.live(sync({ joined: [room("!sec:x.org", { state: { members: { [BO]: { membership: "leave", name: "Bo" } } } })] }));
    // From before Bo left (under an older name), with Ana, not seen before.
    ctx.api.messages.mockResolvedValueOnce({
      events: [msg("old1", BO, "from Bo", 1), msg("old2", ANA, "from Ana", 2)],
      state: { members: { [BO]: { membership: "join", name: "Old Bo" }, [ANA]: { membership: "join", name: "Ana" }, [ME]: { membership: "invite" } } },
    });
    (ctx.adapter as unknown as { rooms: Map<string, { prevBatch?: string }> }).rooms.get("!sec:x.org")!.prevBatch = "p";
    await ctx.act({ type: "loadOlder" });
    expect(ctx.messages().filter((m) => m.content.startsWith("from")).map((m) => m.author)).toEqual(["Bo", "Ana"]);
    // Bo, gone, does not get the keys again.
    await ctx.act({ type: "send", content: "after" });
    expect(ctx.e2ee.encrypt.mock.calls.at(-1)![2]).toEqual([ME]);
  });

  it("encrypts in a room the server says turned encrypted", async () => {
    const ctx = await withCrypto();
    ctx.api.push(sync({ joined: [room("!plain:x.org", { state: { name: "Plain", members: {} } })] }));
    await flush();
    ctx.api.encryption.mockResolvedValueOnce(ROOM_ENCRYPTION);
    await ctx.open("Plain");
    await ctx.act({ type: "send", content: "hi" });
    expect(ctx.e2ee.encrypt).toHaveBeenCalledWith("!plain:x.org", { encryption: ROOM_ENCRYPTION, history: undefined }, [ME, BO], "m.room.message", expect.anything());
  });

  it("refuses rooms with an algorithm it does not know", async () => {
    const ctx = await withCrypto();
    await ctx.live(sync({ joined: [room("!odd:x.org", { state: { name: "Odd", encrypted: true, encryption: { algorithm: "m.olm.v2" }, members: {} } })] }));
    await ctx.open("Odd");
    expect(ctx.chat().channel!.locked).toBe(ALGORITHM_NOTICE);
    await ctx.act({ type: "send", content: "hi" });
    expect(ctx.chat().error).toBe("Message not sent: this room uses an encryption algorithm Multicord does not support");
    expect(ctx.e2ee.encrypt).not.toHaveBeenCalled();
  });

  it("keeps encrypted rooms locked for sessions on another app's device", async () => {
    const ctx = await withCrypto({ session: { ...SESSION, ownDevice: false } });
    expect(ctx.crypto.open).not.toHaveBeenCalled();
    await ctx.open("Secret");
    expect(ctx.chat().channel!.locked).toBe(TOKEN_NOTICE);
    await ctx.act({ type: "send", content: "hi" });
    expect(ctx.chat().error).toBe("Message not sent: this room is end-to-end encrypted, and with an access token Multicord cannot encrypt");
    const tokenPrompt = setup({}, false, { crypto: { open: vi.fn(), deleteStore: vi.fn() } });
    tokenPrompt.api.flows = { password: false };
    await tokenPrompt.adapter.start();
    expect(tokenPrompt.prompt().prompt.description).toContain("Encrypted rooms stay locked");
  });

  it("locks encrypted rooms when encryption could not start, saying why", async () => {
    const e2ee = new FakeE2ee();
    const crypto = { open: vi.fn(async (): Promise<E2ee> => Promise.reject(new Error("IndexedDB is not available"))), deleteStore: vi.fn(async () => {}) };
    const log = vi.fn();
    const ctx = setup({ session: SESSION_JSON }, false, { crypto, log });
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    await ctx.open("Secret");
    expect(ctx.chat().channel!.locked).toBe("🔒 This room is end-to-end encrypted, but encryption could not start (IndexedDB is not available). Nothing is sent here until it does; restart Multicord to try again.");
    expect(log).toHaveBeenCalledWith("Encryption could not start: IndexedDB is not available");
    await ctx.act({ type: "send", content: "hi" });
    expect(ctx.chat().error).toBe("Message not sent: encryption could not start (IndexedDB is not available)");
    expect(e2ee.encrypt).not.toHaveBeenCalled();
    // Without a reason the notice still says it.
    (ctx.adapter as unknown as { cryptoProblem?: string }).cryptoProblem = undefined;
    await ctx.act({ type: "ready" });
    expect(ctx.chat().channel!.locked).toContain("encryption could not start. Nothing is sent");
  });

  it("closes a crypto state that opened after signing out", async () => {
    const e2ee = new FakeE2ee();
    let open!: (value: E2ee) => void;
    const crypto = { open: vi.fn(() => new Promise<E2ee>((resolve) => (open = resolve))), deleteStore: vi.fn(async () => {}) };
    const ctx = setup({ session: SESSION_JSON }, false, { crypto });
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.signOut();
    open(e2ee);
    await flush();
    expect(e2ee.close).toHaveBeenCalled();
    expect(ctx.api.sync).not.toHaveBeenCalled();
  });

  it("deletes the key store on sign-out and when the session ends", async () => {
    const ctx = await withCrypto();
    const name = JSON.parse(ctx.secrets.get("crypto-store")!).name;
    ctx.crypto.deleteStore.mockRejectedValueOnce(new Error("blocked"));
    await ctx.adapter.signOut();
    expect(ctx.e2ee.close).toHaveBeenCalled();
    expect(ctx.crypto.deleteStore).toHaveBeenCalledWith(name);
    expect(ctx.log).toHaveBeenCalledWith("Key store not deleted: blocked");
    expect(ctx.secrets.has("crypto-store")).toBe(false);

    const ended = await withCrypto();
    await ended.live(new MatrixError(401, "M_UNKNOWN_TOKEN", "gone"));
    expect(ended.crypto.deleteStore).toHaveBeenCalledWith(name);
    expect(ended.secrets.has("crypto-store")).toBe(false);
  });
});

describe("verifying with the recovery key", () => {
  const verifyItem = (ctx: Awaited<ReturnType<typeof withCrypto>>) => ctx.chat().sidebar.find((i) => i.name === "🔑 Verify this device");

  it("offers verification until the device is verified", async () => {
    const ctx = await withCrypto();
    expect(ctx.chat().sidebar.slice(0, 2)).toMatchObject([{ id: "security", name: "Encryption", kind: "category" }, { name: "🔑 Verify this device", kind: "text" }]);
    await ctx.act({ type: "select", channelId: verifyItem(ctx)!.id });
    expect(ctx.prompt().prompt).toMatchObject({ id: "recovery", title: "Verify this device", submit: "Verify", cancel: "Not now", fields: [{ name: "key", type: "password" }] });
    expect(ctx.prompt().prompt.description).toContain('To compare emoji with another device instead, choose "Verify with another device"');
    // Syncs carry on behind the screen without leaving it, and so do sync failures.
    await ctx.live(sync({}));
    expect(ctx.prompt().prompt.id).toBe("recovery");
    await ctx.live(new Error("offline"));
    expect(ctx.prompt().prompt.id).toBe("recovery");
    expect(ctx.prompt().status).toBeUndefined();
    // Selecting it again from there does nothing.
    await ctx.act({ type: "select", channelId: "1" });
    await ctx.act({ type: "cancelPrompt", id: "recovery" });
    expect(ctx.chat()).toBeDefined();
  });

  it("verifies, restores keys and decrypts what it now can", async () => {
    const ctx = await withCrypto();
    await ctx.act({ type: "select", channelId: verifyItem(ctx)!.id });
    let finish!: (result: RecoveryResult) => void;
    ctx.e2ee.recover.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const answering = ctx.answer("recovery", { key: "  EsTc abcd  " });
    expect(ctx.prompt()).toMatchObject({ busy: true, status: "Verifying… restoring keys can take a moment." });
    // A second submit while busy is ignored.
    await ctx.answer("recovery", { key: "again" });
    expect(ctx.e2ee.recover).toHaveBeenCalledTimes(1);
    expect(ctx.e2ee.recover).toHaveBeenCalledWith("EsTc abcd");
    ctx.e2ee.clear.set("$c2", msg("c2", BO, "restored", 4000));
    finish({ verified: true, backup: true, imported: 3 });
    await answering;
    await flush();
    expect(verifyItem(ctx)).toBeUndefined();
    await ctx.open("Bo");
    expect(ctx.messages().map((m) => m.content)).toEqual(["decrypted hello", "restored"]);
  });

  it("shows what went wrong and stays on the screen", async () => {
    const ctx = await withCrypto();
    await ctx.act({ type: "select", channelId: verifyItem(ctx)!.id });
    ctx.e2ee.recover.mockRejectedValueOnce(new Error("That recovery key is not right."));
    await ctx.answer("recovery", {});
    expect(ctx.e2ee.recover).toHaveBeenCalledWith("");
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "recovery" }, busy: false, error: "That recovery key is not right." });
  });

  it("checks the device's status again when its own keys change, and ignores failures", async () => {
    const ctx = await withCrypto();
    expect(ctx.e2ee.status).toHaveBeenCalledTimes(1);
    ctx.e2ee.status.mockResolvedValueOnce({ verified: true, backup: false });
    await ctx.live(sync({ crypto: { toDevice: "[]", changed: [ME], left: [], oneTimeKeys: {} } }));
    expect(verifyItem(ctx)).toBeUndefined();
    await ctx.live(sync({ crypto: { toDevice: "[]", changed: [BO], left: [], oneTimeKeys: {} } }));
    expect(ctx.e2ee.status).toHaveBeenCalledTimes(2);
    ctx.e2ee.status.mockRejectedValueOnce(new Error("x"));
    await ctx.live(sync({ crypto: { toDevice: "[]", changed: [ME], left: [], oneTimeKeys: {} } }));
    expect(verifyItem(ctx)).toBeUndefined();
  });

  it("drops a recovery that finishes after signing out", async () => {
    const ctx = await withCrypto();
    await ctx.act({ type: "select", channelId: verifyItem(ctx)!.id });
    let finish!: (result: RecoveryResult) => void;
    ctx.e2ee.recover.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const answering = ctx.answer("recovery", { key: "k" });
    await ctx.adapter.signOut();
    finish({ verified: true, backup: true, imported: 0 });
    await answering;
    expect(ctx.prompt().prompt.id).toBe("login");
  });
});

describe("verifying with another device", () => {
  type Ctx = Awaited<ReturnType<typeof withCrypto>>;
  const entry = (ctx: Ctx, name: string) => ctx.chat().sidebar.find((i) => i.name === name);
  const startOutgoing = async (ctx: Ctx) => {
    // Not awaited: the request may be held open.
    void ctx.act({ type: "select", channelId: entry(ctx, "📱 Verify with another device")!.id });
    await flush();
  };
  const incoming = async (ctx: Ctx) => {
    const verification = new FakeVerification(false);
    ctx.e2ee.requested(verification);
    await flush();
    return verification;
  };

  it("asks the other devices, shows the emoji and ends verified with the key backup", async () => {
    const ctx = await withCrypto();
    expect(ctx.chat().sidebar.slice(0, 3)).toMatchObject([{ name: "Encryption" }, { name: "🔑 Verify this device" }, { name: "📱 Verify with another device", kind: "text", unread: false }]);
    let requested!: (verification: Verification) => void;
    ctx.e2ee.requestVerification.mockImplementationOnce(() => new Promise((resolve) => (requested = resolve)));
    await startOutgoing(ctx);
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "verify-wait", title: "Verify with another device", submit: "Waiting…", cancel: "Cancel" }, busy: true, status: "Sending the request…" });
    expect(ctx.prompt().prompt.description).toContain("signed in as @me:x.org");
    requested(ctx.e2ee.outgoing);
    await flush();
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "verify-wait" }, busy: true, status: "Waiting for your other device…" });
    // Its disabled button does nothing, and syncs carry on behind the screen.
    await ctx.answer("verify-wait");
    await ctx.live(sync({}));
    expect(ctx.prompt().prompt.id).toBe("verify-wait");

    ctx.e2ee.outgoing.set({ phase: "emoji", emoji: EMOJI });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "verify-emoji", title: "🐶  🐱  🦁  🐎  🦄  🐷  🐘", submit: "They match", cancel: "They don't match" }, busy: false });
    expect(ctx.prompt().prompt.description).toContain("Dog, Cat, Lion, Horse, Unicorn, Pig, Elephant");
    await ctx.answer("verify-emoji");
    expect(ctx.e2ee.outgoing.confirm).toHaveBeenCalled();
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "verify-confirmed", submit: "Waiting…" }, busy: true });
    await ctx.answer("verify-confirmed");

    ctx.e2ee.status.mockResolvedValue({ verified: true, backup: false });
    ctx.e2ee.outgoing.set({ phase: "done" });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "verify-done", title: "Verified", submit: "Done" }, status: undefined });
    // The backup key arrives from the other device afterwards.
    ctx.e2ee.status.mockResolvedValue({ verified: true, backup: true });
    ctx.e2ee.statusChanged();
    await flush();
    expect(ctx.prompt().status).toBe("Your key backup is on, so older encrypted messages can be read.");
    await ctx.answer("verify-done");
    expect(ctx.chat().sidebar.find((i) => i.id === "security")).toBeUndefined();
  });

  it("shows the phase a verification is in when a sync renders before it says it moved on", async () => {
    const ctx = await withCrypto();
    await startOutgoing(ctx);
    ctx.e2ee.outgoing.set({ phase: "emoji", emoji: EMOJI });
    // Our "They match" is still on its way: the flow has confirmed but not yet called back.
    ctx.e2ee.outgoing.current = { phase: "confirmed" };
    await ctx.live(sync({}));
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "verify-confirmed", submit: "Waiting…" }, busy: true });
  });

  it("points to the recovery key when the backup key did not come over", async () => {
    const ctx = await withCrypto();
    await startOutgoing(ctx);
    ctx.e2ee.status.mockResolvedValue({ verified: true, backup: false, restorable: true });
    ctx.e2ee.outgoing.set({ phase: "done" });
    ctx.e2ee.statusChanged();
    await flush();
    expect(ctx.prompt().status).toContain('choose "Restore older messages" in the sidebar');
    await ctx.answer("verify-done");
    expect(ctx.chat().sidebar.slice(0, 2)).toMatchObject([{ name: "Encryption" }, { name: "🔑 Restore older messages" }]);
    expect(entry(ctx, "🔑 Verify this device")).toBeUndefined();
    await ctx.act({ type: "select", channelId: entry(ctx, "🔑 Restore older messages")!.id });
    expect(ctx.prompt().prompt).toMatchObject({ id: "recovery", title: "Restore older messages", submit: "Restore", cancel: "Not now" });
  });

  it("cancels when the emoji differ, and tries again", async () => {
    const ctx = await withCrypto();
    await startOutgoing(ctx);
    ctx.e2ee.outgoing.set({ phase: "emoji", emoji: EMOJI });
    await ctx.act({ type: "cancelPrompt", id: "verify-emoji" });
    expect(ctx.e2ee.outgoing.cancel).toHaveBeenCalledWith(true);
    expect(ctx.prompt().prompt).toMatchObject({ id: "verify-cancelled", title: "Verification cancelled", submit: "Close", cancel: "Try again" });
    expect(ctx.prompt().prompt.description).toBe("The devices were not verified. It ended because the emoji did not match.");
    ctx.e2ee.outgoing = new FakeVerification(true);
    await ctx.act({ type: "cancelPrompt", id: "verify-cancelled" });
    await flush();
    expect(ctx.e2ee.requestVerification).toHaveBeenCalledTimes(2);
    expect(ctx.prompt().prompt.id).toBe("verify-wait");
    // Cancel goes straight back to the chat.
    const second = ctx.e2ee.outgoing;
    await ctx.act({ type: "cancelPrompt", id: "verify-wait" });
    expect(second.cancel).toHaveBeenCalledWith();
    expect(ctx.chat()).toBeDefined();
    // Its change afterwards is not followed.
    second.set({ phase: "done" });
    expect(ctx.chat()).toBeDefined();
  });

  it("stops while waiting for the other device to confirm, and logs a cancel that fails", async () => {
    const ctx = await withCrypto();
    await startOutgoing(ctx);
    ctx.e2ee.outgoing.set({ phase: "confirmed" });
    ctx.e2ee.outgoing.cancel.mockRejectedValueOnce(new Error("offline"));
    await ctx.act({ type: "cancelPrompt", id: "verify-confirmed" });
    expect(ctx.chat()).toBeDefined();
    expect(ctx.log).toHaveBeenCalledWith("Verification not cancelled: offline");
    // So does a failing mismatch cancel, which then shows where the flow stands.
    const next = new FakeVerification(true);
    ctx.e2ee.outgoing = next;
    await startOutgoing(ctx);
    next.set({ phase: "emoji", emoji: EMOJI });
    next.cancel.mockRejectedValueOnce(new Error("offline"));
    await ctx.act({ type: "cancelPrompt", id: "verify-emoji" });
    expect(ctx.prompt().prompt.id).toBe("verify-emoji");
  });

  it("shows why a request could not be sent", async () => {
    const ctx = await withCrypto();
    ctx.e2ee.requestVerification.mockRejectedValueOnce(new Error("You are not signed in on another device."));
    await startOutgoing(ctx);
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "verify-cancelled", cancel: "Try again" }, error: "You are not signed in on another device." });
    expect(ctx.prompt().prompt.description).toBe("The devices were not verified.");
    await ctx.answer("verify-cancelled");
    expect(ctx.chat()).toBeDefined();
  });

  it("drops a request answered after cancelling or signing out", async () => {
    const ctx = await withCrypto();
    let requested!: (verification: Verification) => void;
    ctx.e2ee.requestVerification.mockImplementationOnce(() => new Promise((resolve) => (requested = resolve)));
    await startOutgoing(ctx);
    await ctx.act({ type: "cancelPrompt", id: "verify-wait" });
    ctx.e2ee.outgoing.cancel.mockRejectedValueOnce(new Error("offline"));
    requested(ctx.e2ee.outgoing);
    await flush();
    expect(ctx.e2ee.outgoing.cancel).toHaveBeenCalled();
    expect(ctx.chat()).toBeDefined();

    let failed!: (error: Error) => void;
    ctx.e2ee.requestVerification.mockImplementationOnce(() => new Promise((_resolve, reject) => (failed = reject)));
    await startOutgoing(ctx);
    await ctx.adapter.signOut();
    failed(new Error("late"));
    await flush();
    expect(ctx.prompt().prompt.id).toBe("login");
  });

  it("shows the other side cancelling", async () => {
    const ctx = await withCrypto();
    await startOutgoing(ctx);
    ctx.e2ee.outgoing.set({ phase: "cancelled", reason: "it was cancelled on the other device", byUs: false });
    expect(ctx.prompt().prompt.description).toBe("The devices were not verified. It ended because it was cancelled on the other device.");
    await ctx.answer("verify-cancelled");
    expect(entry(ctx, "📱 Verify with another device")).toBeDefined();
  });

  it("offers another device's request in the sidebar and with a notification, then verifies it", async () => {
    const ctx = await withCrypto();
    ctx.adapter.setVisible(true);
    const request = await incoming(ctx);
    expect(ctx.notifications.at(-1)).toEqual({ title: "Verification request", body: "Element (EL) asks to verify by comparing emoji.", target: REQUEST_ENTRY, railKey: "home", inView: true });
    expect(ctx.chat().sidebar.slice(0, 2)).toMatchObject([{ name: "Encryption" }, { name: "📱 Verification request", unread: true, mentions: 1 }]);
    await ctx.adapter.openConversation(REQUEST_ENTRY);
    expect(ctx.prompt().prompt).toMatchObject({ id: "verify-incoming", title: "Verify your other device?", submit: "Accept", cancel: "Decline" });
    expect(ctx.prompt().prompt.description).toContain("Element (EL), signed in to your account");
    await ctx.answer("verify-incoming");
    expect(request.accept).toHaveBeenCalled();
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "verify-wait", title: "Verifying Element (EL)" }, busy: true });
    request.set({ phase: "emoji", emoji: EMOJI });
    await ctx.answer("verify-emoji");
    request.set({ phase: "done" });
    expect(ctx.prompt().prompt.id).toBe("verify-done");
    await ctx.answer("verify-done");
    expect(entry(ctx, "📱 Verification request")).toBeUndefined();
    // A notification clicked after it ended does nothing.
    await ctx.adapter.openConversation(REQUEST_ENTRY);
    expect(ctx.chat()).toBeDefined();
  });

  it("declines another device's request, and shows no way to try again for one that was cancelled", async () => {
    const ctx = await withCrypto();
    const request = await incoming(ctx);
    expect(ctx.notifications.at(-1)!.inView).toBe(false);
    await ctx.act({ type: "select", channelId: entry(ctx, "📱 Verification request")!.id });
    await ctx.act({ type: "cancelPrompt", id: "verify-incoming" });
    expect(request.cancel).toHaveBeenCalled();
    expect(entry(ctx, "📱 Verification request")).toBeUndefined();

    const next = await incoming(ctx);
    await ctx.adapter.openConversation(REQUEST_ENTRY);
    await ctx.answer("verify-incoming");
    next.set({ phase: "cancelled", reason: "it took too long: nothing happened for 10 minutes", byUs: true });
    expect(ctx.prompt().prompt.cancel).toBeUndefined();
    // Only the buttons on screen do anything.
    await ctx.act({ type: "cancelPrompt", id: "verify-cancelled" });
    expect(ctx.chat()).toBeDefined();
  });

  it("drops a waiting request that ends elsewhere, and ignores requests during another verification", async () => {
    const ctx = await withCrypto();
    const request = await incoming(ctx);
    // Still waiting: a second request is left alone.
    await incoming(ctx);
    expect(ctx.notifications).toHaveLength(1);
    request.set({ phase: "incoming", device: "Element (EL)" });
    expect(entry(ctx, "📱 Verification request")).toBeDefined();
    request.set({ phase: "cancelled", reason: "another of your devices answered it", byUs: false });
    expect(entry(ctx, "📱 Verification request")).toBeUndefined();
    // Once it ended, the next request is taken; the notification names the device.
    const next = new FakeVerification(false);
    next.current = { phase: "waiting", device: "x" };
    ctx.e2ee.requested(next);
    expect(ctx.notifications.at(-1)!.body).toBe("Your other device asks to verify by comparing emoji.");
  });

  it("shows why accepting failed", async () => {
    const ctx = await withCrypto();
    const request = await incoming(ctx);
    await ctx.adapter.openConversation(REQUEST_ENTRY);
    request.accept.mockRejectedValueOnce(new Error("offline"));
    await ctx.answer("verify-incoming");
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "verify-incoming" }, busy: false, error: "offline" });
  });

  it("forgets the verification when signing out", async () => {
    const ctx = await withCrypto();
    const request = await incoming(ctx);
    await ctx.adapter.openConversation(REQUEST_ENTRY);
    let accepted!: () => void;
    request.accept.mockImplementationOnce(() => new Promise<void>((resolve) => (accepted = resolve)));
    const answering = ctx.answer("verify-incoming");
    await ctx.adapter.signOut();
    accepted();
    await answering;
    expect(ctx.prompt().prompt.id).toBe("login");
    // A request from the old session's crypto state is ignored.
    ctx.e2ee.requested(new FakeVerification(false));
    expect(ctx.notifications).toHaveLength(1);
  });

  it("drops a mismatch that finishes after signing out", async () => {
    const ctx = await withCrypto();
    await startOutgoing(ctx);
    ctx.e2ee.outgoing.set({ phase: "emoji", emoji: EMOJI });
    let cancelled!: () => void;
    ctx.e2ee.outgoing.cancel.mockImplementationOnce(() => new Promise<void>((resolve) => (cancelled = resolve)));
    const cancelling = ctx.act({ type: "cancelPrompt", id: "verify-emoji" });
    await ctx.adapter.signOut();
    cancelled();
    await cancelling;
    expect(ctx.prompt().prompt.id).toBe("login");
  });

  it("ignores the verification entries outside the chat", async () => {
    const ctx = await withCrypto();
    const id = entry(ctx, "📱 Verify with another device")!.id;
    await startOutgoing(ctx);
    await ctx.act({ type: "select", channelId: id });
    expect(ctx.e2ee.requestVerification).toHaveBeenCalledTimes(1);
  });
});

describe("encryption edge cases", () => {
  it("keeps placeholders whose keys still do not work, and copes with failures and removals meanwhile", async () => {
    const ctx = await withCrypto();
    await ctx.open("Bo");
    // Still no key, then a throwing decryption: both stay as they were.
    ctx.e2ee.keys(["S1"]);
    await flush();
    ctx.e2ee.decrypt.mockRejectedValueOnce(new Error("broken"));
    ctx.e2ee.keys(["S1"]);
    await flush();
    expect(ctx.messages().at(-1)!.content).toBe("🔒 Unable to decrypt: the key has not arrived (yet)");

    // The event is redacted while it is being decrypted.
    let decrypted!: (event: MxEvent) => void;
    ctx.e2ee.decrypt.mockImplementationOnce(() => new Promise((resolve) => (decrypted = resolve)));
    ctx.e2ee.keys(["S1"]);
    await flush();
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [{ kind: "redaction", id: "$r1", sender: BO, ts: 9000, redacts: "$c2" }] })] }));
    decrypted(msg("c2", BO, "too late", 4000));
    await flush();
    expect(ctx.messages().map((m) => m.content)).toEqual(["decrypted hello"]);
  });

  it("stops decrypting again once signed out", async () => {
    const ctx = await withCrypto();
    let decrypted!: (event: MxEvent) => void;
    ctx.e2ee.decrypt.mockImplementationOnce(() => new Promise((resolve) => (decrypted = resolve)));
    ctx.e2ee.keys(["S1"]);
    await flush();
    await ctx.adapter.signOut();
    decrypted(msg("c2", BO, "late", 4000));
    ctx.e2ee.keys(["S1"]);
    await flush();
    expect(ctx.e2ee.decrypt).toHaveBeenCalledTimes(3);
  });

  it("drops decrypted events of types that are not shown", async () => {
    const ctx = await withCrypto();
    ctx.e2ee.clear.set("$x1", undefined);
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [encRaw("x1", BO, 8000)] })] }));
    await ctx.open("Bo");
    expect(ctx.messages()).toHaveLength(2);
  });

  it("stops a sync whose decryption outlasts the session", async () => {
    const ctx = await withCrypto();
    let received!: () => void;
    ctx.e2ee.receiveSync.mockImplementationOnce(() => new Promise<void>((resolve) => (received = resolve)));
    ctx.api.push(sync({ joined: [room("!dm:x.org", { timeline: [msg("late", BO, "late", 9000)] })], crypto: { toDevice: "[]", changed: [], left: [], oneTimeKeys: {} } }));
    await flush();
    await ctx.adapter.signOut();
    received();
    await flush();
    expect(ctx.e2ee.receiveSync).toHaveBeenCalledTimes(2);
    expect(ctx.directs.at(-1)).toEqual([]);
  });

  it("logs to the console by default, never with secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const crypto = { open: vi.fn(async (): Promise<E2ee> => Promise.reject("no IndexedDB")), deleteStore: vi.fn(async () => {}) };
    const ctx = setup({ session: SESSION_JSON }, false, { crypto, log: undefined });
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    expect(warn).toHaveBeenCalledWith("[matrix] Encryption could not start: no IndexedDB");
  });

  it("signs out of a session without a key store", async () => {
    const crypto = { open: vi.fn(), deleteStore: vi.fn(async () => {}) };
    const ctx = setup({ session: JSON.stringify({ ...SESSION, ownDevice: false }) }, false, { crypto });
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.signOut();
    expect(crypto.deleteStore).not.toHaveBeenCalled();
  });

  it("ignores the verify entry outside the chat", async () => {
    const ctx = await withCrypto();
    const id = ctx.chat().sidebar.find((i) => i.name === "🔑 Verify this device")!.id;
    await ctx.act({ type: "select", channelId: id });
    const renders = ctx.renders.length;
    await ctx.act({ type: "select", channelId: id });
    expect(ctx.renders).toHaveLength(renders);
  });

  it("does nothing for the retry screen's missing secondary button", async () => {
    const ctx = setup();
    ctx.api.loginFlows.mockRejectedValueOnce(new Error("offline"));
    await ctx.adapter.start();
    const renders = ctx.renders.length;
    await ctx.act({ type: "cancelPrompt", id: "retry" });
    expect(ctx.renders).toHaveLength(renders);
  });
});

describe("abandoned OAuth sign-ins", () => {
  it("ignores failures and answers that arrive after Back", async () => {
    const ctx = await atOAuth();
    // The code request fails after Back.
    let fail!: (error: Error) => void;
    ctx.oauth.authorizeDevice.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const answering = ctx.answer("oauth");
    await flush();
    (ctx.adapter as unknown as { grantAttempt: number }).grantAttempt++;
    fail(new Error("late"));
    await answering;
    expect(ctx.renders.at(-1)).toEqual({ screen: "connecting", platform: "Matrix", status: "Getting a sign-in code…" });
    (ctx.adapter as unknown as { step: string }).step = "oauth";

    // A pending answer and a failing poll, both after Back.
    for (const outcome of [() => Promise.resolve({ state: "pending" } as DevicePoll), () => Promise.reject(new Error("offline"))]) {
      let answer!: () => void;
      ctx.oauth.pollDevice.mockImplementationOnce(() => new Promise((resolve, reject) => (answer = () => void outcome().then(resolve, reject))));
      await ctx.answer("oauth");
      await flush();
      await ctx.act({ type: "cancelPrompt", id: "device" });
      answer();
      await flush();
      expect(ctx.prompt().prompt.id).toBe("oauth");
      expect(ctx.prompt().error).toBeUndefined();
    }

    // The token check fails after Back.
    let reject!: (error: Error) => void;
    ctx.api.whoami.mockImplementationOnce(() => new Promise((_resolve, r) => (reject = r)));
    await ctx.answer("oauth");
    await flush();
    await ctx.act({ type: "cancelPrompt", id: "device" });
    reject(new Error("late"));
    await flush();
    expect(ctx.prompt().error).toBeUndefined();
  });

  it("signs in through a server without a revocation endpoint", async () => {
    const ctx = await atOAuth();
    const { revocationEndpoint: _r, ...server } = OAUTH_SERVER;
    (ctx.adapter as unknown as { oauthServer: OAuthServer }).oauthServer = server;
    await ctx.answer("oauth");
    await flush();
    expect(JSON.parse(ctx.secrets.get("session")!).oauth).not.toHaveProperty("revocationEndpoint");
  });
});

describe("decrypting again", () => {
  it("leaves events of no known session alone when only some sessions got keys", async () => {
    const ctx = await withCrypto();
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [encRaw("n1", BO, 9000, { sessionId: undefined })] })] }));
    ctx.e2ee.decrypt.mockClear();
    ctx.e2ee.keys(["S1"]);
    await flush();
    expect(ctx.e2ee.decrypt.mock.calls.map(([, e]) => e.id)).toEqual(["$c2"]);
  });
});

// --- Calls ------------------------------------------------------------------------------

const FOCUS = "https://jwt.call.x.org";
const callMember = (user: string, deviceId: string, extra: Partial<MxCallMember> = {}): MxCallMember => ({
  user,
  deviceId,
  createdTs: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  focus: FOCUS,
  identities: [`${user}:${deviceId}`],
  ...extra,
});
const BO_KEY = "_@bo:x.org_BD_m.call";
const MY_KEY = "_@me:x.org_D_m.call";
const callSync = (roomId: string, ...entries: [string, MxCallMember | null][]) => sync({ joined: [room(roomId, { calls: new Map(entries) })] });

/** A signed-in adapter whose homeserver names a call service. */
async function withCalls(options: { session?: MxSession; lock?: boolean; secrets?: Record<string, string>; first?: MxSync; foci?: string[]; transports?: MxRtcTransport[] } = {}) {
  const lockHosts = vi.fn(async (_hosts: string[]) => {});
  const log = vi.fn();
  const ctx = setup({ session: JSON.stringify(options.session ?? SESSION), ...options.secrets }, false, { log, ...(options.lock ? { lockHosts } : {}) });
  ctx.api.rtcFoci.mockResolvedValue(options.foci ?? [FOCUS]);
  ctx.api.rtcTransports.mockResolvedValue(options.transports ?? []);
  const calls: IncomingCall[] = [];
  ctx.adapter.onIncomingCall((call) => calls.push(call));
  ctx.api.push(options.first ?? initialSync());
  await ctx.adapter.start();
  await flush();
  const callItem = (name: string) => ctx.chat().sidebar.find((i) => i.kind === "voice" && i.name === name);
  const join = async (name: string) => {
    await ctx.act({ type: "joinVoice", channelId: callItem(name)!.id });
    await flush();
  };
  /** Starts joining without waiting for it to finish. */
  const begin = async (name: string) => {
    const joining = ctx.act({ type: "joinVoice", channelId: callItem(name)!.id });
    await flush();
    return joining;
  };
  const voice = () => ctx.chat().voice;
  return { ...ctx, lockHosts, log, calls, callItem, join, begin, voice };
}

const anyCall = (state: NativeViewState) => (state.screen === "chat" ? state.sidebar.find((i) => i.kind === "voice")!.id : "");

describe("call services and the host lock", () => {
  it("looks up the call services before locking, and allows them and known LiveKit servers", async () => {
    const lockHosts = vi.fn(async (_hosts: string[]) => {});
    const ctx = setup({ session: SESSION_JSON, rtc: JSON.stringify({ foci: ["https://old.x.org"], sfu: ["sfu.call.x.org", "Bad_Host!", 5] }) }, false, { lockHosts });
    ctx.api.rtcTransports.mockResolvedValue([{ service: "https://mrtc.x.org/livekit/jwt" }]);
    ctx.api.rtcFoci.mockResolvedValue([FOCUS, "https://mrtc.x.org/livekit/jwt"]);
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    expect(ctx.api.rtcTransports).toHaveBeenCalledWith(SESSION);
    expect(lockHosts).toHaveBeenCalledWith(["x.org", "hs.x.org", "mrtc.x.org", "jwt.call.x.org", "sfu.call.x.org"]);
    expect(JSON.parse(ctx.secrets.get("rtc")!)).toEqual({ foci: ["https://mrtc.x.org/livekit/jwt", FOCUS], sfu: ["sfu.call.x.org"] });
  });

  it("keeps the stored services when the lookup finds none, and ignores a stored record it cannot read", async () => {
    const lockHosts = vi.fn(async (_hosts: string[]) => {});
    const ctx = setup({ session: SESSION_JSON, rtc: JSON.stringify({ foci: [FOCUS, "http://bad"], sfu: "x" }) }, false, { lockHosts });
    ctx.api.rtcTransports.mockRejectedValue(new Error("offline"));
    ctx.api.rtcFoci.mockRejectedValue(new Error("offline"));
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    expect(lockHosts).toHaveBeenCalledWith(["x.org", "hs.x.org", "jwt.call.x.org"]);
    const broken = setup({ rtc: "{" }, false, { lockHosts: vi.fn(async () => {}) });
    await broken.adapter.start();
    expect(broken.secrets.get("rtc")).toBe("{");
  });

  it("asks the homeserver for its call transports once signed in, for the next start", async () => {
    const ctx = setup();
    ctx.api.rtcTransports.mockResolvedValue([{ service: FOCUS, sfu: SFU }]);
    await ctx.adapter.start();
    expect(ctx.api.rtcTransports).not.toHaveBeenCalled();
    ctx.api.push(initialSync());
    await ctx.answer("login", { user: "me", password: "pw" });
    await flush();
    expect(ctx.api.rtcTransports).toHaveBeenCalledWith(SESSION);
    expect(JSON.parse(ctx.secrets.get("rtc")!)).toEqual({ foci: [FOCUS], sfu: [], servers: [{ url: SFU, focus: FOCUS }] });
  });

  it("includes the call service in the lock before signing in", async () => {
    const lockHosts = vi.fn(async (_hosts: string[]) => {});
    const ctx = setup({}, false, { lockHosts });
    ctx.api.rtcFoci.mockResolvedValue([FOCUS]);
    await ctx.adapter.start();
    expect(ctx.api.rtcTransports).not.toHaveBeenCalled();
    expect(lockHosts).toHaveBeenCalledWith(["x.org", "hs.x.org", "jwt.call.x.org"]);
  });
});

describe("calls in rooms", () => {
  it("lists ongoing calls with who is in them, and offers to start one in the open room", async () => {
    const ctx = await withCalls();
    expect(ctx.chat().sidebar.some((i) => i.kind === "voice")).toBe(false);
    await ctx.open("Lounge");
    expect(ctx.callItem("Start a call in Lounge")).toMatchObject({ kind: "voice", active: false });
    await ctx.live(
      callSync(
        "!lounge:x.org",
        ["_@ana:x.org_A1_m.call", callMember(ANA, "A1")],
        ["_@ana:x.org_A2_m.call", callMember(ANA, "A2")],
        ["old", callMember(BO, "B1", { expiresAt: Date.now() - 1 })],
        ["gone", callMember("@cy:x.org", "C1")],
      ),
    );
    await ctx.live(sync({ joined: [room("!lounge:x.org", { state: { members: { "@cy:x.org": { membership: "leave" } } } })] }));
    const sidebar = ctx.chat().sidebar;
    const calls = sidebar.findIndex((i) => i.kind === "category" && i.name === "Calls");
    expect(sidebar[calls + 1]).toMatchObject({ name: "Lounge", kind: "voice", members: [{ name: "Ana", muted: false, video: false }] });
    expect(ctx.callItem("Start a call in Lounge")).toBeUndefined();
    expect(sidebar.findIndex((i) => i.name === "Direct messages")).toBeGreaterThan(calls);
    // The memberships end.
    await ctx.live(callSync("!lounge:x.org", ["_@ana:x.org_A1_m.call", null], ["_@ana:x.org_A2_m.call", null]));
    expect(ctx.callItem("Lounge")).toBeUndefined();
  });

  it("offers no new call where the homeserver names no call service, but joins others' calls", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    expect(ctx.chat().sidebar.some((i) => i.kind === "voice")).toBe(false);
    await ctx.live(callSync("!lounge:x.org", ["k", callMember(ANA, "A1")]));
    await ctx.act({ type: "joinVoice", channelId: anyCall(ctx.last()) });
    await flush();
    expect(ctx.api.liveKitGrant).toHaveBeenCalledWith(FOCUS, "!lounge:x.org", "D", OPENID);
  });

  it("shows profile pictures it has", async () => {
    const ctx = await withCalls();
    (ctx.adapter as unknown as { avatars: Map<string, string> }).avatars.set("mxc://x.org/bo", "data:image/png;base64,AA");
    await ctx.live(callSync("!dm:x.org", [BO_KEY, callMember(BO, "BD", { createdTs: 1 })]));
    expect(ctx.callItem("Bo")!.members).toEqual([{ name: "Bo", avatarUrl: "data:image/png;base64,AA", muted: false, video: false }]);
  });
});

describe("joining a call", () => {
  it("joins an unencrypted DM's call, rings the other side, and leaves again", async () => {
    const ctx = await withCalls();
    await ctx.open("Bo");
    let grant!: (g: MxLiveKitGrant) => void;
    ctx.api.liveKitGrant.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)));
    const joining = ctx.begin("Start a call in Bo");
    await flush();
    // Connecting: the view waits for the grant.
    expect(ctx.voice()).toEqual({ channelId: expect.any(String), channelName: "Bo", guildName: "", mute: false, deaf: false, video: false, stream: false });
    expect(ctx.api.encryption).toHaveBeenCalledWith(SESSION, "!dm:x.org");
    grant({ url: "wss://sfu.call.x.org/", jwt: "jwt1" });
    await joining;
    await flush();
    expect(ctx.voice()).toMatchObject({ url: "wss://sfu.call.x.org/", token: "jwt1" });
    expect(ctx.voice()).not.toHaveProperty("e2ee");
    expect(ctx.api.sendState).toHaveBeenCalledWith(SESSION, "!dm:x.org", "org.matrix.msc3401.call.member", MY_KEY, expect.objectContaining({ application: "m.call", device_id: "D" }));
    // Element rings only for an open call slot.
    expect(ctx.api.sendState).toHaveBeenCalledWith(SESSION, "!dm:x.org", "org.matrix.msc4143.rtc.slot", "m.call#ROOM", { status: "open", application: { type: "m.call" } });
    expect(ctx.api.send).toHaveBeenCalledWith(
      SESSION,
      "!dm:x.org",
      expect.objectContaining({ notification_type: "ring", "m.relates_to": { event_id: "$state1", rel_type: "m.reference" } }),
      "org.matrix.msc4075.rtc.notification",
    );
    expect(ctx.callItem("Bo")).toMatchObject({ active: true });
    // Our own membership comes back in the sync.
    await ctx.live(callSync("!dm:x.org", [MY_KEY, callMember(ME, "D")]));
    expect(ctx.callItem("Bo")!.members).toEqual([{ name: "Me", muted: false, video: false }]);
    // Joining it again does nothing.
    await ctx.join("Bo");
    expect(ctx.api.openIdToken).toHaveBeenCalledTimes(1);

    await ctx.act({ type: "voiceState", mute: true, deaf: false, video: true, stream: false });
    expect(ctx.voice()).toMatchObject({ mute: true, video: true });
    await ctx.act({ type: "leaveVoice" });
    await flush();
    expect(ctx.voice()).toBeNull();
    expect(ctx.api.sendState).toHaveBeenLastCalledWith(SESSION, "!dm:x.org", "org.matrix.msc3401.call.member", MY_KEY, {});
    // Without a call, these change nothing.
    await ctx.act({ type: "voiceState", mute: true, deaf: true, video: false, stream: false });
    await ctx.act({ type: "leaveVoice" });
    expect(ctx.voice()).toBeNull();
  });

  it("logs a ring it could not send, and does not ring when someone is already in the call", async () => {
    const ctx = await withCalls();
    await ctx.open("Bo");
    ctx.api.send.mockRejectedValueOnce(new Error("offline"));
    await ctx.join("Start a call in Bo");
    expect(ctx.log).toHaveBeenCalledWith("Ring not sent: offline");
    await ctx.act({ type: "leaveVoice" });
    // Without the slot (e.g. no right to set it), it still rings, for clients that do without one.
    ctx.api.sendState.mockImplementation(async (_s, _room, type) => {
      if (type === "org.matrix.msc4143.rtc.slot") throw new Error("forbidden");
      return "$state";
    });
    ctx.api.send.mockClear();
    await ctx.join("Start a call in Bo");
    expect(ctx.log).toHaveBeenCalledWith("Call slot not opened: forbidden");
    expect(ctx.api.send).toHaveBeenCalledWith(SESSION, "!dm:x.org", expect.objectContaining({ notification_type: "ring" }), "org.matrix.msc4075.rtc.notification");
    await ctx.act({ type: "leaveVoice" });
    await ctx.live(callSync("!dm:x.org", [BO_KEY, callMember(BO, "BD", { createdTs: 1 })]));
    ctx.api.send.mockClear();
    await ctx.join("Bo");
    expect(ctx.api.send).not.toHaveBeenCalled();
    // Rooms other than DMs do not ring.
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    expect(ctx.api.send).not.toHaveBeenCalled();
    // The DM call was left for this one.
    expect(ctx.voice()).toMatchObject({ channelName: "Lounge" });
    expect(ctx.api.sendState).toHaveBeenCalledWith(SESSION, "!dm:x.org", "org.matrix.msc3401.call.member", MY_KEY, {});
  });

  it("ends the call when the view's connection fails, or the room is left", async () => {
    const ctx = await withCalls();
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    // A camera that won't start leaves the call going, the camera off.
    await ctx.act({ type: "voiceState", mute: false, deaf: false, video: true, stream: true });
    await ctx.act({ type: "voiceNotice", message: "The camera could not start: busy", off: "video" });
    expect(ctx.voice()).toMatchObject({ video: false, stream: true });
    expect(ctx.chat().error).toBe("The camera could not start: busy");
    await ctx.act({ type: "voiceNotice", message: "Could not switch devices: gone" });
    expect(ctx.voice()).toMatchObject({ stream: true });
    await ctx.act({ type: "voiceError", message: "Disconnected from voice" });
    expect(ctx.voice()).toBeNull();
    expect(ctx.chat().error).toBe("The call ended: Disconnected from voice");
    await ctx.act({ type: "voiceNotice", message: "late" }); // no call any more
    expect(ctx.chat().error).toBe("The call ended: Disconnected from voice");
    await ctx.join("Start a call in Lounge");
    await ctx.live(sync({ left: ["!lounge:x.org"] }));
    expect(ctx.voice()).toBeNull();
    expect(ctx.chat().error).toBe("You left the room, so you left its call too.");
  });

  it("leaves an unencrypted call once the room turns encrypted", async () => {
    const ctx = await withCalls();
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    await ctx.live(sync({ joined: [room("!lounge:x.org", { state: { encrypted: true, encryption: { algorithm: "m.megolm.v1.aes-sha2" }, members: {} } })] }));
    expect(ctx.voice()).toBeNull();
    expect(ctx.chat().error).toBe("This room is now end-to-end encrypted. Join the call again to encrypt it too.");
  });

  it("says why it cannot join", async () => {
    // A token copied from Element is Element's device.
    const token = await withCalls({ session: { ...SESSION, ownDevice: false } });
    await token.open("Lounge");
    await token.join("Start a call in Lounge");
    expect(token.chat().error).toBe(TOKEN_CALL_NOTICE);
    expect(token.voice()).toBeNull();

    // Encrypted rooms need encryption, which this build lacks.
    const plain = await withCalls();
    await plain.open("Secret");
    await plain.join("Start a call in Secret");
    expect(plain.chat().error).toBe(ENCRYPTED_CALL_NOTICE);

    // A room that turned out to be encrypted when asked.
    await plain.open("Lounge");
    plain.api.encryption.mockResolvedValueOnce({ algorithm: "m.megolm.v1.aes-sha2" });
    await plain.join("Start a call in Lounge");
    expect(plain.chat().error).toBe(ENCRYPTED_CALL_NOTICE);

    // The server cannot say whether the room is encrypted.
    const unsure = await withCalls();
    await unsure.open("Lounge");
    unsure.api.encryption.mockRejectedValueOnce(new Error("offline"));
    await unsure.join("Start a call in Lounge");
    expect(unsure.chat().error).toBe("Could not check whether this room is encrypted, so Multicord did not join its call: offline");
    expect(unsure.api.openIdToken).not.toHaveBeenCalled();
  });

  it("says when the homeserver has no call service, or one found after starting", async () => {
    const none = await signedIn();
    await none.live(callSync("!lounge:x.org", ["k", callMember(ANA, "A1", { focus: undefined })]));
    await none.act({ type: "joinVoice", channelId: anyCall(none.last()) });
    await flush();
    expect(none.chat().error).toBe("x.org offers no calls: its homeserver names no call service (MatrixRTC with LiveKit), which Element Call needs as well.");

    const lockHosts = vi.fn(async (_hosts: string[]) => {});
    const late = setup({ session: SESSION_JSON }, false, { lockHosts });
    late.api.push(initialSync());
    await late.adapter.start();
    await flush();
    // Found after the lock: not reachable until the next start.
    (late.adapter as unknown as { rtc: { foci: string[]; sfu: string[] } }).rtc = { foci: [FOCUS], sfu: [] };
    await late.open("Lounge");
    await late.act({ type: "joinVoice", channelId: anyCall(late.last()) });
    await flush();
    expect(late.chat().error).toBe("The call service jwt.call.x.org is new to Multicord, which fixes the hosts it may reach when it starts. Restart Multicord to use it.");
  });

  it("learns a new LiveKit server's host for the next start", async () => {
    const ctx = await withCalls({ lock: true });
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    expect(ctx.voice()).toBeNull();
    expect(ctx.chat().error).toBe(
      "The call server sfu.call.x.org is new to Multicord, which fixes the hosts it may reach (and so calls) when it starts. Restart Multicord once to allow it; calls work from then on.",
    );
    expect(JSON.parse(ctx.secrets.get("rtc")!)).toEqual({ foci: [FOCUS], sfu: ["sfu.call.x.org"] });
    expect(ctx.api.sendState).not.toHaveBeenCalled();
  });

  it("still says so when the host cannot be stored", async () => {
    const ctx = await withCalls({ lock: true });
    ctx.secrets.set = () => {
      throw new Error("disk full");
    };
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    expect(ctx.chat().error).toContain("Restart Multicord once to allow it");
  });

  it("joins once the LiveKit server is allowed", async () => {
    const ctx = await withCalls({ lock: true, secrets: { rtc: JSON.stringify({ foci: [FOCUS], sfu: ["sfu.call.x.org"] }) } });
    expect(ctx.lockHosts).toHaveBeenCalledWith(["x.org", "hs.x.org", "jwt.call.x.org", "sfu.call.x.org"]);
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    expect(ctx.voice()).toMatchObject({ token: "jwt1" });
  });

  it("carries on when the shell refuses the lock", async () => {
    const lockHosts = vi.fn(async (_hosts: string[]) => {
      throw new Error("A host lock can only narrow");
    });
    const ctx = setup({ session: SESSION_JSON }, false, { lockHosts, log: vi.fn() });
    ctx.api.rtcFoci.mockResolvedValue([FOCUS]);
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    await ctx.open("Lounge");
    await ctx.act({ type: "joinVoice", channelId: anyCall(ctx.last()) });
    await flush();
    expect(ctx.chat().voice).toMatchObject({ token: "jwt1" });
  });

  it("reports a failed join and cleans up", async () => {
    const ctx = await withCalls();
    await ctx.open("Lounge");
    ctx.api.openIdToken.mockRejectedValueOnce(new MatrixError(429, "M_LIMIT_EXCEEDED", "slow down"));
    await ctx.join("Start a call in Lounge");
    expect(ctx.chat().error).toBe("Could not join the call: Too many attempts. Wait a while and try again.");
    expect(ctx.voice()).toBeNull();
  });

  it("says what the server forbids, not that the password is wrong", async () => {
    const ctx = await withCalls();
    await ctx.open("Lounge");
    // Synapse's answer when the room's power levels keep members from announcing a call membership.
    ctx.api.sendState.mockRejectedValueOnce(new MatrixError(403, "M_FORBIDDEN", "You don't have permission to post that to the room."));
    await ctx.join("Start a call in Lounge");
    expect(ctx.chat().error).toBe("Could not join the call: You don't have permission to post that to the room.");
    expect(ctx.voice()).toBeNull();
  });

  it("gives up when the call service does not answer", async () => {
    vi.useFakeTimers();
    const ctx = await withCalls();
    await ctx.open("Lounge");
    ctx.api.liveKitGrant.mockImplementationOnce(() => new Promise(() => {}));
    void ctx.begin("Start a call in Lounge");
    await flush();
    await vi.advanceTimersByTimeAsync(CALL_JOIN_TIMEOUT_MS);
    expect(ctx.voice()).toBeNull();
    expect(ctx.chat().error).toBe("Could not join the call: the call service did not answer.");
  });

  it("does not time out a call that joined, and drops a join the user moved on from", async () => {
    vi.useFakeTimers();
    const ctx = await withCalls();
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    await vi.advanceTimersByTimeAsync(CALL_JOIN_TIMEOUT_MS);
    expect(ctx.voice()).toMatchObject({ token: "jwt1" });
    await ctx.act({ type: "leaveVoice" });

    // Asked twice while the encryption check ran: the first is dropped.
    let answer!: (e: MxEncryption | undefined) => void;
    ctx.api.encryption.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const joining = ctx.act({ type: "joinVoice", channelId: ctx.callItem("Start a call in Lounge")!.id });
    await flush();
    await ctx.act({ type: "joinVoice", channelId: ctx.callItem("Start a call in Lounge")!.id });
    answer(undefined);
    await joining;
    await flush();
    expect(ctx.api.openIdToken).toHaveBeenCalledTimes(2);

    // Left while getting access: the failure is not shown.
    await ctx.act({ type: "leaveVoice" });
    let fail!: (e: Error) => void;
    ctx.api.openIdToken.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const failing = ctx.begin("Start a call in Lounge");
    await flush();
    await ctx.act({ type: "leaveVoice" });
    fail(new Error("late"));
    await failing;
    await flush();
    expect(ctx.chat().error).toBeUndefined();

    // Left while joining succeeded.
    let grant!: (g: MxLiveKitGrant) => void;
    ctx.api.liveKitGrant.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)));
    const late = ctx.begin("Start a call in Lounge");
    await flush();
    await ctx.act({ type: "leaveVoice" });
    grant({ url: "wss://sfu.call.x.org/", jwt: "late" });
    await late;
    await flush();
    expect(ctx.voice()).toBeNull();
  });

  it("joins once when asked twice while the call before is still being left", async () => {
    vi.useFakeTimers();
    const ctx = await withCalls();
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    // Leaving the Lounge call takes a while; meanwhile the next call is asked for twice (a double click).
    let left!: () => void;
    ctx.api.sendState.mockImplementationOnce(() => new Promise((resolve) => (left = () => resolve("$left"))));
    await ctx.open("Bo");
    const id = ctx.callItem("Start a call in Bo")!.id;
    const first = ctx.act({ type: "joinVoice", channelId: id });
    await flush();
    await ctx.act({ type: "joinVoice", channelId: id });
    await flush();
    left();
    await first;
    await flush();
    // One join each: a second call in the same room would keep its membership (and its delayed leave) alive after leaving.
    expect(ctx.api.openIdToken).toHaveBeenCalledTimes(2);
    expect(ctx.voice()).toMatchObject({ token: "jwt1" });
    // And no stray join timer ends the call that joined.
    await vi.advanceTimersByTimeAsync(CALL_JOIN_TIMEOUT_MS);
    expect(ctx.voice()).toMatchObject({ token: "jwt1" });
    expect(ctx.chat().error).toBeUndefined();
  });

  it("leaves when the membership cannot be kept", async () => {
    vi.useFakeTimers();
    const ctx = await withCalls();
    ctx.api.supports.mockResolvedValue(true);
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    expect(ctx.api.sendDelayedState).toHaveBeenCalled();
    ctx.api.updateDelayed.mockRejectedValueOnce(new MatrixError(404, "M_NOT_FOUND", "gone"));
    ctx.api.sendState.mockRejectedValueOnce(new MatrixError(403, "M_FORBIDDEN", "not allowed"));
    await vi.advanceTimersByTimeAsync(4000);
    await flush();
    expect(ctx.voice()).toBeNull();
    expect(ctx.chat().error).toBe("The call membership was lost: not allowed");
  });

  it("ignores joins of unknown entries", async () => {
    const ctx = await withCalls();
    await ctx.act({ type: "joinVoice", channelId: "999" });
    await ctx.act({ type: "joinVoice", channelId: ctx.item("Lounge").id });
    expect(ctx.voice()).toBeNull();
  });

  it("uses the call service the people in the call use, and marks those it cannot reach", async () => {
    const ctx = await withCalls();
    await ctx.live(
      callSync(
        "!lounge:x.org",
        ["a", callMember(ANA, "A1", { focus: "https://other.x.org" })],
        ["b", callMember(BO, "B1", { focus: "https://other.x.org" })],
        ["c", callMember("@cy:x.org", "C1")],
        ["d", callMember("@dee:x.org", "D1", { focus: undefined })],
      ),
    );
    await ctx.join("Lounge");
    expect(ctx.api.liveKitGrant).toHaveBeenCalledWith("https://other.x.org", "!lounge:x.org", "D", OPENID);
    expect(ctx.callItem("Lounge")!.members!.map((m) => m.name)).toEqual(["Ana", "@bo:x.org", `@cy:x.org · ${OTHER_SERVER_LABEL}`, "@dee:x.org"]);
  });

  it("leaves the call when signing out, and drops it when the session ends", async () => {
    const ctx = await withCalls();
    await ctx.open("Lounge");
    await ctx.join("Start a call in Lounge");
    await ctx.act({ type: "logout" });
    await flush();
    expect(ctx.api.sendState).toHaveBeenLastCalledWith(SESSION, "!lounge:x.org", "org.matrix.msc3401.call.member", MY_KEY, {});

    const ended = await withCalls();
    await ended.open("Lounge");
    await ended.join("Start a call in Lounge");
    await ended.live(new MatrixError(401, "M_UNKNOWN_TOKEN", "gone"));
    await flush();
    expect(ended.api.sendState).toHaveBeenCalledTimes(1);
  });
});

describe("ringing", () => {
  it("rings when someone starts a call in a DM, until it ends or is joined", async () => {
    const ctx = await withCalls();
    await ctx.live(callSync("!dm:x.org", [BO_KEY, callMember(BO, "BD", { intent: "video" })]));
    expect(ctx.calls).toEqual([{ conversationKey: "!dm:x.org", from: "Bo", video: true }]);
    expect(ctx.callItem("Bo")).toMatchObject({ unread: true, mentions: 1 });
    expect(ctx.chat().error).toBe("📞 Bo is calling. Join under Calls in the sidebar.");
    // A second device joining does not ring again.
    await ctx.live(callSync("!dm:x.org", ["_@bo:x.org_B2_m.call", callMember(BO, "B2")]));
    expect(ctx.calls).toHaveLength(1);
    await ctx.live(callSync("!dm:x.org", [BO_KEY, null], ["_@bo:x.org_B2_m.call", null]));
    expect(ctx.chat().error).toBeUndefined();

    await ctx.live(callSync("!dm:x.org", [BO_KEY, callMember(BO, "BD")]));
    expect(ctx.calls[1]).toEqual({ conversationKey: "!dm:x.org", from: "Bo", video: false });
    await ctx.join("Bo");
    expect(ctx.chat().error).toBeUndefined();
  });

  it("stops ringing when the DM is left", async () => {
    const ctx = await withCalls();
    await ctx.live(callSync("!dm:x.org", [BO_KEY, callMember(BO, "BD")]));
    await ctx.live(sync({ left: ["!dm:x.org"] }));
    expect(ctx.chat().error).toBeUndefined();
  });

  it("does not ring for old calls, calls seen at start, our own, or rooms", async () => {
    const first = initialSync();
    first.joined[0]!.calls = new Map([[BO_KEY, callMember(BO, "BD")]]);
    const ctx = await withCalls({ first });
    expect(ctx.calls).toHaveLength(0);
    await ctx.live(callSync("!dm:x.org", [BO_KEY, null]));
    await ctx.live(callSync("!dm:x.org", [BO_KEY, callMember(BO, "BD", { createdTs: Date.now() - RING_WINDOW_MS - 1 })]));
    await ctx.live(callSync("!dm:x.org", [BO_KEY, null]));
    // We are in it on another device.
    await ctx.live(callSync("!dm:x.org", ["_@me:x.org_PHONE_m.call", callMember(ME, "PHONE")], [BO_KEY, callMember(BO, "BD")]));
    await ctx.live(callSync("!lounge:x.org", ["a", callMember(ANA, "A1")]));
    expect(ctx.calls).toHaveLength(0);
  });
});

describe("encrypted calls", () => {
  it("joins encrypted, shares media keys over Olm and passes everyone's keys to the view", async () => {
    const ctx = await withCrypto();
    const calls = (roomId: string, ...entries: [string, MxCallMember | null][]) => ctx.live(sync({ joined: [room(roomId, { calls: new Map(entries) })] }));
    await calls("!dm:x.org", [BO_KEY, callMember(BO, "BD", { createdTs: 1 })]);
    await ctx.act({ type: "joinVoice", channelId: anyCall(ctx.last()) });
    await flush();
    const voice = () => ctx.chat().voice!;
    expect(voice().e2ee!.keys).toEqual([{ participant: "@me:x.org:D", index: 0, key: expect.any(String) }]);
    expect(ctx.e2ee.sendToDevices).toHaveBeenCalledWith("io.element.call.encryption_keys", [{ userId: BO, deviceId: "BD" }], expect.objectContaining({ room_id: "!dm:x.org" }));
    // Bo's key arrives over Olm.
    const key = btoa("k".repeat(16));
    ctx.e2ee.toDevice.get("io.element.call.encryption_keys")!({ userId: BO, deviceId: "BD", content: { room_id: "!dm:x.org", media_key: { index: 0, key }, member: { claimed_device_id: "BD" } } });
    expect(voice().e2ee!.keys).toContainEqual({ participant: "@bo:x.org:BD", index: 0, key });
    // Ana joins: she gets the current key.
    await calls("!dm:x.org", ["_@ana:x.org_AD_m.call", callMember(ANA, "AD")]);
    expect(ctx.e2ee.sendToDevices).toHaveBeenLastCalledWith("io.element.call.encryption_keys", [{ userId: ANA, deviceId: "AD" }], expect.anything());
    // Our own membership is no participant, but its server time is ours.
    await calls("!dm:x.org", [MY_KEY, callMember(ME, "D")]);
    expect(ctx.e2ee.sendToDevices).toHaveBeenCalledTimes(2);
    // Changes in other rooms change nothing here.
    await calls("!sec:x.org", ["x", callMember(ANA, "AD")]);
    expect(ctx.e2ee.sendToDevices).toHaveBeenCalledTimes(2);
    await ctx.act({ type: "leaveVoice" });
    // Keys after leaving go nowhere.
    ctx.e2ee.toDevice.get("io.element.call.encryption_keys")!({ userId: BO, deviceId: "BD", content: {} });
    expect(ctx.chat().voice).toBeNull();
  });

  it("refuses an encrypted room's call while encryption could not start", async () => {
    const crypto = { open: vi.fn(async (): Promise<E2ee> => Promise.reject(new Error("no IndexedDB"))), deleteStore: vi.fn(async () => {}) };
    const ctx = setup({ session: SESSION_JSON }, false, { crypto, log: vi.fn() });
    ctx.api.rtcFoci.mockResolvedValue([FOCUS]);
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    await ctx.open("Secret");
    await ctx.act({ type: "joinVoice", channelId: anyCall(ctx.last()) });
    await flush();
    expect(ctx.chat().error).toBe(
      "🔒 This room is end-to-end encrypted, and so are its calls, but encryption could not start (no IndexedDB). Multicord never joins an encrypted room's call unencrypted; restart Multicord to try again.",
    );
    // Without a reason given.
    (ctx.adapter as unknown as { cryptoProblem: string | undefined }).cryptoProblem = undefined;
    await ctx.act({ type: "joinVoice", channelId: anyCall(ctx.last()) });
    await flush();
    expect(ctx.chat().error).toContain("but encryption could not start. Multicord never joins");
  });
});

// --- The newer call format: sticky m.rtc.member memberships -----------------------------

const SFU = "wss://lk.x.org";
const RTC_TYPE = "org.matrix.msc4143.rtc.member";
type RtcEvent = Extract<MxEvent, { kind: "rtc" }>;
/** A sticky membership event of `sender`'s device, on the homeserver's LiveKit server unless said otherwise. */
const rtcEvent = (sender: string, deviceId: string, memberId: string, extra: { member?: Partial<MxCallMember> | null; id?: string; expiresAt?: number } = {}): RtcEvent => {
  const expiresAt = extra.expiresAt ?? Date.now() + 3_600_000;
  return {
    kind: "rtc",
    id: extra.id ?? `$r-${memberId}`,
    sender,
    ts: Date.now(),
    key: `${sender}|${memberId}`,
    expiresAt,
    member: extra.member === null ? null : callMember(sender, deviceId, { memberId, focus: undefined, sfu: SFU, expiresAt, identities: [`hash-${memberId}`], ...extra.member }),
  };
};
const rtcSync = (roomId: string, timeline: MxEvent[], extra: Partial<MxRoomUpdate> = {}) => sync({ joined: [room(roomId, { timeline, ...extra })] });
const rtcOf = (ctx: { adapter: MatrixAdapter }, roomId: string) => (ctx.adapter as unknown as { rooms: Map<string, { rtc: Map<string, unknown> }> }).rooms.get(roomId)!.rtc;
/** A homeserver with sticky events (and delayed events), or without. */
const sticky = (api: FakeMatrixApi, has = true) => api.supports.mockImplementation(async (_s, feature) => has || feature !== "org.matrix.msc4354");

describe("reading the newer call memberships", () => {
  it("lists sticky memberships from the timeline and beside it, preferring them to the same device's state membership", async () => {
    const ctx = await withCalls();
    await ctx.live(
      // Fixed join times: people are listed in the order they joined.
      rtcSync("!lounge:x.org", [rtcEvent(ANA, "A1", "a1", { member: { createdTs: 2_000 } }), msg("l2", ANA, "joining", 600)], {
        sticky: [rtcEvent(BO, "B1", "b1", { member: { createdTs: 1_000 } })],
        calls: new Map([["_@ana:x.org_A1_m.call", callMember(ANA, "A1", { focus: "https://other.x.org" })]]),
      }),
    );
    expect(ctx.callItem("Lounge")!.members!.map((m) => m.name)).toEqual(["@bo:x.org", "Ana"]);
    // The membership is no message.
    await ctx.act({ type: "select", channelId: ctx.chat().sidebar.find((i) => i.kind === "text" && i.name === "Lounge")!.id });
    expect(ctx.messages().map((m) => m.content)).toEqual(["welcome", "joining"]);
    // The server lacks sticky events: we join in the older format, on our service (not the one Ana's state membership names), and Ana's LiveKit server is not ours.
    await ctx.join("Lounge");
    expect(ctx.api.supports).toHaveBeenCalledWith(SESSION, "org.matrix.msc4354");
    expect(ctx.api.liveKitGrant).toHaveBeenCalledWith(FOCUS, "!lounge:x.org", "D", OPENID);
    expect(ctx.api.sendState).toHaveBeenCalledWith(SESSION, "!lounge:x.org", "org.matrix.msc3401.call.member", MY_KEY, expect.objectContaining({ application: "m.call" }));
    expect(ctx.api.sendSticky).not.toHaveBeenCalled();
    expect(ctx.callItem("Lounge")!.members!.map((m) => m.name)).toEqual([`@bo:x.org · ${OTHER_SERVER_LABEL}`, `Ana · ${OTHER_SERVER_LABEL}`]);
  });

  it("keeps the current event per sticky key: later ones replace it, older and expired ones do not", async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const ctx = await withCalls();
    const end = Date.now() + 1000;
    await ctx.live(rtcSync("!lounge:x.org", [rtcEvent(ANA, "A1", "a1", { expiresAt: end })]));
    expect(ctx.callItem("Lounge")).toBeDefined();
    // The leave outlasts the join and replaces it.
    await ctx.live(rtcSync("!lounge:x.org", [rtcEvent(ANA, "A1", "a1", { id: "$leave", member: null, expiresAt: end + 1000 })]));
    expect(ctx.callItem("Lounge")).toBeUndefined();
    // An older join (e.g. from beside the timeline after a gap) does not bring it back; one that outlasts it, or ties with a later id, does.
    await ctx.live(rtcSync("!lounge:x.org", [], { sticky: [rtcEvent(ANA, "A1", "a1", { id: "$old", expiresAt: end })] }));
    expect(ctx.callItem("Lounge")).toBeUndefined();
    await ctx.live(rtcSync("!lounge:x.org", [rtcEvent(ANA, "A1", "a1", { id: "$aaa", expiresAt: end + 1000 })]));
    expect(ctx.callItem("Lounge")).toBeUndefined();
    await ctx.live(rtcSync("!lounge:x.org", [rtcEvent(ANA, "A1", "a1", { id: "$zzz", expiresAt: end + 1000 })]));
    expect(ctx.callItem("Lounge")).toBeDefined();
    // One that already stopped being sticky counts for nothing; and memberships that stopped being sticky go.
    await ctx.live(rtcSync("!lounge:x.org", [rtcEvent(BO, "B1", "b1", { expiresAt: Date.now() })]));
    expect(rtcOf(ctx, "!lounge:x.org").size).toBe(1);
    vi.setSystemTime(end + 1000);
    expect(ctx.callItem("Lounge")).toBeDefined(); // shown until the next change
    await ctx.live(rtcSync("!lounge:x.org", [rtcEvent(BO, "B1", "b1")]));
    expect([...rtcOf(ctx, "!lounge:x.org").keys()]).toEqual(["@bo:x.org|b1"]);
  });

  it("keeps a bounded number of sticky keys per room, and drops a redacted membership", async () => {
    const ctx = await withCalls();
    const many = Array.from({ length: 205 }, (_, i) => rtcEvent(`@u${i}:x.org`, "D", `m${i}`));
    await ctx.live(rtcSync("!lounge:x.org", many));
    expect(rtcOf(ctx, "!lounge:x.org").size).toBe(200);
    await ctx.live(rtcSync("!dm:x.org", [rtcEvent(BO, "BD", "b1"), rtcEvent(BO, "B2", "b2", { member: null })]));
    expect(ctx.callItem("Bo")).toBeDefined();
    await ctx.live(rtcSync("!dm:x.org", [{ kind: "redaction", id: "$red", sender: BO, ts: Date.now(), redacts: "$r-b1" }]));
    expect(ctx.callItem("Bo")).toBeUndefined();
  });

  it("rings for a DM call started in the newer format", async () => {
    const ctx = await withCalls();
    await ctx.live(rtcSync("!dm:x.org", [rtcEvent(BO, "BD", "b1", { member: { intent: "video" } })]));
    expect(ctx.calls).toEqual([{ conversationKey: "!dm:x.org", from: "Bo", video: true }]);
  });
});

describe("joining in the newer call format", () => {
  it("joins a call that uses it on the homeserver's LiveKit server, with access from the homeserver", async () => {
    const ctx = await withCalls({ lock: true, transports: [{ service: FOCUS, sfu: SFU }] });
    expect(ctx.lockHosts).toHaveBeenCalledWith(["x.org", "hs.x.org", "jwt.call.x.org", "lk.x.org"]);
    expect(JSON.parse(ctx.secrets.get("rtc")!)).toEqual({ foci: [FOCUS], sfu: [], servers: [{ url: SFU, focus: FOCUS }] });
    sticky(ctx.api);
    await ctx.live(rtcSync("!lounge:x.org", [rtcEvent(ANA, "A1", "a1")], { calls: new Map([["c", callMember("@cy:x.org", "C1")]]) }));
    await ctx.join("Lounge");
    expect(ctx.api.liveKitToken).toHaveBeenCalledWith(SESSION, { sfu: SFU, roomId: "!lounge:x.org", slotId: "m.call#ROOM", memberId: expect.stringMatching(/^[0-9a-f-]{36}$/), deviceId: "D" });
    expect(ctx.api.openIdToken).not.toHaveBeenCalled();
    expect(ctx.voice()).toMatchObject({ url: SFU, token: "jwt-hs" });
    // An unencrypted room's membership goes as it is; the leave is scheduled first.
    expect(ctx.api.sendDelayedSticky).toHaveBeenCalledWith(SESSION, "!lounge:x.org", RTC_TYPE, { slot_id: "m.call#ROOM", msc4354_sticky_key: expect.any(String) }, 18_000, 3_600_000);
    expect(ctx.api.sendSticky).toHaveBeenCalledWith(SESSION, "!lounge:x.org", RTC_TYPE, expect.objectContaining({ transports: { published: [{ type: "livekit", url: SFU }], can_subscribe: ["livekit"] } }), 3_600_000);
    expect(ctx.api.sendState).not.toHaveBeenCalled();
    // Ana is on our LiveKit server; Cy's service is the one our server's transport names.
    expect(ctx.callItem("Lounge")!.members!.map((m) => m.name)).toEqual(["Ana", "@cy:x.org"]);
    await ctx.act({ type: "leaveVoice" });
    await flush();
    expect(ctx.api.updateDelayed).toHaveBeenLastCalledWith(SESSION, "delay-s1", "send");
  });

  it("joins through the service, and on a LiveKit server the people in the call use", async () => {
    const plain = await withCalls();
    sticky(plain.api);
    // Our own device's old membership does not count as someone using the format.
    await plain.live(rtcSync("!lounge:x.org", [rtcEvent(ME, "D", "mine")]));
    await plain.join("Lounge");
    expect(plain.api.sendState).toHaveBeenCalled();
    await plain.act({ type: "leaveVoice" });
    await plain.live(rtcSync("!lounge:x.org", [rtcEvent(ANA, "A1", "a1", { member: { focus: FOCUS, sfu: undefined } })]));
    await plain.join("Lounge");
    expect(plain.api.liveKitGrant).toHaveBeenCalledWith(FOCUS, "!lounge:x.org", "D", OPENID);
    expect(plain.api.sendSticky.mock.calls[0]![3]).toMatchObject({ transports: { published: [{ type: "livekit", livekit_service_url: FOCUS }] } });

    const two = await withCalls({ transports: [{ sfu: "wss://one.x.org" }, { sfu: SFU }] });
    sticky(two.api);
    await two.live(rtcSync("!lounge:x.org", [rtcEvent(ANA, "A1", "a1")]));
    await two.join("Lounge");
    expect(two.api.liveKitToken.mock.calls[0]![1].sfu).toBe(SFU);
    // Without a service of its own, the call's service is none (nobody here names one).
    expect((two.adapter as unknown as { call: { focus: string } }).call.focus).toBe(FOCUS);
  });

  it("starts a call in the newer format where only it is possible, and says so where the homeserver lacks sticky events", async () => {
    const ctx = await withCalls({ foci: [], transports: [{ sfu: SFU }] });
    await ctx.open("Lounge");
    sticky(ctx.api, false);
    await ctx.join("Start a call in Lounge");
    expect(ctx.chat().error).toBe("x.org offers calls only in MatrixRTC's newer format, which needs sticky events (MSC4354), and its homeserver does not have them.");
    sticky(ctx.api);
    await ctx.join("Start a call in Lounge");
    expect(ctx.voice()).toMatchObject({ url: SFU });
    expect((ctx.adapter as unknown as { call: { focus: string } }).call.focus).toBe("");
    // A homeserver that cannot say is taken to lack them.
    await ctx.act({ type: "leaveVoice" });
    ctx.api.supports.mockRejectedValue(new Error("offline"));
    await ctx.join("Start a call in Lounge");
    expect(ctx.chat().error).toContain("needs sticky events");
  });

  it("says when the homeserver's LiveKit server was found after starting", async () => {
    const lockHosts = vi.fn(async (_hosts: string[]) => {});
    const ctx = setup({ session: SESSION_JSON }, false, { lockHosts });
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    await flush();
    (ctx.adapter as unknown as { rtc: object }).rtc = { foci: [], sfu: [], servers: [{ url: SFU }] };
    await ctx.open("Lounge");
    await ctx.act({ type: "joinVoice", channelId: anyCall(ctx.last()) });
    await flush();
    expect(ctx.chat().error).toBe("The call service lk.x.org is new to Multicord, which fixes the hosts it may reach when it starts. Restart Multicord to use it.");
  });

  it("reads stored LiveKit servers back only as transports", async () => {
    const lockHosts = vi.fn(async (_hosts: string[]) => {});
    const stored = { foci: [], sfu: [], servers: [{ url: SFU }, { url: "ws://plain.x.org" }, { url: "ws://plain.x.org", focus: FOCUS }, "x", { url: "wss://two.x.org", focus: "http://bad" }] };
    const ctx = setup({ session: SESSION_JSON, rtc: JSON.stringify(stored) }, false, { lockHosts });
    ctx.api.push(initialSync());
    await ctx.adapter.start();
    expect(lockHosts).toHaveBeenCalledWith(["x.org", "hs.x.org", "lk.x.org", "two.x.org"]);
  });
});

describe("encrypted calls in the newer format", () => {
  it("encrypts the membership, and gives keys under the identities each membership names", async () => {
    const ctx = await withCrypto();
    sticky(ctx.api);
    await ctx.live(rtcSync("!dm:x.org", [rtcEvent(BO, "BD", "b1", { member: { focus: FOCUS, sfu: undefined, identities: ["hash-b1", "@bo:x.org:BD"] } })]));
    await ctx.act({ type: "joinVoice", channelId: anyCall(ctx.last()) });
    await flush();
    expect(ctx.e2ee.encrypt).toHaveBeenCalledWith("!dm:x.org", { encryption: ROOM_ENCRYPTION, history: undefined }, [ME, BO], RTC_TYPE, expect.objectContaining({ slot_id: "m.call#ROOM" }));
    expect(ctx.api.sendSticky).toHaveBeenCalledWith(SESSION, "!dm:x.org", "m.room.encrypted", { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "secret" }, 3_600_000);
    const memberId = (ctx.adapter as unknown as { call: { memberId: string } }).call.memberId;
    expect(ctx.e2ee.sendToDevices).toHaveBeenCalledWith("io.element.call.encryption_keys", [{ userId: BO, deviceId: "BD" }], expect.objectContaining({ member: { claimed_device_id: "D", id: memberId } }));
    const key = btoa("k".repeat(16));
    ctx.e2ee.toDevice.get("io.element.call.encryption_keys")!({ userId: BO, deviceId: "BD", content: { room_id: "!dm:x.org", media_key: { index: 0, key }, member: { claimed_device_id: "BD", id: "b1" } } });
    expect(ctx.chat().voice!.e2ee!.keys.filter((k) => k.key === key).map((k) => k.participant)).toEqual(["hash-b1", "@bo:x.org:BD"]);
  });

  it("decrypts sticky memberships, now or once their keys arrive", async () => {
    const ctx = await withCrypto();
    const calls: IncomingCall[] = [];
    ctx.adapter.onIncomingCall((call) => calls.push(call));
    const bo = () => ctx.chat().sidebar.find((i) => i.kind === "voice" && i.name === "Bo")!;
    ctx.e2ee.clear.set("$now", rtcEvent(BO, "BD", "b1"));
    await ctx.live(rtcSync("!dm:x.org", [], { sticky: [encRaw("now", BO, 5000), encRaw("late", BO, 5000, { sessionId: "S9" }), encRaw("ring", BO, 5000, { sessionId: "S9" }), encRaw("nothing", BO, 5000, { sessionId: "S9" }), enc("big", BO, 5000)] }));
    expect(calls).toEqual([{ conversationKey: "!dm:x.org", from: "Bo", video: false }]);
    expect(ctx.chat().voice).toBeNull();
    // Keys for other sessions leave them waiting.
    ctx.e2ee.clear.set("$late", rtcEvent(BO, "B2", "b2"));
    ctx.e2ee.keys(["S8"]);
    await flush();
    expect(bo().members).toHaveLength(1);
    ctx.e2ee.clear.set("$ring", msg("ring", BO, "not a membership", 5000));
    ctx.e2ee.clear.set("$nothing", undefined);
    ctx.e2ee.keys(["S9"]);
    await flush();
    const waiting = (ctx.adapter as unknown as { rooms: Map<string, { stickyWaiting: unknown[] }> }).rooms.get("!dm:x.org")!.stickyWaiting;
    expect(waiting).toEqual([]);
    expect(ctx.chat().sidebar.filter((i) => i.kind === "voice").map((i) => i.members?.length)).toEqual([1]);
    expect(rtcOf(ctx, "!dm:x.org").size).toBe(2);

    // In the timeline, a membership whose key came late leaves the messages.
    await ctx.act({ type: "select", channelId: ctx.chat().sidebar.find((i) => i.kind === "dm" && i.name === "Bo")!.id });
    await ctx.live(rtcSync("!dm:x.org", [encRaw("tl", BO, 6000, { sessionId: "S7" })]));
    expect(ctx.messages().at(-1)!.content).toContain("Unable to decrypt");
    const shown = ctx.messages().length;
    ctx.e2ee.clear.set("$tl", rtcEvent(BO, "B3", "b3"));
    ctx.e2ee.keys(["S7"]);
    await flush();
    expect(ctx.messages()).toHaveLength(shown - 1);
    expect(rtcOf(ctx, "!dm:x.org").size).toBe(3);
  });

  it("keeps a sticky membership waiting while it cannot be decrypted, and stops when encryption does", async () => {
    const ctx = await withCrypto();
    await ctx.live(rtcSync("!dm:x.org", [], { sticky: [encRaw("w1", BO, 5000, { sessionId: "S9" })] }));
    const waiting = () => (ctx.adapter as unknown as { rooms: Map<string, { stickyWaiting: unknown[] }> }).rooms.get("!dm:x.org")!.stickyWaiting;
    ctx.e2ee.decrypt.mockRejectedValueOnce(new Error("broken"));
    ctx.e2ee.keys(["S9"]);
    await flush();
    expect(waiting()).toHaveLength(1);
    // Signed out while decrypting: nothing more happens.
    ctx.e2ee.decrypt.mockImplementationOnce(async (_room, event) => {
      (ctx.adapter as unknown as { crypto: unknown }).crypto = undefined;
      return rtcEvent(BO, "BD", "b1", { id: event.id });
    });
    ctx.e2ee.keys(["S9"]);
    await flush();
    expect(waiting()).toHaveLength(1);
  });

  it("shares keys with whoever joins once their membership decrypts", async () => {
    const ctx = await withCrypto();
    sticky(ctx.api, false);
    await ctx.live(rtcSync("!dm:x.org", [rtcEvent(BO, "BD", "b1", { member: { focus: FOCUS, sfu: undefined } })]));
    await ctx.act({ type: "joinVoice", channelId: anyCall(ctx.last()) });
    await flush();
    ctx.e2ee.sendToDevices.mockClear();
    await ctx.live(rtcSync("!dm:x.org", [], { sticky: [encRaw("ana", ANA, 5000, { sessionId: "S5" })] }));
    ctx.e2ee.clear.set("$ana", rtcEvent(ANA, "AD", "a1"));
    ctx.e2ee.keys(["S5"]);
    await flush();
    expect(ctx.e2ee.sendToDevices).toHaveBeenCalledWith("io.element.call.encryption_keys", [{ userId: ANA, deviceId: "AD" }], expect.anything());
  });
});

describe("media", () => {
  const media = (id: string, content: Record<string, unknown>, extra: { sender?: string; ts?: number; type?: string } = {}): MxEvent =>
    parseEvent({ type: extra.type ?? "m.room.message", event_id: `$${id}`, sender: extra.sender ?? BO, origin_server_ts: extra.ts ?? 3000, content })!;
  const IMAGE = { msgtype: "m.image", body: "cat.png", url: "mxc://x.org/cat", info: { mimetype: "image/png", size: 3, w: 4, h: 2 } };
  const download = (values: number[], type?: string): MxDownload => (type ? { bytes: new Uint8Array(values), type } : { bytes: new Uint8Array(values) });

  /** Signed in, with a room "Media" open: an encrypted placeholder, then these events. */
  async function inRoom(timeline: MxEvent[], extra: Partial<MatrixAdapterDeps> = {}) {
    const ctx = setup({ session: SESSION_JSON }, false, extra);
    ctx.api.push(sync({ joined: [room("!media:x.org", { state: { name: "Media", members: { [BO]: { name: "Bo", membership: "join" } } }, timeline: [enc("m0", BO, 100), ...timeline] })] }));
    await ctx.adapter.start();
    await flush();
    await ctx.open("Media");
    const shown = (name: string) => ctx.messages().find((m) => m.attachments[0]?.name === name)!;
    const file = (name: string) => shown(name).attachments[0]!;
    const key = (local: string) => `mx:${ctx.chat().channel!.id}:${local}`;
    const load = async (mediaKey: string) => {
      await ctx.act({ type: "loadMedia", key: mediaKey });
      await flush();
    };
    return { ...ctx, shown, file, key, load };
  }

  const cached = (adapter: MatrixAdapter) => (adapter as unknown as { media: Map<string, string> }).media;

  it("shows a picture from the homeserver once the view asks for it", async () => {
    const ctx = await inRoom([media("img", IMAGE)]);
    const before = ctx.shown("cat.png");
    expect(before.content).toBe("");
    expect(before.attachments).toEqual([{ name: "cat.png", kind: "image", mime: "image/png", size: 3, width: 4, height: 2, mediaKey: ctx.key(before.id) }]);
    ctx.api.download.mockResolvedValue(download([1, 2, 3], "image/jpeg"));
    await ctx.load(ctx.key(before.id));
    expect(ctx.api.download).toHaveBeenCalledWith(SESSION, "mxc://x.org/cat", MAX_MEDIA_BYTES);
    // The sender's type, not the server's.
    expect(ctx.file("cat.png")).toEqual({ name: "cat.png", kind: "image", mime: "image/png", size: 3, width: 4, height: 2, url: "data:image/png;base64,AQID" });
    await ctx.load(ctx.key(before.id));
    expect(ctx.api.download).toHaveBeenCalledTimes(1);
  });

  it("keeps the label for notifications, previews and replies, and only the caption as the message", async () => {
    const ctx = await signedIn();
    const captioned = media("cap", { ...IMAGE, body: "look at *this*", filename: "cat.png" }, { ts: 5000 });
    const reply = msg("re", ME, "cute", 6000, { replyTo: "$cap" });
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [captioned, reply] })] }));
    expect(ctx.notifications.at(-1)!.body).toBe("look at *this*\n📷 Image");
    await ctx.open("Bo");
    const [image, answer] = ctx.messages().slice(-2);
    expect(image!.content).toBe("look at \\*this\\*");
    expect(image!.attachments[0]!.name).toBe("cat.png");
    expect(answer!.reply).toEqual({ author: "Bo", content: "look at *this*\n📷 Image" });
    expect(answer!.attachments).toEqual([]);
    await ctx.live(sync({ joined: [room("!dm:x.org", { timeline: [media("last", IMAGE, { ts: 7000 })] })] }));
    expect(ctx.directs.at(-1)![0]!.preview).toBe("📷 Image");
  });

  it("decrypts an encrypted attachment as Element encrypts it", async () => {
    const plain = new TextEncoder().encode("GIF89a, or so it says");
    const { data, info } = await encryptAttachment(plain);
    const ctx = await inRoom([media("enc", { msgtype: "m.image", body: "secret.gif", file: { ...info, url: "mxc://x.org/secret" }, info: { mimetype: "image/gif" } })]);
    ctx.api.download.mockResolvedValue({ bytes: data, type: "application/octet-stream" });
    await ctx.load(ctx.file("secret.gif").mediaKey!);
    expect(ctx.api.download).toHaveBeenCalledWith(SESSION, "mxc://x.org/secret", MAX_MEDIA_BYTES);
    expect(ctx.file("secret.gif").url).toBe(`data:image/gif;base64,${Buffer.from(plain).toString("base64")}`);
  });

  it("gives an encrypted file without a type no type of the server's", async () => {
    const plain = new Uint8Array([1, 2, 3]);
    const { data, info } = await encryptAttachment(plain);
    const ctx = await inRoom([media("enc", { msgtype: "m.file", body: "notes", file: { ...info, url: "mxc://x.org/notes" } })]);
    ctx.api.download.mockResolvedValue({ bytes: data, type: "text/html" });
    await ctx.load(ctx.file("notes").mediaKey!);
    expect(ctx.file("notes").url).toBe("data:application/octet-stream;base64,AQID");
  });

  it("refuses an encrypted attachment that does not match its hash, and never shows its bytes", async () => {
    const { data, info } = await encryptAttachment(new TextEncoder().encode("the real picture"));
    data[3]! ^= 0xff;
    const ctx = await inRoom([media("enc", { msgtype: "m.image", body: "swapped.png", file: { ...info, url: "mxc://x.org/swapped" } })]);
    ctx.api.download.mockResolvedValue({ bytes: data });
    const key = ctx.file("swapped.png").mediaKey!;
    await ctx.load(key);
    expect(ctx.file("swapped.png")).toEqual({ name: "swapped.png", kind: "image", unavailable: "it does not match its checksum, so it may have been changed" });
    // A failure is final: nothing is fetched again.
    await ctx.load(key);
    expect(ctx.api.download).toHaveBeenCalledTimes(1);
  });

  it("does not offer media it cannot show", async () => {
    const ctx = await inRoom([
      media("bad", { msgtype: "m.image", body: "v1.png", file: { v: "v1" } }),
      media("big", { msgtype: "m.video", body: "film.mp4", url: "mxc://x.org/film", info: { size: MAX_MEDIA_BYTES + 1 } }),
      media("huge", { msgtype: "m.image", body: "huge.png", url: "mxc://x.org/huge", info: { size: MAX_MEDIA_BYTES + 1, thumbnail_url: "mxc://x.org/t", thumbnail_info: { size: MAX_MEDIA_BYTES + 1 } } }),
    ]);
    expect(ctx.file("v1.png")).toEqual({ name: "v1.png", kind: "image", unavailable: "its encryption version is not supported" });
    expect(ctx.file("film.mp4")).toEqual({ name: "film.mp4", kind: "video", size: MAX_MEDIA_BYTES + 1, unavailable: TOO_LARGE });
    expect(ctx.file("huge.png")).toEqual({ name: "huge.png", kind: "image", size: MAX_MEDIA_BYTES + 1, unavailable: TOO_LARGE });
    // Keys the view should not have are not loaded either.
    for (const name of ["v1.png", "film.mp4", "huge.png"]) await ctx.load(ctx.key(ctx.shown(name).id));
    expect(ctx.api.download).not.toHaveBeenCalled();
  });

  it("shows the thumbnail of a picture too large to show", async () => {
    const ctx = await inRoom([
      media("huge", { msgtype: "m.image", body: "huge.png", url: "mxc://x.org/huge", info: { mimetype: "image/png", size: MAX_MEDIA_BYTES + 1, thumbnail_url: "mxc://x.org/t", thumbnail_info: { mimetype: "image/jpeg", size: 2 } } }),
      media("wide", { body: "wide", url: "mxc://x.org/wide", info: { size: MAX_MEDIA_BYTES + 1, thumbnail_url: "mxc://x.org/t2" } }, { type: "m.sticker" }),
    ]);
    ctx.api.download.mockResolvedValue(download([1, 2], "image/webp"));
    await ctx.load(ctx.file("huge.png").mediaKey!);
    expect(ctx.api.download).toHaveBeenLastCalledWith(SESSION, "mxc://x.org/t", MAX_MEDIA_BYTES);
    expect(ctx.file("huge.png").url).toBe("data:image/jpeg;base64,AQI=");
    await ctx.load(ctx.file("wide").mediaKey!);
    expect(ctx.api.download).toHaveBeenLastCalledWith(SESSION, "mxc://x.org/t2", MAX_MEDIA_BYTES);
    expect(ctx.file("wide")).toMatchObject({ kind: "sticker", url: "data:image/webp;base64,AQI=" });
  });

  it("says when a download is too large or fails", async () => {
    const ctx = await inRoom([media("a", { ...IMAGE, body: "a.png" }), media("b", { ...IMAGE, body: "b.png" }), media("c", { ...IMAGE, body: "c.png" })]);
    ctx.api.download.mockResolvedValueOnce(undefined);
    await ctx.load(ctx.file("a.png").mediaKey!);
    expect(ctx.file("a.png").unavailable).toBe(TOO_LARGE);
    ctx.api.download.mockRejectedValueOnce(new MatrixError(404, "M_NOT_FOUND", "Media not found"));
    await ctx.load(ctx.file("b.png").mediaKey!);
    expect(ctx.file("b.png").unavailable).toBe("could not load: Media not found");
    ctx.api.download.mockRejectedValueOnce("offline");
    await ctx.load(ctx.file("c.png").mediaKey!);
    expect(ctx.file("c.png").unavailable).toBe("could not load: offline");
  });

  it("takes a plain file's type from the server when its sender gave none", async () => {
    const ctx = await inRoom([media("pdf", { msgtype: "m.file", body: "r.pdf", url: "mxc://x.org/r" }), media("raw", { msgtype: "m.file", body: "raw", url: "mxc://x.org/raw" })]);
    ctx.api.download.mockResolvedValueOnce(download([1], "application/pdf")).mockResolvedValueOnce(download([1]));
    await ctx.load(ctx.file("r.pdf").mediaKey!);
    await ctx.load(ctx.file("raw").mediaKey!);
    expect(ctx.file("r.pdf").url).toBe("data:application/pdf;base64,AQ==");
    expect(ctx.file("raw").url).toBe("data:application/octet-stream;base64,AQ==");
  });

  it("loads only media of messages on screen", async () => {
    const ctx = await inRoom([media("img", IMAGE), msg("txt", BO, "plain", 4000)]);
    const image = ctx.shown("cat.png");
    const text = ctx.messages().find((m) => m.content === "plain")!;
    const room = ctx.chat().channel!.id;
    for (const key of ["mx:1", `tg:${room}:${image.id}`, `mx:${room}:${image.id}:1`, `mx:${room}:99999`, `mx:99999:${image.id}`, `mx:${image.id}:${image.id}`, ctx.key(text.id)]) await ctx.load(key);
    expect(ctx.api.download).not.toHaveBeenCalled();
    // Not signed in: nothing to load.
    const out = setup();
    await out.adapter.start();
    await out.act({ type: "loadMedia", key: ctx.key(image.id) });
    expect(out.api.download).not.toHaveBeenCalled();
  });

  it("downloads a file once while it loads", async () => {
    const ctx = await inRoom([media("img", IMAGE)]);
    let finish!: (value: MxDownload) => void;
    ctx.api.download.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const key = ctx.file("cat.png").mediaKey!;
    const loading = ctx.act({ type: "loadMedia", key });
    await ctx.load(key);
    finish(download([1, 2, 3]));
    await loading;
    expect(ctx.api.download).toHaveBeenCalledTimes(1);
    expect(ctx.file("cat.png").url).toBe("data:image/png;base64,AQID");
  });

  it("keeps loaded media within its budget, the newest always", async () => {
    // Each picture is a 26-character data: URL.
    const ctx = await inRoom([media("a", { ...IMAGE, body: "a.png" }), media("b", { ...IMAGE, body: "b.png" })], { mediaBudget: 40 });
    ctx.api.download.mockResolvedValue(download([1, 2, 3]));
    const first = ctx.file("a.png").mediaKey!;
    await ctx.load(first);
    expect(ctx.file("a.png").url).toBeDefined();
    await ctx.load(ctx.file("b.png").mediaKey!);
    expect(ctx.file("b.png").url).toBeDefined();
    // The older one went, and can be loaded again.
    expect(ctx.file("a.png").url).toBeUndefined();
    expect(ctx.file("a.png").mediaKey).toBe(first);
    const tiny = await inRoom([media("a", { ...IMAGE, body: "a.png" })], { mediaBudget: 1 });
    tiny.api.download.mockResolvedValue(download([1, 2, 3]));
    await tiny.load(tiny.file("a.png").mediaKey!);
    expect(tiny.file("a.png").url).toBe("data:image/png;base64,AQID");
  });

  it("forgets loaded media when the session ends, and drops downloads that finish after", async () => {
    const ctx = await inRoom([media("a", { ...IMAGE, body: "a.png" }), media("b", { ...IMAGE, body: "b.png" })]);
    ctx.api.download.mockResolvedValueOnce(download([1]));
    await ctx.load(ctx.file("a.png").mediaKey!);
    let finish!: (value: MxDownload) => void;
    ctx.api.download.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const loading = ctx.act({ type: "loadMedia", key: ctx.file("b.png").mediaKey! });
    expect(cached(ctx.adapter).size).toBe(1);
    await ctx.adapter.signOut();
    expect(cached(ctx.adapter).size).toBe(0);
    finish(download([2]));
    await loading;
    expect(cached(ctx.adapter).size).toBe(0);

    const ended = await inRoom([media("a", { ...IMAGE, body: "a.png" })]);
    ended.api.download.mockResolvedValue(download([1]));
    await ended.load(ended.file("a.png").mediaKey!);
    expect(cached(ended.adapter).size).toBe(1);
    await ended.live(new MatrixError(401, "M_UNKNOWN_TOKEN", "gone"));
    expect(cached(ended.adapter).size).toBe(0);
  });

  it("shows stickers, looping videos, sound and files", async () => {
    const ctx = await inRoom([
      media("st", { body: "wave", url: "mxc://x.org/wave", info: { mimetype: "image/webp", w: 128, h: 128 } }, { type: "m.sticker" }),
      media("gif", { msgtype: "m.video", body: "dance.mp4", url: "mxc://x.org/dance", info: { mimetype: "video/mp4", "fi.mau.loop": true } }),
      media("au", { msgtype: "m.audio", body: "voice.ogg", url: "mxc://x.org/voice", "org.matrix.msc3245.voice": {} }),
      media("fi", { msgtype: "m.file", body: "report.pdf", url: "mxc://x.org/report", info: { size: 2048 } }),
    ]);
    expect(ctx.file("wave")).toMatchObject({ kind: "sticker", mime: "image/webp", width: 128, height: 128 });
    expect(ctx.file("dance.mp4")).toMatchObject({ kind: "video", loop: true });
    expect(ctx.file("voice.ogg")).toMatchObject({ kind: "audio" });
    expect(ctx.file("report.pdf")).toMatchObject({ kind: "file", size: 2048 });
    for (const name of ["wave", "dance.mp4", "voice.ogg", "report.pdf"]) expect(ctx.shown(name).content).toBe("");
  });

  it("shows an edited message's new media", async () => {
    const edit = (id: string, sender: string, url: string, ts: number) =>
      media(id, { msgtype: "m.image", body: "* dog.png", "m.new_content": { msgtype: "m.image", body: "dog.png", url }, "m.relates_to": { rel_type: "m.replace", event_id: "$img" } }, { sender, ts });
    const ctx = await inRoom([media("img", IMAGE), edit("ed", BO, "mxc://x.org/dog", 4000), edit("other", ANA, "mxc://x.org/evil", 5000)]);
    const shown = ctx.shown("dog.png");
    expect(shown.edited).toBe(true);
    expect(shown.attachments[0]!.mediaKey).not.toBe(ctx.key(shown.id));
    ctx.api.download.mockResolvedValue(download([1]));
    await ctx.load(shown.attachments[0]!.mediaKey!);
    expect(ctx.api.download).toHaveBeenCalledWith(SESSION, "mxc://x.org/dog", MAX_MEDIA_BYTES);
    // The original's key no longer loads anything.
    await ctx.load(ctx.key(shown.id));
    expect(ctx.api.download).toHaveBeenCalledTimes(1);
  });
});
