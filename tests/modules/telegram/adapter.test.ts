import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectConversation, PlatformNotification } from "../../../src/shared/adapter";
import type { TelegramApi, TelegramCredentials, TgCustomEmoji, TgNewPoll, TgPoll, TgAllowedReactions, TgDialog, TgDialogCursor, TgDialogPage, TgFolder, TgMember, TgQrLogin, TgMemberPage, TgMessage, TgNotifyDefaults, TgProfile, TgSignIn, TgSticker, TgStickerSet, TgText, TgTopic, TgUpdate, TgUser } from "../../../src/modules/telegram/api";
import { EMOJI_LIMIT, EMOJI_SET_LIMIT, MAX_EMOJI_BYTES, PICKER_EMOJI_LIMIT, MAX_STICKER_BYTES, PACK_STICKER_LIMIT, STICKER_LIMIT, STICKER_RENDER_MS, STICKER_SET_LIMIT } from "../../../src/modules/telegram/adapter";
import { QR_REFRESH_MAX_MS, QR_REFRESH_MIN_MS } from "../../../src/modules/telegram/adapter";
import { AVATAR_LIMIT, CAPTION_LIMIT, DIALOG_LIMIT, DIALOG_PAGE, DIALOG_PAGE_MS, TOPIC_LIMIT, MAX_UPLOAD_BYTES, PREMIUM_REACTIONS, TYPING_REPEAT_MS, TYPING_SHOWN_MS, withChosen, FORGET_API_ID, MEMBER_AVATAR_LIMIT, MEMBER_LIMIT, MEMBER_PAGE, MUTE_FOREVER, PAGE_SIZE, TelegramAdapter, chatIdOfView, messageText, parseCredentials, viewId } from "../../../src/modules/telegram/adapter";
import { escapeMarkdown } from "../../../src/shared/markdown";
import { MAX_ATTACHMENTS, type NativeAction, type NativeViewState } from "../../../src/shared/native";
import type { FileSource } from "../../../src/engine/runtime";

const HASH = "0123456789abcdef0123456789ABCDEF";
const CREDS: TelegramCredentials = { apiId: 12, apiHash: HASH.toLowerCase() };
const CREDS_JSON = JSON.stringify(CREDS);

const tgError = (name: string) => ({ errorMessage: name });
const flush = async () => {
  for (let i = 0; i < 500; i++) await Promise.resolve();
};

const msg = (chatId: string, id: number, extra: Partial<TgMessage> = {}): TgMessage => ({ id, chatId, out: false, text: `m${id}`, date: 100 + id, edited: false, ...extra });
const dlg = (chatId: string, extra: Partial<TgDialog> = {}): TgDialog => ({ chatId, kind: "user", title: `User ${chatId}`, bot: false, unreadCount: 0, unreadMentions: 0, date: 0, ...extra });
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
  qrLogin = vi.fn(async (): Promise<TgQrLogin> => ({ token: new Uint8Array([251, 255, 1]), expires: Math.floor(Date.now() / 1000) + 30 }));
  me = vi.fn(async (): Promise<TgUser> => ({ id: "9", name: "Me", bot: false }));
  dialogs = vi.fn(async (_limit: number, _after?: TgDialogCursor): Promise<TgDialogPage> => ({ dialogs: this.dialogList.map((d) => ({ ...d })) }));
  history = vi.fn(async (chatId: string, _before: number | undefined, _limit: number): Promise<TgMessage[]> => [msg(chatId, 1), msg(chatId, 2)]);
  pinned = vi.fn(async (chatId: string, _limit: number): Promise<TgMessage[]> => [msg(chatId, 2, { pinned: true })]);
  pin = vi.fn(async (_chatId: string, _id: number, _pin: boolean) => {});
  search = vi.fn(async (chatId: string, _query: string, _limit: number): Promise<TgMessage[]> => [msg(chatId, 1)]);
  forward = vi.fn(async (_from: string, _id: number, _to: string, _topic?: number) => {});
  vote = vi.fn(async (_chatId: string, _id: number, _options: string[]) => {});
  sendPoll = vi.fn(async (chatId: string, poll: TgNewPoll, _topicId?: number) =>
    msg(chatId, 500, { out: true, text: "", media: "📊 Poll", poll: { id: "90", question: poll.question, answers: poll.answers.map((text, i) => ({ option: String(i), text })), multiple: poll.multiple, closed: false, quiz: false } }),
  );
  closePoll = vi.fn(async (_chatId: string, _id: number, _poll: TgPoll) => {});
  send = vi.fn(async (chatId: string, text: TgText, _replyTo?: number) => msg(chatId, 200, { out: true, ...text }));
  sentFiles = 300;
  sendFile = vi.fn(async (chatId: string, file: FileSource, caption: TgText, _replyTo?: number) => msg(chatId, this.sentFiles++, { out: true, ...caption, media: file.filename }));
  edit = vi.fn(async (chatId: string, id: number, text: TgText) => msg(chatId, id, { out: true, ...text, edited: true }));
  remove = vi.fn(async (_chatId: string, _ids: number[]) => {});
  markRead = vi.fn(async (_chatId: string, _maxId: number) => {});
  mute = vi.fn(async (_chatId: string, _until: number) => {});
  archive = vi.fn(async (_chatId: string, _archived: boolean) => {});
  notifyDefaults = vi.fn(async (): Promise<TgNotifyDefaults> => ({ user: 0, group: 0, channel: 0 }));
  folders = vi.fn(async (): Promise<TgFolder[]> => []);
  avatar = vi.fn(async (_chatId: string): Promise<string | undefined> => undefined);
  members = vi.fn(async (_chatId: string, _offset: number, _limit: number): Promise<TgMemberPage> => ({ members: [], total: 0 }));
  profile = vi.fn(async (userId: string): Promise<TgProfile> => ({ id: userId, name: `User ${userId}`, bot: false, presence: "offline" }));
  react = vi.fn(async (_chatId: string, _id: number, _emoji: string[]) => {});
  allowedReactions = vi.fn(async (_chatId: string): Promise<TgAllowedReactions> => ({ kind: "all" }));
  reactionList = vi.fn(async (): Promise<string[]> => ["👍", "❤", "🔥", "😁"]);
  typing = vi.fn(async (_chatId: string, _active: boolean, _topicId?: number) => {});
  topics = vi.fn(async (_chatId: string, _limit: number): Promise<TgTopic[]> => []);
  createTopic = vi.fn(async (_chatId: string, _title: string) => 77);
  userName = vi.fn(async (_userId: string): Promise<string | undefined> => undefined);
  download = vi.fn(async (_chatId: string, _id: number, _thumbnail: boolean): Promise<Uint8Array | undefined> => new Uint8Array([104, 105]));
  stickerSets = vi.fn(async (): Promise<TgStickerSet[]> => []);
  stickers = vi.fn(async (_setId: string): Promise<TgSticker[]> => []);
  stickerFile = vi.fn(async (_id: string, _thumbnail: boolean): Promise<Uint8Array | undefined> => new Uint8Array([104, 105]));
  sendSticker = vi.fn(async (chatId: string, _id: string, _replyTo?: number, _topicId?: number) => msg(chatId, 400, { out: true, text: "", media: "😀 Sticker" }));
  customEmoji = vi.fn(async (ids: string[]): Promise<TgCustomEmoji[]> => ids.map((id) => ({ id, emoji: "😀", format: "webp" as const })));
  customEmojiFile = vi.fn(async (_id: string, _thumbnail: boolean): Promise<Uint8Array | undefined> => new Uint8Array([104, 105]));
  emojiSets = vi.fn(async (): Promise<TgStickerSet[]> => []);
  emojiSet = vi.fn(async (_setId: string): Promise<TgCustomEmoji[]> => []);
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
  stickerBudget?: number;
  emojiBudget?: number;
  secrets?: Record<string, string>;
  builtIn?: TelegramCredentials;
  dialogs?: TgDialog[];
  authorized?: boolean;
  /** No file picker, as where the engine offers none. */
  noFiles?: boolean;
  settings?: Record<string, boolean | string>;
}

