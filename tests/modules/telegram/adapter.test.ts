import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectConversation, PlatformNotification } from "../../../src/shared/adapter";
import type { TelegramApi, TelegramCredentials, TgDialog, TgMessage, TgSignIn, TgUpdate } from "../../../src/modules/telegram/api";
import { AVATAR_LIMIT, PAGE_SIZE, TelegramAdapter, messageText, parseCredentials } from "../../../src/modules/telegram/adapter";
import { escapeMarkdown } from "../../../src/shared/markdown";
import type { NativeAction, NativeViewState } from "../../../src/shared/native";

const HASH = "0123456789abcdef0123456789ABCDEF";
const CREDS: TelegramCredentials = { apiId: 12, apiHash: HASH.toLowerCase() };
const CREDS_JSON = JSON.stringify(CREDS);

const tgError = (name: string) => ({ errorMessage: name });
const flush = async () => {
  for (let i = 0; i < 500; i++) await Promise.resolve();
};

const msg = (chatId: string, id: number, extra: Partial<TgMessage> = {}): TgMessage => ({ id, chatId, out: false, text: `m${id}`, date: 100 + id, edited: false, ...extra });
const dlg = (chatId: string, extra: Partial<TgDialog> = {}): TgDialog => ({ chatId, title: `User ${chatId}`, bot: false, unreadCount: 0, date: 0, ...extra });
const defaultDialogs = () => [dlg("3", { date: 10 }), dlg("1", { date: 30, unreadCount: 2, lastMessage: msg("1", 2) }), dlg("2", { date: 20 })];

class FakeTelegramApi implements TelegramApi {
  isAuthorized = false;
  dialogList: TgDialog[] = [];
  listener: (update: TgUpdate) => void = () => {};

  connect = vi.fn(async () => {});
  authorized = vi.fn(async () => this.isAuthorized);
  sendCode = vi.fn(async (_phone: string) => ({ hash: "H", viaApp: false }));
  signIn = vi.fn(async (_phone: string, _hash: string, _code: string): Promise<TgSignIn> => ({ done: true }));
  checkPassword = vi.fn(async (_password: string) => {});
  me = vi.fn(async () => ({ id: "9", name: "Me", bot: false }));
  dialogs = vi.fn(async (_limit: number) => this.dialogList.map((d) => ({ ...d })));
  history = vi.fn(async (chatId: string, _before: number | undefined, _limit: number): Promise<TgMessage[]> => [msg(chatId, 1), msg(chatId, 2)]);
  send = vi.fn(async (chatId: string, text: string, _replyTo?: number) => msg(chatId, 200, { out: true, text }));
  edit = vi.fn(async (chatId: string, id: number, text: string) => msg(chatId, id, { out: true, text, edited: true }));
  remove = vi.fn(async (_chatId: string, _ids: number[]) => {});
  markRead = vi.fn(async (_chatId: string, _maxId: number) => {});
  avatar = vi.fn(async (_chatId: string): Promise<string | undefined> => undefined);
  download = vi.fn(async (_chatId: string, _id: number, _thumbnail: boolean): Promise<Uint8Array | undefined> => new Uint8Array([104, 105]));
  onUpdate = vi.fn((cb: (update: TgUpdate) => void) => void (this.listener = cb));
  session = vi.fn(() => "sess");
  logOut = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});

  emit(update: TgUpdate): void {
    this.listener(update);
  }
}

interface Options {
  mediaBudget?: number;
  secrets?: Record<string, string>;
  builtIn?: TelegramCredentials;
  dialogs?: TgDialog[];
  authorized?: boolean;
}

function setup(options: Options = {}) {
  const api = new FakeTelegramApi();
  api.dialogList = options.dialogs ?? defaultDialogs();
  api.isAuthorized = options.authorized ?? false;
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const renders: NativeViewState[] = [];
  const directs: DirectConversation[][] = [];
  const notifications: PlatformNotification[] = [];
  const createApi = vi.fn((_credentials: TelegramCredentials, _session: string) => api);
  const adapter = new TelegramAdapter({
    def: { id: "telegram", name: "Telegram", url: "https://telegram.org" },
    secrets: {
      load: async (k) => secrets.get(k),
      save: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    render: (state) => renders.push(state),
    builtInCredentials: options.builtIn,
    createApi,
    mediaBudget: options.mediaBudget,
  });
  adapter.onDirectsChanged((d) => directs.push(d));
  adapter.onNotification((n) => notifications.push(n));
  const act = (action: NativeAction) => adapter.handleAction(action);
  const answer = (id: string, values: Record<string, string>) => act({ type: "prompt", id, values });
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
  const messageIds = () => chat().channel!.messages.map((m) => m.id);
  return { adapter, api, secrets, renders, directs, notifications, createApi, act, answer, last, prompt, chat, messageIds };
}

/** An adapter that resumed a stored session and shows the chat. */
async function signedIn(options: Options = {}) {
  const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true, ...options });
  await ctx.adapter.start();
  await flush();
  return ctx;
}

/** Walks a fresh adapter (built-in credentials) to the code step. */
async function atCodeStep(options: Options = {}) {
  const ctx = setup({ builtIn: CREDS, ...options });
  await ctx.adapter.start();
  await ctx.answer("phone", { phone: "+31612345678" });
  return ctx;
}

afterEach(() => vi.useRealTimers());

