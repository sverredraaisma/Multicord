import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectConversation, PlatformNotification } from "../../../src/shared/adapter";
import { MatrixError, type MatrixApi, type MxEvent, type MxPage, type MxRoomUpdate, type MxSession, type MxSync } from "../../../src/modules/matrix/api";
import {
  AVATAR_LIMIT,
  ENCRYPTED_NOTICE,
  ENCRYPTED_TEXT,
  MatrixAdapter,
  messageText,
  PAGE_SIZE,
  parseSession,
  SYNC_TIMEOUT_MS,
} from "../../../src/modules/matrix/adapter";
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
  encrypted = vi.fn(async (_s: MxSession, _room: string) => false);
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

function setup(secretsInit: Record<string, string> = {}, realDelay = false) {
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
    expect(ctx.api.whoami).toHaveBeenCalledWith(BASE, "tok");
    expect(ctx.renders.map((r) => r.screen === "connecting" && r.status)).toEqual(["Connecting to x.org…", "Loading your chats…"]);
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-in", name: ME });
    expect(ctx.api.sync).toHaveBeenCalledWith(SESSION, undefined, 0);
    await ctx.live(initialSync());
    expect(ctx.chat()).toMatchObject({ title: "x.org", me: ME, channel: null, voice: null });
    expect(ctx.api.sync).toHaveBeenLastCalledWith(SESSION, `s${batch}`, SYNC_TIMEOUT_MS);
  });

  it("signs in again when the stored session has ended", async () => {
    const ctx = setup({ session: SESSION_JSON });
    ctx.api.whoami.mockRejectedValueOnce(new MatrixError(401, "M_UNKNOWN_TOKEN", "gone"));
    await ctx.adapter.start();
    expect(ctx.secrets.has("session")).toBe(false);
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "login" }, error: "Your Matrix session has ended. Sign in again." });
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("keeps the stored session when the homeserver is unreachable, and retries", async () => {
    const ctx = setup({ session: SESSION_JSON });
    ctx.api.whoami.mockRejectedValueOnce("offline");
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
    ctx.api.encrypted.mockRejectedValueOnce(new Error("nope"));
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
    expect(ctx.api.encrypted).toHaveBeenCalledWith(SESSION, "!dm:x.org");
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
    expect(ctx.api.encrypted).not.toHaveBeenCalled();
    expect(ctx.api.send).not.toHaveBeenCalled();
    expect(ctx.chat().error).toBe("Message not sent: this room is end-to-end encrypted, which Multicord does not support");
  });

  it("never sends when the server says the room is encrypted", async () => {
    const ctx = await signedIn();
    await ctx.open("Lounge");
    ctx.api.encrypted.mockResolvedValueOnce(true);
    await ctx.act({ type: "send", content: "plaintext" });
    expect(ctx.api.send).not.toHaveBeenCalled();
    expect(ctx.chat().channel!.locked).toBe(ENCRYPTED_NOTICE);
    await ctx.act({ type: "send", content: "again" });
    expect(ctx.api.encrypted).toHaveBeenCalledTimes(1);
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