function setup(options: Options = {}) {
  /** What the file picker returns next. */
  const picked: FileSource[] = [];
  const picker = {
    pick: vi.fn(async () => [...picked]),
    // Files the shell hands over.
    open: vi.fn((file: { name: string; size: number; type: string }): FileSource => ({ filename: file.name, size: file.size, contentType: file.type, read: async () => new Uint8Array(file.size) })),
  };
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
    stickerBudget: options.stickerBudget,
    emojiBudget: options.emojiBudget,
    files: options.noFiles ? undefined : picker,
    settings: options.settings,
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
  /** The chats in the sidebar, without section headings. */
  const rows = () => chat().sidebar.filter((i) => i.kind !== "category");
  return { adapter, api, secrets, renders, directs, notifications, createApi, act, answer, last, prompt, chat, messageIds, rows, picked, picker };
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
    expect(ctx.chat()).toMatchObject({ title: "Chats", me: "Me", channel: null });
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

describe("Settings: Forget API ID", () => {
  it("says whose API ID is in use, never the hash", async () => {
    const none = setup();
    await none.adapter.start();
    expect(none.adapter.settingsStatus()).toEqual({ [FORGET_API_ID]: { text: "No API ID entered yet.", disabled: true } });
    const builtIn = setup({ builtIn: CREDS });
    await builtIn.adapter.start();
    expect(builtIn.adapter.settingsStatus()).toEqual({ [FORGET_API_ID]: { text: "Using Multicord's own API ID.", disabled: true } });
    const own = await signedIn();
    expect(own.adapter.settingsStatus()).toEqual({ [FORGET_API_ID]: { text: "Using the API ID you entered (12).", disabled: false } });
    expect(JSON.stringify(own.adapter.settingsStatus())).not.toContain(CREDS.apiHash);
  });

  it("counts credentials entered at the API step as the user's own, until Telegram rejects them", async () => {
    const ctx = setup();
    await ctx.adapter.start();
    await ctx.answer("api", { apiId: "12", apiHash: HASH });
    expect(ctx.adapter.settingsStatus()[FORGET_API_ID]!.disabled).toBe(false);
    ctx.api.sendCode.mockRejectedValue(tgError("API_ID_INVALID"));
    await ctx.answer("phone", { phone: "+31612345678" });
    expect(ctx.adapter.settingsStatus()[FORGET_API_ID]).toEqual({ text: "No API ID entered yet.", disabled: true });
  });

  it("forgets the entered credentials and signs out, back to the API step", async () => {
    const ctx = await signedIn();
    await ctx.adapter.runSettingAction(FORGET_API_ID);
    expect(ctx.secrets.has("api")).toBe(false);
    expect(ctx.secrets.has("session")).toBe(false);
    expect(ctx.api.logOut).toHaveBeenCalled();
    expect(ctx.prompt().prompt.id).toBe("api");
    expect(ctx.adapter.accountStatus()).toEqual({ state: "signed-out" });
    expect(ctx.adapter.settingsStatus()[FORGET_API_ID]!.disabled).toBe(true);
  });

  it("falls back to the built-in credentials, at the phone step", async () => {
    const builtIn = { apiId: 1, apiHash: "f".repeat(32) };
    const ctx = await signedIn({ builtIn });
    ctx.api.isAuthorized = false; // logged out
    await ctx.adapter.runSettingAction(FORGET_API_ID);
    await flush();
    expect(ctx.createApi).toHaveBeenLastCalledWith(builtIn, "");
    expect(ctx.prompt().prompt.id).toBe("phone");
    expect(ctx.adapter.settingsStatus()[FORGET_API_ID]!.text).toBe("Using Multicord's own API ID.");
  });

  it("does nothing for other keys, without entered credentials, or while busy", async () => {
    const ctx = await signedIn();
    await ctx.adapter.runSettingAction("other");
    expect(ctx.secrets.has("api")).toBe(true);
    const builtIn = setup({ builtIn: CREDS });
    await builtIn.adapter.start();
    await builtIn.adapter.runSettingAction(FORGET_API_ID);
    expect(builtIn.api.logOut).not.toHaveBeenCalled();
    const busy = await atCodeStep({ secrets: { api: CREDS_JSON } });
    let finish!: () => void;
    busy.api.signIn.mockReturnValue(new Promise((resolve) => (finish = () => resolve({ done: true }))));
    const signing = busy.answer("code", { code: "1" });
    await busy.adapter.runSettingAction(FORGET_API_ID);
    expect(busy.secrets.has("api")).toBe(true);
    finish();
    await signing;
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
    expect(ctx.api.dialogs).toHaveBeenCalledWith(DIALOG_PAGE);
    expect(ctx.rows().map((i) => i.id)).toEqual(["1", "2", "3"]);
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
    const items = ctx.rows();
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
    await ctx.act({ type: "cancelPrompt", id: "api" });
    // The phone step's other button only works at the phone step.
    await ctx.answer("phone", { phone: "+31612345678" });
    const atCode = ctx.renders.length;
    await ctx.act({ type: "cancelPrompt", id: "phone" });
    expect(ctx.renders).toHaveLength(atCode);
    expect(ctx.renders.slice(0, renders + 1).at(-1)).toBe(ctx.renders[renders]);
    expect(ctx.api.qrLogin).not.toHaveBeenCalled();
  });

  describe("signing in with a QR code", () => {
    /** At the QR step, its first token shown. */
    async function atQrStep() {
      vi.useFakeTimers({ now: 1_000_000_000_000 });
      const ctx = setup({ builtIn: CREDS });
      await ctx.adapter.start();
      expect(ctx.prompt().prompt.cancel).toBe("Sign in with a QR code");
      await ctx.act({ type: "cancelPrompt", id: "phone" });
      return ctx;
    }

    it("shows Telegram's sign-in link as the step's QR code, base64url, renewing it as it runs out", async () => {
      const ctx = await atQrStep();
      expect(ctx.renders.some((r) => r.screen === "prompt" && r.prompt.id === "qr" && r.status === "Getting a code…" && r.prompt.qr === undefined)).toBe(true);
      expect(ctx.prompt().prompt).toMatchObject({ id: "qr", fields: [], submit: "Show a new code", cancel: "Use my phone number", qr: "tg://login?token=-_8B" });
      expect(ctx.prompt().status).toBeUndefined();
      ctx.api.qrLogin.mockResolvedValue({ token: new Uint8Array([1, 2, 3]), expires: 1_000_000_000 + 1000 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ctx.prompt().prompt.qr).toBe("tg://login?token=AQID");
      // Asked again no sooner than QR_REFRESH_MIN_MS, and no later than QR_REFRESH_MAX_MS, whatever the expiry says.
      expect(ctx.api.qrLogin).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(QR_REFRESH_MAX_MS);
      expect(ctx.api.qrLogin).toHaveBeenCalledTimes(3);
      ctx.api.qrLogin.mockResolvedValue({ token: new Uint8Array([1]), expires: 0 });
      await vi.advanceTimersByTimeAsync(QR_REFRESH_MAX_MS);
      expect(ctx.api.qrLogin).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(QR_REFRESH_MIN_MS);
      expect(ctx.api.qrLogin).toHaveBeenCalledTimes(5);
      // A new code on request.
      await ctx.answer("qr", {});
      expect(ctx.api.qrLogin).toHaveBeenCalledTimes(6);
    });

    it("drops the code and stops renewing it on going back to the phone step", async () => {
      const ctx = await atQrStep();
      await ctx.act({ type: "cancelPrompt", id: "qr" });
      expect(ctx.prompt().prompt.id).toBe("phone");
      expect(JSON.stringify(ctx.last())).not.toContain("tg://login");
      await vi.advanceTimersByTimeAsync(QR_REFRESH_MAX_MS * 2);
      expect(ctx.api.qrLogin).toHaveBeenCalledTimes(1);
      // An answer that comes after the step ended changes nothing.
      let release: (value: TgQrLogin) => void = () => {};
      ctx.api.qrLogin.mockImplementation(() => new Promise((resolve) => (release = resolve)));
      const asking = ctx.act({ type: "cancelPrompt", id: "phone" });
      await ctx.act({ type: "cancelPrompt", id: "qr" });
      release({ done: true });
      await flush();
      await asking;
      expect(ctx.prompt().prompt.id).toBe("phone");
      expect(ctx.api.me).not.toHaveBeenCalled();
    });

    it("signs in once another device accepts the code, as Telegram's update says", async () => {
      const ctx = await atQrStep();
      ctx.api.isAuthorized = true;
      ctx.api.qrLogin.mockResolvedValue({ done: true });
      ctx.api.emit({ type: "loginToken" });
      await flush();
      expect(ctx.renders.some((r) => r.screen === "connecting" && r.status === "Signing in…")).toBe(true);
      expect(ctx.chat().me).toBe("Me");
      expect(ctx.secrets.get("session")).toBe("sess");
      expect(JSON.stringify(ctx.renders.at(-1))).not.toContain("tg://login");
      // No longer at the QR step: the update changes nothing.
      ctx.api.emit({ type: "loginToken" });
      await flush();
      expect(ctx.api.qrLogin).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(QR_REFRESH_MAX_MS);
      expect(ctx.api.qrLogin).toHaveBeenCalledTimes(2);
    });

    it("asks for the two-step password after the code, where the account has one", async () => {
      const ctx = await atQrStep();
      ctx.api.qrLogin.mockResolvedValue({ password: true, hint: "pet" });
      ctx.api.emit({ type: "loginToken" });
      await flush();
      expect(ctx.prompt().prompt).toMatchObject({ id: "password", description: "Your account has a password. Hint: pet" });
      await ctx.answer("password", { password: "pw" });
      expect(ctx.api.checkPassword).toHaveBeenCalledWith("pw");
      expect(ctx.chat().me).toBe("Me");
    });

    it("says why there is no code, and starts over where Telegram refuses the API ID", async () => {
      const ctx = await atQrStep();
      ctx.api.qrLogin.mockRejectedValue(tgError("AUTH_TOKEN_EXPIRED"));
      await ctx.answer("qr", {});
      expect(ctx.prompt()).toMatchObject({ prompt: { id: "qr" }, error: "Could not get a code: AUTH_TOKEN_EXPIRED" });
      expect(ctx.prompt().prompt.qr).toBeUndefined();
      ctx.api.qrLogin.mockRejectedValue(tgError("API_ID_INVALID"));
      await ctx.answer("qr", {});
      expect(ctx.prompt().prompt.id).toBe("api");
      // A failure that comes after the step ended is not shown.
      const late = await atQrStep();
      let fail: (error: unknown) => void = () => {};
      late.api.qrLogin.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
      late.api.emit({ type: "loginToken" });
      await late.act({ type: "cancelPrompt", id: "qr" });
      fail(tgError("AUTH_TOKEN_EXPIRED"));
      await flush();
      expect(late.prompt().error).toBeUndefined();
    });

    it("goes back to the phone step when signing in fails after the code was accepted", async () => {
      const ctx = await atQrStep();
      ctx.api.me.mockRejectedValue(tgError("AUTH_KEY_UNREGISTERED"));
      ctx.api.qrLogin.mockResolvedValue({ done: true });
      ctx.api.emit({ type: "loginToken" });
      await flush();
      expect(ctx.prompt()).toMatchObject({ prompt: { id: "phone" }, error: "Could not sign in: AUTH_KEY_UNREGISTERED" });
    });

    it("drops the code on signing out of the QR step", async () => {
      const ctx = await atQrStep();
      await ctx.act({ type: "logout" });
      expect(JSON.stringify(ctx.last())).not.toContain("tg://login");
      await vi.advanceTimersByTimeAsync(QR_REFRESH_MAX_MS * 2);
      expect(ctx.api.qrLogin).toHaveBeenCalledTimes(1);
    });

    it("does not start while a step is being answered", async () => {
      const ctx = setup({ builtIn: CREDS });
      await ctx.adapter.start();
      let release: (value: { hash: string; viaApp: boolean }) => void = () => {};
      ctx.api.sendCode.mockImplementation(() => new Promise((resolve) => (release = resolve)));
      const sending = ctx.answer("phone", { phone: "+31612345678" });
      await ctx.act({ type: "cancelPrompt", id: "phone" });
      expect(ctx.api.qrLogin).not.toHaveBeenCalled();
      release({ hash: "H", viaApp: false });
      await sending;
      expect(ctx.prompt().prompt.id).toBe("code");
    });
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
    await ctx.act({ type: "joinVoice", channelId: "1" });
    await ctx.act({ type: "attach" });
    expect(ctx.renders).toHaveLength(renders + 1);
  });
});

describe("chat view", () => {
  it("lists dialogs as sidebar items with avatars, unread counts and the active flag", async () => {
    const ctx = await signedIn();
    ctx.api.avatar.mockResolvedValue(undefined);
    await ctx.adapter.openConversation("2");
    expect(ctx.chat().sidebar).toEqual([
      { id: "section-user", name: "Direct messages", kind: "category", unread: false, mentions: 0, active: false },
      { id: "1", name: "User 1", kind: "dm", unread: true, mentions: 2, active: false, muted: false, canMute: true, canArchive: true },
      { id: "2", name: "User 2", kind: "dm", unread: false, mentions: 0, active: true, muted: false, canMute: true, canArchive: true },
      { id: "3", name: "User 3", kind: "dm", unread: false, mentions: 0, active: false, muted: false, canMute: true, canArchive: true },
    ]);
  });

  describe("the archive", () => {
    const archivedDialogs = () => [dlg("1", { date: 30 }), dlg("-5", { kind: "group", date: 20, archived: true, unreadCount: 4, unreadMentions: 1 }), dlg("2", { date: 10, archived: true, unreadCount: 2 }), dlg("9", { title: "Saved Messages", date: 5 })];
    const sections = (ctx: Awaited<ReturnType<typeof signedIn>>) => ctx.chat().sidebar.map((i) => (i.kind === "category" ? `[${i.name}]` : i.id));

    it("lists archived chats of every kind in an Archive section that starts folded, with their unread state summed", async () => {
      const ctx = await signedIn({ dialogs: archivedDialogs() });
      expect(sections(ctx)).toEqual(["[Direct messages]", "1", "9", "[Archive]", viewId("-5"), "2"]);
      expect(ctx.chat().sidebar.find((i) => i.id === "section-archive")).toEqual({ id: "section-archive", name: "Archive", kind: "category", unread: true, mentions: 3, active: false, collapsible: true, collapsed: true });
      expect(ctx.chat().sidebar.find((i) => i.id === "2")).toMatchObject({ archived: true, canArchive: true });
      // Saved Messages cannot be archived.
      expect(ctx.chat().sidebar.find((i) => i.id === "9")!.canArchive).toBeUndefined();
    });

    it("archives and unarchives chats from the sidebar, following Telegram's updates", async () => {
      const ctx = await signedIn({ dialogs: archivedDialogs() });
      await ctx.act({ type: "archive", channelId: "1", archive: true });
      expect(ctx.api.archive).toHaveBeenCalledWith("1", true);
      expect(sections(ctx)).toEqual(["[Direct messages]", "9", "[Archive]", "1", viewId("-5"), "2"]);
      // Already there, Saved Messages, or a chat not listed: nothing to do.
      await ctx.act({ type: "archive", channelId: "1", archive: true });
      await ctx.act({ type: "archive", channelId: "9", archive: true });
      await ctx.act({ type: "archive", channelId: "404", archive: true });
      expect(ctx.api.archive).toHaveBeenCalledTimes(1);
      await ctx.act({ type: "archive", channelId: "2", archive: false });
      expect(ctx.api.archive).toHaveBeenLastCalledWith("2", false);
      expect(sections(ctx)).toEqual(["[Direct messages]", "2", "9", "[Archive]", "1", viewId("-5")]);

      ctx.api.emit({ type: "archive", peers: [{ chatId: "1", archived: false }, { chatId: "-5", archived: false }, { chatId: "404", archived: true }] });
      expect(sections(ctx)).toEqual(["[Direct messages]", "1", "2", "9", "[Groups]", viewId("-5")]);

      ctx.api.archive.mockRejectedValueOnce(tgError("PEER_ID_INVALID"));
      await ctx.act({ type: "archive", channelId: "1", archive: true });
      expect(ctx.chat().error).toBe("Could not archive the chat: PEER_ID_INVALID");
      ctx.api.emit({ type: "archive", peers: [{ chatId: "1", archived: true }] });
      ctx.api.archive.mockRejectedValueOnce(tgError("PEER_ID_INVALID"));
      await ctx.act({ type: "archive", channelId: "1", archive: false });
      expect(ctx.chat().error).toBe("Could not move the chat out of the archive: PEER_ID_INVALID");
    });

    it("keeps archived chats out of the home badge and the Messages page until Telegram moves them out", async () => {
      const ctx = await signedIn({ dialogs: [...archivedDialogs(), dlg("-7", { kind: "group", date: 1, unreadCount: 1 })] });
      expect(ctx.adapter.homeBadge()).toEqual({ unread: true, mentions: 0 });
      expect(ctx.directs.at(-1)!.map((d) => d.key)).toEqual(["1", "9"]);
      // An unmuted archived chat that gets a message: Telegram unarchives it and says so.
      ctx.api.emit({ type: "archive", peers: [{ chatId: "2", archived: false }, { chatId: "-5", archived: false }] });
      expect(ctx.directs.at(-1)!.map((d) => d.key)).toEqual(["1", "2", "9"]);
      expect(ctx.adapter.homeBadge()).toEqual({ unread: true, mentions: 1 });
      await ctx.act({ type: "archive", channelId: "1", archive: true });
      expect(ctx.directs.at(-1)!.map((d) => d.key)).toEqual(["2", "9"]);
    });
  });

  describe("folders", () => {
    const folderDialogs = () => [
      dlg("1", { date: 90, contact: true, unreadCount: 1 }),
      dlg("2", { date: 80, unreadCount: 2 }),
      dlg("3", { date: 70, bot: true }),
      dlg("-4", { kind: "group", date: 60, unreadCount: 3, unreadMentions: 2 }),
      dlg("-1005", { kind: "channel", date: 50, mutedUntil: MUTE_FOREVER, unreadCount: 1 }),
      dlg("6", { date: 40, contact: true, archived: true }),
    ];
    const work: TgFolder = { id: 2, title: "Work", include: ["3"], exclude: ["2"], contacts: true, nonContacts: true, groups: true, broadcasts: true, excludeMuted: true };
    const ids = (ctx: Awaited<ReturnType<typeof signedIn>>) => ctx.rows().map((r) => chatIdOfView(r.id));

    async function withFolders(folders: TgFolder[]) {
      const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true, dialogs: folderDialogs() });
      ctx.api.folders.mockResolvedValue(folders);
      await ctx.adapter.start();
      await flush();
      return ctx;
    }

    it("offers no tabs until the user has a folder", async () => {
      const ctx = await withFolders([{ id: 0, title: "All chats", include: [], exclude: [] }]);
      expect(ctx.chat().folders).toBeUndefined();
      ctx.api.folders.mockRejectedValue(new Error("down"));
      ctx.api.emit({ type: "folders" });
      await flush();
      expect(ctx.chat().folders).toBeUndefined();
    });

    it("shows tabs with All chats first, each with the unread state and mentions of its chats", async () => {
      const ctx = await withFolders([work]);
      expect(ctx.chat().folders).toEqual([
        { id: "all", name: "All chats", active: true, unread: true, mentions: 5 },
        { id: "f2", name: "Work", active: false, unread: true, mentions: 3 },
      ]);
      await ctx.act({ type: "folder", id: "f2" });
      expect(ctx.chat().folders!.map((f) => f.active)).toEqual([false, true]);
      // Named chats are in it, left-out ones not, muted ones not where it leaves them out; archived ones show by kind.
      expect(ids(ctx)).toEqual(["1", "3", "6", "-4"]);
      expect(ctx.chat().sidebar.some((i) => i.id === "section-archive")).toBe(false);
      // Unknown tabs change nothing.
      await ctx.act({ type: "folder", id: "f9" });
      await ctx.act({ type: "folder", id: "x" });
      expect(ctx.chat().folders!.map((f) => f.active)).toEqual([false, true]);
      await ctx.act({ type: "folder", id: "all" });
      expect(ids(ctx)).toEqual(["1", "2", "3", "-4", "-1005", "6"]);
    });

    it("follows Telegram's rules for the kinds of chat a folder takes", async () => {
      const folder = (extra: Partial<TgFolder>): TgFolder => ({ id: 3, title: "F", include: [], exclude: [], ...extra });
      const cases: [Partial<TgFolder>, string[]][] = [
        [{ contacts: true }, ["1", "6"]],
        [{ nonContacts: true }, ["2"]],
        [{ bots: true }, ["3"]],
        [{ groups: true }, ["-4"]],
        [{ broadcasts: true }, ["-1005"]],
        [{ contacts: true, nonContacts: true, excludeRead: true }, ["1", "2"]],
        [{ contacts: true, excludeArchived: true }, ["1"]],
        [{}, []],
      ];
      for (const [extra, expected] of cases) {
        const ctx = await withFolders([folder(extra), { id: 0, title: "All chats", include: [], exclude: [] }]);
        await ctx.act({ type: "folder", id: "f3" });
        expect(ids(ctx)).toEqual(expected);
        // The user's order, with All chats where they placed it.
        expect(ctx.chat().folders!.map((f) => f.id)).toEqual(["f3", "all"]);
      }
    });

    it("fetches folders afresh when they change, showing all chats when the shown one is gone, and forgets them on signing out", async () => {
      const ctx = await withFolders([work]);
      await ctx.act({ type: "folder", id: "f2" });
      ctx.api.folders.mockResolvedValue([{ ...work, title: "Job" }]);
      ctx.api.emit({ type: "folders" });
      await flush();
      expect(ctx.chat().folders!.map((f) => [f.name, f.active])).toEqual([["All chats", false], ["Job", true]]);
      ctx.api.folders.mockResolvedValue([{ ...work, id: 7 }]);
      ctx.api.emit({ type: "folders" });
      await flush();
      expect(ctx.chat().folders!.map((f) => [f.id, f.active])).toEqual([["all", true], ["f7", false]]);

      await ctx.act({ type: "folder", id: "f7" });
      let release: (folders: TgFolder[]) => void = () => {};
      ctx.api.folders.mockImplementation(() => new Promise((resolve) => (release = resolve)));
      ctx.api.emit({ type: "folders" });
      ctx.api.isAuthorized = false;
      await ctx.act({ type: "logout" });
      release([work]);
      await flush();
      ctx.api.isAuthorized = true;
      ctx.api.folders.mockResolvedValue([]);
      await ctx.answer("phone", { phone: "+31612345678" });
      await ctx.answer("code", { code: "1" });
      await flush();
      expect(ctx.chat().folders).toBeUndefined();
      expect(ids(ctx)).toEqual(["1", "2", "3", "-4", "-1005", "6"]);
    });
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
    expect(ctx.api.history).toHaveBeenCalledWith("1", undefined, PAGE_SIZE, undefined);
    expect(ctx.chat().channel).toMatchObject({ loading: false, hasOlder: false });
    expect(ctx.chat().channel!.can).toEqual({ reply: true, react: true, attach: true, typing: true, members: false, stickers: true, pins: true, search: true, forward: true, polls: false, anonymousPolls: false });
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
    expect(ctx.rows()[0]).toMatchObject({ unread: false, mentions: 0 });

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

  it("marks where a chat's news began when it was opened: the first incoming message after the last one read", async () => {
    const ctx = await signedIn({ dialogs: [dlg("1", { unreadCount: 2, readUpTo: 11 }), dlg("2", { unreadCount: 3, readUpTo: 5 }), dlg("3", { unreadCount: 1 }), dlg("4")] });
    ctx.adapter.setVisible(true);
    ctx.api.history.mockResolvedValueOnce([msg("1", 10), msg("1", 11), msg("1", 12, { out: true }), msg("1", 13), msg("1", 14)]);
    await ctx.adapter.openConversation("1");
    expect(ctx.chat().channel!.unread).toEqual({ firstId: "13", count: 2 });
    // It stays while the chat is open, read or not.
    ctx.api.emit({ type: "message", message: msg("1", 15) });
    expect(ctx.chat().channel!.unread).toEqual({ firstId: "13", count: 2 });
    // The loaded messages do not reach back to the last one read: it began above them.
    ctx.api.history.mockResolvedValueOnce(Array.from({ length: PAGE_SIZE }, (_, i) => msg("2", 51 + i)));
    await ctx.adapter.openConversation("2");
    expect(ctx.chat().channel!.unread).toEqual({ count: 3 });
    // Nothing older: from the first incoming one.
    ctx.api.history.mockResolvedValueOnce([msg("3", 1, { out: true }), msg("3", 2)]);
    await ctx.adapter.openConversation("3");
    expect(ctx.chat().channel!.unread).toEqual({ firstId: "2", count: 1 });
    await ctx.adapter.openConversation("4");
    expect(ctx.chat().channel).not.toHaveProperty("unread");
    // Read on opening: opened again, it has no news.
    await ctx.adapter.openConversation("1");
    expect(ctx.chat().channel).not.toHaveProperty("unread");
  });

  it("shows hasOlder when a full page came back and loads older messages in front", async () => {
    const ctx = await signedIn();
    const newest = Array.from({ length: PAGE_SIZE }, (_, i) => msg("1", 51 + i));
    ctx.api.history.mockResolvedValueOnce(newest);
    await ctx.adapter.openConversation("1");
    expect(ctx.chat().channel!.hasOlder).toBe(true);

    ctx.api.history.mockResolvedValueOnce([msg("1", 1), msg("1", 2), msg("1", 51)]);
    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.history).toHaveBeenLastCalledWith("1", 51, PAGE_SIZE, undefined);
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
    expect(ctx.api.send).toHaveBeenCalledWith("1", { text: "hello", entities: [] }, undefined, undefined);
    expect(ctx.messageIds().at(-1)).toBe("200");
    expect(ctx.chat().channel!.messages.at(-1)).toMatchObject({ author: "Me", mine: true, canEdit: true, canDelete: true, source: "hello" });
    expect(ctx.notifications).toEqual([]);
  });

  it("passes the reply id as a number", async () => {
    const ctx = await open();
    await ctx.act({ type: "send", content: "re", replyTo: "2" });
    expect(ctx.api.send).toHaveBeenCalledWith("1", { text: "re", entities: [] }, 2, undefined);
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

  it("sends markdown as Telegram formatting, and shows it back the same", async () => {
    const ctx = await open();
    await ctx.act({ type: "send", content: "**bold** and a\\*b" });
    expect(ctx.api.send).toHaveBeenCalledWith("1", { text: "bold and a*b", entities: [{ type: "bold", offset: 0, length: 4 }] }, undefined, undefined);
    expect(ctx.chat().channel!.messages.at(-1)).toMatchObject({ content: "**bold** and a\\*b", source: "**bold** and a\\*b" });
    await ctx.act({ type: "edit", messageId: "200", content: "_now_ italic" });
    expect(ctx.api.edit).toHaveBeenCalledWith("1", 200, { text: "now italic", entities: [{ type: "italic", offset: 0, length: 3 }] });
    expect(ctx.chat().channel!.messages.at(-1)).toMatchObject({ content: "*now* italic" });
  });

  it("sends custom emoji as the emoji they stand for", async () => {
    const ctx = await open();
    await ctx.act({ type: "send", content: "**<:😀:5>** hi" });
    expect(ctx.api.send).toHaveBeenCalledWith("1", { text: "😀 hi", entities: [{ type: "bold", offset: 0, length: 2 }] }, undefined, undefined);
  });

  it("sends nothing for markdown without text", async () => {
    const ctx = await open();
    await ctx.act({ type: "send", content: "> " });
    await ctx.act({ type: "edit", messageId: "2", content: "> " });
    expect(ctx.api.send).not.toHaveBeenCalled();
    expect(ctx.api.edit).not.toHaveBeenCalled();
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
    expect(ctx.api.edit).toHaveBeenCalledWith("1", 2, { text: "fixed", entities: [] });
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
      canPin: true,
      reactions: [],
      attachments: [],
    });
  });

  it("shows Telegram's formatting as markdown, and a label after formatted text", async () => {
    const ctx = await history([
      msg("1", 1, { text: "hi there", entities: [{ type: "bold", offset: 0, length: 2 }], media: "📍 Location" }),
      msg("1", 2, { text: "", media: "📊 Poll" }),
    ]);
    expect(ctx.chat().channel!.messages.map((m) => m.content)).toEqual(["**hi** there\n📍 Location", "📊 Poll"]);
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
    expect(ctx.rows()[0]!.id).toBe("9");

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
    expect(ctx.rows()).toHaveLength(3);
  });

  describe("paging through dialogs", () => {
    const cursor = (chatId: string): TgDialogCursor => ({ chatId, id: 5, date: 7 });

    /** Signed in with a first page that has more after it; later pages come from `pages`, by the cursor's chat. */
    async function paged(pages: Record<string, TgDialogPage | Error>) {
      vi.useFakeTimers();
      const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
      ctx.api.dialogs.mockImplementation(async (_limit, after) => {
        if (!after) return { dialogs: defaultDialogs(), next: cursor("3") };
        const page = pages[after.chatId]!;
        if (page instanceof Error) throw page;
        return page;
      });
      await ctx.adapter.start();
      await flush();
      return ctx;
    }

    it("lists later pages in the background, a page at a time, keeping chats already listed", async () => {
      const ctx = await paged({ "3": { dialogs: [dlg("2", { title: "Old", date: 1 }), dlg("4", { date: 5 })], next: cursor("4") }, "4": { dialogs: [dlg("5", { date: 4 })] } });
      expect(ctx.api.dialogs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS);
      expect(ctx.api.dialogs).toHaveBeenLastCalledWith(DIALOG_PAGE, cursor("3"));
      expect(ctx.rows().map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
      expect(ctx.rows()[1]!.name).toBe("User 2");
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS);
      expect(ctx.api.dialogs).toHaveBeenLastCalledWith(DIALOG_PAGE, cursor("4"));
      expect(ctx.rows().map((r) => r.id)).toEqual(["1", "2", "3", "4", "5"]);
      // The last page had none after it.
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS * 3);
      expect(ctx.api.dialogs).toHaveBeenCalledTimes(3);
      expect(ctx.directs.at(-1)!.map((d) => d.key)).toEqual(["1", "2", "3", "4", "5"]);
    });

    it("keeps chats from later pages when the first page is fetched afresh", async () => {
      const ctx = await paged({ "3": { dialogs: [dlg("4", { date: 5 })] } });
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS);
      ctx.api.emit({ type: "message", message: msg("9", 1) });
      ctx.api.dialogList = [...defaultDialogs(), dlg("9", { date: 99 })];
      ctx.api.dialogs.mockImplementation(async () => ({ dialogs: ctx.api.dialogList, next: cursor("3") }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(ctx.rows().map((r) => r.id)).toEqual(["9", "1", "2", "3", "4"]);
      // A chat newer than the fresh page's oldest that it leaves out is gone; a page with none after it is the whole list.
      ctx.api.dialogList = [dlg("9", { date: 99 }), dlg("3", { date: 10 })];
      ctx.api.emit({ type: "message", message: msg("8", 1) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ctx.rows().map((r) => r.id)).toEqual(["9", "3", "4"]);
      ctx.api.dialogs.mockImplementation(async () => ({ dialogs: ctx.api.dialogList }));
      ctx.api.emit({ type: "message", message: msg("8", 2) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ctx.rows().map((r) => r.id)).toEqual(["9", "3"]);
      // A refresh does not start paging again.
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS * 2);
      expect(ctx.api.dialogs).toHaveBeenCalledTimes(5);
    });

    it("stops at DIALOG_LIMIT chats", async () => {
      const many = (from: number) => Array.from({ length: DIALOG_PAGE }, (_, i) => dlg(String(from + i), { date: 0 }));
      const pages: Record<string, TgDialogPage> = {};
      for (let n = 0; n < DIALOG_LIMIT / DIALOG_PAGE + 1; n++) pages[String(1000 + n)] = { dialogs: many(10_000 + n * DIALOG_PAGE), next: cursor(String(1001 + n)) };
      pages["3"] = pages["1000"]!;
      const ctx = await paged(pages);
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS * (DIALOG_LIMIT / DIALOG_PAGE + 3));
      expect(ctx.rows()).toHaveLength(DIALOG_LIMIT);
      expect(ctx.api.dialogs).toHaveBeenCalledTimes(DIALOG_LIMIT / DIALOG_PAGE + 1);
    });

    it("stops paging when a page fails", async () => {
      const ctx = await paged({ "3": new Error("down") });
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS * 3);
      expect(ctx.api.dialogs).toHaveBeenCalledTimes(2);
      expect(ctx.rows()).toHaveLength(3);
    });

    it("stops paging on signing out, before or while a page is fetched", async () => {
      const ctx = await paged({ "3": { dialogs: [dlg("4")] } });
      ctx.api.isAuthorized = false;
      await ctx.act({ type: "logout" });
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS * 3);
      expect(ctx.api.dialogs).toHaveBeenCalledTimes(1);

      let release: (page: TgDialogPage) => void = () => {};
      const late = await paged({});
      late.api.dialogs.mockImplementation((_limit, after) => (after ? new Promise((resolve) => (release = resolve)) : Promise.resolve({ dialogs: [] })));
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS);
      late.api.isAuthorized = false;
      await late.act({ type: "logout" });
      release({ dialogs: [dlg("4")] });
      await vi.advanceTimersByTimeAsync(DIALOG_PAGE_MS * 3);
      await expect(late.adapter.listDirectConversations()).resolves.toEqual([]);
    });
  });

  it("counts an incoming message as unread, notifies and appends it to a loaded chat", async () => {
    const ctx = await signedIn();
    await ctx.adapter.openConversation("1");
    ctx.api.emit({ type: "message", message: msg("1", 3, { text: "y".repeat(300), media: "📷 Photo" }) });
    expect(ctx.notifications).toEqual([
      { title: "User 1", body: messageText(msg("1", 3, { text: "y".repeat(300), media: "📷 Photo" })).slice(0, 200), target: "1", railKey: "dm:1", inView: false },
    ]);
    expect(ctx.rows()[0]).toMatchObject({ unread: true, mentions: 3 });
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
    expect(ctx.rows().map((i) => i.id)).toEqual(["3", "1", "2"]);
  });

  it("marks an incoming message read instead when its chat is on screen", async () => {
    const ctx = await signedIn();
    ctx.adapter.setVisible(true);
    await ctx.adapter.openConversation("1");
    ctx.api.markRead.mockClear();
    ctx.api.emit({ type: "message", message: msg("1", 3) });
    await flush();
    expect(ctx.notifications[0]).toMatchObject({ inView: true });
    expect(ctx.rows()[0]).toMatchObject({ unread: false, mentions: 0 });
    // Read on the server too, though there was no unread count to clear.
    expect(ctx.api.markRead).toHaveBeenCalledWith("1", 3, undefined);
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
    // Shown as the still it is, which the view labels as an animated sticker.
    const still = ctx.chat().channel!.messages[2]!.attachments[0]!;
    expect(still).toMatchObject({ kind: "sticker", previewUrl: "data:image/webp;base64,aGk=" });
    expect(still).not.toHaveProperty("url");
    expect(still).not.toHaveProperty("mediaKey");
  });

  it("shows link previews, their photo loaded on request in the message's media's place", async () => {
    const ctx = await signedIn();
    ctx.api.history.mockResolvedValueOnce([
      msg("1", 1, { text: "https://site/a", preview: { url: "https://site/a", site: "Site", title: "Page", photo } }),
      msg("1", 2, { text: "x", preview: { description: "Words only" } }),
      msg("1", 3, { text: "y", preview: { title: "Gone", photo } }),
    ]);
    await ctx.act({ type: "select", channelId: "1" });
    const embeds = () => ctx.chat().channel!.messages.map((m) => m.embeds);
    expect(embeds()[0]).toEqual([{ url: "https://site/a", site: "Site", title: "Page", image: { url: undefined, mediaKey: "tg:1:1", width: 4, height: 3, size: 2, thumbnail: true } }]);
    expect(embeds()[1]).toEqual([{ description: "Words only" }]);
    await ctx.act({ type: "loadMedia", key: "tg:1:1" });
    expect(ctx.api.download).toHaveBeenCalledWith("1", 1, false);
    expect(embeds()[0]![0]!.image).toMatchObject({ url: "data:image/jpeg;base64,aGk=", mediaKey: undefined });
    // A photo that could not be fetched is left out of the card.
    ctx.api.download.mockResolvedValueOnce(undefined);
    await ctx.act({ type: "loadMedia", key: "tg:1:3" });
    expect(embeds()[2]).toEqual([{ title: "Gone" }]);
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

describe("groups and channels", () => {
  const GROUP = "-123";
  const SUPER = "-1001234567890";
  const NEWS = "-1009876543210";
  const FOREVER = 2147483647;
  const rooms = () => [
    dlg("1", { date: 50, unreadCount: 2, lastMessage: msg("1", 2) }),
    dlg(GROUP, { kind: "group", title: "Family", date: 40, unreadCount: 5, unreadMentions: 1 }),
    dlg(SUPER, { kind: "group", title: "Club", date: 30, unreadCount: 3, unreadMentions: 2, mutedUntil: FOREVER }),
    dlg(NEWS, { kind: "channel", title: "News", date: 20, unreadCount: 7, readOnly: true }),
    dlg("2", { title: "Quiet", date: 10, unreadCount: 4, mutedUntil: FOREVER }),
  ];

  it("gives groups and channels digit-only view ids above every user id, and reads them back", () => {
    expect(viewId("42")).toBe("42");
    expect(viewId(GROUP)).toBe("10000000000000000123");
    expect(viewId(SUPER)).toBe("10000001001234567890");
    expect(viewId("-999999999999999999")).toMatch(/^\d{20}$/);
    for (const id of ["42", GROUP, SUPER, NEWS]) expect(chatIdOfView(viewId(id))).toBe(id);
  });

  it("lists chats in sections, keeps only one-to-one chats as direct messages and badges home with the rest", async () => {
    const ctx = await signedIn({ dialogs: rooms() });
    expect(ctx.chat().sidebar.filter((i) => i.kind === "category").map((i) => i.name)).toEqual(["Direct messages", "Groups", "Channels"]);
    expect(ctx.rows().map((i) => [i.name, i.unread, i.mentions])).toEqual([
      ["User 1", true, 2],
      ["Quiet", true, 0], // muted: unread, but no count
      ["Family", true, 1],
      ["Club", true, 2], // muted, but mentions still count
      ["News", true, 0],
    ]);
    expect(ctx.rows().map((i) => i.id)).toEqual(["1", "2", viewId(GROUP), viewId(SUPER), viewId(NEWS)]);
    expect((await ctx.adapter.listDirectConversations()).map((d) => [d.key, d.mentions])).toEqual([
      ["1", 2],
      ["2", 0],
    ]);
    expect(ctx.adapter.homeBadge()).toEqual({ unread: true, mentions: 3 });
  });

  it("leaves home unread only for chats that would notify", async () => {
    const ctx = await signedIn({ dialogs: [dlg(SUPER, { kind: "group", unreadCount: 3, mutedUntil: FOREVER }), dlg(NEWS, { kind: "channel", unreadCount: 0 })] });
    expect(ctx.adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
    // A mute that ran out no longer counts.
    const later = await signedIn({ dialogs: [dlg(SUPER, { kind: "group", unreadCount: 3, mutedUntil: 1000 })] });
    expect(later.adapter.homeBadge()).toEqual({ unread: true, mentions: 0 });
  });

  it("shows which chats are muted and mutes or unmutes them in Telegram", async () => {
    const ctx = await signedIn({ dialogs: rooms() });
    expect(ctx.rows().map((i) => [i.name, i.muted, i.canMute])).toEqual([
      ["User 1", false, true],
      ["Quiet", true, true],
      ["Family", false, true],
      ["Club", true, true],
      ["News", false, true],
    ]);
    await ctx.act({ type: "mute", channelId: viewId(GROUP), mute: true });
    expect(ctx.api.mute).toHaveBeenLastCalledWith(GROUP, MUTE_FOREVER);
    expect(ctx.rows().find((i) => i.name === "Family")!.muted).toBe(true);
    // A muted one-to-one chat keeps its unread state but loses its count, here and in the Messages list.
    await ctx.act({ type: "mute", channelId: "1", mute: true });
    expect(ctx.rows()[0]).toMatchObject({ muted: true, unread: true, mentions: 0 });
    expect(ctx.directs.at(-1)![0]).toMatchObject({ key: "1", mentions: 0 });
    await ctx.act({ type: "mute", channelId: "2", mute: false });
    expect(ctx.api.mute).toHaveBeenLastCalledWith("2", 0);
    expect(ctx.rows()[1]).toMatchObject({ muted: false, mentions: 4 });
    // Already so, or unknown: nothing to do.
    const calls = ctx.api.mute.mock.calls.length;
    await ctx.act({ type: "mute", channelId: "2", mute: false });
    await ctx.act({ type: "mute", channelId: "404", mute: true });
    expect(ctx.api.mute).toHaveBeenCalledTimes(calls);
    // A failure says so and changes nothing.
    ctx.api.mute.mockRejectedValueOnce(new Error("FLOOD_WAIT"));
    await ctx.act({ type: "mute", channelId: viewId(NEWS), mute: true });
    expect(ctx.chat().error).toBe("Could not mute the chat: FLOOD_WAIT");
    expect(ctx.rows().find((i) => i.name === "News")!.muted).toBe(false);
    ctx.api.mute.mockRejectedValueOnce(new Error("FLOOD_WAIT"));
    await ctx.act({ type: "mute", channelId: viewId(SUPER), mute: false });
    expect(ctx.chat().error).toBe("Could not unmute the chat: FLOOD_WAIT");
  });

  it("treats chats without a mute of their own as their kind's default says, and follows changes", async () => {
    const own = (chatId: string, mutedUntil: number) => dlg(chatId, { kind: "group", title: `G${chatId}`, unreadCount: 2, mutedUntil });
    const dialogs = [dlg("1", { unreadCount: 2 }), dlg(GROUP, { kind: "group", title: "Family", unreadCount: 3 }), own(SUPER, 0), dlg(NEWS, { kind: "channel", title: "News", unreadCount: 1 })];
    const setupDefaults = (defaults: { user: number; group: number; channel: number }) => {
      const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true, dialogs });
      ctx.api.notifyDefaults.mockResolvedValue(defaults);
      return ctx;
    };
    const ctx = setupDefaults({ user: FOREVER, group: FOREVER, channel: 0 });
    await ctx.adapter.start();
    await flush();
    // One-to-one chats and groups muted by default; the group unmuted on its own is not.
    expect(ctx.rows().map((i) => [i.name, i.muted])).toEqual([
      ["User 1", true],
      ["Family", true],
      [`G${SUPER}`, false],
      ["News", false],
    ]);
    expect(ctx.directs.at(-1)![0]).toMatchObject({ key: "1", mentions: 0 });
    expect(ctx.adapter.homeBadge().unread).toBe(true); // the unmuted group and the channel

    // Defaults changed in another app, and a chat's own mute.
    ctx.api.emit({ type: "notifyDefault", kind: "user", mutedUntil: 0 });
    expect(ctx.directs.at(-1)![0]).toMatchObject({ key: "1", mentions: 2 });
    ctx.api.emit({ type: "notifyChat", chatId: SUPER, mutedUntil: FOREVER });
    ctx.api.emit({ type: "notifyDefault", kind: "channel", mutedUntil: FOREVER });
    expect(ctx.adapter.homeBadge().unread).toBe(false);
    // Back to following the default (muted for groups), or unknown chats: nothing changes.
    ctx.api.emit({ type: "notifyChat", chatId: SUPER });
    ctx.api.emit({ type: "notifyChat", chatId: "404", mutedUntil: 0 });
    expect(ctx.rows().find((i) => i.name === `G${SUPER}`)!.muted).toBe(true);
    // Unmuting here sets the chat's own mute, so the muting default no longer applies.
    await ctx.act({ type: "mute", channelId: viewId(GROUP), mute: false });
    expect(ctx.api.mute).toHaveBeenLastCalledWith(GROUP, 0);
    expect(ctx.rows().find((i) => i.name === "Family")!.muted).toBe(false);

    // Defaults Telegram does not give, or that come for an earlier session, leave chats unmuted.
    const failed = setupDefaults({ user: FOREVER, group: FOREVER, channel: FOREVER });
    failed.api.notifyDefaults.mockRejectedValue(new Error("FLOOD_WAIT"));
    await failed.adapter.start();
    await flush();
    expect(failed.rows().every((i) => !i.muted)).toBe(true);
    const late = setupDefaults({ user: 0, group: 0, channel: 0 });
    let answer: (defaults: { user: number; group: number; channel: number }) => void = () => {};
    late.api.notifyDefaults.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await late.adapter.start();
    await flush();
    await late.adapter.signOut();
    await flush();
    answer({ user: FOREVER, group: FOREVER, channel: FOREVER });
    await flush();
    expect(late.directs.at(-1)!.find((d) => d.key === "1")).toMatchObject({ mentions: 2 });
  });

  it("opens a group from the view and from the shell, by its chat id", async () => {
    const ctx = await signedIn({ dialogs: rooms() });
    await ctx.act({ type: "select", channelId: viewId(GROUP) });
    expect(ctx.api.history).toHaveBeenCalledWith(GROUP, undefined, PAGE_SIZE, undefined);
    expect(ctx.chat().channel).toMatchObject({ id: viewId(GROUP), name: "Family", can: { reply: true } });
    expect(ctx.chat().channel).not.toHaveProperty("locked");
    await ctx.adapter.openConversation(SUPER);
    expect(ctx.chat().channel!.id).toBe(viewId(SUPER));
  });

  it("names each group message's sender, falling back to the group", async () => {
    const ctx = await signedIn({ dialogs: rooms() });
    ctx.api.history.mockResolvedValueOnce([msg(GROUP, 1, { sender: "Ana" }), msg(GROUP, 2, { replyToId: 1 })]);
    await ctx.adapter.openConversation(GROUP);
    const [first, second] = ctx.chat().channel!.messages;
    expect(first!.author).toBe("Ana");
    expect(second).toMatchObject({ author: "Family", reply: { author: "Ana", content: "m1" } });
  });

  it("locks channels only admins post in, and groups the user may not write in", async () => {
    const ctx = await signedIn({ dialogs: [...rooms(), dlg("-77", { kind: "group", title: "Muted me", readOnly: true })] });
    await ctx.adapter.openConversation(NEWS);
    expect(ctx.chat().channel).toMatchObject({ locked: "Only the channel's admins post here.", can: { reply: false } });
    await ctx.act({ type: "send", content: "hi" });
    expect(ctx.api.send).not.toHaveBeenCalled();
    await ctx.adapter.openConversation("-77");
    expect(ctx.chat().channel!.locked).toBe("You cannot send messages in this group.");
  });

  it("counts mentions in groups, notifies under home with the sender, and keeps muted chats quiet", async () => {
    const ctx = await signedIn({ dialogs: rooms() });
    ctx.api.emit({ type: "message", message: msg(GROUP, 10, { sender: "Ana", text: "hi @me", mentioned: true }) });
    expect(ctx.notifications.at(-1)).toEqual({ title: "Family", body: "Ana: hi @me", target: GROUP, railKey: "home", inView: false });
    expect(ctx.rows().find((i) => i.name === "Family")).toMatchObject({ mentions: 2 });
    ctx.api.emit({ type: "message", message: msg(GROUP, 11) });
    expect(ctx.notifications.at(-1)).toMatchObject({ body: "m11" });
    expect(ctx.rows().find((i) => i.name === "Family")).toMatchObject({ mentions: 2 });
    ctx.api.emit({ type: "message", message: msg(NEWS, 5, { sender: "News" }) });
    expect(ctx.notifications.at(-1)).toMatchObject({ title: "News", body: "m5", railKey: "home" });

    const before = ctx.notifications.length;
    ctx.api.emit({ type: "message", message: msg(SUPER, 20) });
    ctx.api.emit({ type: "message", message: msg("2", 20, { mentioned: true }) });
    expect(ctx.notifications).toHaveLength(before);
    // A muted group still notifies about a mention or an answer, as Telegram does.
    ctx.api.emit({ type: "message", message: msg(SUPER, 21, { mentioned: true }) });
    expect(ctx.notifications.at(-1)).toMatchObject({ title: "Club", target: SUPER });
    expect(ctx.adapter.homeBadge().mentions).toBe(5);
  });

  it("marks messages that mention or answer the user, as Telegram flags them", async () => {
    const ctx = await signedIn({ dialogs: rooms() });
    ctx.api.history.mockResolvedValueOnce([msg(GROUP, 1, { mentioned: true, senderUsername: "ana_x" }), msg(GROUP, 2), msg(GROUP, 3, { out: true, mentioned: true, senderUsername: "me_me" })]);
    await ctx.adapter.openConversation(GROUP);
    expect(ctx.chat().channel!.messages.map((m) => m.mentionsMe === true)).toEqual([true, false, false]);
    // Those with a username are mentioned by it.
    expect(ctx.chat().channel!.messages.map((m) => m.authorMention)).toEqual(["@ana_x", undefined, undefined]);
  });

  it("clears a group's mentions once read", async () => {
    const ctx = await signedIn({ dialogs: rooms() });
    ctx.adapter.setVisible(true);
    ctx.api.history.mockResolvedValueOnce([msg(GROUP, 1)]);
    await ctx.adapter.openConversation(GROUP);
    expect(ctx.api.markRead).toHaveBeenCalledWith(GROUP, 1);
    expect(ctx.rows().find((i) => i.name === "Family")).toMatchObject({ unread: false, mentions: 0 });
    // Only mentions left still get read.
    const other = await signedIn({ dialogs: [dlg(SUPER, { kind: "group", unreadCount: 0, unreadMentions: 1, lastMessage: msg(SUPER, 4) })] });
    other.adapter.setVisible(true);
    other.api.history.mockResolvedValueOnce([]);
    await other.adapter.openConversation(SUPER);
    expect(other.api.markRead).toHaveBeenCalledWith(SUPER, 4);
  });

  it("applies deletions without a chat to private chats and basic groups, not to supergroups or channels", async () => {
    const ctx = await signedIn({ dialogs: [dlg("1"), dlg(GROUP, { kind: "group", lastMessage: msg(GROUP, 2) }), dlg(SUPER, { kind: "group", lastMessage: msg(SUPER, 2) })] });
    for (const id of [SUPER, GROUP, "1"]) await ctx.adapter.openConversation(id);
    ctx.api.emit({ type: "delete", ids: [2] });
    expect(ctx.messageIds()).toEqual(["1"]);
    await ctx.adapter.openConversation(GROUP);
    expect(ctx.messageIds()).toEqual(["1"]);
    await ctx.adapter.openConversation(SUPER);
    expect(ctx.messageIds()).toEqual(["1", "2"]);
    ctx.api.emit({ type: "delete", chatId: SUPER, ids: [2] });
    expect(ctx.messageIds()).toEqual(["1"]);
  });
});

describe("members and profiles", () => {
  const GROUP = "-123";
  const NEWS = "-1009876543210";
  const dialogs = () => [
    dlg("1", { date: 50 }),
    dlg(GROUP, { kind: "group", title: "Family", date: 40, members: true }),
    dlg(NEWS, { kind: "channel", title: "News", date: 20, readOnly: true }),
  ];
  const member = (id: string, extra: Partial<TgMember> = {}): TgMember => ({ id, name: `M${id}`, bot: false, presence: "offline", ...extra });
  const page = (members: TgMember[], total: number, next?: number): TgMemberPage => (next === undefined ? { members, total } : { members, total, next });

  async function inGroup() {
    const ctx = await signedIn({ dialogs: dialogs() });
    await ctx.act({ type: "select", channelId: viewId(GROUP) });
    await flush();
    return ctx;
  }
  const channel = (ctx: Awaited<ReturnType<typeof inGroup>>) => ctx.chat().channel!;

  it("offers members in groups the user is in, not in private chats or channels they do not run", async () => {
    const ctx = await inGroup();
    expect(channel(ctx).can.members).toBe(true);
    expect(channel(ctx)).not.toHaveProperty("members");
    await ctx.act({ type: "select", channelId: "1" });
    expect(channel(ctx).can.members).toBe(false);
    await ctx.act({ type: "select", channelId: viewId(NEWS) });
    expect(channel(ctx).can.members).toBe(false);
    expect(ctx.api.members).not.toHaveBeenCalled();
  });

  it("lists admins, then members, those online first, once the panel opens", async () => {
    const ctx = await inGroup();
    let release!: (page: TgMemberPage) => void;
    ctx.api.members.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const opening = ctx.act({ type: "members", open: true });
    expect(channel(ctx).members).toEqual({ sections: [], hasMore: false, loading: true });
    release(
      page(
        [
          member("4", { presence: "recently", username: "mila_4" }),
          member("5", { presence: "online", bot: true }),
          member("2", { role: "admin", rank: "Helper", presence: "online" }),
          member("3", { role: "owner" }),
          member("9", { name: "Me again" }),
        ],
        120,
        5,
      ),
    );
    await opening;
    expect(ctx.api.members).toHaveBeenCalledWith(GROUP, 0, MEMBER_PAGE);
    expect(channel(ctx).members).toEqual({
      sections: [
        { name: "Admins", members: [{ id: "3", name: "M3", presence: "offline" }, { id: "2", name: "M2", presence: "online", status: "Helper" }] },
        {
          name: "Members",
          members: [
            { id: "5", name: "M5", presence: "online", status: "Bot" },
            { id: "4", name: "M4", presence: "offline", status: "last seen recently", mention: "@mila_4" },
            { id: "9", name: "Me", presence: "offline" },
          ],
        },
      ],
      more: 115,
      hasMore: true,
      loading: false,
    });
  });

  it("loads further pages once each, from the number listed, up to MEMBER_LIMIT", async () => {
    const ctx = await inGroup();
    let offset = 0;
    ctx.api.members.mockImplementation(async (_chat, from, limit) => {
      expect(from).toBe(offset);
      offset = from + limit;
      return page(Array.from({ length: limit }, (_, i) => member(String(from + i + 100))), 5000, from + limit);
    });
    await ctx.act({ type: "members", open: true });
    await ctx.act({ type: "loadMembers", offset: 3 });
    expect(ctx.api.members).toHaveBeenCalledTimes(1);
    for (let listed = MEMBER_PAGE; listed < MEMBER_LIMIT; listed += MEMBER_PAGE) await ctx.act({ type: "loadMembers", offset: listed });
    expect(ctx.api.members).toHaveBeenCalledTimes(MEMBER_LIMIT / MEMBER_PAGE);
    const list = channel(ctx).members!;
    expect(list.sections[0]!.members).toHaveLength(MEMBER_LIMIT);
    expect(list).toMatchObject({ more: 5000 - MEMBER_LIMIT, hasMore: false });
    await ctx.act({ type: "loadMembers", offset: MEMBER_LIMIT });
    expect(ctx.api.members).toHaveBeenCalledTimes(MEMBER_LIMIT / MEMBER_PAGE);
  });

  it("drops members a later page repeats, and counts none past the last page", async () => {
    const ctx = await inGroup();
    ctx.api.members.mockResolvedValueOnce(page([member("1"), member("2")], 10, 2)).mockResolvedValueOnce(page([member("2"), member("3")], 10));
    await ctx.act({ type: "members", open: true });
    await ctx.act({ type: "loadMembers", offset: 2 });
    expect(channel(ctx).members!.sections[0]!.members.map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect(channel(ctx).members).toMatchObject({ hasMore: false });
    expect(channel(ctx).members).not.toHaveProperty("more");
  });

  it("ignores loadMembers while closed, without a list or while a page loads", async () => {
    const ctx = await inGroup();
    await ctx.act({ type: "loadMembers", offset: 0 });
    let release!: (page: TgMemberPage) => void;
    ctx.api.members.mockResolvedValueOnce(page([member("1")], 5, 1)).mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    await ctx.act({ type: "members", open: true });
    const loading = ctx.act({ type: "loadMembers", offset: 1 });
    await ctx.act({ type: "loadMembers", offset: 1 });
    release(page([member("2")], 5));
    await loading;
    expect(ctx.api.members).toHaveBeenCalledTimes(2);
    await ctx.act({ type: "members", open: false });
    expect(channel(ctx)).not.toHaveProperty("members");
    await ctx.act({ type: "loadMembers", offset: 2 });
    expect(ctx.api.members).toHaveBeenCalledTimes(2);
  });

  it("fetches afresh when the panel opens again, and for each group opened meanwhile", async () => {
    const ctx = await inGroup();
    await ctx.act({ type: "members", open: true });
    await ctx.act({ type: "members", open: false });
    await ctx.act({ type: "members", open: true });
    expect(ctx.api.members).toHaveBeenCalledTimes(2);
    // Private chats have no list; a group not yet listed is fetched once.
    await ctx.act({ type: "select", channelId: "1" });
    expect(channel(ctx)).not.toHaveProperty("members");
    await ctx.act({ type: "select", channelId: viewId(GROUP) });
    expect(ctx.api.members).toHaveBeenCalledTimes(2);
    const other = await signedIn({ dialogs: [...dialogs(), dlg("-77", { kind: "group", title: "Two", date: 1, members: true })] });
    await other.act({ type: "members", open: true });
    expect(other.api.members).not.toHaveBeenCalled();
    await other.act({ type: "select", channelId: viewId("-77") });
    await flush();
    expect(other.api.members).toHaveBeenCalledWith("-77", 0, MEMBER_PAGE);
  });

  it("stops offering members Telegram does not show, and reports other failures", async () => {
    const ctx = await inGroup();
    ctx.api.members.mockResolvedValueOnce({ members: [], total: 0, hidden: true });
    await ctx.act({ type: "members", open: true });
    expect(channel(ctx).can.members).toBe(false);
    expect(channel(ctx)).not.toHaveProperty("members");
    // Once known, the list is not asked for again.
    await ctx.act({ type: "members", open: true });
    expect(ctx.api.members).toHaveBeenCalledTimes(1);

    const admins = await inGroup();
    admins.api.members.mockRejectedValueOnce(tgError("CHAT_ADMIN_REQUIRED"));
    await admins.act({ type: "members", open: true });
    expect(channel(admins).can.members).toBe(false);

    const failing = await inGroup();
    failing.api.members.mockRejectedValueOnce(tgError("FLOOD_WAIT_30"));
    await failing.act({ type: "members", open: true });
    expect(channel(failing).members).toMatchObject({ error: "Could not load members: Too many attempts. Wait a while and try again.", loading: false });
  });

  it("forgets a list that arrives after signing out", async () => {
    const ctx = await inGroup();
    let release!: (page: TgMemberPage) => void;
    ctx.api.members.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const opening = ctx.act({ type: "members", open: true });
    ctx.api.authorized.mockResolvedValue(false);
    await ctx.adapter.signOut();
    release(page([member("1")], 1));
    await opening;
    let failRelease!: (error: unknown) => void;
    const again = await inGroup();
    again.api.members.mockImplementationOnce(() => new Promise((_resolve, reject) => (failRelease = reject)));
    const failing = again.act({ type: "members", open: true });
    again.api.authorized.mockResolvedValue(false);
    await again.adapter.signOut();
    failRelease(new Error("late"));
    await failing;
    expect(again.prompt().prompt.id).toBe("phone");
  });

  it("opens the panel with no chat selected without fetching", async () => {
    const ctx = await signedIn({ dialogs: dialogs() });
    await ctx.act({ type: "members", open: true });
    await ctx.act({ type: "loadMembers", offset: 0 });
    expect(ctx.api.members).not.toHaveBeenCalled();
  });

  it("shows the first members' pictures, asking for each once", async () => {
    const ctx = await inGroup();
    const members = Array.from({ length: MEMBER_AVATAR_LIMIT + 5 }, (_, i) => member(String(i + 100)));
    ctx.api.members.mockResolvedValue(page(members, members.length));
    ctx.api.avatar.mockImplementation(async (id) => (id === "100" ? "data:image/jpeg;base64,AA" : id === "101" ? Promise.reject(new Error("no")) : undefined));
    ctx.api.avatar.mockClear();
    await ctx.act({ type: "members", open: true });
    expect(ctx.api.avatar).toHaveBeenCalledTimes(MEMBER_AVATAR_LIMIT);
    expect(channel(ctx).members!.sections[0]!.members[0]).toMatchObject({ id: "100", avatarUrl: "data:image/jpeg;base64,AA" });
    await ctx.act({ type: "members", open: false });
    await ctx.act({ type: "members", open: true });
    expect(ctx.api.avatar).toHaveBeenCalledTimes(MEMBER_AVATAR_LIMIT);
  });

  it("stops fetching pictures after signing out", async () => {
    const ctx = await inGroup();
    ctx.api.members.mockResolvedValue(page([member("100"), member("101")], 2));
    let release!: (url: string) => void;
    ctx.api.avatar.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    ctx.api.avatar.mockClear();
    const opening = ctx.act({ type: "members", open: true });
    await flush();
    ctx.api.authorized.mockResolvedValue(false);
    await ctx.adapter.signOut();
    release("data:late");
    await opening;
    expect(ctx.api.avatar).toHaveBeenCalledTimes(1);
  });

  it("names message authors by id: the sender, or the user for their own", async () => {
    const ctx = await signedIn({ dialogs: dialogs() });
    ctx.api.history.mockResolvedValueOnce([msg(GROUP, 1, { senderId: "5", sender: "Ana" }), msg(GROUP, 2, { out: true }), msg(GROUP, 3)]);
    await ctx.act({ type: "select", channelId: viewId(GROUP) });
    await flush();
    expect(ctx.chat().channel!.messages.map((m) => m.authorId)).toEqual(["5", "9", undefined]);
  });

  describe("profiles", () => {
    it("answers with what Telegram shows: name, username, bio, presence and picture", async () => {
      const ctx = await inGroup();
      ctx.api.members.mockResolvedValue(page([member("5", { role: "admin", rank: "Helper" }), member("6", { role: "owner" }), member("7", { role: "admin" })], 3));
      ctx.api.avatar.mockImplementation(async (id) => (id === "5" ? "data:image/jpeg;base64,BB" : undefined));
      await ctx.act({ type: "members", open: true });
      let release!: (profile: TgProfile) => void;
      ctx.api.profile.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
      const asking = ctx.act({ type: "profile", id: "5" });
      expect(ctx.chat().profile).toEqual({ id: "5", loading: true, roles: [{ name: "Helper" }], avatarUrl: "data:image/jpeg;base64,BB" });
      release({ id: "5", name: "Ana", bot: false, presence: "recently", username: "@ana", about: "Hi" });
      await asking;
      expect(ctx.chat().profile).toEqual({ id: "5", roles: [{ name: "Helper" }], name: "Ana", presence: "offline", status: "last seen recently", username: "@ana", about: "Hi", avatarUrl: "data:image/jpeg;base64,BB" });
      await ctx.act({ type: "profile", id: "6" });
      expect(ctx.chat().profile).toMatchObject({ roles: [{ name: "Owner" }] });
      await ctx.act({ type: "profile", id: "7" });
      expect(ctx.chat().profile).toMatchObject({ roles: [{ name: "Admin" }] });
      // A picture known already is not asked for again.
      ctx.api.avatar.mockClear();
      await ctx.act({ type: "profile", id: "5" });
      expect(ctx.api.avatar).not.toHaveBeenCalled();
      expect(ctx.chat().profile).toMatchObject({ avatarUrl: "data:image/jpeg;base64,BB" });
    });

    it("names bots and the user, and keeps the card when Telegram cannot tell more", async () => {
      const ctx = await signedIn({ dialogs: dialogs() });
      ctx.api.profile.mockResolvedValueOnce({ id: "8", name: "Helper", bot: true, presence: "online" });
      ctx.api.avatar.mockResolvedValueOnce("data:image/jpeg;base64,CC");
      await ctx.act({ type: "profile", id: "8" });
      expect(ctx.chat().profile).toEqual({ id: "8", name: "Helper", presence: "online", status: "Bot", avatarUrl: "data:image/jpeg;base64,CC" });
      ctx.api.profile.mockResolvedValueOnce({ id: "9", name: "Telegram name", bot: false, presence: "offline" });
      await ctx.act({ type: "profile", id: "9" });
      expect(ctx.chat().profile).toEqual({ id: "9", name: "Me", presence: "offline" });
      ctx.api.profile.mockRejectedValueOnce(new Error("Could not find the input entity"));
      ctx.api.avatar.mockRejectedValueOnce(new Error("no"));
      await ctx.act({ type: "profile", id: "10" });
      expect(ctx.chat().profile).toEqual({ id: "10" });
    });

    it("ignores ids that are not Telegram users, and answers that came too late", async () => {
      const ctx = await signedIn({ dialogs: dialogs() });
      await ctx.act({ type: "profile", id: "@ana:example.org" });
      expect(ctx.api.profile).not.toHaveBeenCalled();
      let release!: (profile: TgProfile) => void;
      ctx.api.profile.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
      const first = ctx.act({ type: "profile", id: "5" });
      await ctx.act({ type: "profile", id: "6" });
      release({ id: "5", name: "Late", bot: false, presence: "offline" });
      await first;
      expect(ctx.chat().profile).toMatchObject({ id: "6" });
      // A picture arriving after another card opened is dropped too.
      let picture!: (url: string) => void;
      ctx.api.avatar.mockImplementationOnce(() => new Promise<string>((resolve) => (picture = resolve)));
      const third = ctx.act({ type: "profile", id: "11" });
      await flush();
      await ctx.act({ type: "profile", id: "12" });
      picture("data:late");
      await third;
      expect(ctx.chat().profile).toMatchObject({ id: "12" });
      expect(ctx.chat().profile).not.toHaveProperty("avatarUrl");
      // So is a failure.
      let fail!: (error: unknown) => void;
      ctx.api.profile.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
      const fourth = ctx.act({ type: "profile", id: "13" });
      await ctx.act({ type: "profile", id: "14" });
      fail(new Error("gone"));
      await fourth;
      expect(ctx.chat().profile).toMatchObject({ id: "14" });
    });

    it("is forgotten on sign-out, and not asked for while signed out", async () => {
      const ctx = await signedIn({ dialogs: dialogs() });
      let release!: (profile: TgProfile) => void;
      ctx.api.profile.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
      const asking = ctx.act({ type: "profile", id: "5" });
      ctx.api.authorized.mockResolvedValue(false);
      await ctx.adapter.signOut();
      release({ id: "5", name: "Late", bot: false, presence: "offline" });
      await asking;
      const fresh = setup({ builtIn: CREDS });
      await fresh.act({ type: "profile", id: "5" });
      expect(fresh.api.profile).not.toHaveBeenCalled();
      await fresh.act({ type: "members", open: true });
      expect(fresh.renders.at(-1)).toBeDefined();
    });
  });
});

describe("reactions", () => {
  const HEART = "❤" + String.fromCharCode(0xfe0f);
  const open = async (messages: TgMessage[], options: Options = {}) => {
    const ctx = await signedIn(options);
    ctx.api.history.mockResolvedValue(messages);
    await ctx.adapter.openConversation(options.dialogs?.[0]?.chatId ?? "1");
    await flush();
    return ctx;
  };
  const reacted = (extra: Partial<TgMessage> = {}) => msg("1", 5, { reactions: [{ emoji: "❤", count: 2, chosen: false }, { emoji: "👍", count: 1, chosen: true }], ...extra });

  it("shows reactions with counts and the user's own, hearts as the emoji picker writes them", async () => {
    const ctx = await open([reacted()]);
    expect(ctx.chat().channel!.messages[0]!.reactions).toEqual([
      { key: HEART, label: HEART, count: 2, me: false },
      { key: "👍", label: "👍", count: 1, me: true },
    ]);
    expect(ctx.chat().channel!.can.react).toBe(true);
  });

  it("gives a reaction in place of the user's one, and takes it back", async () => {
    const ctx = await open([reacted()]);
    await ctx.act({ type: "react", messageId: "5", emoji: HEART, add: true });
    expect(ctx.api.react).toHaveBeenLastCalledWith("1", 5, ["❤"]);
    expect(ctx.chat().channel!.messages[0]!.reactions).toEqual([{ key: HEART, label: HEART, count: 3, me: true }]);
    await ctx.act({ type: "react", messageId: "5", emoji: HEART, add: false });
    expect(ctx.api.react).toHaveBeenLastCalledWith("1", 5, []);
    expect(ctx.chat().channel!.messages[0]!.reactions).toEqual([{ key: HEART, label: HEART, count: 2, me: false }]);
    // Asking for what is already so does nothing.
    await ctx.act({ type: "react", messageId: "5", emoji: HEART, add: false });
    expect(ctx.api.react).toHaveBeenCalledTimes(2);
  });

  it("lets Premium users give up to PREMIUM_REACTIONS, the oldest giving way", async () => {
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.me.mockResolvedValue({ id: "9", name: "Me", bot: false, premium: true });
    await ctx.adapter.start();
    await flush();
    ctx.api.history.mockResolvedValue([msg("1", 5)]);
    await ctx.adapter.openConversation("1");
    await flush();
    for (const emoji of ["👍", "🔥", HEART, "😁"]) await ctx.act({ type: "react", messageId: "5", emoji, add: true });
    expect(PREMIUM_REACTIONS).toBe(3);
    expect(ctx.api.react.mock.calls.map((c) => c[2])).toEqual([["👍"], ["👍", "🔥"], ["👍", "🔥", "❤"], ["🔥", "❤", "😁"]]);
  });

  it("refuses reactions Telegram does not offer", async () => {
    const ctx = await open([msg("1", 5)]);
    await ctx.act({ type: "react", messageId: "5", emoji: "🤖", add: true });
    expect(ctx.chat().error).toBe("Telegram does not offer 🤖 as a reaction.");
    expect(ctx.api.react).not.toHaveBeenCalled();
  });

  it("follows what a group takes, and offers no reactions where it takes none", async () => {
    const group = [dlg("-5", { kind: "group", title: "G" }), dlg("-6", { kind: "group", title: "H" })];
    const ctx = await signedIn({ dialogs: group });
    ctx.api.history.mockResolvedValue([msg("-5", 5)]);
    ctx.api.allowedReactions.mockResolvedValueOnce({ kind: "some", emoji: ["👍"] }).mockResolvedValueOnce({ kind: "none" });
    await ctx.act({ type: "select", channelId: viewId("-5") });
    await flush();
    expect(ctx.api.allowedReactions).toHaveBeenCalledWith("-5");
    await ctx.act({ type: "react", messageId: "5", emoji: "🔥", add: true });
    expect(ctx.chat().error).toBe("This chat does not take 🔥 as a reaction.");
    await ctx.act({ type: "react", messageId: "5", emoji: "👍", add: true });
    expect(ctx.api.react).toHaveBeenCalledWith("-5", 5, ["👍"]);
    ctx.api.history.mockResolvedValue([msg("-6", 5)]);
    await ctx.act({ type: "select", channelId: viewId("-6") });
    await flush();
    expect(ctx.chat().channel!.can.react).toBe(false);
    await ctx.act({ type: "react", messageId: "5", emoji: "👍", add: true });
    expect(ctx.api.react).toHaveBeenCalledTimes(1);
    // Asked once per chat; one-to-one chats take all.
    await ctx.act({ type: "select", channelId: viewId("-5") });
    await flush();
    expect(ctx.api.allowedReactions).toHaveBeenCalledTimes(2);
    expect(ctx.api.reactionList).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failure, and leaves the choice to Telegram while it cannot tell", async () => {
    const group = [dlg("-5", { kind: "group", title: "G" })];
    const ctx = await signedIn({ dialogs: group });
    ctx.api.history.mockResolvedValue([msg("-5", 5)]);
    ctx.api.allowedReactions.mockRejectedValueOnce(new Error("down"));
    ctx.api.reactionList.mockRejectedValueOnce(new Error("down"));
    await ctx.act({ type: "select", channelId: viewId("-5") });
    await flush();
    await ctx.act({ type: "react", messageId: "5", emoji: "🤖", add: true });
    expect(ctx.api.react).toHaveBeenCalledWith("-5", 5, ["🤖"]);
    await ctx.act({ type: "select", channelId: viewId("-5") });
    await flush();
    expect(ctx.api.allowedReactions).toHaveBeenCalledTimes(2);
    expect(ctx.api.reactionList).toHaveBeenCalledTimes(2);
  });

  it("offers no reactions in chats the user left, and ignores unknown messages", async () => {
    const group = [dlg("-5", { kind: "group", title: "G", left: true, readOnly: true })];
    const ctx = await open([msg("-5", 5)], { dialogs: group });
    expect(ctx.chat().channel!.can.react).toBe(false);
    await ctx.act({ type: "react", messageId: "5", emoji: "👍", add: true });
    const other = await open([msg("1", 5)]);
    await other.act({ type: "react", messageId: "77", emoji: "👍", add: true });
    const none = await signedIn();
    await none.act({ type: "react", messageId: "5", emoji: "👍", add: true });
    expect(ctx.api.react).not.toHaveBeenCalled();
    expect(other.api.react).not.toHaveBeenCalled();
    expect(none.api.react).not.toHaveBeenCalled();
  });

  it("reports a reaction Telegram refused", async () => {
    const ctx = await open([msg("1", 5)]);
    ctx.api.react.mockRejectedValue(tgError("REACTION_INVALID"));
    await ctx.act({ type: "react", messageId: "5", emoji: "👍", add: true });
    expect(ctx.chat().error).toBe("Reaction failed: REACTION_INVALID");
    expect(ctx.chat().channel!.messages[0]!.reactions).toEqual([]);
  });

  it("follows live reactions, keeping the user's own where the update leaves them out", async () => {
    const ctx = await open([reacted()]);
    ctx.api.emit({ type: "reactions", chatId: "1", id: 5, reactions: [{ emoji: "👍", count: 4, chosen: false }, { emoji: "🔥", count: 1, chosen: false }], own: false });
    expect(ctx.chat().channel!.messages[0]!.reactions).toEqual([
      { key: "👍", label: "👍", count: 4, me: true },
      { key: "🔥", label: "🔥", count: 1, me: false },
    ]);
    ctx.api.emit({ type: "reactions", chatId: "1", id: 5, reactions: [{ emoji: "👍", count: 3, chosen: false }], own: true });
    expect(ctx.chat().channel!.messages[0]!.reactions).toEqual([{ key: "👍", label: "👍", count: 3, me: false }]);
    // Messages of other chats, or not loaded, are left alone.
    const renders = ctx.renders.length;
    ctx.api.emit({ type: "reactions", chatId: "2", id: 5, reactions: [], own: true });
    ctx.api.emit({ type: "reactions", chatId: "1", id: 99, reactions: [], own: true });
    expect(ctx.renders.length).toBe(renders);
  });

  it("keeps none of the user's own in an update without them for a message that had none", async () => {
    const ctx = await open([msg("1", 5)]);
    ctx.api.emit({ type: "reactions", chatId: "1", id: 5, reactions: [{ emoji: "👍", count: 1, chosen: true }], own: false });
    expect(ctx.chat().channel!.messages[0]!.reactions).toEqual([{ key: "👍", label: "👍", count: 1, me: false }]);
  });

  it("forgets what chats take on sign-out", async () => {
    const group = [dlg("-5", { kind: "group", title: "G" })];
    const ctx = await signedIn({ dialogs: group });
    ctx.api.allowedReactions.mockResolvedValue({ kind: "none" });
    await ctx.act({ type: "select", channelId: viewId("-5") });
    await flush();
    expect(ctx.chat().channel!.can.react).toBe(false);
    await ctx.act({ type: "logout" });
    await ctx.answer("phone", { phone: "+31612345678" });
    await ctx.answer("code", { code: "1" });
    await flush();
    ctx.api.allowedReactions.mockResolvedValue({ kind: "all" });
    await ctx.act({ type: "select", channelId: viewId("-5") });
    await flush();
    expect(ctx.chat().channel!.can.react).toBe(true);
  });

  it("drops answers that arrive after a sign-out", async () => {
    const group = [dlg("-5", { kind: "group", title: "G" })];
    const first = await signedIn({ dialogs: group });
    let release!: () => void;
    first.api.reactionList.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(["👍"]))));
    await first.act({ type: "select", channelId: viewId("-5") });
    await first.act({ type: "logout" });
    release();
    await flush();
    expect(first.api.allowedReactions).not.toHaveBeenCalled();

    for (const answer of [() => Promise.reject(new Error("x")), () => Promise.resolve({ kind: "none" } as const)]) {
      const ctx = await signedIn({ dialogs: group });
      let settle!: () => void;
      ctx.api.allowedReactions.mockImplementationOnce(() => new Promise((resolve, reject) => (settle = () => void answer().then(resolve, reject))));
      await ctx.act({ type: "select", channelId: viewId("-5") });
      await flush();
      await ctx.act({ type: "logout" });
      settle();
      await flush();
      await ctx.answer("phone", { phone: "+31612345678" });
      await ctx.answer("code", { code: "1" });
      await flush();
      await ctx.act({ type: "select", channelId: viewId("-5") });
      await flush();
      expect(ctx.chat().channel!.can.react).toBe(true);
    }
  });

  it("counts the user's choice in: one more for new ones, one less for those given up", () => {
    const before = [{ emoji: "a", count: 1, chosen: true }, { emoji: "b", count: 2, chosen: true }, { emoji: "c", count: 1, chosen: false }];
    expect(withChosen(before, ["b", "c", "d"])).toEqual([{ emoji: "b", count: 2, chosen: true }, { emoji: "c", count: 2, chosen: true }, { emoji: "d", count: 1, chosen: true }]);
  });
});

