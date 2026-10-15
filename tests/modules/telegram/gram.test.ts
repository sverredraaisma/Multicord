import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class Base {
    constructor(props: Record<string, unknown> = {}) {
      Object.assign(this, props);
    }
  }
  const names = [
    "MessageMediaEmpty", "MessageMediaWebPage", "MessageMediaPhoto", "MessageMediaDocument", "Document",
    "DocumentAttributeSticker", "DocumentAttributeAudio", "DocumentAttributeVideo", "DocumentAttributeFilename",
    "MessageMediaGeo", "MessageMediaGeoLive", "MessageMediaVenue", "MessageMediaContact", "MessageMediaPoll",
    "PeerUser", "PeerChat", "Message", "MessageReplyHeader", "User",
    "Photo", "PhotoSize", "PhotoSizeProgressive", "DocumentAttributeImageSize", "DocumentAttributeAnimated",
  ];
  const Api: Record<string, unknown> = {
    auth: { SignIn: class extends Base {}, AuthorizationSignUpRequired: class extends Base {}, CheckPassword: class extends Base {}, LogOut: class extends Base {} },
    account: { GetPassword: class extends Base {} },
  };
  for (const name of names) Api[name] = class extends Base {};

  class FakeClient {
    static instances: FakeClient[] = [];
    connect = vi.fn(async () => true);
    checkAuthorization = vi.fn(async () => true);
    sendCode = vi.fn();
    invoke = vi.fn();
    getMe = vi.fn();
    getDialogs = vi.fn();
    getMessages = vi.fn();
    sendMessage = vi.fn();
    editMessage = vi.fn();
    deleteMessages = vi.fn(async () => []);
    markAsRead = vi.fn(async () => true);
    downloadProfilePhoto = vi.fn();
    downloadMedia = vi.fn();
    addEventHandler = vi.fn();
    setLogLevel = vi.fn();
    destroy = vi.fn(async () => undefined);
    constructor(
      public session: { save(): string },
      public apiId: number,
      public apiHash: string,
      public options: Record<string, unknown>,
    ) {
      FakeClient.instances.push(this);
    }
  }
  const eventClass = () => class { constructor(public args: unknown) {} };
  return { Base, Api, FakeClient, eventClass };
});

vi.mock("telegram", () => ({ Api: h.Api, TelegramClient: h.FakeClient }));
vi.mock("telegram/events/DeletedMessage", () => ({ DeletedMessage: h.eventClass() }));
vi.mock("telegram/events/EditedMessage", () => ({ EditedMessage: h.eventClass() }));
vi.mock("telegram/events/NewMessage", () => ({ NewMessage: h.eventClass() }));
vi.mock("telegram/extensions/Logger", () => ({ LogLevel: { ERROR: "error" } }));
vi.mock("telegram/Helpers", () => ({ returnBigInt: (value: string) => BigInt(value) }));
vi.mock("telegram/Password", () => ({ computeCheck: async (request: unknown, password: string) => ({ request, password }) }));
vi.mock("telegram/sessions/StringSession", () => ({
  StringSession: class {
    constructor(public value: string) {}
    save() {
      return `saved:${this.value}`;
    }
  },
}));

import { createGramApi, mediaFile, mediaLabel, toMessage, userChatId } from "../../../src/modules/telegram/gram";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Api = h.Api as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const make = (cls: new (props?: any) => any, props: Record<string, unknown> = {}) => new cls(props);

const document = (...attributes: unknown[]) => make(Api.MessageMediaDocument, { document: make(Api.Document, { attributes }) });

