import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectConversation, PlatformNotification } from "../../../src/shared/adapter";
import { MatrixError, type MatrixApi, type MxCryptoSync, type MxEncryptedEvent, type MxEncryption, type MxEvent, type MxOAuthSession, type MxPage, type MxRoomUpdate, type MxSession, type MxSync } from "../../../src/modules/matrix/api";
import {
  ALGORITHM_NOTICE,
  AVATAR_LIMIT,
  ENCRYPTED_NOTICE,
  ENCRYPTED_TEXT,
  MatrixAdapter,
  type MatrixAdapterDeps,
  messageText,
  PAGE_SIZE,
  REQUEST_ENTRY,
  parseSession,
  SYNC_TIMEOUT_MS,
  TOKEN_NOTICE,
  UNVERIFIED_LABEL,
} from "../../../src/modules/matrix/adapter";
import type { E2ee, E2eeOptions, E2eeStatus, RecoveryResult, RoomEncryption } from "../../../src/modules/matrix/crypto";
import type { Verification, VerificationState } from "../../../src/modules/matrix/verification";
import { OAuthError, type DeviceGrant, type DevicePoll, type OAuthServer, type OAuthTokens } from "../../../src/modules/matrix/oauth";
import { MAX_DIRECTS } from "../../../src/shared/engine";
import type { NativeAction, NativeViewState } from "../../../src/shared/native";

const ME = "@me:x.org";
const BO = "@bo:x.org";
const ANA = "@ana:x.org";
const BASE = "https://hs.x.org";
const SESSION: MxSession = { baseUrl: BASE, accessToken: "tok", userId: ME, deviceId: "D", ownDevice: true };
const SESSION_JSON = JSON.stringify(SESSION);

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
  logout = vi.fn(async (_s: MxSession) => {});

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
    expect(ctx.chat().error).toBe("Could not load messages: That username or password is not right.");
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
    expect(ctx.adapter.capabilities).toEqual({ directMessages: true, messagePreviews: true, voice: false, screenShare: false });
    expect(ctx.adapter.mode).toBe("native");
  });

  it("ignores actions Matrix does not offer", async () => {
    const ctx = await signedIn();
    const renders = ctx.renders.length;
    for (const action of [{ type: "typing" }, { type: "attach" }, { type: "react", messageId: "1", emoji: "👍", add: true }] as NativeAction[]) await ctx.act(action);
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