describe("typing", () => {
  const group = () => [dlg("-5", { kind: "group", title: "G" }), dlg("1", { title: "Ana" }), dlg("-6", { kind: "group", title: "Quiet", readOnly: true })];
  const typingNow = (ctx: Awaited<ReturnType<typeof signedIn>>) => ctx.chat().channel!.typing;

  it("tells the open chat the user is typing, at most every TYPING_REPEAT_MS, and stops it on sending", async () => {
    vi.useFakeTimers();
    const ctx = await signedIn({ dialogs: group() });
    await ctx.adapter.openConversation("1");
    expect(ctx.chat().channel!.can.typing).toBe(true);
    await ctx.act({ type: "typing" });
    await ctx.act({ type: "typing" });
    expect(ctx.api.typing.mock.calls).toEqual([["1", true, undefined]]);
    vi.advanceTimersByTime(TYPING_REPEAT_MS);
    await ctx.act({ type: "typing" });
    expect(ctx.api.typing).toHaveBeenCalledTimes(2);
    await ctx.act({ type: "send", content: "hi" });
    expect(ctx.api.typing).toHaveBeenLastCalledWith("1", false, undefined);
    // Sent without typing first, or once the notice ran out: nothing to stop.
    await ctx.act({ type: "send", content: "again" });
    await ctx.act({ type: "typing" });
    vi.advanceTimersByTime(TYPING_SHOWN_MS);
    await ctx.act({ type: "send", content: "late" });
    expect(ctx.api.typing.mock.calls.filter((c) => c[1] === false)).toHaveLength(1);
  });

  it("starts afresh in another chat, and sends nothing where the user cannot write or without a chat", async () => {
    const ctx = await signedIn({ dialogs: group() });
    await ctx.act({ type: "typing" });
    await ctx.adapter.openConversation("1");
    await ctx.act({ type: "typing" });
    await ctx.act({ type: "select", channelId: viewId("-5") });
    await ctx.act({ type: "typing" });
    await ctx.act({ type: "send", content: "x" });
    await ctx.act({ type: "select", channelId: viewId("-6") });
    await ctx.act({ type: "typing" });
    expect(ctx.chat().channel!.can.typing).toBe(false);
    expect(ctx.api.typing.mock.calls).toEqual([["1", true, undefined], ["-5", true, undefined], ["-5", false, undefined]]);
  });

  it("sends no typing while Settings turns it off, calling off a notice that still shows", async () => {
    const off = await signedIn({ dialogs: group(), settings: { typing: false } });
    await off.adapter.openConversation("1");
    expect(off.chat().channel!.can.typing).toBe(false);
    await off.act({ type: "typing" });
    expect(off.api.typing).not.toHaveBeenCalled();

    const ctx = await signedIn({ dialogs: group() });
    await ctx.adapter.openConversation("1");
    ctx.adapter.applySettings({ typing: false }); // nothing to call off
    ctx.adapter.applySettings({});
    await ctx.act({ type: "typing" });
    ctx.adapter.applySettings({ typing: false });
    await ctx.act({ type: "typing" });
    expect(ctx.api.typing.mock.calls).toEqual([["1", true, undefined], ["1", false, undefined]]);
    ctx.adapter.applySettings({ typing: true });
    await ctx.act({ type: "typing" });
    expect(ctx.api.typing).toHaveBeenCalledTimes(3);
  });

  it("ignores a failing typing notice", async () => {
    const ctx = await signedIn({ dialogs: group() });
    await ctx.adapter.openConversation("1");
    ctx.api.typing.mockRejectedValue(new Error("flood"));
    await ctx.act({ type: "typing" });
    await ctx.act({ type: "send", content: "x" });
    await flush();
    expect(ctx.chat().error).toBeUndefined();
  });

  it("shows who is typing by name, and drops them after TYPING_SHOWN_MS", async () => {
    vi.useFakeTimers();
    const ctx = await signedIn({ dialogs: group() });
    ctx.api.history.mockResolvedValue([msg("-5", 1, { senderId: "21", sender: "Bo" })]);
    ctx.api.userName.mockResolvedValue("Cy");
    await ctx.act({ type: "select", channelId: viewId("-5") });
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "21", active: true });
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "22", active: true });
    expect(typingNow(ctx)).toEqual(["Bo", "Someone"]);
    await flush();
    expect(typingNow(ctx)).toEqual(["Bo", "Cy"]);
    expect(ctx.api.userName).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TYPING_SHOWN_MS / 2);
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "22", active: true });
    vi.advanceTimersByTime(TYPING_SHOWN_MS / 2);
    expect(typingNow(ctx)).toEqual(["Cy"]);
    vi.advanceTimersByTime(TYPING_SHOWN_MS / 2);
    expect(typingNow(ctx)).toEqual([]);
    expect(ctx.api.userName).toHaveBeenCalledTimes(1);
  });

  it("names typing members from the member list, and the other side of a one-to-one chat by its title", async () => {
    const ctx = await signedIn({ dialogs: [dlg("-5", { kind: "group", title: "G", members: true }), dlg("1", { title: "Ana" })] });
    ctx.api.members.mockResolvedValue({ members: [{ id: "31", name: "Di", bot: false, presence: "online" }], total: 1 });
    await ctx.act({ type: "select", channelId: viewId("-5") });
    await ctx.act({ type: "members", open: true });
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "31", active: true });
    expect(typingNow(ctx)).toEqual(["Di"]);
    ctx.api.emit({ type: "typing", chatId: "1", userId: "1", active: true });
    await ctx.adapter.openConversation("1");
    expect(typingNow(ctx)).toEqual(["Ana"]);
    expect(ctx.api.userName).not.toHaveBeenCalled();
  });

  it("stops showing someone who stopped or sent their message, the user themselves, and chats not listed", async () => {
    const ctx = await signedIn({ dialogs: group() });
    await ctx.act({ type: "select", channelId: viewId("-5") });
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "21", active: true });
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "21", active: false });
    expect(typingNow(ctx)).toEqual([]);
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "21", active: true });
    ctx.api.emit({ type: "message", message: msg("-5", 50, { senderId: "21" }) });
    expect(typingNow(ctx)).toEqual([]);
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "9", active: true });
    ctx.api.emit({ type: "typing", chatId: "-77", userId: "21", active: true });
    expect(typingNow(ctx)).toEqual([]);
    // Typing elsewhere shows there, not here.
    const renders = ctx.renders.length;
    ctx.api.emit({ type: "typing", chatId: "1", userId: "1", active: true });
    expect(ctx.renders.length).toBe(renders);
  });

  it("shows at most ten people typing in one chat", async () => {
    const ctx = await signedIn({ dialogs: group() });
    await ctx.act({ type: "select", channelId: viewId("-5") });
    for (let i = 0; i < 15; i++) ctx.api.emit({ type: "typing", chatId: "-5", userId: String(100 + i), active: true });
    expect(typingNow(ctx)).toHaveLength(10);
  });

  it("keeps no one typing, nor names, across accounts", async () => {
    const ctx = await signedIn({ dialogs: group() });
    let answer!: (name: string) => void;
    ctx.api.userName.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await ctx.act({ type: "select", channelId: viewId("-5") });
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "21", active: true });
    await ctx.act({ type: "logout" });
    answer("Old");
    await ctx.answer("phone", { phone: "+31612345678" });
    await ctx.answer("code", { code: "1" });
    await flush();
    await ctx.act({ type: "select", channelId: viewId("-5") });
    expect(typingNow(ctx)).toEqual([]);
    ctx.api.userName.mockRejectedValueOnce(new Error("unknown"));
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "21", active: true });
    await flush();
    expect(typingNow(ctx)).toEqual(["Someone"]);
    expect(ctx.api.userName).toHaveBeenCalledTimes(2);
  });

  it("asks no names once signed out", async () => {
    const ctx = await signedIn({ dialogs: group() });
    await ctx.act({ type: "select", channelId: viewId("-5") });
    ctx.api.isAuthorized = false;
    await ctx.act({ type: "logout" });
    ctx.api.emit({ type: "typing", chatId: "-5", userId: "21", active: true });
    await ctx.act({ type: "typing" });
    expect(ctx.api.userName).not.toHaveBeenCalled();
    expect(ctx.api.typing).not.toHaveBeenCalled();
  });
});