describe("mediaLabel", () => {
  it("has no label for nothing, empty media and link previews", () => {
    expect(mediaLabel(undefined)).toBeUndefined();
    expect(mediaLabel(make(Api.MessageMediaEmpty))).toBeUndefined();
    expect(mediaLabel(make(Api.MessageMediaWebPage))).toBeUndefined();
  });

  it("labels photos", () => {
    expect(mediaLabel(make(Api.MessageMediaPhoto))).toBe("📷 Photo");
  });

  it("labels documents by their attributes", () => {
    expect(mediaLabel(document(make(Api.DocumentAttributeSticker, { alt: "😀" })))).toBe("😀 Sticker");
    expect(mediaLabel(document(make(Api.DocumentAttributeSticker, { alt: "" })))).toBe("🙂 Sticker");
    expect(mediaLabel(document(make(Api.DocumentAttributeAudio, { voice: true })))).toBe("🎤 Voice message");
    expect(mediaLabel(document(make(Api.DocumentAttributeAudio)))).toBe("🎵 Audio");
    expect(mediaLabel(document(make(Api.DocumentAttributeVideo)))).toBe("🎥 Video");
    expect(mediaLabel(document(make(Api.DocumentAttributeFilename, { fileName: "a.pdf" })))).toBe("📎 a.pdf");
    expect(mediaLabel(document())).toBe("📎 File");
  });

  it("labels a document that did not arrive in full as a file", () => {
    expect(mediaLabel(make(Api.MessageMediaDocument, { document: undefined }))).toBe("📎 File");
  });

  it("labels locations, contacts and polls", () => {
    for (const cls of [Api.MessageMediaGeo, Api.MessageMediaGeoLive, Api.MessageMediaVenue]) expect(mediaLabel(make(cls))).toBe("📍 Location");
    expect(mediaLabel(make(Api.MessageMediaContact))).toBe("👤 Contact");
    expect(mediaLabel(make(Api.MessageMediaPoll))).toBe("📊 Poll");
  });

  it("falls back to a generic label", () => {
    expect(mediaLabel({} as never)).toBe("Attachment");
  });
});

describe("userChatId", () => {
  it("names the user of a private chat only", () => {
    expect(userChatId(make(Api.PeerUser, { userId: 42n }))).toBe("42");
    expect(userChatId(make(Api.PeerChat, { chatId: 7n }))).toBeUndefined();
    expect(userChatId(undefined)).toBeUndefined();
  });
});

describe("toMessage", () => {
  const base = { id: 5, date: 1000, message: "hi" };

  it("maps a plain message", () => {
    expect(toMessage(make(Api.Message, { ...base, out: true }), "9")).toEqual({ id: 5, chatId: "9", out: true, text: "hi", date: 1000, edited: false });
  });

  it("defaults missing text and out flag", () => {
    expect(toMessage(make(Api.Message, { id: 1, date: 2 }), "9")).toMatchObject({ out: false, text: "", edited: false });
  });

  it("is edited only with an edit date that is not hidden", () => {
    expect(toMessage(make(Api.Message, { ...base, editDate: 5 }), "9").edited).toBe(true);
    expect(toMessage(make(Api.Message, { ...base, editDate: 5, editHide: true }), "9").edited).toBe(false);
  });

  it("adds a media label and a reply id", () => {
    const message = make(Api.Message, { ...base, media: make(Api.MessageMediaPhoto), replyTo: make(Api.MessageReplyHeader, { replyToMsgId: 3 }) });
    expect(toMessage(message, "9")).toMatchObject({ media: "📷 Photo", replyToId: 3 });
  });

  it("ignores reply headers of other kinds and missing ids", () => {
    expect(toMessage(make(Api.Message, { ...base, replyTo: {} }), "9")).not.toHaveProperty("replyToId");
    expect(toMessage(make(Api.Message, { ...base, replyTo: make(Api.MessageReplyHeader) }), "9")).not.toHaveProperty("replyToId");
  });
});

