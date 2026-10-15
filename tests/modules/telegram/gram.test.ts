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
    "PeerUser", "PeerChat", "PeerChannel", "Message", "MessageReplyHeader", "User", "Chat", "Channel", "ChatForbidden", "PeerNotifySettings",
    "Photo", "PhotoSize", "PhotoSizeProgressive", "DocumentAttributeImageSize", "DocumentAttributeAnimated",
    "UserStatusOnline", "UserStatusRecently", "UserStatusOffline", "ChatFull", "ChatParticipants", "ChatParticipantsForbidden", "ChatParticipant", "ChatParticipantAdmin",
    "ChatParticipantCreator", "ChannelFull", "ChannelParticipant", "ChannelParticipantAdmin", "ChannelParticipantCreator", "ChannelParticipantsRecent", "ChannelParticipantsAdmins",
    "MessageEntityBold", "MessageEntityItalic", "MessageEntityUnderline", "MessageEntityStrike", "MessageEntitySpoiler", "MessageEntityCode", "MessageEntityPre",
    "MessageEntityTextUrl", "MessageEntityBlockquote", "MessageEntityMention",
  ];
  const Api: Record<string, unknown> = {
    auth: { SignIn: class extends Base {}, AuthorizationSignUpRequired: class extends Base {}, CheckPassword: class extends Base {}, LogOut: class extends Base {} },
    account: { GetPassword: class extends Base {} },
    messages: { ReadMentions: class extends Base {}, GetFullChat: class extends Base {} },
    channels: { GetFullChannel: class extends Base {}, GetParticipants: class extends Base {}, ChannelParticipants: class extends Base {} },
    users: { GetFullUser: class extends Base {} },
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
    getInputEntity = vi.fn(async (peer: unknown) => ({ input: peer }));
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

import { apiEntities, chatIdOf, createGramApi, describeChat, entitiesOf, mediaFile, mediaLabel, membersOf, presenceOf, SAVED_MESSAGES, toMessage } from "../../../src/modules/telegram/gram";

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

describe("chatIdOf", () => {
  it("marks ids as GramJS does: users plain, basic groups negative, supergroups and channels with -100", () => {
    expect(chatIdOf(make(Api.PeerUser, { userId: 42n }))).toBe("42");
    expect(chatIdOf(make(Api.PeerChat, { chatId: 7n }))).toBe("-7");
    expect(chatIdOf(make(Api.PeerChannel, { channelId: 1234567890n }))).toBe("-1001234567890");
    expect(chatIdOf(undefined)).toBeUndefined();
    expect(chatIdOf({} as never)).toBeUndefined();
  });
});

describe("describeChat", () => {
  const rights = (props: Record<string, unknown>) => props;

  it("describes users, bots and the chat with yourself", () => {
    expect(describeChat(make(Api.User, { firstName: "Ana", bot: true }))).toEqual({ kind: "user", title: "Ana", bot: true, readOnly: false, members: false });
    expect(describeChat(make(Api.User, { firstName: "Me", self: true }))).toEqual({ kind: "user", title: SAVED_MESSAGES, bot: false, readOnly: false, members: false });
  });

  it("describes basic groups, read-only when left or when members may not write", () => {
    expect(describeChat(make(Api.Chat, { title: "Family" }))).toEqual({ kind: "group", title: "Family", bot: false, readOnly: false, members: true });
    expect(describeChat(make(Api.Chat, { title: "" }))).toMatchObject({ title: "Group" });
    expect(describeChat(make(Api.Chat, { title: "Old", left: true }))).toMatchObject({ readOnly: true, members: false });
    expect(describeChat(make(Api.Chat, { title: "Quiet", defaultBannedRights: rights({ sendMessages: true }) }))).toMatchObject({ readOnly: true });
    expect(describeChat(make(Api.Chat, { title: "Quiet", defaultBannedRights: rights({ sendPlain: true }), adminRights: {} }))).toMatchObject({ readOnly: false });
    expect(describeChat(make(Api.Chat, { title: "Quiet", defaultBannedRights: rights({ sendMessages: true }), creator: true }))).toMatchObject({ readOnly: false });
  });

  it("leaves out groups that moved into a supergroup, and chats the user can no longer open", () => {
    expect(describeChat(make(Api.Chat, { title: "Moved", deactivated: true }))).toBeUndefined();
    expect(describeChat(make(Api.Chat, { title: "Moved", migratedTo: {} }))).toBeUndefined();
    expect(describeChat(make(Api.ChatForbidden, { title: "Gone" }))).toBeUndefined();
    expect(describeChat(undefined)).toBeUndefined();
  });

  it("describes broadcast channels, open only to their posting admins", () => {
    expect(describeChat(make(Api.Channel, { title: "News", broadcast: true }))).toEqual({ kind: "channel", title: "News", bot: false, readOnly: true, members: false });
    expect(describeChat(make(Api.Channel, { title: "", broadcast: true, creator: true }))).toEqual({ kind: "channel", title: "Channel", bot: false, readOnly: false, members: true });
    expect(describeChat(make(Api.Channel, { title: "News", adminRights: { postMessages: true } }))).toMatchObject({ readOnly: false, members: true });
    expect(describeChat(make(Api.Channel, { title: "News", adminRights: { editMessages: true } }))).toMatchObject({ readOnly: true });
  });

  it("describes supergroups as groups, read-only when left, banned, silenced or a broadcast group", () => {
    const group = (props: Record<string, unknown>) => describeChat(make(Api.Channel, { title: "Club", megagroup: true, ...props }));
    expect(group({})).toEqual({ kind: "group", title: "Club", bot: false, readOnly: false, members: true });
    expect(group({ left: true })).toMatchObject({ readOnly: true, members: false });
    expect(group({ bannedRights: rights({ sendMessages: true }) })).toMatchObject({ readOnly: true });
    expect(group({ defaultBannedRights: rights({ sendPlain: true }) })).toMatchObject({ readOnly: true });
    expect(group({ gigagroup: true })).toMatchObject({ readOnly: true });
    expect(group({ gigagroup: true, adminRights: {} })).toMatchObject({ readOnly: false });
    expect(group({ defaultBannedRights: rights({ sendMessages: true }), creator: true })).toMatchObject({ readOnly: false });
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

  it("names the sender of group and channel messages, and says when the user is mentioned", () => {
    const inGroup = (props: Record<string, unknown>) => toMessage(make(Api.Message, { ...base, peerId: make(Api.PeerChannel, { channelId: 1n }), ...props }), "-1001");
    expect(inGroup({ sender: make(Api.User, { firstName: "Ana" }), mentioned: true })).toMatchObject({ sender: "Ana", mentioned: true });
    expect(inGroup({ sender: make(Api.Channel, { title: "News" }) })).toMatchObject({ sender: "News" });
    expect(inGroup({ sender: make(Api.Chat, { title: "" }), postAuthor: "Bo" })).toMatchObject({ sender: "Bo" });
    expect(inGroup({ sender: {} })).not.toHaveProperty("sender");
    // In a private chat the chat names the sender.
    const direct = toMessage(make(Api.Message, { ...base, peerId: make(Api.PeerUser, { userId: 9n }), sender: make(Api.User, { firstName: "Ana" }) }), "9");
    expect(direct).not.toHaveProperty("sender");
    expect(direct).not.toHaveProperty("mentioned");
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

  it("lists one-to-one chats, groups and channels, with titles, counts, mutes and last messages", async () => {
    const last = make(Api.Message, { id: 9, date: 50, message: "yo" });
    const settings = (props: Record<string, unknown>) => ({ dialog: { notifySettings: make(Api.PeerNotifySettings, props) } });
    const none = { dialog: {} };
    client.getDialogs.mockResolvedValue([
      { ...none, id: 1n, unreadCount: 2, unreadMentionsCount: 0, date: 100, message: last, entity: make(Api.User, { firstName: "Ana", bot: true }) },
      { ...settings({ muteUntil: 2147483647 }), id: 2n, unreadCount: 0, unreadMentionsCount: 0, date: 90, entity: make(Api.User, { username: "bo" }) },
      { ...settings({ muteUntil: 0 }), id: -7n, unreadCount: 3, unreadMentionsCount: 1, date: 85, entity: make(Api.Chat, { title: "Family" }) },
      { ...none, id: -1001234567890n, unreadCount: 2_000_000, unreadMentionsCount: -1, date: 80, entity: make(Api.Channel, { title: "News", broadcast: true }) },
      { ...none, id: 3n, unreadCount: 0, unreadMentionsCount: 0, date: 75, entity: {} },
      { ...none, id: 4n, unreadCount: 0, unreadMentionsCount: 0, date: 70, entity: make(Api.ChatForbidden) },
      { ...none, id: undefined, unreadCount: 0, unreadMentionsCount: 0, date: 60, entity: make(Api.User) },
      { ...none, id: 10n ** 19n, unreadCount: 0, unreadMentionsCount: 0, date: 50, entity: make(Api.User) },
    ]);
    await expect(api.dialogs(20)).resolves.toEqual([
      { chatId: "1", kind: "user", title: "Ana", bot: true, unreadCount: 2, unreadMentions: 0, date: 100, lastMessage: toMessage(last, "1") },
      { chatId: "2", kind: "user", title: "@bo", bot: false, unreadCount: 0, unreadMentions: 0, date: 90, mutedUntil: 2147483647 },
      { chatId: "-7", kind: "group", title: "Family", bot: false, unreadCount: 3, unreadMentions: 1, date: 85, members: true },
      { chatId: "-1001234567890", kind: "channel", title: "News", bot: false, unreadCount: 1_000_000, unreadMentions: 0, date: 80, readOnly: true },
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

  it("sends and edits with their formatting as entities, never parsing the text", async () => {
    client.sendMessage.mockResolvedValue(make(Api.Message, { id: 1, date: 1, out: true, message: "a" }));
    await expect(api.send("7", { text: "a", entities: [{ type: "bold", offset: 0, length: 1 }] }, 4)).resolves.toMatchObject({ id: 1, chatId: "7", out: true });
    const sent = client.sendMessage.mock.calls[0]! as unknown as [bigint, { message: string; replyTo: number; formattingEntities: unknown[] }];
    expect(sent[0]).toBe(7n);
    expect(sent[1]).toMatchObject({ message: "a", replyTo: 4 });
    expect(sent[1].formattingEntities[0]).toBeInstanceOf(Api.MessageEntityBold);

    client.editMessage.mockResolvedValue(make(Api.Message, { id: 1, date: 1, message: "b" }));
    await expect(api.edit("7", 1, { text: "b", entities: [] })).resolves.toMatchObject({ text: "b" });
    expect(client.editMessage).toHaveBeenCalledWith(7n, { message: 1, text: "b", formattingEntities: [] });
  });

  it("deletes for everyone and marks read", async () => {
    await expect(api.remove("7", [1, 2])).resolves.toBeUndefined();
    expect(client.deleteMessages).toHaveBeenCalledWith(7n, [1, 2], { revoke: true });
    await expect(api.markRead("7", 5)).resolves.toBeUndefined();
    expect(client.markAsRead).toHaveBeenCalledWith(7n, 5);
    expect(client.invoke).not.toHaveBeenCalled();
    // A group's mentions are read with it.
    await api.markRead("-1001234567890", 6);
    expect(client.markAsRead).toHaveBeenLastCalledWith(-1001234567890n, 6);
    const request = client.invoke.mock.calls[0]![0] as { peer: unknown };
    expect(request).toBeInstanceOf(Api.messages.ReadMentions);
    expect(request.peer).toEqual({ input: -1001234567890n });
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

    it("forwards messages and edits of private chats, groups and channels", () => {
      const { cb, newH, editH } = setup();
      const user = make(Api.PeerUser, { userId: 8n });
      newH(event(user));
      editH(event(user));
      newH(event(make(Api.PeerChat, { chatId: 1n })));
      editH(event(make(Api.PeerChannel, { channelId: 1234567890n })));
      newH(event(undefined));
      editH(event(undefined));
      expect(cb).toHaveBeenCalledTimes(4);
      expect(cb).toHaveBeenNthCalledWith(1, { type: "message", message: expect.objectContaining({ id: 4, chatId: "8" }) });
      expect(cb).toHaveBeenNthCalledWith(2, { type: "edit", message: expect.objectContaining({ chatId: "8" }) });
      expect(cb).toHaveBeenNthCalledWith(3, { type: "message", message: expect.objectContaining({ chatId: "-1" }) });
      expect(cb).toHaveBeenNthCalledWith(4, { type: "edit", message: expect.objectContaining({ chatId: "-1001234567890" }) });
    });

    it("forwards deletions, naming the supergroup or channel they happened in", () => {
      const { cb, delH } = setup();
      delH({ deletedIds: [1, 2] });
      delH({ peer: make(Api.PeerChannel, { channelId: 1234567890n }), deletedIds: [3] });
      delH({ peer: {}, deletedIds: [4] });
      expect(cb.mock.calls).toEqual([[{ type: "delete", ids: [1, 2] }], [{ type: "delete", chatId: "-1001234567890", ids: [3] }]]);
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

describe("members and profiles", () => {
  const user = (id: number, props: Record<string, unknown> = {}) => make(Api.User, { id: BigInt(id), firstName: `U${id}`, ...props });
  const part = (cls: unknown, id: number, props: Record<string, unknown> = {}) => make(cls as never, { userId: BigInt(id), ...props });

  it("maps user statuses to how recently they were online", () => {
    expect(presenceOf(make(Api.UserStatusOnline))).toBe("online");
    expect(presenceOf(make(Api.UserStatusRecently))).toBe("recently");
    expect(presenceOf(make(Api.UserStatusOffline))).toBe("offline");
    expect(presenceOf(undefined)).toBe("offline");
  });

  it("names a message's sending user, or the other side of a private chat", () => {
    const base = { id: 5, date: 1000, message: "hi" };
    expect(toMessage(make(Api.Message, { ...base, peerId: make(Api.PeerChat, { chatId: 1n }), fromId: make(Api.PeerUser, { userId: 7n }) }), "-1").senderId).toBe("7");
    expect(toMessage(make(Api.Message, { ...base, peerId: make(Api.PeerUser, { userId: 9n }) }), "9").senderId).toBe("9");
    expect(toMessage(make(Api.Message, { ...base, out: true, peerId: make(Api.PeerUser, { userId: 9n }) }), "9")).not.toHaveProperty("senderId");
    expect(toMessage(make(Api.Message, { ...base, peerId: make(Api.PeerChannel, { channelId: 1n }), fromId: make(Api.PeerChannel, { channelId: 1n }) }), "-1001")).not.toHaveProperty("senderId");
  });

  it("maps participants to members with their role, leaving out deleted and unknown users", () => {
    const users = [user(1, { status: make(Api.UserStatusOnline) }), user(2, { bot: true, username: "bot" }), user(3), user(4, { deleted: true }), {}];
    expect(
      membersOf(
        [part(Api.ChatParticipantCreator, 1), part(Api.ChannelParticipantAdmin, 2, { rank: "Helper" }), part(Api.ChatParticipantAdmin, 3, { rank: "" }), part(Api.ChatParticipant, 4), part(Api.ChatParticipant, 5), {}, undefined],
        users,
      ),
    ).toEqual([
      { id: "1", name: "U1", bot: false, presence: "online", role: "owner" },
      { id: "2", name: "U2", bot: true, presence: "offline", role: "admin", rank: "Helper" },
      { id: "3", name: "U3", bot: false, presence: "offline", role: "admin" },
    ]);
    expect(membersOf([part(Api.ChannelParticipantCreator, 1), part(Api.ChannelParticipant, 3)], users).map((m) => m.role)).toEqual(["owner", undefined]);
  });

  describe("through the client", () => {
    let client: InstanceType<typeof h.FakeClient>;
    let api: ReturnType<typeof createGramApi>;
    beforeEach(() => {
      api = createGramApi({ apiId: 1, apiHash: "h" }, "", { os: "linux", appVersion: "1" });
      client = h.FakeClient.instances.at(-1)!;
    });

    it("pages a basic group's members out of its full info", async () => {
      const participants = make(Api.ChatParticipants, { participants: [1, 2, 3].map((id) => part(Api.ChatParticipant, id)) });
      client.invoke.mockResolvedValue({ fullChat: make(Api.ChatFull, { participants }), users: [user(1), user(2), user(3)] });
      const first = await api.members("-7", 0, 2);
      expect(first).toEqual({ members: [expect.objectContaining({ id: "1" }), expect.objectContaining({ id: "2" })], total: 3, next: 2 });
      const request = client.invoke.mock.calls[0]![0] as { chatId: unknown };
      expect(request).toBeInstanceOf(Api.messages.GetFullChat);
      expect(request.chatId).toBe(7n);
      await expect(api.members("-7", 2, 2)).resolves.toEqual({ members: [expect.objectContaining({ id: "3" })], total: 3 });
      // A group the user is no longer in shows no members.
      client.invoke.mockResolvedValue({ fullChat: make(Api.ChatFull, { participants: make(Api.ChatParticipantsForbidden) }), users: [] });
      await expect(api.members("-7", 0, 2)).resolves.toEqual({ members: [], total: 0, hidden: true });
      client.invoke.mockResolvedValue({ fullChat: {}, users: [] });
      await expect(api.members("-7", 0, 2)).resolves.toMatchObject({ hidden: true });
    });

    it("lists a supergroup's admins first, then its recent members, a page at a time", async () => {
      const page = (ids: number[], parts: unknown[], count = 500) => make(Api.channels.ChannelParticipants, { count, participants: parts, users: ids.map((id) => user(id)) });
      client.invoke.mockImplementation(async (request: { filter?: unknown; offset?: number }) => {
        if (request instanceof Api.channels.GetFullChannel) return { fullChat: make(Api.ChannelFull, { canViewParticipants: true, participantsCount: 1234 }), users: [] };
        if (request.filter instanceof Api.ChannelParticipantsAdmins) return page([1], [part(Api.ChannelParticipantCreator, 1)]);
        return page([1, 2], [part(Api.ChannelParticipantCreator, 1), part(Api.ChannelParticipant, 2)]);
      });
      const first = await api.members("-1001234", 0, 2);
      expect(first.members.map((m) => [m.id, m.role])).toEqual([["1", "owner"], ["2", undefined]]);
      expect(first).toMatchObject({ total: 1234, next: 2 });
      const requests = client.invoke.mock.calls.map((c) => c[0] as { channel: unknown; offset: number; limit: number; hash: unknown; filter: unknown });
      expect(requests[0]).toBeInstanceOf(Api.channels.GetFullChannel);
      expect(requests[0]!.channel).toBe(-1001234n);
      expect(requests[1]).toMatchObject({ offset: 0, limit: 2, hash: 0n });
      expect(requests[1]!.filter).toBeInstanceOf(Api.ChannelParticipantsAdmins);
      expect(requests[2]!.filter).toBeInstanceOf(Api.ChannelParticipantsRecent);

      // Later pages ask for recent members only, and the last one says so.
      client.invoke.mockClear();
      client.invoke.mockResolvedValue(page([3], [part(Api.ChannelParticipant, 3)], 0));
      await expect(api.members("-1001234", 2, 2)).resolves.toEqual({ members: [expect.objectContaining({ id: "3" })], total: 0 });
      expect(client.invoke).toHaveBeenCalledTimes(1);
      expect(client.invoke.mock.calls[0]![0]).toMatchObject({ offset: 2 });
      client.invoke.mockResolvedValue({});
      await expect(api.members("-1001234", 2, 2)).resolves.toEqual({ members: [], total: 0 });
    });

    it("counts members from the page when the full info has none, and keeps admins when the recent page is unchanged", async () => {
      client.invoke.mockImplementation(async (request: { filter?: unknown }) => {
        if (request instanceof Api.channels.GetFullChannel) return { fullChat: make(Api.ChannelFull, { canViewParticipants: true }), users: [] };
        if (request.filter instanceof Api.ChannelParticipantsAdmins) return {};
        return make(Api.channels.ChannelParticipants, { count: 2_000_000_000, participants: [], users: [] });
      });
      await expect(api.members("-1001234", 0, 2)).resolves.toEqual({ members: [], total: 100_000_000 });
      client.invoke.mockImplementation(async (request: { filter?: unknown }) => {
        if (request instanceof Api.channels.GetFullChannel) return { fullChat: make(Api.ChannelFull, { canViewParticipants: true, participantsCount: 9 }), users: [] };
        if (request.filter instanceof Api.ChannelParticipantsAdmins) return make(Api.channels.ChannelParticipants, { count: 1, participants: [part(Api.ChannelParticipantAdmin, 1)], users: [user(1)] });
        return {};
      });
      await expect(api.members("-1001234", 0, 2)).resolves.toEqual({ members: [expect.objectContaining({ id: "1", role: "admin" })], total: 9 });
    });

    it("says when Telegram hides a supergroup's or channel's members", async () => {
      for (const fullChat of [make(Api.ChannelFull, { canViewParticipants: false }), make(Api.ChannelFull), {}]) {
        client.invoke.mockResolvedValue({ fullChat, users: [] });
        await expect(api.members("-1001234", 0, 50)).resolves.toEqual({ members: [], total: 0, hidden: true });
      }
    });

    it("fetches a profile: name, username, bio and presence, never more", async () => {
      client.invoke.mockResolvedValue({ fullUser: { about: "Hello", phone: "+31600000000" }, users: [user(8), user(7, { username: "ana", status: make(Api.UserStatusRecently), phone: "+31611111111" })] });
      await expect(api.profile("7")).resolves.toEqual({ id: "7", name: "U7", bot: false, presence: "recently", username: "@ana", about: "Hello" });
      const request = client.invoke.mock.calls[0]![0] as { id: unknown };
      expect(request).toBeInstanceOf(Api.users.GetFullUser);
      expect(request.id).toBe(7n);
      client.invoke.mockResolvedValue({ fullUser: {}, users: [] });
      await expect(api.profile("7")).resolves.toEqual({ id: "7", name: "Telegram user", bot: false, presence: "offline" });
    });
  });
});

describe("entities", () => {
  it("reads the formatting the view shows, as far as it fits the text", () => {
    const text = "bold link code";
    const entities = [
      make(Api.MessageEntityBold, { offset: 0, length: 4 }),
      make(Api.MessageEntityTextUrl, { offset: 5, length: 4, url: "https://x.org" }),
      make(Api.MessageEntityPre, { offset: 10, length: 4, language: "js" }),
      make(Api.MessageEntityPre, { offset: 10, length: 4, language: "" }),
      make(Api.MessageEntityItalic, { offset: 0, length: 1 }),
      make(Api.MessageEntityUnderline, { offset: 0, length: 1 }),
      make(Api.MessageEntityStrike, { offset: 0, length: 1 }),
      make(Api.MessageEntitySpoiler, { offset: 0, length: 1 }),
      make(Api.MessageEntityCode, { offset: 0, length: 1 }),
      make(Api.MessageEntityBlockquote, { offset: 0, length: 14 }),
      make(Api.MessageEntityTextUrl, { offset: 0, length: 1 }),
      // Mentions are plain text; ranges past the text, empty or malformed are dropped.
      make(Api.MessageEntityMention, { offset: 0, length: 1 }),
      make(Api.MessageEntityBold, { offset: 10, length: 5 }),
      make(Api.MessageEntityBold, { offset: -1, length: 2 }),
      make(Api.MessageEntityBold, { offset: 1, length: 0 }),
      make(Api.MessageEntityBold, { offset: "1", length: 1 }),
      undefined,
    ];
    expect(entitiesOf(entities, text)).toEqual([
      { type: "bold", offset: 0, length: 4 },
      { type: "textUrl", offset: 5, length: 4, url: "https://x.org" },
      { type: "pre", offset: 10, length: 4, language: "js" },
      { type: "pre", offset: 10, length: 4 },
      { type: "italic", offset: 0, length: 1 },
      { type: "underline", offset: 0, length: 1 },
      { type: "strike", offset: 0, length: 1 },
      { type: "spoiler", offset: 0, length: 1 },
      { type: "code", offset: 0, length: 1 },
      { type: "blockquote", offset: 0, length: 14 },
      { type: "textUrl", offset: 0, length: 1 },
    ]);
    expect(entitiesOf(undefined, text)).toEqual([]);
    expect(entitiesOf(Array.from({ length: 600 }, () => make(Api.MessageEntityBold, { offset: 0, length: 1 })), "x")).toHaveLength(500);
  });

  it("turns formatting into Telegram's entities", () => {
    const out = apiEntities([
      { type: "bold", offset: 0, length: 1 },
      { type: "textUrl", offset: 1, length: 2, url: "https://x.org" },
      { type: "textUrl", offset: 1, length: 2 },
      { type: "pre", offset: 3, length: 1, language: "py" },
      { type: "pre", offset: 3, length: 1 },
      { type: "blockquote", offset: 0, length: 4 },
    ]);
    expect(out.map((entity) => entity.constructor)).toEqual([Api.MessageEntityBold, Api.MessageEntityTextUrl, Api.MessageEntityTextUrl, Api.MessageEntityPre, Api.MessageEntityPre, Api.MessageEntityBlockquote]);
    expect(out.map((entity) => ({ ...entity }))).toEqual([
      { offset: 0, length: 1 },
      { offset: 1, length: 2, url: "https://x.org" },
      { offset: 1, length: 2, url: "" },
      { offset: 3, length: 1, language: "py" },
      { offset: 3, length: 1, language: "" },
      { offset: 0, length: 4 },
    ]);
  });

  it("gives messages their formatting", () => {
    const message = make(Api.Message, { id: 1, date: 1, message: "hi", entities: [make(Api.MessageEntityBold, { offset: 0, length: 2 })] });
    expect(toMessage(message, "9").entities).toEqual([{ type: "bold", offset: 0, length: 2 }]);
  });
});