describe("sending files", () => {
  const file = (filename: string, size = 3, contentType = "image/png"): FileSource => ({ filename, size, contentType, read: async () => new Uint8Array(size) });
  const open = async (options: Options = {}) => {
    const ctx = await signedIn(options);
    await ctx.adapter.openConversation(options.dialogs?.[0]?.chatId ?? "1");
    return ctx;
  };
  const pending = (ctx: Awaited<ReturnType<typeof open>>) => ctx.chat().channel!.pending;

  it("offers files where the user may send them, with a picker", async () => {
    const ctx = await open();
    expect(ctx.chat().channel!.can.attach).toBe(true);
    for (const extra of [{ readOnly: true }, { noMedia: true }]) {
      const other = await open({ dialogs: [dlg("1", extra)] });
      expect(other.chat().channel!.can.attach).toBe(false);
      await other.act({ type: "attach" });
      expect(other.picker.pick).not.toHaveBeenCalled();
    }
    const none = await open({ noFiles: true });
    expect(none.chat().channel!.can.attach).toBe(false);
    await none.act({ type: "attach" });
    const unselected = await signedIn();
    await unselected.act({ type: "attach" });
    expect(unselected.picker.pick).not.toHaveBeenCalled();
  });

  it("lists picked files for the open chat, and drops one on request", async () => {
    const ctx = await open();
    ctx.picked.push(file("a.png"), file("b.pdf", 10, "application/pdf"));
    await ctx.act({ type: "attach" });
    expect(pending(ctx)).toEqual([{ name: "a.png", size: 3 }, { name: "b.pdf", size: 10 }]);
    await ctx.act({ type: "removeAttachment", index: 0 });
    expect(pending(ctx)).toEqual([{ name: "b.pdf", size: 10 }]);
    // Another chat has its own list.
    await ctx.adapter.openConversation("2");
    expect(pending(ctx)).toEqual([]);
    await ctx.act({ type: "removeAttachment", index: 0 });
    const none = await signedIn();
    await none.act({ type: "removeAttachment", index: 0 });
  });

  it("leaves out files too large or empty, and more than MAX_ATTACHMENTS", async () => {
    const ctx = await open();
    ctx.picked.push(file("huge.mp4", MAX_UPLOAD_BYTES + 1, "video/mp4"));
    await ctx.act({ type: "attach" });
    expect(ctx.chat().error).toBe("huge.mp4 is larger than the 50 MB Multicord sends.");
    ctx.picked.splice(0, 1, file("", 0));
    await ctx.act({ type: "attach" });
    expect(ctx.chat().error).toBe("A file is empty.");
    expect(pending(ctx)).toEqual([]);
    ctx.picked.splice(0, 1, ...Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => file(`${i}.png`)));
    await ctx.act({ type: "attach" });
    expect(pending(ctx)).toHaveLength(MAX_ATTACHMENTS);
    expect(ctx.chat().error).toBe(`At most ${MAX_ATTACHMENTS} files per message.`);
  });

  it("sends a file the shell hands over at once, or with the files waiting", async () => {
    const shared = (name: string, size = 3) => ({ type: "sendFile" as const, file: { handle: "h", name, size, type: "image/gif" } });
    const unselected = await signedIn();
    await unselected.act(shared("a.gif"));
    const readOnly = await open({ dialogs: [dlg("1", { readOnly: true })] });
    await readOnly.act(shared("a.gif"));
    expect(readOnly.picker.open).not.toHaveBeenCalled();
    const ctx = await open();
    await ctx.act({ ...shared("dance.gif"), replyTo: "2" });
    expect(ctx.api.sendFile.mock.calls.map((c) => [c[1].filename, c[3]])).toEqual([["dance.gif", 2]]);
    expect(pending(ctx)).toEqual([]);
    await ctx.act(shared("empty.gif", 0));
    expect(ctx.chat().error).toBe("empty.gif cannot be sent.");
    await ctx.act(shared("huge.gif", MAX_UPLOAD_BYTES + 1));
    expect(ctx.chat().error).toBe("huge.gif cannot be sent.");
    ctx.picked.push(...Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) => file(`${i}.png`)));
    await ctx.act({ type: "attach" });
    await ctx.act(shared("dance.gif"));
    expect(pending(ctx).at(-1)).toEqual({ name: "dance.gif", size: 3 });
    await ctx.act(shared("more.gif"));
    expect(ctx.chat().error).toBe(`At most ${MAX_ATTACHMENTS} files per message.`);
    const none = await open({ noFiles: true });
    await none.act(shared("a.gif"));
    expect(none.api.sendFile).not.toHaveBeenCalled();
  });

  it("reports a picker that failed", async () => {
    const ctx = await open();
    ctx.picker.pick.mockRejectedValue(new Error("too late"));
    await ctx.act({ type: "attach" });
    expect(ctx.chat().error).toBe("Could not attach: too late");
  });

  it("sends each file, the text as the last one's caption and the reply with the first", async () => {
    const ctx = await open();
    ctx.picked.push(file("a.png"), file("b.png"));
    await ctx.act({ type: "attach" });
    let release!: () => void;
    ctx.api.sendFile.mockImplementationOnce(async (chatId, f, caption) => {
      await new Promise<void>((resolve) => (release = resolve));
      return msg(chatId, 310, { out: true, text: caption.text, media: f.filename });
    });
    const sending = ctx.act({ type: "send", content: "**look**", replyTo: "2" });
    await flush();
    expect(ctx.chat().channel!.uploading).toBe(true);
    // Nothing else goes while files go out.
    await ctx.act({ type: "send", content: "other" });
    await ctx.act({ type: "attach" });
    await ctx.act({ type: "removeAttachment", index: 0 });
    expect(ctx.api.send).not.toHaveBeenCalled();
    expect(ctx.picker.pick).toHaveBeenCalledTimes(1);
    release();
    await sending;
    expect(ctx.api.sendFile.mock.calls.map((c) => [c[0], c[1].filename, c[2], c[3]])).toEqual([
      ["1", "a.png", { text: "", entities: [] }, 2],
      ["1", "b.png", { text: "look", entities: [{ type: "bold", offset: 0, length: 4 }] }, undefined],
    ]);
    expect(ctx.chat().channel).toMatchObject({ uploading: false, pending: [] });
    expect(ctx.messageIds().slice(-2)).toEqual(["310", "300"]);
  });

  it("sends files alone, and text too long for a caption after them", async () => {
    const ctx = await open();
    ctx.picked.push(file("a.png"));
    await ctx.act({ type: "attach" });
    await ctx.act({ type: "send", content: "" });
    expect(ctx.api.sendFile).toHaveBeenCalledTimes(1);
    expect(ctx.api.send).not.toHaveBeenCalled();
    await ctx.act({ type: "attach" });
    const long = "x".repeat(CAPTION_LIMIT + 1);
    await ctx.act({ type: "send", content: long, replyTo: "2" });
    expect(ctx.api.sendFile).toHaveBeenLastCalledWith("1", expect.anything(), { text: "", entities: [] }, 2, undefined);
    expect(ctx.api.send).toHaveBeenCalledWith("1", { text: long, entities: [] }, undefined, undefined);
  });

  it("gives Premium users longer captions", async () => {
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.me.mockResolvedValue({ id: "9", name: "Me", bot: false, premium: true });
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.openConversation("1");
    ctx.picked.push(file("a.png"));
    await ctx.act({ type: "attach" });
    const long = "x".repeat(CAPTION_LIMIT + 1);
    await ctx.act({ type: "send", content: long });
    expect(ctx.api.sendFile).toHaveBeenCalledWith("1", expect.anything(), { text: long, entities: [] }, undefined, undefined);
    expect(ctx.api.send).not.toHaveBeenCalled();
  });

  it("keeps the files not sent when one fails", async () => {
    const ctx = await open();
    ctx.picked.push(file("a.png"), file("b.png"));
    await ctx.act({ type: "attach" });
    ctx.api.sendFile.mockResolvedValueOnce(msg("1", 300, { out: true })).mockRejectedValueOnce(tgError("CHAT_SEND_PHOTOS_FORBIDDEN"));
    await ctx.act({ type: "send", content: "hi" });
    expect(ctx.chat().error).toBe("Message not sent: CHAT_SEND_PHOTOS_FORBIDDEN");
    expect(ctx.chat().channel).toMatchObject({ uploading: false, pending: [{ name: "b.png", size: 3 }] });
    expect(ctx.api.send).not.toHaveBeenCalled();
  });

  it("drops files and stops sending them on sign-out", async () => {
    const ctx = await open();
    ctx.picked.push(file("a.png"), file("b.png"));
    await ctx.act({ type: "attach" });
    let release!: () => void;
    ctx.api.sendFile.mockImplementationOnce(async (chatId) => {
      await new Promise<void>((resolve) => (release = resolve));
      return msg(chatId, 300, { out: true });
    });
    const sending = ctx.act({ type: "send", content: "" });
    await flush();
    await ctx.act({ type: "logout" });
    release();
    await sending;
    expect(ctx.api.sendFile).toHaveBeenCalledTimes(1);
    await ctx.adapter.openConversation("1");
    expect(ctx.chat().channel).toMatchObject({ uploading: false, pending: [] });
  });
});