describe("createGramApi", () => {
  const credentials = { apiId: 12, apiHash: "a".repeat(32) };
  let client: InstanceType<typeof h.FakeClient>;
  let api: ReturnType<typeof createGramApi>;

  beforeEach(() => {
    h.FakeClient.instances.length = 0;
    api = createGramApi(credentials, "old", { os: "linux", appVersion: "1.2.3" });
    client = h.FakeClient.instances[0]!;
  });

  it("creates the client over WSS with the given session and device info", () => {
    expect(client.apiId).toBe(12);
    expect(client.apiHash).toBe(credentials.apiHash);
    expect(client.options).toEqual({
      connectionRetries: 5,
      useWSS: true,
      deviceModel: "Multicord",
      systemVersion: "linux",
      appVersion: "1.2.3",
      langCode: "en",
      systemLangCode: "en",
    });
    expect(client.setLogLevel).toHaveBeenCalledWith("error");
    expect(api.session()).toBe("saved:old");
  });

  it("connects and checks authorization", async () => {
    await expect(api.connect()).resolves.toBeUndefined();
    expect(client.connect).toHaveBeenCalled();
    client.checkAuthorization.mockResolvedValue(false);
    await expect(api.authorized()).resolves.toBe(false);
  });

  it("sends a code and maps the result", async () => {
    client.sendCode.mockResolvedValue({ phoneCodeHash: "h", isCodeViaApp: true });
    await expect(api.sendCode("+31600000000")).resolves.toEqual({ hash: "h", viaApp: true });
    expect(client.sendCode).toHaveBeenCalledWith({ apiId: 12, apiHash: credentials.apiHash }, "+31600000000");
  });

  describe("signIn", () => {
    it("is done after a normal authorization", async () => {
      client.invoke.mockResolvedValue({});
      await expect(api.signIn("+1", "h", "123")).resolves.toEqual({ done: true });
      const request = client.invoke.mock.calls[0]![0];
      expect(request).toBeInstanceOf(Api.auth.SignIn);
      expect(request).toMatchObject({ phoneNumber: "+1", phoneCodeHash: "h", phoneCode: "123" });
    });

    it("asks to sign up when the number has no account", async () => {
      client.invoke.mockResolvedValue(make(Api.auth.AuthorizationSignUpRequired));
      await expect(api.signIn("+1", "h", "123")).resolves.toEqual({ signUp: true });
    });

    it("asks for the password, with its hint when there is one", async () => {
      client.invoke.mockRejectedValueOnce({ errorMessage: "SESSION_PASSWORD_NEEDED" }).mockResolvedValueOnce({ hint: "pet" });
      await expect(api.signIn("+1", "h", "123")).resolves.toEqual({ password: true, hint: "pet" });
      expect(client.invoke.mock.calls[1]![0]).toBeInstanceOf(Api.account.GetPassword);

      client.invoke.mockRejectedValueOnce({ errorMessage: "SESSION_PASSWORD_NEEDED" }).mockResolvedValueOnce({});
      await expect(api.signIn("+1", "h", "123")).resolves.toEqual({ password: true });
    });

    it("rethrows other errors", async () => {
      const error = { errorMessage: "PHONE_CODE_INVALID" };
      client.invoke.mockRejectedValue(error);
      await expect(api.signIn("+1", "h", "1")).rejects.toBe(error);
    });
  });

  it("checks the password against the account's SRP parameters", async () => {
    const request = { srp: true };
    client.invoke.mockResolvedValueOnce(request).mockResolvedValueOnce({});
    await api.checkPassword("secret");
    const check = client.invoke.mock.calls[1]![0];
    expect(check).toBeInstanceOf(Api.auth.CheckPassword);
    expect(check.password).toEqual({ request, password: "secret" });
  });

  it("names the user from their first and last name, username or a fallback", async () => {
    client.getMe.mockResolvedValue({ id: 1n, firstName: "Ana", lastName: "Li", bot: true });
    await expect(api.me()).resolves.toEqual({ id: "1", name: "Ana Li", bot: true });
    client.getMe.mockResolvedValue({ id: 2n, firstName: "Ana" });
    await expect(api.me()).resolves.toEqual({ id: "2", name: "Ana", bot: false });
    client.getMe.mockResolvedValue({ id: 3n, username: "ana" });
    await expect(api.me()).resolves.toMatchObject({ name: "@ana" });
    client.getMe.mockResolvedValue({ id: 4n });
    await expect(api.me()).resolves.toMatchObject({ name: "Telegram user" });
  });

  it("lists user dialogs only, with titles, bots and last messages", async () => {
    const last = make(Api.Message, { id: 9, date: 50, message: "yo" });
    client.getDialogs.mockResolvedValue([
      { isUser: true, id: 1n, title: "Ana", unreadCount: 2, date: 100, message: last, entity: make(Api.User, { bot: true }) },
      { isUser: true, id: 2n, title: "", unreadCount: 0, date: 90, entity: make(Api.User, { username: "bo" }) },
      { isUser: true, id: 3n, title: "", unreadCount: 0, date: 80, entity: {} },
      { isUser: false, id: 4n, title: "Group", unreadCount: 0, date: 70 },
      { isUser: true, id: undefined, title: "Ghost", unreadCount: 0, date: 60 },
    ]);
    await expect(api.dialogs(20)).resolves.toEqual([
      { chatId: "1", title: "Ana", bot: true, unreadCount: 2, date: 100, lastMessage: toMessage(last, "1") },
      { chatId: "2", title: "@bo", bot: false, unreadCount: 0, date: 90 },
      { chatId: "3", title: "Telegram user", bot: false, unreadCount: 0, date: 80 },
    ]);
    expect(client.getDialogs).toHaveBeenCalledWith({ limit: 20 });
  });

  it("returns history oldest first, skipping service messages", async () => {
    client.getMessages.mockResolvedValue([make(Api.Message, { id: 3, date: 3 }), {}, make(Api.Message, { id: 2, date: 2 })]);
    const page = await api.history("7", 10, 50);
    expect(page.map((m) => m.id)).toEqual([2, 3]);
    expect(client.getMessages).toHaveBeenCalledWith(7n, { limit: 50, offsetId: 10 });

    await api.history("7", undefined, 50);
    expect(client.getMessages).toHaveBeenLastCalledWith(7n, { limit: 50, offsetId: 0 });
  });

  it("sends and edits as plain text", async () => {
    client.sendMessage.mockResolvedValue(make(Api.Message, { id: 1, date: 1, out: true, message: "a" }));
    await expect(api.send("7", "a", 4)).resolves.toMatchObject({ id: 1, chatId: "7", out: true });
    expect(client.sendMessage).toHaveBeenCalledWith(7n, { message: "a", replyTo: 4, parseMode: false });

    client.editMessage.mockResolvedValue(make(Api.Message, { id: 1, date: 1, message: "b" }));
    await expect(api.edit("7", 1, "b")).resolves.toMatchObject({ text: "b" });
    expect(client.editMessage).toHaveBeenCalledWith(7n, { message: 1, text: "b", parseMode: false });
  });

  it("deletes for everyone and marks read", async () => {
    await expect(api.remove("7", [1, 2])).resolves.toBeUndefined();
    expect(client.deleteMessages).toHaveBeenCalledWith(7n, [1, 2], { revoke: true });
    await expect(api.markRead("7", 5)).resolves.toBeUndefined();
    expect(client.markAsRead).toHaveBeenCalledWith(7n, 5);
  });

  describe("avatar", () => {
    it("returns a data URL for a small picture", async () => {
      client.downloadProfilePhoto.mockResolvedValue(Buffer.from("abc"));
      await expect(api.avatar("7")).resolves.toBe(`data:image/jpeg;base64,${Buffer.from("abc").toString("base64")}`);
      expect(client.downloadProfilePhoto).toHaveBeenCalledWith(7n, { isBig: false });
    });

    it("returns nothing for missing, path, empty or oversized pictures", async () => {
      for (const photo of [undefined, "/tmp/x.jpg", Buffer.alloc(0), Buffer.alloc(140_001)]) {
        client.downloadProfilePhoto.mockResolvedValue(photo);
        await expect(api.avatar("7")).resolves.toBeUndefined();
      }
      client.downloadProfilePhoto.mockResolvedValue(Buffer.alloc(140_000));
      await expect(api.avatar("7")).resolves.toMatch(/^data:/);
    });
  });

  describe("onUpdate", () => {
    const setup = () => {
      const cb = vi.fn();
      api.onUpdate(cb);
      const [newH, editH, delH] = client.addEventHandler.mock.calls.map((c) => c[0] as (event: unknown) => void);
      return { cb, newH: newH!, editH: editH!, delH: delH! };
    };
    const event = (peerId: unknown) => ({ message: make(Api.Message, { id: 4, date: 4, message: "x", peerId }) });

    it("registers three handlers", () => {
      setup();
      expect(client.addEventHandler).toHaveBeenCalledTimes(3);
    });

    it("forwards messages and edits of private chats only", () => {
      const { cb, newH, editH } = setup();
      const user = make(Api.PeerUser, { userId: 8n });
      newH(event(user));
      editH(event(user));
      newH(event(make(Api.PeerChat, { chatId: 1n })));
      editH(event(undefined));
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenNthCalledWith(1, { type: "message", message: expect.objectContaining({ id: 4, chatId: "8" }) });
      expect(cb).toHaveBeenNthCalledWith(2, { type: "edit", message: expect.objectContaining({ chatId: "8" }) });
    });

    it("forwards deletions without a channel only", () => {
      const { cb, delH } = setup();
      delH({ deletedIds: [1, 2] });
      delH({ peer: {}, deletedIds: [3] });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ type: "delete", ids: [1, 2] });
    });
  });

  it("logs out and disconnects", async () => {
    await expect(api.logOut()).resolves.toBeUndefined();
    expect(client.invoke.mock.calls[0]![0]).toBeInstanceOf(Api.auth.LogOut);
    await expect(api.disconnect()).resolves.toBeUndefined();
    expect(client.destroy).toHaveBeenCalled();
  });
});