describe("starting", () => {
  it("asks for API credentials when there are none", async () => {
    const ctx = setup();
    await ctx.adapter.start();
    expect(ctx.prompt().prompt).toMatchObject({ id: "api", fields: [{ name: "apiId" }, { name: "apiHash" }] });
    expect(ctx.createApi).not.toHaveBeenCalled();
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("skips the credentials step with built-in credentials", async () => {
    const ctx = setup({ builtIn: CREDS });
    await ctx.adapter.start();
    expect(ctx.createApi).toHaveBeenCalledWith(CREDS, "");
    expect(ctx.renders[0]).toMatchObject({ screen: "connecting", status: "Connecting to Telegram…" });
    expect(ctx.prompt().prompt.id).toBe("phone");
    expect(ctx.api.onUpdate).toHaveBeenCalled();
  });

  it("uses stored credentials, lowercased, over built-in ones", async () => {
    const ctx = setup({ secrets: { api: JSON.stringify({ apiId: 5, apiHash: HASH }) }, builtIn: { apiId: 1, apiHash: "f".repeat(32) } });
    await ctx.adapter.start();
    expect(ctx.createApi).toHaveBeenCalledWith({ apiId: 5, apiHash: HASH.toLowerCase() }, "");
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["a non-integer id", JSON.stringify({ apiId: 1.5, apiHash: HASH })],
    ["a non-positive id", JSON.stringify({ apiId: 0, apiHash: HASH })],
    ["a short hash", JSON.stringify({ apiId: 1, apiHash: "abc" })],
    ["a non-hex hash", JSON.stringify({ apiId: 1, apiHash: "z".repeat(32) })],
    ["a missing hash", JSON.stringify({ apiId: 1 })],
  ])("ignores stored credentials with %s", async (_name, stored) => {
    const ctx = setup({ secrets: { api: stored } });
    await ctx.adapter.start();
    expect(ctx.prompt().prompt.id).toBe("api");
  });

  it("resumes a stored session straight into the chat", async () => {
    const ctx = await signedIn();
    expect(ctx.createApi).toHaveBeenCalledWith(CREDS, "old");
    expect(ctx.secrets.get("session")).toBe("sess");
    expect(ctx.chat()).toMatchObject({ title: "Direct messages", me: "Me", channel: null });
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-in", name: "Me" });
  });

  it("forgets a stored session that is no longer authorized", async () => {
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: false });
    await ctx.adapter.start();
    expect(ctx.secrets.has("session")).toBe(false);
    expect(ctx.prompt().prompt.id).toBe("phone");
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("counts a stored session as signed in while still connecting", async () => {
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    let release!: () => void;
    ctx.api.connect.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const started = ctx.adapter.start();
    await flush();
    expect(ctx.last()).toMatchObject({ screen: "connecting" });
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-in" });
    release();
    await started;
  });

  it("reports a connection failure and goes to the phone step", async () => {
    const ctx = setup({ builtIn: CREDS });
    ctx.api.connect.mockRejectedValue(new Error("offline"));
    await ctx.adapter.start();
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "phone" }, error: "Could not reach Telegram: offline", status: undefined });
  });

  it("resets stored credentials when Telegram rejects the API ID", async () => {
    const ctx = setup({ secrets: { api: CREDS_JSON } });
    ctx.api.connect.mockRejectedValue(tgError("API_ID_INVALID"));
    await ctx.adapter.start();
    expect(ctx.secrets.has("api")).toBe(false);
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "api" }, error: "Could not reach Telegram: Telegram does not accept this API ID and hash." });
  });
});

describe("API credentials step", () => {
  const apiStep = async () => {
    const ctx = setup();
    await ctx.adapter.start();
    return ctx;
  };

  it("saves valid credentials, lowercased, and connects", async () => {
    const ctx = await apiStep();
    await ctx.answer("api", { apiId: "12", apiHash: HASH });
    expect(JSON.parse(ctx.secrets.get("api")!)).toEqual(CREDS);
    expect(ctx.createApi).toHaveBeenCalledWith(CREDS, "");
    expect(ctx.prompt().prompt.id).toBe("phone");
  });

  it.each([
    ["0", HASH],
    ["1.5", HASH],
    ["abc", HASH],
    ["12", "short"],
    ["12", "g".repeat(32)],
  ])("rejects API ID %s with hash %s", async (apiId, apiHash) => {
    const ctx = await apiStep();
    await ctx.answer("api", { apiId, apiHash });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "api" }, busy: false, error: expect.stringContaining("my.telegram.org") });
    expect(ctx.secrets.has("api")).toBe(false);
    expect(ctx.createApi).not.toHaveBeenCalled();
  });
});

describe("phone step", () => {
  it("normalizes the number, shows a status while sending and moves to the code step", async () => {
    const ctx = setup({ builtIn: CREDS });
    await ctx.adapter.start();
    await ctx.answer("phone", { phone: "+31 (6) 1234-5678" });
    expect(ctx.api.sendCode).toHaveBeenCalledWith("+31612345678");
    expect(ctx.renders.some((s) => s.screen === "prompt" && s.busy && s.status === "Sending the code…")).toBe(true);
    expect(ctx.prompt()).toMatchObject({ busy: false, status: undefined, prompt: { id: "code", description: "Telegram sent a code by text message to +31612345678.", cancel: "Use another number" } });
  });

  it("says the code went to the Telegram app when it did", async () => {
    const ctx = setup({ builtIn: CREDS });
    ctx.api.sendCode.mockResolvedValue({ hash: "H", viaApp: true });
    await ctx.adapter.start();
    await ctx.answer("phone", { phone: "+31612345678" });
    expect(ctx.prompt().prompt.description).toBe("Telegram sent a code to your Telegram app for +31612345678.");
  });

  it.each(["12", "abc", "+1234567890123456", ""])("rejects the number %j", async (phone) => {
    const ctx = setup({ builtIn: CREDS });
    await ctx.adapter.start();
    await ctx.answer("phone", { phone });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "phone" }, error: "That phone number is not valid. Include the country code, e.g. +31." });
    expect(ctx.api.sendCode).not.toHaveBeenCalled();
  });

  it("treats a missing phone value as invalid", async () => {
    const ctx = setup({ builtIn: CREDS });
    await ctx.adapter.start();
    await ctx.answer("phone", {});
    expect(ctx.prompt().error).toContain("not valid");
  });

  it.each([
    ["FLOOD_WAIT_123", "Too many attempts. Wait a while and try again."],
    ["PHONE_NUMBER_BANNED", "Telegram has banned this phone number."],
    ["SOMETHING_NEW", "SOMETHING_NEW"],
  ])("shows %s as %j", async (name, text) => {
    const ctx = setup({ builtIn: CREDS });
    ctx.api.sendCode.mockRejectedValue(tgError(name));
    await ctx.adapter.start();
    await ctx.answer("phone", { phone: "+31612345678" });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "phone" }, error: text });
  });

  it("shows a non-Error rejection as text", async () => {
    const ctx = setup({ builtIn: CREDS });
    ctx.api.sendCode.mockRejectedValue("plain failure");
    await ctx.adapter.start();
    await ctx.answer("phone", { phone: "+31612345678" });
    expect(ctx.prompt().error).toBe("plain failure");
  });

  it("starts over at the API step when Telegram rejects the API ID", async () => {
    const ctx = setup({ secrets: { api: CREDS_JSON } });
    ctx.api.sendCode.mockRejectedValue(tgError("API_ID_INVALID"));
    await ctx.adapter.start();
    await ctx.answer("phone", { phone: "+31612345678" });
    expect(ctx.secrets.has("api")).toBe(false);
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "api" }, error: "Telegram does not accept this API ID and hash." });
  });
});