describe("forum topics", () => {
  const FORUM = "-1005";
  const forum = (extra: Partial<TgDialog> = {}) => [dlg(FORUM, { kind: "group", title: "Club", forum: true, members: true, unreadCount: 5, unreadMentions: 2, ...extra }), dlg("1")];
  const topic = (id: number, extra: Partial<TgTopic> = {}): TgTopic => ({ id, title: `T${id}`, unreadCount: 0, unreadMentions: 0, date: id, ...extra });
  const open = async (extra: Partial<TgDialog> = {}) => {
    const ctx = await signedIn({ dialogs: forum(extra) });
    ctx.api.topics.mockResolvedValue([topic(1, { title: "General", date: 5 }), topic(10, { unreadCount: 3, unreadMentions: 1, date: 50 }), topic(20, { pinned: true, date: 1 })]);
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    return ctx;
  };
  const threads = (ctx: Awaited<ReturnType<typeof open>>) => ctx.rows().filter((r) => r.kind === "thread");
  const openTopic = async (ctx: Awaited<ReturnType<typeof open>>, name: string) => {
    await ctx.act({ type: "select", channelId: threads(ctx).find((t) => t.name === name)!.id });
    await flush();
  };

  it("mutes and unmutes topics on their own, which otherwise follow their group, and keeps muted topics quiet", async () => {
    const ctx = await signedIn({ dialogs: forum({ mutedUntil: MUTE_FOREVER }) });
    ctx.api.topics.mockResolvedValue([topic(1, { title: "General" }), topic(10, { mutedUntil: 0 }), topic(20)]);
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    const row = (name: string) => threads(ctx).find((t) => t.name === name)!;
    // General follows the muted group; T10 was unmuted on its own.
    expect([row("General"), row("T10")].map((t) => [t.muted, t.canMute])).toEqual([[true, true], [false, true]]);
    ctx.api.emit({ type: "message", message: msg(FORUM, 50, { topicId: 10 }) });
    ctx.api.emit({ type: "message", message: msg(FORUM, 51, { topicId: 20 }) });
    ctx.api.emit({ type: "message", message: msg(FORUM, 52, { topicId: 20, mentioned: true }) });
    expect(ctx.notifications.map((n) => n.body)).toEqual(["m50", "m52"]);

    await ctx.act({ type: "mute", channelId: row("T10").id, mute: true });
    expect(ctx.api.mute).toHaveBeenLastCalledWith(FORUM, MUTE_FOREVER, 10);
    expect(row("T10").muted).toBe(true);
    await ctx.act({ type: "mute", channelId: row("General").id, mute: false });
    expect(ctx.api.mute).toHaveBeenLastCalledWith(FORUM, 0, 1);
    expect(row("General").muted).toBe(false);
    // Already so: nothing to do.
    await ctx.act({ type: "mute", channelId: row("General").id, mute: false });
    expect(ctx.api.mute).toHaveBeenCalledTimes(2);
    ctx.api.mute.mockRejectedValueOnce(tgError("TOPIC_ID_INVALID"));
    await ctx.act({ type: "mute", channelId: row("T20").id, mute: false });
    expect(ctx.chat().error).toBe("Could not unmute the topic: TOPIC_ID_INVALID");
    ctx.api.mute.mockRejectedValueOnce(tgError("TOPIC_ID_INVALID"));
    await ctx.act({ type: "mute", channelId: row("General").id, mute: true });
    expect(ctx.chat().error).toBe("Could not mute the topic: TOPIC_ID_INVALID");
    // A topic no longer listed is left alone.
    const id = row("T20").id;
    ctx.api.topics.mockResolvedValue([]);
    await ctx.act({ type: "select", channelId: "1" });
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    await ctx.act({ type: "mute", channelId: id, mute: false });
    expect(ctx.api.mute).toHaveBeenCalledTimes(4);
  });

  it("lists a topic's pins and searches within it, each panel kept to its topic", async () => {
    const ctx = await open();
    expect(ctx.chat().channel!.can.pins).toBeUndefined();
    await openTopic(ctx, "T10");
    expect(ctx.chat().channel!.can).toMatchObject({ pins: true, search: true });
    expect(ctx.chat().channel!.messages[0]!.canPin).toBe(true);
    ctx.api.pinned.mockResolvedValueOnce([msg(FORUM, 12, { pinned: true, topicId: 10, sender: "Ana" })]);
    await ctx.act({ type: "pins", open: true });
    expect(ctx.api.pinned).toHaveBeenCalledWith(FORUM, 50, 10);
    expect(ctx.chat().channel!.pins!.messages).toEqual([expect.objectContaining({ id: "12", author: "Ana" })]);
    // A pin change in the forum fetches the open topic's pins again.
    ctx.api.emit({ type: "pins", chatId: FORUM, ids: [12], pinned: false });
    await flush();
    expect(ctx.api.pinned).toHaveBeenLastCalledWith(FORUM, 50, 10);
    await ctx.act({ type: "search", query: "hello" });
    expect(ctx.api.search).toHaveBeenCalledWith(FORUM, "hello", 50, 10);
    expect(ctx.chat().channel!.search).toMatchObject({ query: "hello", loading: false });
    // Another topic of the same forum has panels of its own.
    await openTopic(ctx, "General");
    expect(ctx.chat().channel!.pins).toBeUndefined();
    expect(ctx.chat().channel!.search).toBeUndefined();
    await ctx.act({ type: "search", query: "x" });
    expect(ctx.api.search).toHaveBeenLastCalledWith(FORUM, "x", 50, 1);
  });

  it("marks where a topic's news began, and gives the topic list no marker of its own", async () => {
    const ctx = await signedIn({ dialogs: forum() });
    ctx.adapter.setVisible(true);
    ctx.api.topics.mockResolvedValue([topic(10, { unreadCount: 2, readUpTo: 101 })]);
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    expect(ctx.chat().channel).not.toHaveProperty("unread");
    ctx.api.history.mockResolvedValueOnce([msg(FORUM, 100, { topicId: 10 }), msg(FORUM, 101, { topicId: 10 }), msg(FORUM, 102, { topicId: 10 })]);
    await openTopic(ctx, "T10");
    expect(ctx.chat().channel!.unread).toEqual({ firstId: "102", count: 2 });
    // Read now, and noted so: back in the list and into the topic again, no news.
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    await openTopic(ctx, "T10");
    expect(ctx.chat().channel).not.toHaveProperty("unread");
  });

  it("lists a forum's topics, pinned first then most recently active, as posts and under the forum", async () => {
    const ctx = await open();
    expect(ctx.api.topics).toHaveBeenCalledWith(FORUM, TOPIC_LIMIT);
    expect(ctx.api.history).not.toHaveBeenCalled();
    const channel = ctx.chat().channel!;
    expect(channel.posts!.map((p) => [p.name, p.unread, p.mentions])).toEqual([["T20", false, 0], ["T10", true, 1], ["General", false, 0]]);
    expect(channel.can).toEqual({ reply: false, react: false, attach: false, typing: false, members: true });
    expect(threads(ctx).map((t) => t.name)).toEqual(["T20", "T10", "General"]);
    expect(channel.posts!.map((p) => p.id)).toEqual(threads(ctx).map((t) => t.id));
    // Topic ids sit between users' and groups' ids.
    for (const t of threads(ctx)) expect(BigInt(t.id) > 9n * 10n ** 18n && BigInt(t.id) < 10n ** 19n).toBe(true);
    expect(ctx.rows().find((r) => r.id === viewId(FORUM))!.active).toBe(true);
    // Other chats do not show their topics.
    await ctx.adapter.openConversation("1");
    expect(threads(ctx)).toEqual([]);
  });

  it("shows the list loading, and says when it could not be loaded", async () => {
    const ctx = await signedIn({ dialogs: forum() });
    let fail!: () => void;
    ctx.api.topics.mockImplementationOnce(() => new Promise((_, reject) => (fail = () => reject(tgError("CHANNEL_PRIVATE")))));
    const opening = ctx.act({ type: "select", channelId: viewId(FORUM) });
    expect(ctx.chat().channel).toMatchObject({ loading: true, posts: [] });
    // Opened again meanwhile: asked once.
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    fail();
    await opening;
    expect(ctx.api.topics).toHaveBeenCalledTimes(1);
    expect(ctx.chat()).toMatchObject({ error: "Could not load topics: CHANNEL_PRIVATE" });
    expect(ctx.chat().channel!.loading).toBe(false);
  });

  it("opens a topic: its messages, read with its counts taken off the forum's", async () => {
    const ctx = await open();
    ctx.adapter.setVisible(true);
    ctx.api.history.mockResolvedValue([msg(FORUM, 11, { topicId: 10 }), msg(FORUM, 12, { topicId: 10 })]);
    await openTopic(ctx, "T10");
    expect(ctx.api.history).toHaveBeenCalledWith(FORUM, undefined, PAGE_SIZE, 10);
    const channel = ctx.chat().channel!;
    expect(channel.name).toBe("Club › T10");
    expect(channel.posts).toBeUndefined();
    expect(channel.id).toBe(threads(ctx).find((t) => t.name === "T10")!.id);
    expect(channel.can).toMatchObject({ reply: true, attach: true, typing: true });
    expect(ctx.messageIds()).toEqual(["11", "12"]);
    expect(ctx.api.markRead).toHaveBeenCalledWith(FORUM, 12, 10);
    expect(threads(ctx).find((t) => t.name === "T10")).toMatchObject({ active: true, unread: false, mentions: 0 });
    expect(ctx.rows().find((r) => r.id === viewId(FORUM))).toMatchObject({ active: false, unread: true, mentions: 1 });
    // Read already: not again.
    ctx.adapter.setVisible(true);
    await flush();
    expect(ctx.api.markRead).toHaveBeenCalledTimes(1);
  });

  it("ignores a topic Telegram would not mark read", async () => {
    const ctx = await open();
    ctx.adapter.setVisible(true);
    ctx.api.markRead.mockRejectedValue(new Error("x"));
    await openTopic(ctx, "T10");
    expect(ctx.chat().error).toBeUndefined();
  });

  it("reads nothing in the topic list, nor a topic without messages", async () => {
    const ctx = await open();
    ctx.adapter.setVisible(true);
    ctx.api.history.mockResolvedValue([]);
    await openTopic(ctx, "T10");
    await ctx.act({ type: "loadOlder" });
    expect(ctx.api.markRead).not.toHaveBeenCalled();
  });

  it("sends into the open topic, with files and typing there too", async () => {
    const ctx = await open();
    await openTopic(ctx, "T10");
    await ctx.act({ type: "typing" });
    expect(ctx.api.typing).toHaveBeenCalledWith(FORUM, true, 10);
    await ctx.act({ type: "send", content: "hi", replyTo: "11" });
    expect(ctx.api.send).toHaveBeenCalledWith(FORUM, { text: "hi", entities: [] }, 11, 10);
    expect(ctx.api.typing).toHaveBeenLastCalledWith(FORUM, false, 10);
    ctx.picked.push({ filename: "a.png", size: 3, contentType: "image/png", read: async () => new Uint8Array(3) });
    await ctx.act({ type: "attach" });
    expect(ctx.chat().channel!.pending).toHaveLength(1);
    await ctx.act({ type: "send", content: "" });
    expect(ctx.api.sendFile).toHaveBeenCalledWith(FORUM, expect.anything(), { text: "", entities: [] }, undefined, 10);
  });

  it("takes no messages, files or typing in the topic list", async () => {
    const ctx = await open();
    await ctx.act({ type: "send", content: "hi" });
    await ctx.act({ type: "typing" });
    await ctx.act({ type: "attach" });
    expect(ctx.api.send).not.toHaveBeenCalled();
    expect(ctx.api.typing).not.toHaveBeenCalled();
    expect(ctx.picker.pick).not.toHaveBeenCalled();
  });

  it("files live messages under their topic, counting them unread there unless open", async () => {
    const ctx = await open();
    ctx.adapter.setVisible(true);
    await openTopic(ctx, "T10");
    ctx.api.emit({ type: "message", message: msg(FORUM, 200, { topicId: 10 }) });
    expect(ctx.messageIds()).toContain("200");
    expect(ctx.api.markRead).toHaveBeenLastCalledWith(FORUM, 200, 10);
    ctx.api.emit({ type: "message", message: msg(FORUM, 201, { topicId: 20, mentioned: true, date: 999 }) });
    ctx.api.emit({ type: "message", message: msg(FORUM, 202) });
    expect(ctx.messageIds()).not.toContain("201");
    // General moved up with its new message.
    expect(threads(ctx).map((t) => [t.name, t.unread, t.mentions])).toEqual([["T20", true, 1], ["General", true, 0], ["T10", false, 0]]);
    // A topic not listed yet counts for the forum only.
    ctx.api.emit({ type: "message", message: msg(FORUM, 203, { topicId: 99 }) });
    expect(ctx.rows().find((r) => r.id === viewId(FORUM))!.mentions).toBe(2);
    // General's messages are read as General.
    await openTopic(ctx, "General");
    expect(ctx.api.history).toHaveBeenLastCalledWith(FORUM, undefined, PAGE_SIZE, 1);
    ctx.api.emit({ type: "message", message: msg(FORUM, 204) });
    expect(ctx.api.markRead).toHaveBeenLastCalledWith(FORUM, 204, 1);
  });

  it("keeps topics apart for typing, edits, reactions, deletions and media", async () => {
    const ctx = await open();
    ctx.api.history.mockResolvedValue([msg(FORUM, 11, { topicId: 10, file: { kind: "image", name: "p", size: 2 } })]);
    await openTopic(ctx, "T10");
    ctx.api.emit({ type: "typing", chatId: FORUM, userId: "21", active: true, topicId: 20 });
    ctx.api.emit({ type: "typing", chatId: FORUM, userId: "23", active: true });
    expect(ctx.chat().channel!.typing).toEqual([]);
    ctx.api.emit({ type: "typing", chatId: FORUM, userId: "22", active: true, topicId: 10 });
    expect(ctx.chat().channel!.typing).toEqual(["Someone"]);
    await ctx.act({ type: "loadMedia", key: `tg:${FORUM}:11` });
    expect(ctx.api.download).toHaveBeenCalledWith(FORUM, 11, false);
    ctx.api.emit({ type: "edit", message: msg(FORUM, 11, { topicId: 10, text: "changed" }) });
    expect(ctx.chat().channel!.messages[0]!.content).toBe("changed");
    ctx.api.emit({ type: "reactions", chatId: FORUM, id: 11, reactions: [{ emoji: "👍", count: 1, chosen: false }], own: true });
    expect(ctx.chat().channel!.messages[0]!.reactions).toHaveLength(1);
    await ctx.act({ type: "react", messageId: "11", emoji: "👍", add: true });
    expect(ctx.api.react).toHaveBeenCalledWith(FORUM, 11, ["👍"]);
    ctx.api.emit({ type: "delete", chatId: FORUM, ids: [11] });
    expect(ctx.messageIds()).toEqual([]);
  });

  it("starts a topic with its first message and opens it", async () => {
    const ctx = await open();
    ctx.api.send.mockResolvedValueOnce(msg(FORUM, 78, { out: true, text: "first", topicId: 77, date: 2000 }));
    ctx.api.history.mockResolvedValue([msg(FORUM, 78, { out: true, text: "first", topicId: 77 })]);
    await ctx.act({ type: "createPost", name: " New ", content: "**first**" });
    expect(ctx.api.createTopic).toHaveBeenCalledWith(FORUM, "New");
    expect(ctx.api.send).toHaveBeenCalledWith(FORUM, { text: "first", entities: [{ type: "bold", offset: 0, length: 5 }] }, undefined, 77);
    expect(ctx.chat().channel!.name).toBe("Club › New");
    expect(ctx.messageIds()).toEqual(["78"]);
    expect(threads(ctx)[0]).toMatchObject({ name: "T20" });
    expect(threads(ctx)[1]).toMatchObject({ name: "New", active: true });
    expect(ctx.api.history).not.toHaveBeenCalled();
  });

  it("starts no topic where only admins may, outside the list, or without text, and reports a refusal", async () => {
    const locked = await open({ noTopics: true });
    await locked.act({ type: "createPost", name: "x", content: "y" });
    expect(locked.chat().error).toBe("Only the group's admins start topics here.");
    const none = await signedIn({ dialogs: forum() });
    await none.act({ type: "createPost", name: "x", content: "y" });
    expect(none.api.createTopic).not.toHaveBeenCalled();
    const ctx = await open();
    await ctx.act({ type: "createPost", name: "x", content: "> " });
    await openTopic(ctx, "T10");
    await ctx.act({ type: "createPost", name: "x", content: "y" });
    await ctx.adapter.openConversation("1");
    await ctx.act({ type: "createPost", name: "x", content: "y" });
    expect(ctx.api.createTopic).not.toHaveBeenCalled();
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    ctx.api.createTopic.mockRejectedValue(tgError("CHAT_ADMIN_REQUIRED"));
    await ctx.act({ type: "createPost", name: "x", content: "y" });
    expect(ctx.chat().error).toBe("Topic not started: CHAT_ADMIN_REQUIRED");
  });

  it("starts a topic in a forum whose list could not be loaded", async () => {
    const ctx = await signedIn({ dialogs: forum() });
    ctx.api.topics.mockRejectedValue(new Error("down"));
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    await ctx.act({ type: "createPost", name: "Fresh", content: "x" });
    expect(threads(ctx).map((t) => t.name)).toEqual(["Fresh"]);
  });

  it("lists a topic only once, should Telegram list it before it is opened", async () => {
    const ctx = await open();
    ctx.api.createTopic.mockResolvedValue(10);
    await ctx.act({ type: "createPost", name: "Again", content: "x" });
    expect(threads(ctx).filter((t) => t.name === "T10")).toHaveLength(1);
  });

  it("opens a topic from elsewhere without listing the forum again, and ignores unknown ids", async () => {
    const ctx = await signedIn({ dialogs: forum() });
    ctx.api.topics.mockResolvedValue([topic(10)]);
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    const id = threads(ctx)[0]!.id;
    await ctx.adapter.openConversation("1");
    await ctx.act({ type: "select", channelId: id });
    await flush();
    expect(ctx.api.topics).toHaveBeenCalledTimes(1);
    expect(ctx.chat().channel!.name).toBe("Club › T10");
    // Unknown ids name no chat.
    await ctx.act({ type: "select", channelId: String(9n * 10n ** 18n + 999n) });
    expect(ctx.chat().channel!.name).toBe("Club › T10");
  });

  it("forgets topics on sign-out, and drops a list that arrives after it", async () => {
    const ctx = await signedIn({ dialogs: forum() });
    let answer!: (topics: TgTopic[]) => void;
    ctx.api.topics.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const opening = ctx.act({ type: "select", channelId: viewId(FORUM) });
    await ctx.act({ type: "logout" });
    answer([topic(10)]);
    await opening;
    await ctx.answer("phone", { phone: "+31612345678" });
    await ctx.answer("code", { code: "1" });
    await flush();
    let fail!: () => void;
    ctx.api.topics.mockImplementationOnce(() => new Promise((_, reject) => (fail = () => reject(new Error("x")))));
    const again = ctx.act({ type: "select", channelId: viewId(FORUM) });
    expect(threads(ctx)).toEqual([]);
    ctx.api.isAuthorized = false;
    await ctx.act({ type: "logout" });
    fail();
    await again;
    expect(ctx.last().screen).not.toBe("chat");
  });
});