describe("mediaFile", () => {
  const doc = (props: Record<string, unknown>, ...attributes: unknown[]) => make(Api.MessageMediaDocument, { document: make(Api.Document, { attributes, ...props }) });

  it("describes photos by their largest size", () => {
    const photo = make(Api.Photo, { sizes: [make(Api.PhotoSize, { w: 90, h: 60, size: 900 }), make(Api.PhotoSizeProgressive, { w: 1280, h: 853, sizes: [100, 5000, 90000] })] });
    expect(mediaFile(make(Api.MessageMediaPhoto, { photo }))).toEqual({ kind: "image", name: "Photo", mime: "image/jpeg", width: 1280, height: 853, size: 90000 });
    expect(mediaFile(make(Api.MessageMediaPhoto, { photo: undefined }))).toEqual({ kind: "image", name: "Photo", mime: "image/jpeg", width: undefined, height: undefined, size: undefined });
  });

  it("describes documents by their attributes", () => {
    expect(mediaFile(doc({ mimeType: "image/webp", size: 5000 }, make(Api.DocumentAttributeSticker, { alt: "😀" }), make(Api.DocumentAttributeImageSize, { w: 512, h: 512 })))).toEqual({
      kind: "sticker", name: "😀 Sticker", mime: "image/webp", size: 5000, width: 512, height: 512,
    });
    expect(mediaFile(doc({ mimeType: "application/x-tgsticker" }, make(Api.DocumentAttributeSticker, { alt: "" })))).toMatchObject({ kind: "sticker", name: "🙂 Sticker", mime: "image/webp", thumbnailOnly: true });
    expect(mediaFile(doc({ mimeType: "video/webm" }, make(Api.DocumentAttributeSticker, { alt: "🎉" }), make(Api.DocumentAttributeVideo, { w: 512, h: 512 })))).toMatchObject({ kind: "sticker", mime: "video/webm", width: 512 });
    expect(mediaFile(doc({ mimeType: "audio/ogg", size: BigInt(4000) }, make(Api.DocumentAttributeAudio, { voice: true })))).toEqual({ kind: "audio", name: "Voice message", mime: "audio/ogg", size: 4000 });
    expect(mediaFile(doc({ mimeType: "audio/mpeg", size: { toJSNumber: () => 7 } }, make(Api.DocumentAttributeAudio, { performer: "Band", title: "Song" })))).toMatchObject({ name: "Band – Song", size: 7 });
    expect(mediaFile(doc({}, make(Api.DocumentAttributeAudio), make(Api.DocumentAttributeFilename, { fileName: "a.mp3" })))).toMatchObject({ name: "a.mp3" });
    expect(mediaFile(doc({}, make(Api.DocumentAttributeAudio)))).toMatchObject({ name: "Audio" });
    expect(mediaFile(doc({ mimeType: "video/mp4" }, make(Api.DocumentAttributeAnimated), make(Api.DocumentAttributeVideo, { w: 320, h: 240 })))).toMatchObject({ kind: "video", name: "GIF", loop: true, width: 320 });
    expect(mediaFile(doc({ mimeType: "video/mp4", size: -1 }, make(Api.DocumentAttributeVideo, { w: 1920, h: 1080, roundMessage: true })))).toEqual({ kind: "video", name: "Video message", mime: "video/mp4", size: undefined, width: 1920, height: 1080 });
    expect(mediaFile(doc({}, make(Api.DocumentAttributeVideo), make(Api.DocumentAttributeFilename, { fileName: "clip.mp4" })))).toMatchObject({ name: "clip.mp4" });
    expect(mediaFile(doc({}, make(Api.DocumentAttributeVideo)))).toMatchObject({ name: "Video" });
    expect(mediaFile(doc({ mimeType: "image/png" }, make(Api.DocumentAttributeFilename, { fileName: "s.png" })))).toMatchObject({ kind: "image", name: "s.png" });
    expect(mediaFile(doc({ mimeType: "image/png" }))).toMatchObject({ kind: "image", name: "Image" });
    expect(mediaFile(doc({ mimeType: "application/pdf", size: 10 }, make(Api.DocumentAttributeFilename, { fileName: "a.pdf" })))).toEqual({ kind: "file", name: "a.pdf", mime: "application/pdf", size: 10 });
    expect(mediaFile(doc({ mimeType: "" }))).toEqual({ kind: "file", name: "File", mime: undefined, size: undefined });
  });

  it("has nothing to show for other media", () => {
    expect(mediaFile(undefined)).toBeUndefined();
    expect(mediaFile(make(Api.MessageMediaGeo))).toBeUndefined();
    expect(mediaFile(make(Api.MessageMediaDocument, { document: undefined }))).toBeUndefined();
  });
});