describe("code step", () => {
  it("signs in: saves the session, loads dialogs newest first and shows the chat", async () => {
    const ctx = await atCodeStep();
    await ctx.answer("code", { code: "12 345" });
    expect(ctx.api.signIn).toHaveBeenCalledWith("+31612345678", "H", "12345");
    expect(ctx.secrets.get("session")).toBe("sess");
    expect(ctx.api.dialogs).toHaveBeenCalledWith(100);
    expect(ctx.chat().sidebar.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-in", name: "Me" });
  });

  it("sends an empty code when none is given", async () => {
    const ctx = await atCodeStep();
    await ctx.answer("code", {});
    expect(ctx.api.signIn).toHaveBeenCalledWith("+31612345678", "H", "");
  });

  it("asks for the password, showing the hint when there is one", async () => {
    const ctx = await atCodeStep();
    ctx.api.signIn.mockResolvedValue({ password: true, hint: "pet" });
    await ctx.answer("code", { code: "1" });
    expect(ctx.prompt().prompt).toMatchObject({ id: "password", description: "Your account has a password. Hint: pet", cancel: "Use another number" });
  });

  it("asks for the password without a hint", async () => {
    const ctx = await atCodeStep();
    ctx.api.signIn.mockResolvedValue({ password: true });
    await ctx.answer("code", { code: "1" });
    expect(ctx.prompt().prompt.description).toBe("Your account has a password.");
  });

  it("sends a number without an account back to the phone step", async () => {
    const ctx = await atCodeStep();
    ctx.api.signIn.mockResolvedValue({ signUp: true });
    await ctx.answer("code", { code: "1" });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "phone" }, error: expect.stringContaining("no Telegram account yet") });
  });

  it("goes back to the phone step when the code expired", async () => {
    const ctx = await atCodeStep();
    ctx.api.signIn.mockRejectedValue(tgError("PHONE_CODE_EXPIRED"));
    await ctx.answer("code", { code: "1" });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "phone" }, error: "The code expired. Request a new one." });
  });

  it("stays on the code step for a wrong code", async () => {
    const ctx = await atCodeStep();
    ctx.api.signIn.mockRejectedValue(tgError("PHONE_CODE_INVALID"));
    await ctx.answer("code", { code: "1" });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "code" }, error: "That code is not right." });
  });

  it("fetches avatars for up to AVATAR_LIMIT dialogs, skipping failures", async () => {
    const dialogs = Array.from({ length: AVATAR_LIMIT + 5 }, (_, i) => dlg(String(i + 1), { date: 1000 - i }));
    const ctx = await atCodeStep({ dialogs });
    ctx.api.avatar.mockImplementation(async (id) => {
      if (id === "1") throw new Error("nope");
      return id === "2" ? "data:image/jpeg;base64,AA" : undefined;
    });
    await ctx.answer("code", { code: "1" });
    await flush();
    expect(ctx.api.avatar).toHaveBeenCalledTimes(AVATAR_LIMIT);
    const items = ctx.chat().sidebar;
    expect(items.find((i) => i.id === "2")?.iconUrl).toBe("data:image/jpeg;base64,AA");
    expect(items.find((i) => i.id === "1")).not.toHaveProperty("iconUrl");
    expect(items.find((i) => i.id === "3")).not.toHaveProperty("iconUrl");
  });

  it("does not fetch the same avatar twice, nor after signing out", async () => {
    const ctx = await atCodeStep({ dialogs: [dlg("1", { date: 3 }), dlg("1", { date: 2 }), dlg("2", { date: 1 })] });
    let release!: (url: string) => void;
    ctx.api.avatar.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    await ctx.answer("code", { code: "1" });
    await flush();
    ctx.api.authorized.mockResolvedValue(false);
    await ctx.adapter.signOut();
    release("data:late");
    await flush();
    expect(ctx.api.avatar).toHaveBeenCalledTimes(1);
  });
});

describe("password step", () => {
  const atPassword = async () => {
    const ctx = await atCodeStep();
    ctx.api.signIn.mockResolvedValue({ password: true });
    await ctx.answer("code", { code: "1" });
    return ctx;
  };

  it("checks the password, then signs in", async () => {
    const ctx = await atPassword();
    await ctx.answer("password", { password: "hunter2" });
    expect(ctx.api.checkPassword).toHaveBeenCalledWith("hunter2");
    expect(ctx.chat().me).toBe("Me");
  });

  it("checks an empty password when none is given", async () => {
    const ctx = await atPassword();
    await ctx.answer("password", {});
    expect(ctx.api.checkPassword).toHaveBeenCalledWith("");
  });

  it("shows a wrong password and stays", async () => {
    const ctx = await atPassword();
    ctx.api.checkPassword.mockRejectedValue(tgError("PASSWORD_HASH_INVALID"));
    await ctx.answer("password", { password: "x" });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "password" }, error: "That password is not right." });
  });
});