describe("stickers", () => {
  const stk = (id: string, extra: Partial<TgSticker> = {}): TgSticker => ({ id, emoji: "😀", format: "webp", ...extra });
  const GROUP = "-1005";

  interface StickerOptions extends Options {
    premium?: boolean;
  }

  /** Signed in with these packs (set ids are digits; "faved" and "recent" the user's own), a chat open, the picker open and the packs fetched. */
  async function stickerChat(packs: Record<string, TgSticker[]>, options: StickerOptions = {}, chat = "1") {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true, ...options });
    if (options.premium) ctx.api.me.mockResolvedValue({ id: "9", name: "Me", bot: false, premium: true });
    ctx.api.stickerSets.mockResolvedValue(Object.keys(packs).filter((id) => /^\d+$/.test(id)).map((id) => ({ id, title: `Set ${id}` })));
    ctx.api.stickers.mockImplementation(async (id: string) => packs[id] ?? []);
    await ctx.adapter.start();
    await flush();
    await ctx.act({ type: "select", channelId: viewId(chat) });
    await ctx.act({ type: "picker", open: true });
    await settle();
    return ctx;
  }
  const settle = async () => {
    await flush();
    await vi.advanceTimersByTimeAsync(STICKER_RENDER_MS);
  };
  type Ctx = Awaited<ReturnType<typeof stickerChat>>;
  const packs = (ctx: Ctx) => ctx.chat().stickers ?? [];
  const offered = (ctx: Ctx) => packs(ctx).flatMap((p) => p.stickers);

  it("fetches packs when the picker first opens, and keeps them out of the state while it is closed", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.stickers.mockImplementation(async (id: string) => (id === "faved" ? [stk("1"), stk("2")] : []));
    // Not signed in yet: nothing to fetch.
    await ctx.act({ type: "picker", open: true });
    await ctx.adapter.start();
    await flush();
    await ctx.act({ type: "select", channelId: "1" });
    await settle();
    expect(ctx.api.stickerSets).not.toHaveBeenCalled();
    expect(ctx.chat().stickers).toBeUndefined();
    await ctx.act({ type: "picker", open: true });
    await settle();
    expect(ctx.api.stickerSets).toHaveBeenCalledTimes(1);
    expect(offered(ctx).map((s) => s.id)).toEqual(["tg:1", "tg:2"]);
    await ctx.act({ type: "loadMedia", key: "tgsticker:1" });
    await settle();
    expect(offered(ctx)[0]!.url).toBe("data:image/webp;base64,aGk=");
    // Closed: the packs and their pictures stay out of the state, and no picture is loaded.
    await ctx.act({ type: "picker", open: false });
    expect(ctx.chat().stickers).toBeUndefined();
    await ctx.act({ type: "loadMedia", key: "tgsticker:2" });
    await settle();
    expect(ctx.api.stickerFile).toHaveBeenCalledTimes(1);
    // Opened again: fetched already, the picture kept.
    await ctx.act({ type: "picker", open: true });
    expect(offered(ctx)[0]!.url).toBe("data:image/webp;base64,aGk=");
    // A view reloaded has its picker closed.
    await ctx.act({ type: "ready" });
    expect(ctx.chat().stickers).toBeUndefined();
    expect(ctx.api.stickerSets).toHaveBeenCalledTimes(1);
  });

  it("offers the user's favourite and recent stickers, then their sets", async () => {
    const ctx = await stickerChat({ faved: [stk("1")], recent: [], "11": [stk("2", { emoji: "" })], "12": [stk("3")] });
    expect(ctx.api.stickers.mock.calls.map((c) => c[0])).toEqual(["faved", "recent", "11", "12"]);
    expect(packs(ctx).map((p) => [p.id, p.name])).toEqual([["faved", "Favourite stickers"], ["set:11", "Set 11"], ["set:12", "Set 12"]]);
    expect(offered(ctx)[0]).toEqual({ id: "tg:1", name: "😀 sticker", format: "webp", emoji: "😀", mediaKey: "tgsticker:1" });
    expect(offered(ctx)[1]).toEqual({ id: "tg:2", name: "🙂 sticker", format: "webp", mediaKey: "tgsticker:2" });
    expect(ctx.chat().channel!.can.stickers).toBe(true);
    // Fetched once a session.
    await ctx.act({ type: "select", channelId: "2" });
    await ctx.act({ type: "picker", open: true });
    await settle();
    expect(packs(ctx)).toHaveLength(3);
    expect(ctx.api.stickerSets).toHaveBeenCalledTimes(1);
    // Neither GIF search nor custom emoji is offered.
    expect(ctx.chat().channel!.can.gifs).toBeUndefined();
    expect(ctx.chat().customEmoji).toBeUndefined();
  });

  it("shows packs as they arrive, a few at a time, leaving out those that fail", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    await ctx.adapter.start();
    await flush();
    ctx.api.stickerSets.mockRejectedValueOnce(new Error("offline"));
    await ctx.act({ type: "select", channelId: "1" });
    await ctx.act({ type: "picker", open: true });
    await settle();
    expect(ctx.api.stickers).not.toHaveBeenCalled();
    // Asked again when the picker opens next.
    const answers: ((stickers: TgSticker[]) => void)[] = [];
    ctx.api.stickerSets.mockResolvedValue([{ id: "11", title: "Cats" }, { id: "12", title: "Dogs" }, { id: "13", title: "Owls" }]);
    ctx.api.stickers.mockImplementation((id: string) => (id === "12" ? Promise.reject(new Error("gone")) : new Promise((resolve) => answers.push(resolve))));
    await ctx.act({ type: "picker", open: true });
    await flush();
    expect(ctx.api.stickers.mock.calls.map((c) => c[0])).toEqual(["faved", "recent", "11"]);
    answers[2]!([stk("1")]);
    await settle();
    expect(packs(ctx).map((p) => p.id)).toEqual(["set:11"]);
    expect(ctx.api.stickers.mock.calls.map((c) => c[0])).toEqual(["faved", "recent", "11", "12", "13"]);
    answers[0]!([stk("2")]);
    answers[1]!([]);
    answers[3]!([stk("3")]);
    await settle();
    expect(packs(ctx).map((p) => p.id)).toEqual(["faved", "set:11", "set:13"]);
  });

  it("fetches at most so many sets, and offers as many stickers as the view shows", async () => {
    const sets: Record<string, TgSticker[]> = {};
    for (let i = 1; i <= STICKER_SET_LIMIT + 1; i++) sets[String(i)] = Array.from({ length: PACK_STICKER_LIMIT + 1 }, (_, j) => stk(`${i}${String(j).padStart(4, "0")}`));
    const ctx = await stickerChat(sets);
    expect(ctx.api.stickers).toHaveBeenCalledTimes(STICKER_SET_LIMIT + 2);
    expect(ctx.api.stickers).not.toHaveBeenCalledWith(String(STICKER_SET_LIMIT + 1));
    expect(packs(ctx)[0]!.stickers).toHaveLength(PACK_STICKER_LIMIT);
    expect(offered(ctx)).toHaveLength(STICKER_LIMIT);
  });

  it("loads pictures for the picker: the file for static and video stickers, the still for animated ones and large static ones", async () => {
    const ctx = await stickerChat({
      "11": [stk("1"), stk("2", { format: "lottie" }), stk("3", { format: "webm", size: 1000 }), stk("4", { size: MAX_STICKER_BYTES + 1 }), stk("5", { format: "webm", size: MAX_STICKER_BYTES + 1 }), stk("6", { format: "webm" })],
    });
    // A video sticker too large to load is not offered; a large static one shows its thumbnail, and says so.
    expect(offered(ctx).map((s) => [s.id, s.name, s.format])).toEqual([
      ["tg:1", "😀 sticker", "webp"],
      ["tg:2", "😀 sticker", "lottie"],
      ["tg:3", "😀 sticker", "webm"],
      ["tg:4", "😀 sticker (small preview)", "webp"],
      ["tg:6", "😀 sticker", "webm"],
    ]);
    for (const id of ["1", "2", "3", "4"]) await ctx.act({ type: "loadMedia", key: `tgsticker:${id}` });
    expect(ctx.api.stickerFile.mock.calls).toEqual([["1", false], ["2", true], ["3", false], ["4", true]]);
    await flush();
    // Gathered before the view hears of them.
    expect(offered(ctx)[0]).not.toHaveProperty("url");
    await settle();
    expect(offered(ctx).map((s) => s.url)).toEqual(["data:image/webp;base64,aGk=", "data:image/webp;base64,aGk=", "data:video/webm;base64,aGk=", "data:image/webp;base64,aGk=", undefined]);
    expect(offered(ctx)[0]).not.toHaveProperty("mediaKey");
    // Loaded once; keys not offered are ignored.
    for (const key of ["tgsticker:1", "tgsticker:5", "tgsticker:99"]) await ctx.act({ type: "loadMedia", key });
    expect(ctx.api.stickerFile).toHaveBeenCalledTimes(4);
  });

  it("downloads a few pictures at once, each once", async () => {
    const ctx = await stickerChat({ "11": ["1", "2", "3", "4", "5", "6"].map((id) => stk(id)) });
    const answers: (() => void)[] = [];
    ctx.api.stickerFile.mockImplementation(() => new Promise((resolve) => answers.push(() => resolve(new Uint8Array([1])))));
    for (const id of ["1", "2", "3", "4", "5", "6", "6"]) await ctx.act({ type: "loadMedia", key: `tgsticker:${id}` });
    expect(ctx.api.stickerFile).toHaveBeenCalledTimes(4);
    answers[0]!();
    answers[1]!();
    await flush();
    expect(ctx.api.stickerFile).toHaveBeenCalledTimes(6);
    for (const answer of answers) answer();
    await settle();
    expect(offered(ctx).every((s) => s.url === "data:image/webp;base64,AQ==")).toBe(true);
  });

  it("leaves out stickers whose picture could not be loaded, is too large, or is past the budget", async () => {
    const ctx = await stickerChat({ "11": ["1", "2", "3", "4", "5"].map((id) => stk(id)) }, { stickerBudget: 50 });
    ctx.api.stickerFile.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Uint8Array(MAX_STICKER_BYTES + 1));
    for (const id of ["1", "2", "3", "4", "5"]) await ctx.act({ type: "loadMedia", key: `tgsticker:${id}` });
    await settle();
    // "data:image/webp;base64,aGk=" is 27 characters: one fits the budget.
    expect(offered(ctx).map((s) => s.id)).toEqual(["tg:4"]);
  });

  it("offers Premium stickers only to Premium users", async () => {
    const plain = await stickerChat({ "11": [stk("1"), stk("2", { premium: true })] });
    expect(offered(plain).map((s) => s.id)).toEqual(["tg:1"]);
    await plain.act({ type: "sendSticker", stickerId: "tg:2" });
    expect(plain.api.sendSticker).not.toHaveBeenCalled();
    const premium = await stickerChat({ "11": [stk("1"), stk("2", { premium: true })] }, { premium: true });
    expect(offered(premium).map((s) => s.id)).toEqual(["tg:1", "tg:2"]);
  });

  it("offers stickers only where they may be sent as stickers", async () => {
    const dialogs = [
      dlg("1"),
      dlg("-1", { kind: "channel", readOnly: true }),
      dlg("-2", { kind: "group", noStickers: true }),
      dlg(GROUP, { kind: "group", forum: true }),
    ];
    const ctx = await stickerChat({ "11": [stk("1")] }, { dialogs });
    expect(offered(ctx)).toHaveLength(1);
    for (const chat of ["-1", "-2", GROUP]) {
      await ctx.act({ type: "select", channelId: viewId(chat) });
      await settle();
      expect(ctx.chat().stickers).toBeUndefined();
      expect(ctx.chat().channel!.can.stickers).not.toBe(true);
      await ctx.act({ type: "sendSticker", stickerId: "tg:1" });
    }
    expect(ctx.api.sendSticker).not.toHaveBeenCalled();
    // In a forum, within a topic.
    ctx.api.topics.mockResolvedValue([{ id: 10, title: "T10", unreadCount: 0, unreadMentions: 0, date: 1 }]);
    await ctx.act({ type: "select", channelId: viewId(GROUP) });
    await flush();
    await ctx.act({ type: "select", channelId: ctx.rows().find((r) => r.kind === "thread")!.id });
    await settle();
    expect(ctx.chat().channel!.can.stickers).toBe(true);
    await ctx.act({ type: "sendSticker", stickerId: "tg:1" });
    expect(ctx.api.sendSticker).toHaveBeenCalledWith(GROUP, "1", undefined, 10);
  });

  it("sends an offered sticker as a sticker, as a reply where asked, and shows it", async () => {
    const ctx = await stickerChat({ "11": [stk("1")] });
    await ctx.act({ type: "sendSticker", stickerId: "tg:1", replyTo: "2" });
    expect(ctx.api.sendSticker).toHaveBeenCalledWith("1", "1", 2, undefined);
    expect(ctx.messageIds()).toContain("400");
    // Only stickers offered.
    await ctx.act({ type: "sendSticker", stickerId: "tg:9" });
    expect(ctx.api.sendSticker).toHaveBeenCalledTimes(1);
    ctx.api.sendSticker.mockRejectedValueOnce(tgError("CHAT_SEND_STICKERS_FORBIDDEN"));
    await ctx.act({ type: "sendSticker", stickerId: "tg:1" });
    expect(ctx.chat().error).toBe("Sticker not sent: CHAT_SEND_STICKERS_FORBIDDEN");
  });

  it("sends nothing without an open chat", async () => {
    vi.useFakeTimers();
    const ctx = await signedIn();
    await ctx.act({ type: "sendSticker", stickerId: "tg:1" });
    expect(ctx.api.sendSticker).not.toHaveBeenCalled();
    expect(ctx.chat().stickers).toBeUndefined();
  });

  it("forgets stickers on sign-out, and drops what arrives after it", async () => {
    const ctx = await stickerChat({ "11": [stk("1"), stk("2")] });
    let loaded!: (bytes: Uint8Array) => void;
    ctx.api.stickerFile.mockImplementationOnce(() => new Promise((resolve) => (loaded = resolve)));
    await ctx.act({ type: "loadMedia", key: "tgsticker:1" });
    await ctx.act({ type: "loadMedia", key: "tgsticker:2" });
    await ctx.act({ type: "logout" });
    loaded(new Uint8Array([1]));
    await settle();
    // Signed in again: fetched afresh, with what came late left out.
    let sets!: (sets: TgStickerSet[]) => void;
    ctx.api.stickerSets.mockImplementationOnce(() => new Promise((resolve) => (sets = resolve)));
    await ctx.answer("phone", { phone: "+31612345678" });
    await ctx.answer("code", { code: "1" });
    await flush();
    await ctx.act({ type: "select", channelId: "1" });
    // The picker counts as closed after signing in again.
    expect(ctx.api.stickerSets).toHaveBeenCalledTimes(1);
    const opening = ctx.act({ type: "picker", open: true });
    await flush();
    expect(ctx.chat().stickers).toBeUndefined();
    await ctx.act({ type: "logout" });
    sets([{ id: "11", title: "Cats" }]);
    await opening;
    await settle();
    expect(ctx.api.stickers).toHaveBeenCalledTimes(3); // faved, recent and set 11, before the first sign-out
  });

  it("drops packs that arrive after sign-out", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    await ctx.adapter.start();
    await flush();
    ctx.api.stickerSets.mockResolvedValue([]);
    const answers: ((stickers: TgSticker[]) => void)[] = [];
    ctx.api.stickers.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    await ctx.act({ type: "select", channelId: "1" });
    await ctx.act({ type: "picker", open: true });
    await flush();
    await ctx.act({ type: "logout" });
    for (const answer of answers) answer([stk("1")]);
    await settle();
    expect(ctx.api.stickers).toHaveBeenCalledTimes(2);
  });
});