describe("downloads", () => {
  it("downloads a message's media, or its largest thumbnail", async () => {
    const api = createGramApi({ apiId: 1, apiHash: "h" }, "", { os: "linux", appVersion: "1" });
    const client = h.FakeClient.instances.at(-1)!;
    const message = make(Api.Message, { id: 5, media: make(Api.MessageMediaDocument, { document: make(Api.Document, { attributes: [], thumbs: [{}, {}] }) }) });
    client.getMessages.mockResolvedValue([message]);
    client.downloadMedia.mockResolvedValue(new Uint8Array([1, 2]));
    expect(await api.download("42", 5, false)).toEqual(new Uint8Array([1, 2]));
    expect(client.downloadMedia).toHaveBeenLastCalledWith(message, {});
    await api.download("42", 5, true);
    expect(client.downloadMedia).toHaveBeenLastCalledWith(message, { thumb: 1 });
    client.getMessages.mockResolvedValue([make(Api.Message, { id: 6, media: make(Api.MessageMediaPhoto) })]);
    await api.download("42", 6, true);
    expect(client.downloadMedia).toHaveBeenLastCalledWith(expect.anything(), { thumb: 0 });
    client.downloadMedia.mockResolvedValue("a path");
    expect(await api.download("42", 6, false)).toBeUndefined();
    client.downloadMedia.mockResolvedValue(new Uint8Array());
    expect(await api.download("42", 6, false)).toBeUndefined();
    client.getMessages.mockResolvedValue([make(Api.Message, { id: 7 })]);
    expect(await api.download("42", 7, false)).toBeUndefined();
    client.getMessages.mockResolvedValue([undefined]);
    expect(await api.download("42", 8, false)).toBeUndefined();
  });
});