describe("prompt handling", () => {
  it("returns to the phone step when the code or password is cancelled", async () => {
    const ctx = await atCodeStep();
    ctx.api.signIn.mockRejectedValue(tgError("PHONE_CODE_INVALID"));
    await ctx.answer("code", { code: "1" });
    await ctx.act({ type: "cancelPrompt", id: "code" });
    expect(ctx.prompt()).toMatchObject({ prompt: { id: "phone" }, error: undefined });

    await ctx.answer("phone", { phone: "+31612345678" });
    ctx.api.signIn.mockResolvedValue({ password: true });
    await ctx.answer("code", { code: "1" });
    await ctx.act({ type: "cancelPrompt", id: "password" });
    expect(ctx.prompt().prompt.id).toBe("phone");
  });

  it("ignores cancelling other prompts", async () => {
    const ctx = setup({ builtIn: CREDS });
    await ctx.adapter.start();
    const renders = ctx.renders.length;
    await ctx.act({ type: "cancelPrompt", id: "phone" });
    expect(ctx.renders).toHaveLength(renders);
  });

  it("ignores answers for a step that is not current", async () => {
    const ctx = setup({ builtIn: CREDS });
    await ctx.adapter.start();
    const renders = ctx.renders.length;
    await ctx.answer("code", { code: "1" });
    expect(ctx.api.signIn).not.toHaveBeenCalled();
    expect(ctx.renders).toHaveLength(renders);
  });

  it("ignores answers while busy", async () => {
    const ctx = setup({ builtIn: CREDS });
    let release!: (v: { hash: string; viaApp: boolean }) => void;
    ctx.api.sendCode.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await ctx.adapter.start();
    const first = ctx.answer("phone", { phone: "+31612345678" });
    await flush();
    expect(ctx.prompt().busy).toBe(true);
    await ctx.answer("phone", { phone: "+31699999999" });
    release({ hash: "H", viaApp: false });
    await first;
    expect(ctx.api.sendCode).toHaveBeenCalledTimes(1);
  });

  it("renders on ready and ignores unsupported actions", async () => {
    const ctx = await signedIn();
    const renders = ctx.renders.length;
    await ctx.act({ type: "ready" });
    expect(ctx.renders).toHaveLength(renders + 1);
    await ctx.act({ type: "react", messageId: "1", emoji: "x", add: true });
    await ctx.act({ type: "typing" });
    expect(ctx.renders).toHaveLength(renders + 1);
  });
});

describe("chat view", () => {
  it("lists dialogs as sidebar items with avatars, unread counts and the active flag", async () => {
    const ctx = await signedIn();
    ctx.api.avatar.mockResolvedValue(undefined);
    await ctx.adapter.openConversation("2");
    expect(ctx.chat().sidebar).toEqual([
      { id: "1", name: "User 1", kind: "dm", unread: true, mentions: 2, active: false },
      { id: "2", name: "User 2", kind: "dm", unread: false, mentions: 0, active: true },
      { id: "3", name: "User 3", kind: "dm", unread: false, mentions: 0, active: false },
    ]);
  });

  it("has no channel until a chat is selected, and ignores unknown chats", async () => {
    const ctx = await signedIn();
    expect(ctx.chat().channel).toBeNull();
    await ctx.act({ type: "select", channelId: "404" });
    expect(ctx.chat().channel).toBeNull();
    expect(ctx.api.history).not.toHaveBeenCalled();
  });

  it("fetches history once, oldest first, with a loading flag meanwhile", async () => {
    const ctx = await signedIn();
    let resolve!: (page: TgMessage[]) => void;
    ctx.api.history.mockImplementation(() => new Promise((r) => (resolve = r)));
    const first = ctx.adapter.openConversation("1");
    await flush();
    expect(ctx.chat().channel).toMatchObject({ id: "1", name: "User 1", loading: true });
    const second = ctx.adapter.openConversation("1");
    await flush();
    expect(ctx.api.history).toHaveBeenCalledTimes(1);
    resolve([msg("1", 3), msg("1", 1), msg("1", 2)]);
    await Promise.all([first, second]);
    expect(ctx.api.history).toHaveBeenCalledWith("1", undefined, PAGE_SIZE);
    expect(ctx.chat().channel).toMatchObject({ loading: false, hasOlder: false });
    expect(ctx.messageIds()).toEqual(["1", "2", "3"]);

    await ctx.adapter.openConversation("1");
    expect(ctx.api.history).toHaveBeenCalledTimes(1);
  });

  it("marks the chat read when visible and unread, not otherwise", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    expect(ctx.api.markRead).not.toHaveBeenCalled();
    ctx.adapter.setVisible(true);
    await flush();
    expect(ctx.api.markRead).toHaveBeenCalledWith("1", 2);
    expect(ctx.chat().sidebar[0]).toMatchObject({ unread: false, mentions: 0 });

    await ctx.adapter.openConversation("2");
    expect(ctx.api.markRead).toHaveBeenCalledTimes(1);
  });

  it("ignores a failing markRead and chats with nothing to mark", async () => {
    const ctx = await signedIn({ dialogs: [dlg("1", { unreadCount: 1 }), dlg("2", { unreadCount: 1, lastMessage: msg("2", 5) })] });
    ctx.api.history.mockResolvedValue([]);
    ctx.adapter.setVisible(true);
    await ctx.adapter.openConversation("1");
    expect(ctx.api.markRead).not.toHaveBeenCalled();
    ctx.api.markRead.mockRejectedValue(new Error("x"));
    await ctx.adapter.openConversation("2");
    expect(ctx.api.markRead).toHaveBeenCalledWith("2", 5);
  });

  it("does not mark a chat read once it left the dialog list", async () => {
    vi.useFakeTimers();
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    ctx.api.dialogList = [];
    ctx.api.emit({ type: "message", message: msg("99", 1) });
    await vi.advanceTimersByTimeAsync(1000);
    ctx.adapter.setVisible(true);
    await flush();
    expect(ctx.api.markRead).not.toHaveBeenCalled();
  });

  it("shows hasOlder when a full page came back and loads older messages in front", async () => {
    const ctx = await signedIn();
    const newest = Array.from({ length: PAGE_SIZE }, (_, i) => msg("1", 51 + i));
    ctx.api.history.mockResolvedValueOnce(newest);
    await ctx.adapter.openConversation("1");
    expect(ctx.chat().channel!.hasOlder).toBe(true);

    ctx.api.history.mockResolvedValueOnce([msg("1", 1), msg("1", 2), msg("1", 51)]);
    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.history).toHaveBeenLastCalledWith("1", 51, PAGE_SIZE);
    expect(ctx.messageIds().slice(0, 3)).toEqual(["1", "2", "51"]);
    expect(ctx.messageIds()).toHaveLength(PAGE_SIZE + 2);
    expect(ctx.chat().channel!.hasOlder).toBe(false);

    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.history).toHaveBeenCalledTimes(2);
  });

  it("ignores loadOlder without a selection", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.history).not.toHaveBeenCalled();
  });

  it("reports history errors", async () => {
    const ctx = await signedIn();
    ctx.api.history.mockRejectedValue(new Error("boom"));
    await ctx.adapter.openConversation("1");
    expect(ctx.chat()).toMatchObject({ error: "Could not load messages: boom" });
    expect(ctx.chat().channel).toMatchObject({ loading: false, messages: [] });
  });
});