describe("pinned messages", () => {
  it("lists the chat's pins while the panel is open, following pin changes", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "select", channelId: "1" });
    expect(ctx.chat().channel!.can.pins).toBe(true);
    const pending = ctx.act({ type: "pins", open: true });
    expect(ctx.chat().channel!.pins).toEqual({ messages: [], loading: true });
    await pending;
    expect(ctx.api.pinned).toHaveBeenCalledWith("1", 50, undefined);
    expect(ctx.chat().channel!.pins).toEqual({ messages: [{ id: "2", author: "User 1", content: "m2", timestamp: new Date(102_000).toISOString() }], loading: false });
    // Pinned elsewhere: the loaded message is marked, and the open list fetched again.
    ctx.api.pinned.mockResolvedValueOnce([msg("1", 1, { out: true, pinned: true })]);
    ctx.api.emit({ type: "pins", chatId: "1", ids: [1], pinned: true });
    await flush();
    expect(ctx.chat().channel!.messages[0]).toMatchObject({ id: "1", pinned: true, canPin: true });
    expect(ctx.chat().channel!.pins!.messages).toEqual([expect.objectContaining({ id: "1", author: "Me" })]);
    ctx.api.emit({ type: "pins", chatId: "2", ids: [1], pinned: false });
    expect(ctx.api.pinned).toHaveBeenCalledTimes(2);
    await ctx.act({ type: "pins", open: false });
    expect(ctx.chat().channel!.pins).toBeUndefined();
    // Another chat drops the panel; the same one keeps it.
    await ctx.act({ type: "pins", open: true });
    await ctx.act({ type: "select", channelId: "1" });
    expect(ctx.chat().channel!.pins).toBeDefined();
    await ctx.act({ type: "select", channelId: "2" });
    expect(ctx.chat().channel!.pins).toBeUndefined();
  });

  it("says when the pins cannot be loaded, drops answers for a closed panel, and lists none for a forum's topic list", async () => {
    const ctx = await signedIn({ dialogs: [...defaultDialogs(), dlg("-5", { kind: "group", forum: true }), dlg("-6", { kind: "channel", readOnly: true })] });
    await ctx.act({ type: "pins", open: true });
    expect(ctx.api.pinned).not.toHaveBeenCalled();
    await ctx.act({ type: "select", channelId: "1" });
    ctx.api.pinned.mockRejectedValueOnce(tgError("CHAT_ADMIN_REQUIRED"));
    await ctx.act({ type: "pins", open: true });
    expect(ctx.chat().channel!.pins).toEqual({ messages: [], loading: false, error: expect.stringMatching(/^Could not load pinned messages: /) });
    const reopening = ctx.act({ type: "pins", open: true });
    await ctx.act({ type: "pins", open: false });
    await reopening;
    expect(ctx.chat().channel!.pins).toBeUndefined();
    await ctx.act({ type: "select", channelId: "-6" });
    expect(ctx.chat().channel!.messages[0]!.canPin).toBeUndefined();
    await ctx.act({ type: "select", channelId: "-5" });
    await ctx.act({ type: "pins", open: true });
    expect(ctx.chat().channel!.can.pins).not.toBe(true);
    expect(ctx.api.pinned).toHaveBeenCalledTimes(2);
  });

  it("pins and unpins quietly, and shows a refusal", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "pin", messageId: "1", pin: true });
    expect(ctx.api.pin).not.toHaveBeenCalled();
    await ctx.act({ type: "select", channelId: "1" });
    await ctx.act({ type: "pin", messageId: "2", pin: true });
    expect(ctx.api.pin).toHaveBeenCalledWith("1", 2, true);
    expect(ctx.chat().channel!.messages[1]!.pinned).toBe(true);
    await ctx.act({ type: "pin", messageId: "2", pin: false });
    expect(ctx.chat().channel!.messages[1]!.pinned).toBeUndefined();
    ctx.api.pin.mockRejectedValueOnce(tgError("CHAT_ADMIN_REQUIRED"));
    await ctx.act({ type: "pin", messageId: "2", pin: true });
    expect(ctx.chat().error).toMatch(/^Message not pinned: /);
    ctx.api.pin.mockRejectedValueOnce(tgError("CHAT_ADMIN_REQUIRED"));
    await ctx.act({ type: "pin", messageId: "2", pin: false });
    expect(ctx.chat().error).toMatch(/^Message not unpinned: /);
  });
});

describe("search", () => {
  it("searches the selected chat with Telegram's search", async () => {
    const ctx = await signedIn({ dialogs: [...defaultDialogs(), dlg("-5", { kind: "group", forum: true })] });
    await ctx.act({ type: "search", query: "nowhere" });
    expect(ctx.api.search).not.toHaveBeenCalled();
    await ctx.act({ type: "select", channelId: "1" });
    expect(ctx.chat().channel!.can.search).toBe(true);
    const pending = ctx.act({ type: "search", query: " m1 " });
    expect(ctx.chat().channel!.search).toEqual({ query: "m1", messages: [], loading: true });
    await pending;
    expect(ctx.api.search).toHaveBeenCalledWith("1", "m1", 50, undefined);
    expect(ctx.chat().channel!.search).toEqual({ query: "m1", messages: [{ id: "1", author: "User 1", content: "m1", timestamp: new Date(101_000).toISOString() }], loading: false });
    await ctx.act({ type: "search", query: "" });
    expect(ctx.chat().channel!.search).toBeUndefined();
    await ctx.act({ type: "search", query: "x" });
    await ctx.act({ type: "select", channelId: "1" });
    expect(ctx.chat().channel!.search).toBeDefined();
    await ctx.act({ type: "select", channelId: "2" });
    expect(ctx.chat().channel!.search).toBeUndefined();
    // A forum's topic list is not searched; its topics are.
    await ctx.act({ type: "select", channelId: "-5" });
    await ctx.act({ type: "search", query: "x" });
    expect(ctx.api.search).toHaveBeenCalledTimes(2);
  });

  it("shows failures, and drops answers to earlier searches", async () => {
    const ctx = await signedIn();
    await ctx.act({ type: "select", channelId: "1" });
    ctx.api.search.mockRejectedValueOnce(tgError("SEARCH_QUERY_EMPTY"));
    await ctx.act({ type: "search", query: "a" });
    expect(ctx.chat().channel!.search).toEqual({ query: "a", messages: [], loading: false, error: expect.stringMatching(/^Search failed: /) });
    let release: (found: TgMessage[]) => void = () => {};
    ctx.api.search.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const first = ctx.act({ type: "search", query: "first" });
    await ctx.act({ type: "search", query: "second" });
    release([msg("1", 2)]);
    await first;
    expect(ctx.chat().channel!.search).toMatchObject({ query: "second", loading: false, messages: [expect.objectContaining({ id: "1" })] });
    const ending = ctx.act({ type: "search", query: "third" });
    await ctx.act({ type: "search", query: "" });
    await ending;
    expect(ctx.chat().channel!.search).toBeUndefined();
  });
});

describe("forwarding", () => {
  const FORUM = "-1005";

  it("forwards natively into another chat or a forum's topic, and shows a refusal", async () => {
    const ctx = await signedIn({ dialogs: [...defaultDialogs(), dlg(FORUM, { kind: "group", title: "Club", forum: true })] });
    await ctx.act({ type: "forward", messageId: "1", channelId: "2" });
    expect(ctx.api.forward).not.toHaveBeenCalled();
    ctx.api.topics.mockResolvedValue([{ id: 1, title: "General", unreadCount: 0, unreadMentions: 0, date: 5 }, { id: 10, title: "T10", unreadCount: 0, unreadMentions: 0, date: 6 }]);
    await ctx.act({ type: "select", channelId: viewId(FORUM) });
    const topicId = ctx.rows().find((r) => r.name === "T10")!.id;
    await ctx.act({ type: "select", channelId: "1" });
    expect(ctx.chat().channel!.can.forward).toBe(true);
    await ctx.act({ type: "forward", messageId: "2", channelId: "2" });
    expect(ctx.api.forward).toHaveBeenLastCalledWith("1", 2, "2", undefined);
    await ctx.act({ type: "forward", messageId: "2", channelId: topicId });
    expect(ctx.api.forward).toHaveBeenLastCalledWith("1", 2, FORUM, 10);
    // A chat not listed is no target.
    await ctx.act({ type: "forward", messageId: "2", channelId: "777" });
    expect(ctx.api.forward).toHaveBeenCalledTimes(2);
    ctx.api.forward.mockRejectedValueOnce(tgError("CHAT_FORWARDS_RESTRICTED"));
    await ctx.act({ type: "forward", messageId: "2", channelId: "2" });
    expect(ctx.chat().error).toMatch(/^Message not forwarded: /);
  });
});

describe("polls", () => {
  const poll = (extra: Partial<TgPoll> = {}): TgPoll => ({
    id: "77",
    question: "Lunch?",
    answers: [{ option: "MA==", text: "Pizza" }, { option: "MQ==", text: "Soup" }],
    multiple: false,
    closed: false,
    quiz: false,
    ...extra,
  });

  it("shows a poll with its results, votes, and follows Telegram's updates", async () => {
    const ctx = await signedIn();
    ctx.api.history.mockResolvedValueOnce([
      msg("1", 1, { text: "", media: "📊 Poll", poll: poll({ results: { voters: [{ option: "MA==", votes: 3, chosen: true }, { option: "MQ==", votes: 1, correct: true }], total: 4, min: false } }) }),
      msg("1", 2, { text: "", media: "📊 Poll", poll: poll({ id: "78", multiple: true }) }),
    ]);
    await ctx.act({ type: "select", channelId: "1" });
    const [first, second] = ctx.chat().channel!.messages;
    expect(first!.content).toBe("");
    expect(first!.poll).toEqual({
      question: "Lunch?",
      options: [{ id: "0", text: "Pizza", votes: 3, chosen: true }, { id: "1", text: "Soup", votes: 1, correct: true }],
      multiple: false,
      closed: false,
      total: 4,
      canVote: true,
    });
    expect(second!.poll).toEqual({ question: "Lunch?", options: [{ id: "0", text: "Pizza" }, { id: "1", text: "Soup" }], multiple: true, closed: false, canVote: true });
    await ctx.act({ type: "vote", messageId: "1", options: ["1"] });
    expect(ctx.api.vote).toHaveBeenLastCalledWith("1", 1, ["MQ=="]);
    await ctx.act({ type: "vote", messageId: "2", options: ["0", "1"] });
    expect(ctx.api.vote).toHaveBeenLastCalledWith("1", 2, ["MA==", "MQ=="]);
    await ctx.act({ type: "vote", messageId: "1", options: [] });
    expect(ctx.api.vote).toHaveBeenLastCalledWith("1", 1, []);
    // Several answers where one is allowed, unknown answers or messages: nothing is sent.
    await ctx.act({ type: "vote", messageId: "1", options: ["0", "1"] });
    await ctx.act({ type: "vote", messageId: "1", options: ["5"] });
    await ctx.act({ type: "vote", messageId: "9", options: ["0"] });
    expect(ctx.api.vote).toHaveBeenCalledTimes(3);
    // Results without the user's choice keep it; a closed poll takes no votes.
    ctx.api.emit({ type: "poll", pollId: "77", results: { voters: [{ option: "MA==", votes: 5 }, { option: "MQ==", votes: 2 }], total: 7, min: true }, closed: true });
    expect(ctx.chat().channel!.messages[0]!.poll).toEqual({
      question: "Lunch?",
      options: [{ id: "0", text: "Pizza", votes: 5, chosen: true }, { id: "1", text: "Soup", votes: 2 }],
      multiple: false,
      closed: true,
      total: 7,
    });
    await ctx.act({ type: "vote", messageId: "1", options: ["1"] });
    expect(ctx.api.vote).toHaveBeenCalledTimes(3);
    ctx.api.emit({ type: "poll", pollId: "78", results: { voters: [], min: true } });
    ctx.api.emit({ type: "poll", pollId: "78", results: { voters: [{ option: "MA==", votes: 1, chosen: true }], min: false } });
    expect(ctx.chat().channel!.messages[1]!.poll!.options[0]).toEqual({ id: "0", text: "Pizza", votes: 1, chosen: true });
    ctx.api.vote.mockRejectedValueOnce(tgError("POLL_VOTE_REQUIRED"));
    await ctx.act({ type: "vote", messageId: "2", options: ["0"] });
    expect(ctx.chat().error).toMatch(/^Vote not counted: /);
  });

  it("starts polls in groups and channels, with the choice of anonymous votes in groups", async () => {
    const ctx = await signedIn({ dialogs: [dlg("-6", { kind: "group" }), dlg("-1007", { kind: "channel" }), ...defaultDialogs()] });
    await ctx.act({ type: "createPoll", question: "Q", answers: ["A", "B"], multiple: false });
    await ctx.act({ type: "select", channelId: viewId("-6") });
    expect(ctx.chat().channel!.can).toMatchObject({ polls: true, anonymousPolls: true });
    await ctx.act({ type: "createPoll", question: "Lunch?", answers: ["Pizza", "Soup"], multiple: true, anonymous: false });
    expect(ctx.api.sendPoll).toHaveBeenLastCalledWith("-6", { question: "Lunch?", answers: ["Pizza", "Soup"], multiple: true, publicVoters: true }, undefined);
    const sent = ctx.chat().channel!.messages.at(-1)!;
    expect(sent.poll).toMatchObject({ question: "Lunch?", canVote: true, canEnd: true });
    await ctx.act({ type: "createPoll", question: "Q", answers: ["A", "B"], multiple: false });
    expect(ctx.api.sendPoll).toHaveBeenLastCalledWith("-6", expect.objectContaining({ publicVoters: false }), undefined);
    // Channels take anonymous polls only.
    await ctx.act({ type: "select", channelId: viewId("-1007") });
    expect(ctx.chat().channel!.can).toMatchObject({ polls: true, anonymousPolls: false });
    await ctx.act({ type: "createPoll", question: "Q", answers: ["A", "B"], multiple: false, anonymous: false });
    expect(ctx.api.sendPoll).toHaveBeenLastCalledWith("-1007", expect.objectContaining({ publicVoters: false }), undefined);
    ctx.api.sendPoll.mockRejectedValueOnce(tgError("CHAT_SEND_POLL_FORBIDDEN"));
    await ctx.act({ type: "createPoll", question: "Q", answers: ["A", "B"], multiple: false });
    expect(ctx.chat().error).toMatch(/^Poll not sent: /);
  });

  it("offers no polls in one-to-one chats, where they are barred, nor outside a forum's topics", async () => {
    const ctx = await signedIn({ dialogs: [dlg("-6", { kind: "group", noPolls: true }), dlg("-8", { kind: "group", readOnly: true }), dlg("-9", { kind: "group", left: true }), ...defaultDialogs()] });
    for (const id of ["1", viewId("-6"), viewId("-8"), viewId("-9")]) {
      await ctx.act({ type: "select", channelId: id });
      expect(ctx.chat().channel!.can).toMatchObject({ polls: false, anonymousPolls: false });
      await ctx.act({ type: "createPoll", question: "Q", answers: ["A", "B"], multiple: false });
    }
    expect(ctx.api.sendPoll).not.toHaveBeenCalled();
    const forum = await signedIn({ dialogs: [dlg("-1005", { kind: "group", forum: true }), ...defaultDialogs()] });
    forum.api.topics.mockResolvedValue([{ id: 10, title: "T10", unreadCount: 0, unreadMentions: 0, date: 1 }]);
    await forum.act({ type: "select", channelId: viewId("-1005") });
    await forum.act({ type: "createPoll", question: "Q", answers: ["A", "B"], multiple: false });
    expect(forum.api.sendPoll).not.toHaveBeenCalled();
    await forum.act({ type: "select", channelId: forum.rows().find((r) => r.name === "T10")!.id });
    await flush();
    expect(forum.chat().channel!.can.polls).toBe(true);
    await forum.act({ type: "createPoll", question: "Q", answers: ["A", "B"], multiple: false });
    expect(forum.api.sendPoll).toHaveBeenLastCalledWith("-1005", expect.anything(), 10);
  });

  it("ends the user's own polls, not quizzes or others' polls", async () => {
    const ctx = await signedIn({ dialogs: [dlg("-6", { kind: "group" }), ...defaultDialogs()] });
    const mine = poll({ results: { voters: [{ option: "MA==", votes: 2, chosen: true }], total: 2, min: false } });
    ctx.api.history.mockResolvedValueOnce([
      msg("-6", 1, { text: "", poll: mine, out: true }),
      msg("-6", 2, { text: "", poll: poll({ id: "78" }) }),
      msg("-6", 3, { text: "", poll: poll({ id: "79", quiz: true }), out: true }),
      msg("-6", 4, { text: "", poll: poll({ id: "80" }), out: true }),
    ]);
    await ctx.act({ type: "select", channelId: viewId("-6") });
    const shown = ctx.chat().channel!.messages;
    expect(shown.map((m) => m.poll!.canEnd === true)).toEqual([true, false, false, true]);
    for (const id of ["2", "3", "99"]) await ctx.act({ type: "endPoll", messageId: id });
    expect(ctx.api.closePoll).not.toHaveBeenCalled();
    await ctx.act({ type: "endPoll", messageId: "1" });
    expect(ctx.api.closePoll).toHaveBeenLastCalledWith("-6", 1, mine);
    expect(ctx.chat().channel!.messages[0]!.poll).toMatchObject({ closed: true, total: 2, options: [{ id: "0", text: "Pizza", votes: 2, chosen: true }, { id: "1", text: "Soup" }] });
    expect(ctx.chat().channel!.messages[0]!.poll).not.toHaveProperty("canEnd");
    await ctx.act({ type: "endPoll", messageId: "1" });
    expect(ctx.api.closePoll).toHaveBeenCalledTimes(1);
    ctx.api.closePoll.mockRejectedValueOnce(tgError("MESSAGE_ID_INVALID"));
    await ctx.act({ type: "endPoll", messageId: "4" });
    expect(ctx.chat().error).toMatch(/^Poll not ended: /);
    expect(ctx.chat().channel!.messages[3]!.poll!.closed).toBe(false);
    await ctx.act({ type: "endPoll", messageId: "4" });
    expect(ctx.chat().channel!.messages[3]!.poll!.closed).toBe(true);
  });

  it("takes no votes where the user left, or with no conversation open", async () => {
    const ctx = await signedIn({ dialogs: [dlg("-6", { kind: "group", left: true, readOnly: true }), ...defaultDialogs()] });
    await ctx.act({ type: "vote", messageId: "1", options: ["0"] });
    await ctx.act({ type: "endPoll", messageId: "1" });
    ctx.api.history.mockResolvedValueOnce([msg("-6", 1, { text: "", poll: poll(), out: true })]);
    await ctx.act({ type: "select", channelId: viewId("-6") });
    expect(ctx.chat().channel!.messages[0]!.poll!.canVote).toBeUndefined();
    expect(ctx.chat().channel!.messages[0]!.poll!.canEnd).toBeUndefined();
    await ctx.act({ type: "endPoll", messageId: "1" });
    expect(ctx.api.vote).not.toHaveBeenCalled();
    expect(ctx.api.closePoll).not.toHaveBeenCalled();
  });
});