describe("sending", () => {
  const open = async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    return ctx;
  };

  it("sends the message and appends the result", async () => {
    const ctx = await open();
    await ctx.act({ type: "send", content: "hello" });
    expect(ctx.api.send).toHaveBeenCalledWith("1", "hello", undefined);
    expect(ctx.messageIds().at(-1)).toBe("200");
    expect(ctx.chat().channel!.messages.at(-1)).toMatchObject({ author: "Me", mine: true, canEdit: true, canDelete: true, source: "hello" });
    expect(ctx.notifications).toEqual([]);
  });

  it("passes the reply id as a number", async () => {
    const ctx = await open();
    await ctx.act({ type: "send", content: "re", replyTo: "2" });
    expect(ctx.api.send).toHaveBeenCalledWith("1", "re", 2);
  });

  it("ignores empty messages and a missing selection", async () => {
    const ctx = await open();
    await ctx.act({ type: "send", content: "  \n" });
    expect(ctx.api.send).not.toHaveBeenCalled();
    const other = await signedIn();
    await other.act({ type: "send", content: "hi" });
    await other.act({ type: "edit", messageId: "1", content: "x" });
    await other.act({ type: "delete", messageId: "1" });
    expect(other.api.send).not.toHaveBeenCalled();
    expect(other.api.edit).not.toHaveBeenCalled();
    expect(other.api.remove).not.toHaveBeenCalled();
  });

  it("reports a failed send", async () => {
    const ctx = await open();
    ctx.api.send.mockRejectedValue(new Error("flaky"));
    await ctx.act({ type: "send", content: "hello" });
    expect(ctx.chat().error).toBe("Message not sent: flaky");
  });

  it("edits a message", async () => {
    const ctx = await open();
    await ctx.act({ type: "edit", messageId: "2", content: "fixed" });
    expect(ctx.api.edit).toHaveBeenCalledWith("1", 2, "fixed");
    expect(ctx.chat().channel!.messages[1]).toMatchObject({ id: "2", content: "fixed", edited: true, source: "fixed" });
  });

  it("reports a failed edit", async () => {
    const ctx = await open();
    ctx.api.edit.mockRejectedValue(tgError("MESSAGE_EDIT_TIME_EXPIRED"));
    await ctx.act({ type: "edit", messageId: "2", content: "x" });
    expect(ctx.chat().error).toBe("Message not edited: MESSAGE_EDIT_TIME_EXPIRED");
  });

  it("deletes a message", async () => {
    const ctx = await open();
    await ctx.act({ type: "delete", messageId: "2" });
    expect(ctx.api.remove).toHaveBeenCalledWith("1", [2]);
    expect(ctx.messageIds()).toEqual(["1"]);
  });

  it("reports a failed delete", async () => {
    const ctx = await open();
    ctx.api.remove.mockRejectedValue(new Error("denied"));
    await ctx.act({ type: "delete", messageId: "2" });
    expect(ctx.chat().error).toBe("Message not deleted: denied");
  });
});

describe("message rendering", () => {
  const history = async (messages: TgMessage[], options: Options = {}) => {
    const ctx = await signedIn(options);
    ctx.api.history.mockResolvedValue(messages);
    await ctx.adapter.openConversation("1");
    return ctx;
  };

  it("escapes the text, appends the media label and maps the fields", async () => {
    const ctx = await history([msg("1", 1, { text: "*hi*", media: "📷 Photo", date: 60, edited: true })]);
    expect(ctx.chat().channel!.messages[0]).toEqual({
      id: "1",
      author: "User 1",
      content: escapeMarkdown("*hi*\n📷 Photo"),
      timestamp: "1970-01-01T00:01:00.000Z",
      edited: true,
      mine: false,
      canEdit: false,
      canDelete: false,
      reactions: [],
      attachments: [],
    });
  });

  it("uses the sender's name when known", async () => {
    const ctx = await history([msg("1", 1, { sender: "Ana" })]);
    expect(ctx.chat().channel!.messages[0]!.author).toBe("Ana");
  });

  it("only allows editing own messages that have text", async () => {
    const ctx = await history([msg("1", 1, { out: true, text: "", media: "📷 Photo" }), msg("1", 2, { out: true, text: "mine" })]);
    const [media, text] = ctx.chat().channel!.messages;
    expect(media).toMatchObject({ mine: true, canEdit: false, canDelete: true });
    expect(media).not.toHaveProperty("source");
    expect(text).toMatchObject({ canEdit: true, source: "mine" });
  });

  it("falls back to You when the account name is unknown", async () => {
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.me.mockResolvedValue(undefined as never);
    await ctx.adapter.start();
    await flush();
    ctx.api.history.mockResolvedValue([msg("1", 1, { out: true }), msg("1", 2, { replyToId: 1 })]);
    await ctx.adapter.openConversation("1");
    expect(ctx.chat().me).toBe("");
    expect(ctx.chat().channel!.messages[0]!.author).toBe("You");
    expect(ctx.chat().channel!.messages[1]!.reply!.author).toBe("You");
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-in" });
  });

  it("previews the message being replied to when it is cached", async () => {
    const long = "x".repeat(150);
    const ctx = await history([
      msg("1", 1, { out: true, text: "mine" }),
      msg("1", 2, { sender: "Ana", text: long }),
      msg("1", 3, { replyToId: 1 }),
      msg("1", 4, { replyToId: 2 }),
      msg("1", 5, { replyToId: 77 }),
      msg("1", 6, { replyToId: 7 }),
    ]);
    const messages = ctx.chat().channel!.messages;
    expect(messages[2]!.reply).toEqual({ author: "Me", content: "mine" });
    expect(messages[3]!.reply).toEqual({ author: "Ana", content: "x".repeat(100) });
    expect(messages[4]).not.toHaveProperty("reply");
  });

  it("names a replied message after the dialog when it has no sender", async () => {
    const ctx = await history([msg("1", 1), msg("1", 2, { replyToId: 1 })]);
    expect(ctx.chat().channel!.messages[1]!.reply).toEqual({ author: "User 1", content: "m1" });
  });
});

describe("updates", () => {
  it("refreshes the dialog list once for a message from an unknown chat", async () => {
    vi.useFakeTimers();
    const ctx = await signedIn();
    ctx.api.dialogs.mockClear();
    ctx.api.dialogList = [...defaultDialogs(), dlg("9", { date: 99 })];
    ctx.api.emit({ type: "message", message: msg("9", 1) });
    ctx.api.emit({ type: "message", message: msg("9", 2) });
    expect(ctx.api.dialogs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.api.dialogs).toHaveBeenCalledTimes(1);
    expect(ctx.chat().sidebar[0]!.id).toBe("9");

    ctx.api.emit({ type: "message", message: msg("8", 1) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.api.dialogs).toHaveBeenCalledTimes(2);
  });

  it("survives a failing dialog refresh", async () => {
    vi.useFakeTimers();
    const ctx = await signedIn();
    ctx.api.dialogs.mockRejectedValue(new Error("down"));
    ctx.api.emit({ type: "message", message: msg("9", 1) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.chat().sidebar).toHaveLength(3);
  });

  it("counts an incoming message as unread, notifies and appends it to a loaded chat", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    ctx.api.emit({ type: "message", message: msg("1", 3, { text: "y".repeat(300), media: "📷 Photo" }) });
    expect(ctx.notifications).toEqual([
      { title: "User 1", body: messageText(msg("1", 3, { text: "y".repeat(300), media: "📷 Photo" })).slice(0, 200), target: "1", railKey: "dm:1", inView: false },
    ]);
    expect(ctx.chat().sidebar[0]).toMatchObject({ unread: true, mentions: 3 });
    expect(ctx.messageIds()).toEqual(["1", "2", "3"]);
    expect(ctx.directs.at(-1)![0]).toMatchObject({ key: "1", lastActivity: 103_000, mentions: 3 });
  });

  it("does not duplicate a known message or let an older one replace the last message", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    ctx.api.emit({ type: "message", message: msg("1", 2, { text: "again" }) });
    expect(ctx.messageIds()).toEqual(["1", "2"]);
    ctx.api.emit({ type: "message", message: msg("1", 1, { text: "old" }) });
    expect((await ctx.adapter.listDirectConversations()).find((d) => d.key === "1")!.preview).toBe("again");
  });

  it("moves the dialog of a new message to the top", async () => {
    const ctx = await signedIn();
    ctx.api.emit({ type: "message", message: msg("3", 1, { date: 500 }) });
    expect(ctx.chat().sidebar.map((i) => i.id)).toEqual(["3", "1", "2"]);
  });

  it("marks an incoming message read instead when its chat is on screen", async () => {
    const ctx = await signedIn();
    ctx.adapter.setVisible(true);
    await ctx.adapter.openConversation("1");
    ctx.api.markRead.mockClear();
    ctx.api.emit({ type: "message", message: msg("1", 3) });
    await flush();
    expect(ctx.notifications[0]).toMatchObject({ inView: true });
    expect(ctx.chat().sidebar[0]).toMatchObject({ unread: false, mentions: 0 });
    // Read on the server too, though there was no unread count to clear.
    expect(ctx.api.markRead).toHaveBeenCalledWith("1", 3);
    ctx.api.markRead.mockRejectedValueOnce(new Error("offline"));
    ctx.api.emit({ type: "message", message: msg("1", 4) });
    await flush(); // a failed read receipt is not an error worth showing
  });

  it("marks a backlog read on screen up to the new message", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    ctx.adapter.setVisible(true);
    await flush();
    ctx.api.markRead.mockClear();
    ctx.adapter.setVisible(false);
    ctx.api.emit({ type: "message", message: msg("1", 3) });
    ctx.adapter.setVisible(true);
    await flush();
    expect(ctx.api.markRead).toHaveBeenCalledWith("1", 3);
  });

  it("does not notify or count messages sent from another device", async () => {
    const ctx = await signedIn();
    ctx.api.emit({ type: "message", message: msg("2", 7, { out: true }) });
    expect(ctx.notifications).toEqual([]);
    expect(ctx.chat().sidebar.find((i) => i.id === "2")).toMatchObject({ unread: false });
  });

  it("replaces an edited message in the cache and as the last message", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    ctx.api.emit({ type: "edit", message: msg("1", 2, { text: "fixed", edited: true }) });
    expect(ctx.chat().channel!.messages[1]).toMatchObject({ content: "fixed", edited: true });
    expect((await ctx.adapter.listDirectConversations())[0]!.preview).toBe("fixed");
  });

  it("tolerates edits of messages it does not have", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    ctx.api.emit({ type: "edit", message: msg("1", 55, { text: "?" }) });
    ctx.api.emit({ type: "edit", message: msg("404", 1) });
    expect(ctx.messageIds()).toEqual(["1", "2"]);
  });

  describe("deletions", () => {
    const loaded = async () => {
      const ctx = await signedIn();
      await ctx.adapter.openConversation("2");
      await ctx.adapter.openConversation("1");
      return ctx;
    };
    const idsOf = async (ctx: Awaited<ReturnType<typeof loaded>>, chatId: string) => {
      await ctx.adapter.openConversation(chatId);
      return ctx.messageIds();
    };

    it("removes the ids from the named chat only", async () => {
      const ctx = await loaded();
      ctx.api.emit({ type: "delete", chatId: "1", ids: [1] });
      expect(await idsOf(ctx, "1")).toEqual(["2"]);
      expect(await idsOf(ctx, "2")).toEqual(["1", "2"]);
    });

    it("removes the ids from every chat when no chat is named, and clears the last message", async () => {
      const ctx = await loaded();
      ctx.api.emit({ type: "delete", ids: [2] });
      expect(await idsOf(ctx, "1")).toEqual(["1"]);
      expect(await idsOf(ctx, "2")).toEqual(["1"]);
      expect((await ctx.adapter.listDirectConversations())[0]).not.toHaveProperty("preview");
    });
  });
});