describe("custom emoji in messages", () => {
  const ce = (offset: number, documentId: string) => ({ type: "customEmoji" as const, offset, length: 2, documentId });
  /** A message "a😀" whose emoji is a custom one. */
  const withEmoji = (id: number, documentId = "77", extra: Partial<TgMessage> = {}) => msg("1", id, { text: "a😀", entities: [ce(1, documentId)], ...extra });
  const settle = async () => {
    await flush();
    await vi.advanceTimersByTimeAsync(STICKER_RENDER_MS);
    await flush();
  };

  interface EmojiOptions extends Options {
    premium?: boolean;
    /** What Telegram describes; by default every emoji asked about, as a WebP. */
    described?: TgCustomEmoji[];
  }

  /** Signed in, with a chat open showing these messages and their emoji settled. */
  async function emojiChat(messages: TgMessage[], options: EmojiOptions = {}, chatId = "1") {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true, ...options });
    if (options.premium) ctx.api.me.mockResolvedValue({ id: "9", name: "Me", bot: false, premium: true });
    if (options.described) ctx.api.customEmoji.mockImplementation(async (ids: string[]) => options.described!.filter((e) => ids.includes(e.id)));
    ctx.api.history.mockResolvedValue(messages);
    await ctx.adapter.start();
    await flush();
    await ctx.act({ type: "select", channelId: viewId(chatId) });
    await settle();
    return ctx;
  }
  type Ctx = Awaited<ReturnType<typeof emojiChat>>;
  const contents = (ctx: Ctx) => ctx.chat().channel!.messages.map((m) => m.content);

  it("shows custom emoji as their pictures once loaded, as their emoji until then", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.history.mockResolvedValue([withEmoji(1), withEmoji(2, "78")]);
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.openConversation("1");
    expect(ctx.chat().channel!.messages[0]!.content).toBe("a😀");
    expect(ctx.chat().emojiUrls).toBeUndefined();
    await settle();
    expect(contents(ctx)).toEqual(["a<:😀:77>", "a<:😀:78>"]);
    expect(ctx.chat().emojiUrls).toEqual({ "77": "data:image/webp;base64,aGk=", "78": "data:image/webp;base64,aGk=" });
    // Asked about once, newest first, in one request; the WebP itself loaded.
    expect(ctx.api.customEmoji).toHaveBeenCalledTimes(1);
    expect(ctx.api.customEmoji).toHaveBeenCalledWith(["78", "77"]);
    expect(ctx.api.customEmojiFile).toHaveBeenCalledWith("77", false);
    ctx.api.emit({ type: "message", message: withEmoji(3) });
    await settle();
    expect(contents(ctx).at(-1)).toBe("a<:😀:77>");
    expect(ctx.api.customEmoji).toHaveBeenCalledTimes(1);
    expect(ctx.api.customEmojiFile).toHaveBeenCalledTimes(2);
  });

  it("loads the still of animated and video emoji, and of static ones too large", async () => {
    const described: TgCustomEmoji[] = [
      { id: "1", emoji: "😀", format: "lottie" },
      { id: "2", emoji: "😀", format: "webm" },
      { id: "3", emoji: "😀", format: "webp", size: MAX_EMOJI_BYTES + 1 },
      { id: "4", emoji: "😀", format: "webp", size: 10 },
    ];
    const ctx = await emojiChat([withEmoji(1, "1"), withEmoji(2, "2"), withEmoji(3, "3"), withEmoji(4, "4")], { described });
    expect(Object.fromEntries(ctx.api.customEmojiFile.mock.calls)).toEqual({ "1": true, "2": true, "3": true, "4": false });
    expect(contents(ctx)).toEqual(["a<:😀:1>", "a<:😀:2>", "a<:😀:3>", "a<:😀:4>"]);
  });

  it("shows as their emoji those not described, without a picture, too large or past the budget, and asks once", async () => {
    const described: TgCustomEmoji[] = ["2", "3", "4", "5"].map((id) => ({ id, emoji: "😀", format: "webp" }));
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true, emojiBudget: 30 });
    ctx.api.customEmoji.mockImplementation(async (ids: string[]) => described.filter((e) => ids.includes(e.id)));
    ctx.api.customEmojiFile.mockImplementation(async (id: string) => (id === "2" ? undefined : id === "3" ? new Uint8Array(MAX_EMOJI_BYTES + 1) : new Uint8Array([104, 105])));
    ctx.api.history.mockResolvedValue(["1", "2", "3", "4", "5"].map((id, i) => withEmoji(i + 1, id)));
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.openConversation("1");
    await settle();
    // Newest first: the fifth's picture fits the budget, the fourth's no longer does.
    expect(contents(ctx)).toEqual(["a😀", "a😀", "a😀", "a😀", "a<:😀:5>"]);
    expect(ctx.chat().emojiUrls).toEqual({ "5": "data:image/webp;base64,aGk=" });
    ctx.api.emit({ type: "message", message: withEmoji(6, "4") });
    await settle();
    expect(ctx.api.customEmoji).toHaveBeenCalledTimes(1);
    expect(ctx.api.customEmojiFile).toHaveBeenCalledTimes(4);
  });

  it("shows emoji as their emoji for the session when Telegram cannot be asked", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.customEmoji.mockRejectedValue(new Error("offline"));
    ctx.api.history.mockResolvedValue([withEmoji(1)]);
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.openConversation("1");
    await settle();
    expect(contents(ctx)).toEqual(["a😀"]);
    ctx.api.emit({ type: "message", message: withEmoji(2) });
    await settle();
    expect(ctx.api.customEmoji).toHaveBeenCalledTimes(1);
  });

  it("shows an emoji whose picture fails to load as its emoji", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.customEmojiFile.mockRejectedValue(new Error("offline"));
    ctx.api.history.mockResolvedValue([withEmoji(1)]);
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.openConversation("1");
    await settle();
    expect(contents(ctx)).toEqual(["a😀"]);
    expect(ctx.api.customEmojiFile).toHaveBeenCalledTimes(1);
  });

  it("asks about at most EMOJI_LIMIT emoji a session, a batch at a time", async () => {
    // Five messages of 450 emoji each: more than the view takes.
    const many = Array.from({ length: 5 }, (_, m) => msg("1", m + 1, { text: "😀".repeat(450), entities: Array.from({ length: 450 }, (_, i) => ce(i * 2, String(m * 1000 + i + 1))) }));
    const ctx = await emojiChat(many);
    const asked = ctx.api.customEmoji.mock.calls.map((c) => c[0]);
    expect(asked.every((ids) => ids.length <= 200)).toBe(true);
    expect(new Set(asked.flat()).size).toBe(EMOJI_LIMIT);
    // The limit reached, a new emoji is not asked about.
    ctx.api.emit({ type: "message", message: withEmoji(9, "99999") });
    await settle();
    expect(ctx.api.customEmoji.mock.calls.flatMap((c) => c[0])).not.toContain("99999");
  });

  it("asks about emoji that show while a request is under way, after it", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    let answer: (found: TgCustomEmoji[]) => void = () => {};
    ctx.api.customEmoji.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    ctx.api.history.mockResolvedValue([withEmoji(1)]);
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.openConversation("1");
    await flush();
    ctx.api.emit({ type: "message", message: withEmoji(2, "78") });
    await flush();
    expect(ctx.api.customEmoji).toHaveBeenCalledTimes(1);
    answer([{ id: "77", emoji: "😀", format: "webp" }]);
    await settle();
    expect(ctx.api.customEmoji).toHaveBeenLastCalledWith(["78"]);
    expect(contents(ctx)).toEqual(["a<:😀:77>", "a<:😀:78>"]);
  });

  it("drops what arrives for a session that ended", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    let answer: (found: TgCustomEmoji[]) => void = () => {};
    ctx.api.customEmoji.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    ctx.api.history.mockResolvedValue([withEmoji(1)]);
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.openConversation("1");
    await flush();
    await ctx.adapter.signOut();
    answer([{ id: "77", emoji: "😀", format: "webp" }]);
    await settle();
    expect(ctx.api.customEmojiFile).not.toHaveBeenCalled();

    let picture: (bytes: Uint8Array) => void = () => {};
    const other = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    other.api.customEmojiFile.mockImplementationOnce(() => new Promise((resolve) => (picture = resolve)));
    other.api.history.mockResolvedValue([withEmoji(1)]);
    await other.adapter.start();
    await flush();
    await other.adapter.openConversation("1");
    await flush();
    expect(other.api.customEmojiFile).toHaveBeenCalledTimes(1);
    await other.adapter.signOut();
    await settle();
    const renders = other.renders.length;
    picture(new Uint8Array([1]));
    await settle();
    expect(other.renders.length).toBe(renders);
  });

  it("shows custom emoji reactions as their pictures, named by their emoji", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.history.mockResolvedValue([msg("1", 5, { reactions: [{ emoji: "custom:77", count: 2, chosen: true }, { emoji: "👍", count: 1, chosen: false }] })]);
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.openConversation("1");
    expect(ctx.chat().channel!.messages[0]!.reactions[0]).toEqual({ key: "custom:77", label: "Custom emoji", count: 2, me: true });
    await settle();
    expect(ctx.chat().channel!.messages[0]!.reactions).toEqual([
      { key: "custom:77", label: "😀", count: 2, me: true, imageUrl: "data:image/webp;base64,aGk=" },
      { key: "👍", label: "👍", count: 1, me: false },
    ]);
    expect(ctx.chat().emojiUrls).toEqual({ "77": "data:image/webp;base64,aGk=" });
  });

  it("takes back a custom emoji reaction, and gives one only with Premium where the chat takes it", async () => {
    const reacted = () => [msg("1", 5, { reactions: [{ emoji: "custom:77", count: 1, chosen: true }] })];
    const free = await emojiChat(reacted());
    await free.act({ type: "react", messageId: "5", emoji: "custom:78", add: true });
    expect(free.chat().error).toBe("Reacting with custom emoji takes Telegram Premium.");
    await free.act({ type: "react", messageId: "5", emoji: "custom:77", add: false });
    expect(free.api.react).toHaveBeenCalledWith("1", 5, []);

    const premium = await emojiChat(reacted(), { premium: true });
    await premium.act({ type: "react", messageId: "5", emoji: "custom:78", add: true });
    expect(premium.api.react).toHaveBeenCalledWith("1", 5, ["custom:77", "custom:78"]);

    const groups = [dlg("-5", { kind: "group", title: "G" }), dlg("-6", { kind: "group", title: "H" })];
    const group = await emojiChat([], { premium: true, dialogs: groups }, "-6");
    group.api.history.mockResolvedValue([msg("-5", 5)]);
    group.api.allowedReactions.mockResolvedValue({ kind: "some", emoji: ["custom:78"] });
    await group.act({ type: "select", channelId: viewId("-5") });
    await settle();
    await group.act({ type: "react", messageId: "5", emoji: "custom:79", add: true });
    expect(group.chat().error).toBe("This chat does not take this custom emoji as a reaction.");
    await group.act({ type: "react", messageId: "5", emoji: "custom:78", add: true });
    expect(group.api.react).toHaveBeenCalledWith("-5", 5, ["custom:78"]);
    // A group that takes every emoji but no custom ones.
    group.api.history.mockResolvedValue([msg("-6", 5)]);
    await group.act({ type: "select", channelId: viewId("-6") });
    await settle();
    await group.act({ type: "react", messageId: "5", emoji: "custom:78", add: true });
    expect(group.chat().error).toBe("This chat does not take this custom emoji as a reaction.");
  });
});

describe("sending custom emoji", () => {
  const ce = (offset: number, documentId: string) => ({ type: "customEmoji" as const, offset, length: 2, documentId });
  const settle = async () => {
    await flush();
    await vi.advanceTimersByTimeAsync(STICKER_RENDER_MS);
    await flush();
  };

  /** Signed in, a chat open whose messages show custom emoji 77 (free) and 78, so Telegram described them. */
  async function described(options: Options & { premium?: boolean } = {}, chatId = "1") {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true, ...options });
    if (options.premium) ctx.api.me.mockResolvedValue({ id: "9", name: "Me", bot: false, premium: true });
    ctx.api.customEmoji.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, emoji: "😀", format: "webp" as const, ...(id === "77" ? { free: true } : {}) })));
    ctx.api.history.mockResolvedValue([msg(chatId, 1, { text: "😀😀", entities: [ce(0, "77"), ce(2, "78")] })]);
    await ctx.adapter.start();
    await flush();
    await ctx.act({ type: "select", channelId: viewId(chatId) });
    await settle();
    return ctx;
  }
  const emojiOf = (id: string, offset = 0) => ({ type: "customEmoji", offset, length: 2, documentId: id });

  it("sends custom emoji Telegram described as its own, with Premium", async () => {
    const ctx = await described({ premium: true });
    await ctx.act({ type: "send", content: "<:😀:78> hi <:😀:99>" });
    // One never described goes as its emoji.
    expect(ctx.api.send).toHaveBeenCalledWith("1", { text: "😀 hi 😀", entities: [emojiOf("78")] }, undefined, undefined);
    await ctx.act({ type: "edit", messageId: "1", content: "<:😀:77>" });
    expect(ctx.api.edit).toHaveBeenCalledWith("1", 1, { text: "😀", entities: [emojiOf("77")] });
  });

  it("sends only free custom emoji without Premium, except in Saved Messages", async () => {
    const ctx = await described();
    await ctx.act({ type: "send", content: "<:😀:77><:😀:78>" });
    expect(ctx.api.send).toHaveBeenLastCalledWith("1", { text: "😀😀", entities: [emojiOf("77")] }, undefined, undefined);
    const saved = await described({ dialogs: [dlg("9", { title: "Saved Messages" })] }, "9");
    await saved.act({ type: "send", content: "<:😀:77><:😀:78>" });
    expect(saved.api.send).toHaveBeenLastCalledWith("9", { text: "😀😀", entities: [emojiOf("77"), emojiOf("78", 2)] }, undefined, undefined);
  });

  it("keeps custom emoji in what the user edits, before their pictures load", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.customEmojiFile.mockImplementation(() => new Promise(() => {}));
    ctx.api.history.mockResolvedValue([msg("1", 1, { out: true, text: "a😀", entities: [{ type: "bold", offset: 0, length: 1 }, ce(1, "77")] })]);
    await ctx.adapter.start();
    await flush();
    await ctx.adapter.openConversation("1");
    await settle();
    expect(ctx.chat().channel!.messages[0]).toMatchObject({ content: "**a**😀", source: "**a**<:😀:77>" });
  });
});

describe("custom emoji in the picker", () => {
  const settle = async () => {
    await flush();
    await vi.advanceTimersByTimeAsync(STICKER_RENDER_MS);
    await flush();
  };
  const cat: TgCustomEmoji = { id: "101", emoji: "😺", format: "webp" };
  const free: TgCustomEmoji = { id: "102", emoji: "😀", format: "lottie", free: true };

  interface PickerOptions extends Options {
    premium?: boolean;
    sets?: Record<string, TgCustomEmoji[]>;
  }

  /** Signed in with these emoji sets (by id, titled "Set <id>"), a chat open and the picker open. */
  async function pickerChat(options: PickerOptions = {}, chatId = "1") {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true, ...options });
    if (options.premium) ctx.api.me.mockResolvedValue({ id: "9", name: "Me", bot: false, premium: true });
    const sets = options.sets ?? { "31": [cat, free] };
    ctx.api.emojiSets.mockResolvedValue(Object.keys(sets).map((id) => ({ id, title: `Set ${id}` })));
    ctx.api.emojiSet.mockImplementation(async (id: string) => sets[id] ?? []);
    await ctx.adapter.start();
    await flush();
    await ctx.act({ type: "select", channelId: viewId(chatId) });
    await ctx.act({ type: "picker", open: true });
    await settle();
    await settle();
    return ctx;
  }
  type Ctx = Awaited<ReturnType<typeof pickerChat>>;
  const offered = (ctx: Ctx) => (ctx.chat().customEmoji ?? []).map((e) => e.id);

  it("offers the user's emoji sets with Premium, each emoji once its picture loaded, only while the picker is open", async () => {
    const ctx = await pickerChat({ premium: true, sets: { "31": [cat, { id: "103", emoji: "", format: "webp" }], "32": [], "33": [free] } });
    expect(ctx.chat().customEmoji).toEqual([
      { id: "101", name: "😺", animated: false, url: "data:image/webp;base64,aGk=", source: "Set 31", text: "<:😺:101>", key: "custom:101", react: true },
      { id: "102", name: "😀", animated: false, url: "data:image/webp;base64,aGk=", source: "Set 33", text: "<:😀:102>", key: "custom:102", react: true },
    ]);
    // The WebP for static emoji, the still for animated ones; an emoji without an emoji of its own is left out.
    expect(Object.fromEntries(ctx.api.customEmojiFile.mock.calls)).toEqual({ "101": false, "102": true });
    await ctx.act({ type: "picker", open: false });
    expect(ctx.chat().customEmoji).toBeUndefined();
    await ctx.act({ type: "picker", open: true });
    expect(offered(ctx)).toEqual(["101", "102"]);
    expect(ctx.api.emojiSets).toHaveBeenCalledTimes(1);
    // Picked, it goes as Telegram's own custom emoji.
    await ctx.act({ type: "send", content: "<:😺:101>" });
    expect(ctx.api.send).toHaveBeenCalledWith("1", { text: "😺", entities: [{ type: "customEmoji", offset: 0, length: 2, documentId: "101" }] }, undefined, undefined);
  });

  it("offers only free emoji without Premium, except in Saved Messages, and reactions with none of them", async () => {
    const ctx = await pickerChat();
    expect(offered(ctx)).toEqual(["102"]);
    expect(ctx.chat().customEmoji![0]!.react).toBe(false);
    const saved = await pickerChat({ dialogs: [dlg("9", { title: "Saved Messages" })] }, "9");
    expect(offered(saved)).toEqual(["101", "102"]);
  });

  it("offers nothing where the user may not write, nor in a forum's topic list", async () => {
    const channel = await pickerChat({ premium: true, dialogs: [dlg("-1007", { kind: "channel", title: "News", readOnly: true })] }, "-1007");
    expect(channel.chat().customEmoji).toBeUndefined();
    expect(channel.api.customEmojiFile).not.toHaveBeenCalled();
    const forum = await pickerChat({ premium: true, dialogs: [dlg("-1008", { kind: "group", title: "Forum", forum: true })] }, "-1008");
    expect(forum.chat().customEmoji).toBeUndefined();
  });

  it("follows the chat's rules for reacting with them", async () => {
    const ctx = await pickerChat({ premium: true, dialogs: [dlg("-5", { kind: "group", title: "G" })] }, "-5");
    expect(ctx.api.allowedReactions).toHaveBeenCalledWith("-5");
    // The fake group takes every emoji, but no custom ones.
    expect(ctx.chat().customEmoji!.map((e) => e.react)).toEqual([false, false]);
  });

  it("asks for the sets again when Telegram did not list them, and leaves out a set that fails", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    ctx.api.me.mockResolvedValue({ id: "9", name: "Me", bot: false, premium: true });
    ctx.api.emojiSets.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([{ id: "31", title: "Cats" }, { id: "32", title: "Dogs" }]);
    ctx.api.emojiSet.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([cat]);
    await ctx.adapter.start();
    await flush();
    await ctx.act({ type: "select", channelId: "1" });
    await ctx.act({ type: "picker", open: true });
    await settle();
    expect(ctx.chat().customEmoji).toBeUndefined();
    await ctx.act({ type: "picker", open: false });
    await ctx.act({ type: "picker", open: true });
    await settle();
    await settle();
    expect(ctx.api.emojiSets).toHaveBeenCalledTimes(2);
    expect(ctx.chat().customEmoji!.map((e) => e.source)).toEqual(["Dogs"]);
  });

  it("fetches at most EMOJI_SET_LIMIT sets and PICKER_EMOJI_LIMIT emoji", async () => {
    const emoji = (set: number, count: number) => Array.from({ length: count }, (_, i): TgCustomEmoji => ({ id: String(set * 1000 + i), emoji: "😀", format: "webp" }));
    const many = Object.fromEntries(Array.from({ length: EMOJI_SET_LIMIT + 10 }, (_, i) => [String(i + 1), emoji(i + 1, 1)]));
    const ctx = await pickerChat({ premium: true, sets: many });
    expect(ctx.api.emojiSet).toHaveBeenCalledTimes(EMOJI_SET_LIMIT);
    const large = await pickerChat({ premium: true, sets: { "1": emoji(1, 300), "2": emoji(2, 300), "3": emoji(3, 1) } });
    expect(large.api.emojiSet).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 200; i++) await settle();
    expect(large.chat().customEmoji).toHaveLength(PICKER_EMOJI_LIMIT);
  });

  it("drops sets that arrive for a session that ended", async () => {
    vi.useFakeTimers();
    const ctx = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    let list: (sets: TgStickerSet[]) => void = () => {};
    ctx.api.emojiSets.mockImplementationOnce(() => new Promise((resolve) => (list = resolve)));
    await ctx.adapter.start();
    await flush();
    await ctx.act({ type: "select", channelId: "1" });
    await ctx.act({ type: "picker", open: true });
    await ctx.adapter.signOut();
    list([{ id: "31", title: "Cats" }]);
    await settle();
    expect(ctx.api.emojiSet).not.toHaveBeenCalled();

    const other = setup({ secrets: { api: CREDS_JSON, session: "old" }, authorized: true });
    let set: (emoji: TgCustomEmoji[]) => void = () => {};
    other.api.emojiSets.mockResolvedValue([{ id: "31", title: "Cats" }, { id: "32", title: "Dogs" }]);
    other.api.emojiSet.mockImplementationOnce(() => new Promise((resolve) => (set = resolve)));
    await other.adapter.start();
    await flush();
    await other.act({ type: "select", channelId: "1" });
    await other.act({ type: "picker", open: true });
    await flush();
    await other.adapter.signOut();
    set([cat]);
    await settle();
    expect(other.api.emojiSet).toHaveBeenCalledTimes(1);
  });
});