describe("shell interface", () => {
  it("maps dialogs to direct conversations", async () => {
    const long = `a  b\n\n${"c".repeat(300)}`;
    const ctx = await signedIn({
      dialogs: [dlg("1", { date: 30, unreadCount: 2, lastMessage: msg("1", 2, { text: long, media: "📷 Photo" }) }), dlg("2", { date: 20, title: "Bot" })],
    });
    ctx.api.avatar.mockImplementation(async (id) => (id === "2" ? "data:2" : undefined));
    // Avatars load once after sign-in; start over to pick up the new mock.
    const again = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true, dialogs: ctx.api.dialogList });
    again.api.avatar.mockImplementation(async (id) => (id === "2" ? "data:2" : undefined));
    await again.adapter.start();
    await flush();
    const [one, two] = await again.adapter.listDirectConversations();
    expect(one).toMatchObject({ key: "1", title: "User 1", lastActivity: 30_000, unread: true, mentions: 2 });
    expect(one!.account).toEqual({ platform: "telegram", instance: "telegram.org", accountId: "default" });
    expect(one!.preview).toHaveLength(200);
    expect(one!.preview!.startsWith("a b c")).toBe(true);
    expect(one).not.toHaveProperty("avatarUrl");
    expect(two).toMatchObject({ key: "2", title: "Bot", unread: false, avatarUrl: "data:2" });
    expect(two).not.toHaveProperty("preview");
    expect(again.adapter.directs()).toEqual([one, two]);
  });

  it("selects a conversation, renders home and reports no home badge", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("2");
    expect(ctx.chat().channel!.id).toBe("2");
    const renders = ctx.renders.length;
    await ctx.adapter.openHome();
    expect(ctx.renders).toHaveLength(renders + 1);
    expect(ctx.adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
    expect(ctx.adapter.mode).toBe("native");
    expect(ctx.adapter.capabilities).toMatchObject({ directMessages: true, voice: false });
  });

  it("has no servers", async () => {
    const ctx = await signedIn();
    await expect(ctx.adapter.openServer("x")).rejects.toThrow("Telegram has no server x");
  });

  it("signs out: logs out, clears everything and returns to the phone step", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    ctx.api.logOut.mockRejectedValue(new Error("gone"));
    ctx.api.disconnect.mockRejectedValue(new Error("gone"));
    ctx.api.authorized.mockResolvedValue(false);
    const clients = ctx.createApi.mock.calls.length;
    await ctx.act({ type: "logout" });
    // A fresh client for the next sign-in, without the old session.
    expect(ctx.createApi.mock.calls.length).toBe(clients + 1);
    expect(ctx.createApi.mock.calls.at(-1)![1]).toBe("");
    expect(ctx.api.logOut).toHaveBeenCalled();
    expect(ctx.api.disconnect).toHaveBeenCalled();
    expect(ctx.secrets.has("session")).toBe(false);
    expect(ctx.secrets.has("api")).toBe(true);
    expect(ctx.directs.at(-1)).toEqual([]);
    expect(await ctx.adapter.listDirectConversations()).toEqual([]);
    expect(ctx.prompt().prompt.id).toBe("phone");
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("signs out to the API step when there are no credentials", async () => {
    const ctx = setup();
    await ctx.adapter.start();
    await ctx.adapter.signOut();
    expect(ctx.prompt().prompt.id).toBe("api");
  });
});

describe("parseCredentials", () => {
  it("accepts a positive integer id and a 32-character hex hash, lowercasing it", () => {
    expect(parseCredentials(JSON.stringify({ apiId: 1, apiHash: HASH }))).toEqual({ apiId: 1, apiHash: HASH.toLowerCase() });
  });

  it.each([undefined, "", "null", "[]", "{", JSON.stringify({ apiId: "1", apiHash: HASH }), JSON.stringify({ apiId: -3, apiHash: HASH }), JSON.stringify({ apiId: 1, apiHash: 5 })])(
    "rejects %j",
    (text) => {
      expect(parseCredentials(text)).toBeUndefined();
    },
  );
});

describe("messageText", () => {
  it("joins text and media, skipping empty parts", () => {
    expect(messageText(msg("1", 1, { text: "hi", media: "📷 Photo" }))).toBe("hi\n📷 Photo");
    expect(messageText(msg("1", 1, { text: "hi" }))).toBe("hi");
    expect(messageText(msg("1", 1, { text: "", media: "📷 Photo" }))).toBe("📷 Photo");
    expect(messageText(msg("1", 1, { text: "" }))).toBe("");
  });
});

describe("media", () => {
  const photo = { kind: "image" as const, name: "Photo", mime: "image/jpeg", size: 2, width: 4, height: 3 };

  it("offers media to load, and loads it once into the view", async () => {
    const ctx = await signedIn();
    ctx.api.history.mockResolvedValueOnce([
      msg("1", 1, { text: "look", media: "📷 Photo", file: photo }),
      msg("1", 2, { text: "", media: "📍 Location" }),
      msg("1", 3, { text: "", media: "🎉 Sticker", file: { kind: "sticker", name: "🎉 Sticker", mime: "image/webp", thumbnailOnly: true } }),
      msg("1", 4, { text: "", media: "GIF", file: { kind: "video", name: "GIF", mime: "video/mp4", loop: true } }),
    ]);
    await ctx.act({ type: "select", channelId: "1" });
    const [first, second, , gif] = ctx.chat().channel!.messages;
    expect(first!.content).toBe("look"); // the picture shows; no label needed
    expect(first!.attachments).toEqual([{ ...photo, mediaKey: "tg:1:1" }]);
    expect(second!.content).toBe("📍 Location");
    expect(gif!.attachments[0]).toMatchObject({ loop: true, mediaKey: "tg:1:4" });

    await ctx.act({ type: "loadMedia", key: "tg:1:1" });
    expect(ctx.api.download).toHaveBeenCalledWith("1", 1, false);
    expect(ctx.chat().channel!.messages[0]!.attachments[0]).toMatchObject({ url: "data:image/jpeg;base64,aGk=" });
    await ctx.act({ type: "loadMedia", key: "tg:1:1" }); // already here
    await ctx.act({ type: "loadMedia", key: "tg:1:3" });
    expect(ctx.api.download).toHaveBeenLastCalledWith("1", 3, true); // the still of an animated sticker
    expect(ctx.api.download).toHaveBeenCalledTimes(2);
  });

  it("says when media is too large, gone or failed, and ignores keys it did not give", async () => {
    const { MAX_MEDIA_BYTES } = await import("../../../src/modules/telegram/adapter");
    const ctx = await signedIn();
    ctx.api.history.mockResolvedValueOnce([
      msg("1", 1, { file: { ...photo, size: MAX_MEDIA_BYTES + 1 } }),
      msg("1", 2, { file: photo }),
      msg("1", 3, { file: { kind: "file", name: "a.bin" } }),
      msg("1", 4, { file: { kind: "video", name: "v" } }),
      msg("1", 5, { file: { kind: "audio", name: "a" } }),
    ]);
    await ctx.act({ type: "select", channelId: "1" });
    const attachment = (i: number) => ctx.chat().channel!.messages[i]!.attachments[0]!;
    expect(attachment(0)).toMatchObject({ unavailable: "too large to show here; open it in Telegram" });
    expect(attachment(0)).not.toHaveProperty("mediaKey");

    ctx.api.download.mockResolvedValueOnce(undefined);
    await ctx.act({ type: "loadMedia", key: "tg:1:2" });
    expect(attachment(1)).toMatchObject({ unavailable: "not available" });
    ctx.api.download.mockResolvedValueOnce(new Uint8Array(MAX_MEDIA_BYTES + 1));
    await ctx.act({ type: "loadMedia", key: "tg:1:3" });
    expect(attachment(2)).toMatchObject({ unavailable: "too large to show here; open it in Telegram" });
    ctx.api.download.mockRejectedValueOnce({ errorMessage: "FILE_REFERENCE_EXPIRED" });
    await ctx.act({ type: "loadMedia", key: "tg:1:4" });
    expect(attachment(3)).toMatchObject({ unavailable: "could not load: FILE_REFERENCE_EXPIRED" });
    // A file of unknown type travels as plain bytes.
    await ctx.act({ type: "loadMedia", key: "tg:1:5" });
    expect(attachment(4)).toMatchObject({ url: "data:application/octet-stream;base64,aGk=" });

    ctx.api.download.mockClear();
    for (const key of ["tg:1:99", "tg:9:1", "other:1:1", "tg:x:1"]) await ctx.act({ type: "loadMedia", key });
    expect(ctx.api.download).not.toHaveBeenCalled();
  });

  it("keeps loaded media within its budget, forgetting the oldest first", async () => {
    const ctx = await signedIn({ mediaBudget: 1000 });
    ctx.api.history.mockResolvedValueOnce([msg("1", 1, { file: photo }), msg("1", 2, { file: photo })]);
    await ctx.act({ type: "select", channelId: "1" });
    // Each download takes more than half the budget once encoded.
    ctx.api.download.mockResolvedValue(new Uint8Array(400));
    await ctx.act({ type: "loadMedia", key: "tg:1:1" });
    await ctx.act({ type: "loadMedia", key: "tg:1:2" });
    const [first, second] = ctx.chat().channel!.messages;
    expect(first!.attachments[0]).toMatchObject({ mediaKey: "tg:1:1" });
    expect(first!.attachments[0]).not.toHaveProperty("url");
    expect(second!.attachments[0]!.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("encodes large files to base64 in pieces", async () => {
    const { toBase64 } = await import("../../../src/modules/telegram/adapter");
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
