import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class Base {
    constructor(props: Record<string, unknown> = {}) {
      Object.assign(this, props);
    }
  }
  const names = [
    "MessageMediaEmpty", "MessageMediaWebPage", "WebPage", "UpdatePinnedMessages", "UpdatePinnedChannelMessages", "InputMessagesFilterPinned", "Poll", "PollAnswer", "PollResults", "PollAnswerVoters", "UpdateMessagePoll", "MessageMediaPhoto", "MessageMediaDocument", "Document",
    "DocumentAttributeSticker", "DocumentAttributeAudio", "DocumentAttributeVideo", "DocumentAttributeFilename",
    "MessageMediaGeo", "MessageMediaGeoLive", "MessageMediaVenue", "MessageMediaContact", "MessageMediaPoll",
    "PeerUser", "PeerChat", "PeerChannel", "Message", "MessageReplyHeader", "User", "Chat", "Channel", "ChatForbidden", "PeerNotifySettings",
    "Photo", "PhotoSize", "PhotoSizeProgressive", "DocumentAttributeImageSize", "DocumentAttributeAnimated",
    "UserStatusOnline", "UserStatusRecently", "UserStatusOffline", "ChatFull", "ChatParticipants", "ChatParticipantsForbidden", "ChatParticipant", "ChatParticipantAdmin",
    "ChatParticipantCreator", "ChannelFull", "ChannelParticipant", "ChannelParticipantAdmin", "ChannelParticipantCreator", "ChannelParticipantsRecent", "ChannelParticipantsAdmins",
    "MessageEntityBold", "MessageEntityItalic", "MessageEntityUnderline", "MessageEntityStrike", "MessageEntitySpoiler", "MessageEntityCode", "MessageEntityPre",
    "MessageEntityTextUrl", "MessageEntityBlockquote", "MessageEntityMention",
    "ReactionEmoji", "ReactionCustomEmoji", "ReactionCount", "MessageReactions", "ChatReactionsNone", "ChatReactionsSome", "ChatReactionsAll", "UpdateMessageReactions",
    "UpdateUserTyping", "UpdateChatUserTyping", "UpdateChannelUserTyping", "SendMessageTypingAction", "SendMessageCancelAction", "SendMessageUploadPhotoAction",
    "SendMessageRecordVideoAction", "SendMessageUploadVideoAction", "SendMessageRecordAudioAction", "SendMessageUploadAudioAction", "SendMessageUploadDocumentAction",
    "SendMessageRecordRoundAction", "SendMessageUploadRoundAction", "SendMessageChooseStickerAction", "SendMessageEmojiInteraction",
    "InputFile", "InputFileBig", "InputMediaUploadedPhoto", "InputMediaUploadedDocument",
    "PhotoPathSize", "VideoSize", "StickerSet", "InputStickerSetID", "InputMediaDocument", "InputDocument",
    "ForumTopic", "ForumTopicDeleted", "MessageService", "Updates", "UpdatesCombined", "UpdateNewChannelMessage", "UpdateNewMessage", "MessageActionTopicCreate", "InputNotifyPeer", "InputPeerNotifySettings", "InputFolderPeer", "FolderPeer", "UpdateFolderPeers", "DialogFilter", "DialogFilterChatlist", "DialogFilterDefault", "InputPeerUser", "InputPeerChat", "InputPeerChannel", "InputPeerSelf", "UpdateDialogFilter", "UpdateDialogFilters", "UpdateDialogFilterOrder", "UpdateLoginToken", "InputMessagesFilterEmpty", "InputNotifyForumTopic",
    "InputNotifyUsers", "InputNotifyChats", "InputNotifyBroadcasts", "NotifyPeer", "NotifyUsers", "NotifyChats", "NotifyBroadcasts", "NotifyForumTopic", "UpdateNotifySettings",
  ];
  const Api: Record<string, unknown> = {
    auth: {
      SignIn: class extends Base {},
      AuthorizationSignUpRequired: class extends Base {},
      CheckPassword: class extends Base {},
      LogOut: class extends Base {},
      ExportLoginToken: class extends Base {},
      ImportLoginToken: class extends Base {},
      LoginToken: class extends Base {},
      LoginTokenMigrateTo: class extends Base {},
      LoginTokenSuccess: class extends Base {},
    },
    account: { GetPassword: class extends Base {}, UpdateNotifySettings: class extends Base {}, GetNotifySettings: class extends Base {} },
    messages: {
      ReadMentions: class extends Base {},
      GetFullChat: class extends Base {},
      SendReaction: class extends Base {},
      SetTyping: class extends Base {},
      ReadDiscussion: class extends Base {},
      GetAvailableReactions: class extends Base {},
      AvailableReactions: class extends Base {},
      GetAllStickers: class extends Base {},
      AllStickers: class extends Base {},
      GetStickerSet: class extends Base {},
      StickerSet: class extends Base {},
      GetRecentStickers: class extends Base {},
      RecentStickers: class extends Base {},
      GetFavedStickers: class extends Base {},
      FavedStickers: class extends Base {},
      UpdatePinnedMessage: class extends Base {},
      ForwardMessages: class extends Base {},
      SendVote: class extends Base {},
      GetDialogFilters: class extends Base {},
      Search: class extends Base {},
      DialogFilters: class extends Base {},
    },
    channels: {
      GetFullChannel: class extends Base {},
      GetParticipants: class extends Base {},
      ChannelParticipants: class extends Base {},
      GetForumTopics: class extends Base {},
      CreateForumTopic: class extends Base {},
    },
    users: { GetFullUser: class extends Base {} },
    folders: { EditPeerFolders: class extends Base {} },
    upload: { SaveFilePart: class extends Base {}, SaveBigFilePart: class extends Base {} },
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
    sendFile = vi.fn();
    editMessage = vi.fn();
    deleteMessages = vi.fn(async () => []);
    markAsRead = vi.fn(async () => true);
    getInputEntity = vi.fn(async (peer: unknown) => ({ input: peer }));
    getEntity = vi.fn();
    downloadProfilePhoto = vi.fn();
    downloadMedia = vi.fn();
    addEventHandler = vi.fn();
    setLogLevel = vi.fn();
    destroy = vi.fn(async () => undefined);
    _switchDC = vi.fn(async () => true);
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
vi.mock("telegram/events/Raw", () => ({ Raw: h.eventClass() }));
vi.mock("telegram/extensions/Logger", () => ({ LogLevel: { ERROR: "error" } }));
vi.mock("telegram/Helpers", () => ({
  returnBigInt: (value: string) => BigInt(value),
  generateRandomBytes: (count: number) => Buffer.alloc(count, 1),
  readBigIntFromBuffer: (buffer: Buffer) => BigInt(buffer.length * 1000),
}));
vi.mock("telegram/Password", () => ({ computeCheck: async (request: unknown, password: string) => ({ request, password }) }));
vi.mock("telegram/sessions/StringSession", () => ({
  StringSession: class {
    constructor(public value: string) {}
    save() {
      return `saved:${this.value}`;
    }
  },
}));

import { allowedOf, apiEntities, foldersOf, foundMessages, MAX_FOLDER_PEERS, chatIdOf, createGramApi, describeChat, entitiesOf, fileName, forumOf, mediaBanned, topicReply, topicsOf, UPLOAD_PART, uploadMedia, mediaFile, mediaLabel, membersOf, presenceOf, reactionsOf, SAVED_MESSAGES, stickerOf, stickersBanned, stickerSetsOf, thumbIndex, toMessage, typingOf, webPreview, pollOf, pollResultsOf } from "../../../src/modules/telegram/gram";

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

describe("polls", () => {
  const answer = (text: unknown, option: number) => make(Api.PollAnswer, { text, option: Buffer.from([option]) });
  const voters = (option: number, count: number, extra: Record<string, unknown> = {}) => make(Api.PollAnswerVoters, { option: Buffer.from([option]), voters: count, ...extra });

  it("reads a poll's question, answers and results", () => {
    const media = make(Api.MessageMediaPoll, {
      poll: make(Api.Poll, { id: 77n, question: { text: "Lunch?" }, answers: [answer({ text: "Pizza" }, 48), answer("Soup", 49), {}], multipleChoice: true }),
      results: make(Api.PollResults, { results: [voters(48, 3, { chosen: true }), voters(49, -2, { correct: true }), {}], totalVoters: 4 }),
    });
    expect(pollOf(media)).toEqual({
      id: "77",
      question: "Lunch?",
      answers: [{ option: "MA==", text: "Pizza" }, { option: "MQ==", text: "Soup" }],
      multiple: true,
      closed: false,
      quiz: false,
      results: { voters: [{ option: "MA==", votes: 3, chosen: true }, { option: "MQ==", votes: 0, correct: true }], total: 4, min: false },
    });
    expect(pollOf(make(Api.MessageMediaPoll, { poll: make(Api.Poll, { id: 1n, question: 5, answers: [], closed: true, quiz: true }) }))).toEqual({ id: "1", question: "", answers: [], multiple: false, closed: true, quiz: true });
    expect(pollOf(make(Api.MessageMediaPoll, { poll: {} }))).toBeUndefined();
    expect(pollOf(undefined)).toBeUndefined();
    expect(pollResultsOf(make(Api.PollResults, { min: true }))).toEqual({ voters: [], min: true });
    expect(pollResultsOf({})).toBeUndefined();
    expect(toMessage(make(Api.Message, { id: 1, date: 2, media }), "9").poll).toMatchObject({ id: "77" });
  });
});

describe("webPreview", () => {
  const photo = make(Api.Photo, { sizes: [make(Api.PhotoSize, { w: 8, h: 6, size: 50 })] });
  const page = (props: Record<string, unknown>) => make(Api.MessageMediaWebPage, { webpage: make(Api.WebPage, { url: "https://site/a", ...props }) });

  it("reads a page's site, title, description and photo", () => {
    expect(webPreview(page({ siteName: "Site", title: "T".repeat(300), description: "Words", photo }))).toEqual({
      url: "https://site/a",
      site: "Site",
      title: "T".repeat(256),
      description: "Words",
      photo: { kind: "image", name: "Photo", mime: "image/jpeg", width: 8, height: 6, size: 50 },
    });
    // A page's own video or file would download in the photo's place, so the photo is left out with it.
    expect(webPreview(page({ url: "http://plain", title: "Clip", photo, document: {} }))).toEqual({ title: "Clip" });
    expect(webPreview(page({ siteName: " ", description: "d", photo: {} }))).toEqual({ url: "https://site/a", description: "d" });
  });

  it("has nothing for other media, pending previews or empty ones", () => {
    expect(webPreview(undefined)).toBeUndefined();
    expect(webPreview(make(Api.MessageMediaPhoto))).toBeUndefined();
    expect(webPreview(make(Api.MessageMediaWebPage, { webpage: {} }))).toBeUndefined();
    expect(webPreview(page({ siteName: "Only a site" }))).toBeUndefined();
    expect(toMessage(make(Api.Message, { id: 1, date: 2, media: page({ title: "T" }) }), "9").preview).toEqual({ url: "https://site/a", title: "T" });
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
    expect(describeChat(make(Api.User, { firstName: "Ana", bot: true }))).toEqual({ kind: "user", title: "Ana", bot: true, readOnly: false, members: false, left: false });
    expect(describeChat(make(Api.User, { firstName: "Me", self: true }))).toEqual({ kind: "user", title: SAVED_MESSAGES, bot: false, readOnly: false, members: false, left: false });
  });

  it("describes basic groups, read-only when left or when members may not write", () => {
    expect(describeChat(make(Api.Chat, { title: "Family" }))).toEqual({ kind: "group", title: "Family", bot: false, readOnly: false, members: true, left: false });
    expect(describeChat(make(Api.Chat, { title: "" }))).toMatchObject({ title: "Group" });
    expect(describeChat(make(Api.Chat, { title: "Old", left: true }))).toMatchObject({ readOnly: true, members: false, left: true });
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
    expect(describeChat(make(Api.Channel, { title: "News", broadcast: true }))).toEqual({ kind: "channel", title: "News", bot: false, readOnly: true, members: false, left: false });
    expect(describeChat(make(Api.Channel, { title: "", broadcast: true, creator: true }))).toEqual({ kind: "channel", title: "Channel", bot: false, readOnly: false, members: true, left: false });
    expect(describeChat(make(Api.Channel, { title: "News", adminRights: { postMessages: true } }))).toMatchObject({ readOnly: false, members: true });
    expect(describeChat(make(Api.Channel, { title: "News", adminRights: { editMessages: true } }))).toMatchObject({ readOnly: true });
  });

  it("describes supergroups as groups, read-only when left, banned, silenced or a broadcast group", () => {
    const group = (props: Record<string, unknown>) => describeChat(make(Api.Channel, { title: "Club", megagroup: true, ...props }));
    expect(group({})).toEqual({ kind: "group", title: "Club", bot: false, readOnly: false, members: true, left: false });
    expect(group({ left: true })).toMatchObject({ readOnly: true, members: false, left: true });
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

  describe("qrLogin", () => {
    it("gives a token to show, until it is accepted", async () => {
      client.invoke.mockResolvedValue(make(Api.auth.LoginToken, { token: Buffer.from([1, 2]), expires: 99 }));
      await expect(api.qrLogin()).resolves.toEqual({ token: new Uint8Array([1, 2]), expires: 99 });
      expect(client.invoke.mock.calls[0]![0]).toBeInstanceOf(Api.auth.ExportLoginToken);
      expect(client.invoke.mock.calls[0]![0]).toMatchObject({ apiId: 12, apiHash: credentials.apiHash, exceptIds: [] });
      client.invoke.mockResolvedValue(make(Api.auth.LoginTokenSuccess, {}));
      await expect(api.qrLogin()).resolves.toEqual({ done: true });
    });

    it("follows the account to its data centre, and signs in there with the token it gives", async () => {
      client.invoke.mockResolvedValueOnce(make(Api.auth.LoginTokenMigrateTo, { dcId: 4, token: Buffer.from([7]) })).mockResolvedValueOnce(make(Api.auth.LoginTokenSuccess, {}));
      await expect(api.qrLogin()).resolves.toEqual({ done: true });
      expect(client._switchDC).toHaveBeenCalledWith(4);
      const imported = client.invoke.mock.calls[1]![0] as { token: Buffer };
      expect(imported).toBeInstanceOf(Api.auth.ImportLoginToken);
      expect(imported.token).toEqual(Buffer.from([7]));
    });

    it("asks for the password where the account has one, and refuses answers it does not know", async () => {
      client.invoke.mockRejectedValueOnce({ errorMessage: "SESSION_PASSWORD_NEEDED" }).mockResolvedValueOnce({ hint: "pet" });
      await expect(api.qrLogin()).resolves.toEqual({ password: true, hint: "pet" });
      client.invoke.mockResolvedValue({});
      await expect(api.qrLogin()).rejects.toThrow("Telegram did not answer the QR sign-in as expected");
      client.invoke.mockRejectedValue({ errorMessage: "AUTH_TOKEN_EXPIRED" });
      await expect(api.qrLogin()).rejects.toEqual({ errorMessage: "AUTH_TOKEN_EXPIRED" });
    });
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
      { dialog: { readInboxMaxId: 7 }, id: 1n, unreadCount: 2, unreadMentionsCount: 0, date: 100, message: last, entity: make(Api.User, { firstName: "Ana", bot: true }) },
      { ...settings({ muteUntil: 2147483647 }), id: 2n, unreadCount: 0, unreadMentionsCount: 0, date: 90, entity: make(Api.User, { username: "bo" }) },
      { ...settings({ muteUntil: 0 }), id: -7n, unreadCount: 3, unreadMentionsCount: 1, date: 85, entity: make(Api.Chat, { title: "Family", defaultBannedRights: { sendMedia: true } }) },
      { ...none, id: -1001234567890n, unreadCount: 2_000_000, unreadMentionsCount: -1, date: 80, entity: make(Api.Channel, { title: "News", broadcast: true, left: true }) },
      { ...none, id: 3n, unreadCount: 0, unreadMentionsCount: 0, date: 75, entity: {} },
      { ...none, id: 4n, unreadCount: 0, unreadMentionsCount: 0, date: 70, entity: make(Api.ChatForbidden) },
      { ...none, id: undefined, unreadCount: 0, unreadMentionsCount: 0, date: 60, entity: make(Api.User) },
      { ...none, id: 10n ** 19n, unreadCount: 0, unreadMentionsCount: 0, date: 50, entity: make(Api.User) },
    ]);
    await expect(api.dialogs(20)).resolves.toEqual({
      dialogs: [
        { chatId: "1", kind: "user", title: "Ana", bot: true, unreadCount: 2, unreadMentions: 0, date: 100, readUpTo: 7, lastMessage: toMessage(last, "1") },
        { chatId: "2", kind: "user", title: "@bo", bot: false, unreadCount: 0, unreadMentions: 0, date: 90, mutedUntil: 2147483647 },
        // Unmuted by its own setting (0), where "none" follows the defaults.
        { chatId: "-7", kind: "group", title: "Family", bot: false, unreadCount: 3, unreadMentions: 1, date: 85, mutedUntil: 0, members: true, noMedia: true, noStickers: true },
        { chatId: "-1001234567890", kind: "channel", title: "News", bot: false, unreadCount: 1_000_000, unreadMentions: 0, date: 80, readOnly: true, left: true },
      ],
    });
    expect(client.getDialogs).toHaveBeenCalledWith({ limit: 20 });
  });

  it("pages through dialogs after the last chat with a message", async () => {
    const entity = make(Api.User, { firstName: "A" });
    const row = (id: bigint, message?: unknown) => ({ dialog: {}, id, unreadCount: 0, unreadMentionsCount: 0, date: 1, entity, message });
    client.getDialogs.mockResolvedValue([row(1n, make(Api.Message, { id: 4, date: 40 })), row(-1002n, make(Api.Message, { id: 9, date: 30 })), row(3n)]);
    const page = await api.dialogs(3);
    expect(page.next).toEqual({ chatId: "-1002", id: 9, date: 30 });
    await api.dialogs(3, page.next);
    expect(client.getInputEntity).toHaveBeenCalledWith(-1002n);
    expect(client.getDialogs).toHaveBeenLastCalledWith({ limit: 3, offsetDate: 30, offsetId: 9, offsetPeer: { input: -1002n }, ignorePinned: true });
    // A page short of the limit is the last; so is one whose chats have no messages to page from, or ids not Telegram's.
    expect((await api.dialogs(4)).next).toBeUndefined();
    client.getDialogs.mockResolvedValue([row(1n), row(2n)]);
    expect((await api.dialogs(2)).next).toBeUndefined();
    client.getDialogs.mockResolvedValue([{ ...row(1n, make(Api.Message, { id: 1, date: 1 })), id: undefined }]);
    expect((await api.dialogs(1)).next).toBeUndefined();
  });

  it("lists a forum topic's pins and search results through Telegram's own search, which GramJS's drops the topic from", async () => {
    const ana = make(Api.User, { id: 4n, firstName: "Ana", username: "ana_b" });
    client.invoke.mockResolvedValue({ messages: [make(Api.Message, { id: 7, date: 7, fromId: make(Api.PeerUser, { userId: 4n }), peerId: make(Api.PeerChannel, { channelId: 5n }) })], users: [ana], chats: [] });
    const pinned = await api.pinned("-1005", 50, 10);
    expect(pinned).toEqual([expect.objectContaining({ id: 7, sender: "Ana", senderUsername: "ana_b", senderId: "4" })]);
    const request = client.invoke.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toBeInstanceOf(Api.messages.Search);
    expect(request).toMatchObject({ peer: -1005n, q: "", topMsgId: 10, limit: 50 });
    expect(request.filter).toBeInstanceOf(Api.InputMessagesFilterPinned);
    await api.search("-1005", "hi", 20, 1);
    const search = client.invoke.mock.calls[1]![0] as Record<string, unknown>;
    expect(search).toMatchObject({ q: "hi", topMsgId: 1, limit: 20 });
    expect(search.filter).toBeInstanceOf(Api.InputMessagesFilterEmpty);
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it("names the senders of raw search results from the users and chats listed with them", () => {
    const peerChannel = make(Api.PeerChannel, { channelId: 5n });
    const found = {
      messages: [
        make(Api.Message, { id: 1, date: 1, peerId: peerChannel }),
        make(Api.Message, { id: 2, date: 2, fromId: make(Api.PeerChat, { chatId: 6n }), peerId: peerChannel }),
        make(Api.Message, { id: 3, date: 3, fromId: make(Api.PeerUser, { userId: 9n }), peerId: peerChannel }),
        make(Api.MessageService, { id: 4 }),
        make(Api.Message, { id: 5, date: 5, peerId: {} }),
      ],
      users: [{}],
      chats: [make(Api.Channel, { id: 5n, title: "News" }), make(Api.Chat, { id: 6n, title: "Old group" }), {}],
    };
    expect(foundMessages(found, "-1005").map((m) => [m.id, m.sender])).toEqual([[1, "News"], [2, "Old group"], [3, undefined], [5, undefined]]);
    expect(foundMessages({}, "-1005")).toEqual([]);
  });

  it("lists pinned messages newest first, and pins and unpins quietly", async () => {
    client.getMessages.mockResolvedValue([make(Api.Message, { id: 3, date: 3, pinned: true }), {}, make(Api.Message, { id: 2, date: 2 })]);
    const pinned = await api.pinned("7", 50);
    expect(pinned.map((m) => [m.id, m.pinned])).toEqual([[3, true], [2, undefined]]);
    const options = client.getMessages.mock.calls[0]![1] as { limit: number; filter: unknown };
    expect(options.limit).toBe(50);
    expect(options.filter).toBeInstanceOf(Api.InputMessagesFilterPinned);
    const found = await api.search("7", "hello", 50);
    expect(found.map((m) => m.id)).toEqual([3, 2]);
    expect(client.getMessages).toHaveBeenLastCalledWith(7n, { limit: 50, search: "hello" });
    client.invoke.mockResolvedValue({});
    await api.pin("-7", 5, true);
    await api.pin("-7", 5, false);
    expect(client.invoke.mock.calls.map(([r]) => r)).toEqual([
      expect.objectContaining({ peer: -7n, id: 5, unpin: false, silent: true }),
      expect.objectContaining({ peer: -7n, id: 5, unpin: true, silent: true }),
    ]);
    expect(client.invoke.mock.calls[0]![0]).toBeInstanceOf(Api.messages.UpdatePinnedMessage);
    client.invoke.mockClear();
    await api.forward("7", 3, "-1001234", 10);
    await api.forward("7", 3, "8", 1);
    expect(client.invoke.mock.calls.map(([r]) => r)).toEqual([
      expect.objectContaining({ fromPeer: 7n, id: [3], toPeer: -1001234n, topMsgId: 10 }),
      expect.not.objectContaining({ topMsgId: expect.anything() }),
    ]);
    expect(client.invoke.mock.calls[0]![0]).toBeInstanceOf(Api.messages.ForwardMessages);
    client.invoke.mockClear();
    await api.vote("7", 3, ["MA==", "AQI="]);
    const vote = client.invoke.mock.calls[0]![0] as { peer: unknown; msgId: number; options: Buffer[] };
    expect(vote).toBeInstanceOf(Api.messages.SendVote);
    expect([vote.peer, vote.msgId, vote.options.map((o) => [...o])]).toEqual([7n, 3, [[48], [1, 2]]]);
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

  it("mutes and unmutes a chat's notifications", async () => {
    await expect(api.mute("-1001234567890", 2147483647)).resolves.toBeUndefined();
    const request = client.invoke.mock.calls[0]![0] as { peer: { peer: unknown }; settings: { muteUntil: number } };
    expect(request).toBeInstanceOf(Api.account.UpdateNotifySettings);
    expect(request.peer).toBeInstanceOf(Api.InputNotifyPeer);
    expect(request.peer.peer).toEqual({ input: -1001234567890n });
    expect(request.settings).toBeInstanceOf(Api.InputPeerNotifySettings);
    expect(request.settings.muteUntil).toBe(2147483647);
    await api.mute("7", 0);
    expect((client.invoke.mock.calls[1]![0] as { settings: { muteUntil: number } }).settings.muteUntil).toBe(0);
  });

  it("reads the default mutes for one-to-one chats, groups and channels", async () => {
    client.invoke.mockImplementation(async (request: { peer: unknown }) =>
      request.peer instanceof Api.InputNotifyUsers ? make(Api.PeerNotifySettings, { muteUntil: 2147483647 }) : request.peer instanceof Api.InputNotifyChats ? make(Api.PeerNotifySettings, {}) : {},
    );
    await expect(api.notifyDefaults()).resolves.toEqual({ user: 2147483647, group: 0, channel: 0 });
    expect(client.invoke.mock.calls.map((c) => c[0])).toEqual([expect.any(Api.account.GetNotifySettings), expect.any(Api.account.GetNotifySettings), expect.any(Api.account.GetNotifySettings)]);
  });

  it("moves a chat into the archive and out of it", async () => {
    await expect(api.archive("-7", true)).resolves.toBeUndefined();
    await api.archive("7", false);
    const requests = client.invoke.mock.calls.map(([r]) => r as { folderPeers: { peer: unknown; folderId: number }[] });
    expect(requests[0]).toBeInstanceOf(Api.folders.EditPeerFolders);
    expect(requests[0]!.folderPeers[0]).toBeInstanceOf(Api.InputFolderPeer);
    expect(requests.map((r) => r.folderPeers.map((p) => ({ ...p })))).toEqual([[{ peer: { input: -7n }, folderId: 1 }], [{ peer: { input: 7n }, folderId: 0 }]]);
  });

  it("marks archived dialogs, and chats with contacts or the user themselves", async () => {
    const row = (id: bigint, entity: unknown, extra: object = {}) => ({ dialog: {}, id, unreadCount: 0, unreadMentionsCount: 0, date: 1, entity, ...extra });
    client.getDialogs.mockResolvedValue([row(1n, make(Api.User, { firstName: "A" }), { archived: true }), row(2n, make(Api.User, { contact: true })), row(3n, make(Api.User, { self: true })), row(-4n, make(Api.Chat, { title: "G" }))]);
    const { dialogs } = await api.dialogs(5);
    expect(dialogs.map((d) => [d.archived, d.contact])).toEqual([[true, undefined], [undefined, true], [undefined, true], [undefined, undefined]]);
  });

  it("lists the user's folders, naming their own chat by their id", async () => {
    const user = make(Api.InputPeerUser, { userId: 5n });
    client.invoke.mockResolvedValue(make(Api.messages.DialogFilters, { filters: [make(Api.DialogFilter, { id: 2, title: { text: "Work" }, pinnedPeers: [make(Api.InputPeerSelf)], includePeers: [user], excludePeers: [] })] }));
    client.getMe.mockResolvedValue({ id: 9n });
    expect(await api.folders()).toEqual([{ id: 2, title: "Work", include: ["9", "5"], exclude: [] }]);
    expect(client.invoke.mock.calls[0]![0]).toBeInstanceOf(Api.messages.GetDialogFilters);
    // Without the user's own chat in any folder, they are not asked for; an answer of another kind has no folders.
    client.getMe.mockClear();
    client.invoke.mockResolvedValue(make(Api.messages.DialogFilters, { filters: [make(Api.DialogFilterChatlist, { id: 3, title: "Shared", pinnedPeers: [], includePeers: [user] }), make(Api.DialogFilterDefault)] }));
    expect(await api.folders()).toEqual([{ id: 3, title: "Shared", include: ["5"], exclude: [] }, { id: 0, title: "All chats", include: [], exclude: [] }]);
    expect(client.getMe).not.toHaveBeenCalled();
    client.invoke.mockResolvedValue([]);
    expect(await api.folders()).toEqual([]);
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
      const [newH, editH, delH, rawH] = client.addEventHandler.mock.calls.map((c) => c[0] as (event: unknown) => void);
      return { cb, newH: newH!, editH: editH!, delH: delH!, rawH: rawH! };
    };
    const event = (peerId: unknown) => ({ message: make(Api.Message, { id: 4, date: 4, message: "x", peerId }) });

    it("registers handlers for messages, edits, deletions and raw updates", () => {
      setup();
      expect(client.addEventHandler).toHaveBeenCalledTimes(4);
      expect((client.addEventHandler.mock.calls[3]![1] as { args: { types: unknown[] } }).args.types).toEqual([
        Api.UpdateMessageReactions,
        Api.UpdateUserTyping,
        Api.UpdateChatUserTyping,
        Api.UpdateChannelUserTyping,
        Api.UpdatePinnedMessages,
        Api.UpdatePinnedChannelMessages,
        Api.UpdateMessagePoll,
        Api.UpdateFolderPeers,
        Api.UpdateNotifySettings,
        Api.UpdateDialogFilter,
        Api.UpdateDialogFilters,
        Api.UpdateDialogFilterOrder,
        Api.UpdateLoginToken,
      ]);
    });

    it("forwards reaction updates of messages it can place", () => {
      const { cb, rawH } = setup();
      const reactions = make(Api.MessageReactions, { min: true, results: [make(Api.ReactionCount, { reaction: make(Api.ReactionEmoji, { emoticon: "👍" }), count: 2 })] });
      rawH(make(Api.UpdateMessageReactions, { peer: make(Api.PeerUser, { userId: 8n }), msgId: 4, reactions }));
      rawH(make(Api.UpdateMessageReactions, { peer: {}, msgId: 4, reactions }));
      rawH(make(Api.UpdateMessageReactions, { peer: make(Api.PeerUser, { userId: 8n }), msgId: 0, reactions }));
      rawH(make(Api.UpdateMessageReactions, { peer: make(Api.PeerUser, { userId: 8n }), msgId: 1.5, reactions }));
      rawH({});
      rawH(make(Api.UpdatePinnedMessages, { peer: make(Api.PeerChat, { chatId: 1n }), messages: [4, 0, 1.5], pinned: true }));
      rawH(make(Api.UpdatePinnedChannelMessages, { channelId: 1234567890n, messages: [5] }));
      rawH(make(Api.UpdatePinnedMessages, { peer: {}, messages: [4] }));
      rawH(make(Api.UpdateMessagePoll, { pollId: 77n, results: make(Api.PollResults, { totalVoters: 2 }), poll: make(Api.Poll, { closed: true }) }));
      rawH(make(Api.UpdateMessagePoll, { pollId: 78n, results: make(Api.PollResults, {}), poll: {} }));
      rawH(make(Api.UpdateMessagePoll, { pollId: 79n, results: {} }));
      expect(cb.mock.calls.splice(-2)).toEqual([[{ type: "poll", pollId: "77", results: { voters: [], total: 2, min: false }, closed: true }], [{ type: "poll", pollId: "78", results: { voters: [], min: false } }]]);
      expect(cb.mock.calls.splice(-2)).toEqual([[{ type: "pins", chatId: "-1", ids: [4], pinned: true }], [{ type: "pins", chatId: "-1001234567890", ids: [5], pinned: false }]]);
      const folderPeer = (peer: unknown, folderId: number) => make(Api.FolderPeer, { peer, folderId });
      rawH(make(Api.UpdateFolderPeers, { folderPeers: [folderPeer(make(Api.PeerUser, { userId: 8n }), 1), folderPeer(make(Api.PeerChat, { chatId: 2n }), 0), folderPeer({}, 1), {}] }));
      rawH(make(Api.UpdateFolderPeers, { folderPeers: [{}] }));
      expect(cb.mock.calls.splice(-1)).toEqual([[{ type: "archive", peers: [{ chatId: "8", archived: true }, { chatId: "-2", archived: false }] }]]);
      rawH(make(Api.UpdateDialogFilter, { id: 2 }));
      rawH(make(Api.UpdateDialogFilters));
      rawH(make(Api.UpdateDialogFilterOrder, { order: [2] }));
      expect(cb.mock.calls.splice(-3)).toEqual([[{ type: "folders" }], [{ type: "folders" }], [{ type: "folders" }]]);
      rawH(make(Api.UpdateLoginToken));
      expect(cb.mock.calls.splice(-1)).toEqual([[{ type: "loginToken" }]]);
      const notify = (peer: unknown, settings: Record<string, unknown> | undefined) => make(Api.UpdateNotifySettings, { peer, notifySettings: settings && make(Api.PeerNotifySettings, settings) });
      rawH(notify(make(Api.NotifyPeer, { peer: make(Api.PeerUser, { userId: 8n }) }), { muteUntil: 2147483647 }));
      rawH(notify(make(Api.NotifyPeer, { peer: make(Api.PeerChat, { chatId: 2n }) }), {}));
      rawH(notify(make(Api.NotifyPeer, { peer: {} }), { muteUntil: 5 }));
      rawH(notify(make(Api.NotifyUsers), { muteUntil: 2147483647 }));
      rawH(notify(make(Api.NotifyChats), { muteUntil: -1 }));
      rawH(notify(make(Api.NotifyBroadcasts), undefined));
      rawH(notify(make(Api.NotifyForumTopic), { muteUntil: 5 }));
      expect(cb.mock.calls.splice(-5)).toEqual([
        [{ type: "notifyChat", chatId: "8", mutedUntil: 2147483647 }],
        [{ type: "notifyChat", chatId: "-2" }],
        [{ type: "notifyDefault", kind: "user", mutedUntil: 2147483647 }],
        [{ type: "notifyDefault", kind: "group", mutedUntil: 0 }],
        [{ type: "notifyDefault", kind: "channel", mutedUntil: 0 }],
      ]);
      rawH(make(Api.UpdateUserTyping, { userId: 8n, action: make(Api.SendMessageTypingAction) }));
      expect(cb.mock.calls.at(-1)).toEqual([{ type: "typing", chatId: "8", userId: "8", active: true }]);
      cb.mock.calls.pop();
      expect(cb.mock.calls).toEqual([[{ type: "reactions", chatId: "8", id: 4, reactions: [{ emoji: "👍", count: 2, chosen: false }], own: false }]]);
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
    expect(mediaFile(doc({ mimeType: "application/x-tgsticker" }, make(Api.DocumentAttributeSticker, { alt: "" })))).toMatchObject({ kind: "sticker", name: "🙂 Sticker", mime: "application/x-tgsticker", thumbnailOnly: true });
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
    // Vector outlines are not counted, as GramJS leaves them out; with no thumbnail at all, nothing (never the file).
    client.getMessages.mockResolvedValue([make(Api.Message, { id: 9, media: make(Api.MessageMediaDocument, { document: make(Api.Document, { attributes: [], thumbs: [make(Api.PhotoPathSize), {}] }) }) })]);
    client.downloadMedia.mockClear().mockResolvedValue(new Uint8Array([3]));
    await api.download("42", 9, true);
    expect(client.downloadMedia).toHaveBeenLastCalledWith(expect.anything(), { thumb: 0 });
    client.getMessages.mockResolvedValue([make(Api.Message, { id: 9, media: make(Api.MessageMediaDocument, { document: make(Api.Document, { attributes: [] }) }) })]);
    expect(await api.download("42", 9, true)).toBeUndefined();
    expect(client.downloadMedia).toHaveBeenCalledTimes(1);
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

  it("gives a group message's sender's username, where it looks like one", () => {
    const base = { id: 5, date: 1000, message: "hi", peerId: make(Api.PeerChat, { chatId: 1n }) };
    const from = (props: Record<string, unknown>) => toMessage(Object.assign(make(Api.Message, base), { sender: user(7, props) }), "-1");
    expect(from({ username: "ana_x" }).senderUsername).toBe("ana_x");
    expect(from({ username: "bot" })).not.toHaveProperty("senderUsername");
    expect(from({ username: "a b c d" })).not.toHaveProperty("senderUsername");
    expect(from({})).not.toHaveProperty("senderUsername");
    expect(toMessage(Object.assign(make(Api.Message, base), { sender: make(Api.Chat, { title: "Club" }) }), "-1")).not.toHaveProperty("senderUsername");
  });

  it("maps participants to members with their role, leaving out deleted and unknown users", () => {
    const users = [user(1, { status: make(Api.UserStatusOnline), username: "first_one" }), user(2, { bot: true, username: "bot" }), user(3), user(4, { deleted: true }), {}];
    expect(
      membersOf(
        [part(Api.ChatParticipantCreator, 1), part(Api.ChannelParticipantAdmin, 2, { rank: "Helper" }), part(Api.ChatParticipantAdmin, 3, { rank: "" }), part(Api.ChatParticipant, 4), part(Api.ChatParticipant, 5), {}, undefined],
        users,
      ),
    ).toEqual([
      { id: "1", name: "U1", bot: false, presence: "online", role: "owner", username: "first_one" },
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

describe("reactions", () => {
  const emoji = (emoticon: unknown) => make(Api.ReactionEmoji, { emoticon });
  const counted = (reaction: unknown, count: unknown, chosenOrder?: number) => make(Api.ReactionCount, { reaction, count, chosenOrder });

  it("reads emoji reactions with their counts and the user's own, without variation selectors", () => {
    const heart = "❤" + String.fromCharCode(0xfe0f);
    const results = [
      counted(emoji(heart), 3, 0),
      counted(emoji("👍"), 1),
      // Custom emoji, malformed or empty reactions, and repeats are left out.
      counted(make(Api.ReactionCustomEmoji, { documentId: 1n }), 4),
      counted(emoji("<b>"), 1),
      counted(emoji(""), 1),
      counted(emoji("x".repeat(33)), 1),
      counted(emoji(7), 1),
      counted(emoji("🔥"), 0),
      counted(emoji("👍"), 9),
      {},
    ];
    expect(reactionsOf(make(Api.MessageReactions, { results }))).toEqual({ reactions: [{ emoji: "❤", count: 3, chosen: true }, { emoji: "👍", count: 1, chosen: false }], own: true });
    expect(reactionsOf(make(Api.MessageReactions, { min: true }))).toEqual({ reactions: [], own: false });
    expect(reactionsOf(undefined)).toEqual({ reactions: [], own: true });
    const many = Array.from({ length: 60 }, (_, i) => counted(emoji(String(i)), 1));
    expect(reactionsOf(make(Api.MessageReactions, { results: many })).reactions).toHaveLength(50);
  });

  it("gives messages their reactions", () => {
    const reactions = make(Api.MessageReactions, { results: [counted(emoji("👍"), 2)] });
    expect(toMessage(make(Api.Message, { id: 1, date: 1, message: "", reactions }), "9").reactions).toEqual([{ emoji: "👍", count: 2, chosen: false }]);
    expect(toMessage(make(Api.Message, { id: 1, date: 1, message: "" }), "9")).not.toHaveProperty("reactions");
  });

  it("reads which reactions a chat takes", () => {
    expect(allowedOf(make(Api.ChatReactionsNone))).toEqual({ kind: "none" });
    expect(allowedOf(make(Api.ChatReactionsAll))).toEqual({ kind: "all" });
    expect(allowedOf(undefined)).toEqual({ kind: "all" });
    expect(allowedOf(make(Api.ChatReactionsSome, { reactions: [emoji("👍"), make(Api.ReactionCustomEmoji)] }))).toEqual({ kind: "some", emoji: ["👍"] });
  });

  describe("through the client", () => {
    let client: InstanceType<typeof h.FakeClient>;
    let api: ReturnType<typeof createGramApi>;
    beforeEach(() => {
      api = createGramApi({ apiId: 1, apiHash: "h" }, "", { os: "linux", appVersion: "1" });
      client = h.FakeClient.instances.at(-1)!;
    });

    it("sets the user's reactions on a message", async () => {
      client.invoke.mockResolvedValue({});
      await api.react("-1001234", 5, ["👍", "❤"]);
      const request = client.invoke.mock.calls[0]![0] as { peer: unknown; msgId: number; reaction: { emoticon: string }[] };
      expect(request).toBeInstanceOf(Api.messages.SendReaction);
      expect(request).toMatchObject({ peer: -1001234n, msgId: 5 });
      expect(request.reaction.map((r) => r.emoticon)).toEqual(["👍", "❤"]);
      expect(request.reaction[0]).toBeInstanceOf(Api.ReactionEmoji);
    });

    it("asks a group's or channel's full info which reactions it takes; one-to-one chats take all", async () => {
      await expect(api.allowedReactions("7")).resolves.toEqual({ kind: "all" });
      expect(client.invoke).not.toHaveBeenCalled();
      client.invoke.mockResolvedValue({ fullChat: { availableReactions: make(Api.ChatReactionsNone) } });
      await expect(api.allowedReactions("-7")).resolves.toEqual({ kind: "none" });
      expect(client.invoke.mock.calls[0]![0]).toBeInstanceOf(Api.messages.GetFullChat);
      expect((client.invoke.mock.calls[0]![0] as { chatId: unknown }).chatId).toBe(7n);
      await expect(api.allowedReactions("-1001234")).resolves.toEqual({ kind: "none" });
      expect(client.invoke.mock.calls[1]![0]).toBeInstanceOf(Api.channels.GetFullChannel);
    });

    it("lists the reactions Telegram offers, premium ones only to Premium users", async () => {
      const list = make(Api.messages.AvailableReactions, {
        reactions: [{ reaction: "👍" }, { reaction: "💀", inactive: true }, { reaction: "⭐", premium: true }, { reaction: "<x>" }],
      });
      client.invoke.mockResolvedValue(list);
      client.getMe.mockResolvedValue({ id: 1n });
      await expect(api.reactionList()).resolves.toEqual(["👍"]);
      expect(client.invoke.mock.calls[0]![0]).toBeInstanceOf(Api.messages.GetAvailableReactions);
      client.getMe.mockResolvedValue({ id: 1n, premium: true });
      await expect(api.reactionList()).resolves.toEqual(["👍", "⭐"]);
      client.invoke.mockResolvedValue({});
      await expect(api.reactionList()).resolves.toEqual([]);
    });

    it("says when the user has Premium", async () => {
      client.getMe.mockResolvedValue({ id: 1n, firstName: "A", premium: true });
      await expect(api.me()).resolves.toEqual({ id: "1", name: "A", bot: false, premium: true });
    });
  });
});

describe("foldersOf", () => {
  it("reads folders' chats, kinds and exclusions, leaving out what is not a folder", () => {
    const peers = [make(Api.InputPeerUser, { userId: 1n }), make(Api.InputPeerChat, { chatId: 2n }), make(Api.InputPeerChannel, { channelId: 3n }), make(Api.InputPeerSelf), {}];
    const filter = make(Api.DialogFilter, { id: 4, title: "  ", contacts: true, groups: true, bots: false, excludeMuted: true, excludeRead: true, excludeArchived: true, nonContacts: true, broadcasts: true, pinnedPeers: [peers[0]], includePeers: peers, excludePeers: [peers[1]] });
    expect(foldersOf([filter, make(Api.DialogFilter, { id: 0, title: "x" }), make(Api.DialogFilter, { id: 1.5, title: "x" }), {}], undefined)).toEqual([
      { id: 4, title: "Folder", include: ["1", "-2", "-1003"], exclude: ["-2"], contacts: true, nonContacts: true, groups: true, broadcasts: true, excludeMuted: true, excludeRead: true, excludeArchived: true },
    ]);
    expect(foldersOf([make(Api.DialogFilter, { id: 5, title: { text: "x".repeat(80) }, pinnedPeers: [], includePeers: [make(Api.InputPeerSelf)], excludePeers: [] })], "9")).toEqual([{ id: 5, title: "x".repeat(64), include: ["9"], exclude: [] }]);
    const many = Array.from({ length: MAX_FOLDER_PEERS + 5 }, (_, i) => make(Api.InputPeerUser, { userId: BigInt(i + 1) }));
    expect(foldersOf([make(Api.DialogFilterChatlist, { id: 6, title: "L", pinnedPeers: [], includePeers: many })], undefined)[0]!.include).toHaveLength(MAX_FOLDER_PEERS);
    expect(foldersOf(Array.from({ length: 40 }, (_, i) => make(Api.DialogFilter, { id: i + 2, title: "F", pinnedPeers: [], includePeers: [], excludePeers: [] })), undefined)).toHaveLength(31);
  });
});

describe("typing", () => {
  const typing = make(Api.SendMessageTypingAction);
  const user = (id: bigint) => make(Api.PeerUser, { userId: id });

  it("reads who is typing where: one-to-one chats, basic groups and supergroups", () => {
    expect(typingOf(make(Api.UpdateUserTyping, { userId: 8n, action: typing }))).toEqual({ type: "typing", chatId: "8", userId: "8", active: true });
    expect(typingOf(make(Api.UpdateChatUserTyping, { chatId: 7n, fromId: user(8n), action: make(Api.SendMessageUploadPhotoAction) }))).toEqual({ type: "typing", chatId: "-7", userId: "8", active: true });
    expect(typingOf(make(Api.UpdateChannelUserTyping, { channelId: 1234n, fromId: user(8n), action: make(Api.SendMessageCancelAction) }))).toEqual({ type: "typing", chatId: "-1001234", userId: "8", active: false });
  });

  it("leaves out channels typing as themselves, other actions, malformed ids and other updates", () => {
    expect(typingOf(make(Api.UpdateChannelUserTyping, { channelId: 1234n, fromId: make(Api.PeerChannel, { channelId: 1n }), action: typing }))).toBeUndefined();
    expect(typingOf(make(Api.UpdateUserTyping, { userId: 8n, action: make(Api.SendMessageEmojiInteraction) }))).toBeUndefined();
    expect(typingOf(make(Api.UpdateUserTyping, { userId: 10n ** 19n, action: typing }))).toBeUndefined();
    expect(typingOf(make(Api.UpdateChatUserTyping, { chatId: "x", fromId: user(8n), action: typing }))).toBeUndefined();
    expect(typingOf(make(Api.UpdateMessageReactions))).toBeUndefined();
    expect(typingOf(undefined)).toBeUndefined();
  });

  describe("through the client", () => {
    let client: InstanceType<typeof h.FakeClient>;
    let api: ReturnType<typeof createGramApi>;
    beforeEach(() => {
      api = createGramApi({ apiId: 1, apiHash: "h" }, "", { os: "linux", appVersion: "1" });
      client = h.FakeClient.instances.at(-1)!;
    });

    it("says the user is typing, or stopped", async () => {
      client.invoke.mockResolvedValue(true);
      await api.typing("-7", true);
      await api.typing("-7", false);
      const [start, stop] = client.invoke.mock.calls.map((c) => c[0] as { peer: unknown; action: unknown });
      expect(start).toBeInstanceOf(Api.messages.SetTyping);
      expect(start!.peer).toBe(-7n);
      expect(start!.action).toBeInstanceOf(Api.SendMessageTypingAction);
      expect(stop!.action).toBeInstanceOf(Api.SendMessageCancelAction);
    });

    it("names users Telegram knows", async () => {
      client.getEntity.mockResolvedValue(make(Api.User, { id: 8n, firstName: "Ana" }));
      await expect(api.userName("8")).resolves.toBe("Ana");
      expect((client.getEntity.mock.calls[0]![0] as { userId: unknown }).userId).toBe(8n);
      client.getEntity.mockResolvedValue(make(Api.Channel, { title: "x" }));
      await expect(api.userName("8")).resolves.toBeUndefined();
    });
  });
});

describe("sending files", () => {
  const source = (filename: string, size: number, contentType: string) => {
    const read = vi.fn(async (start: number, end: number) => new Uint8Array(end - start).fill(start / UPLOAD_PART));
    return { filename, size, contentType, read };
  };

  it("sends JPEG and PNG pictures as photos, videos as videos, the rest as documents", () => {
    const uploaded = make(Api.InputFile);
    expect(uploadMedia(uploaded, source("a.jpg", 10, "image/jpeg"), "a.jpg")).toBeInstanceOf(Api.InputMediaUploadedPhoto);
    expect(uploadMedia(uploaded, source("a.png", 10, "IMAGE/PNG"), "a.png")).toBeInstanceOf(Api.InputMediaUploadedPhoto);
    const big = uploadMedia(uploaded, source("a.png", 10 * 1024 * 1024 + 1, "image/png"), "a.png") as { mimeType: string; attributes: unknown[] };
    expect(big).toBeInstanceOf(Api.InputMediaUploadedDocument);
    expect(big.mimeType).toBe("image/png");
    const video = uploadMedia(uploaded, source("v.mp4", 10, "video/mp4"), "v.mp4") as { attributes: { supportsStreaming?: boolean; fileName?: string }[] };
    expect(video.attributes[0]).toBeInstanceOf(Api.DocumentAttributeFilename);
    expect(video.attributes[0]!.fileName).toBe("v.mp4");
    expect(video.attributes[1]).toBeInstanceOf(Api.DocumentAttributeVideo);
    expect(video.attributes[1]!.supportsStreaming).toBe(true);
    const webm = uploadMedia(uploaded, source("v.webm", 10, "video/webm"), "v.webm") as { attributes: { supportsStreaming?: boolean }[] };
    expect(webm.attributes[1]!.supportsStreaming).toBe(false);
    const doc = uploadMedia(uploaded, source("x", 10, "not a type"), "x") as { mimeType: string; attributes: unknown[] };
    expect(doc).toMatchObject({ mimeType: "application/octet-stream" });
    expect(doc.attributes).toHaveLength(1);
  });

  it("names files by their last path part, without control characters", () => {
    expect(fileName("C:\\dir\\a.txt")).toBe("a.txt");
    expect(fileName("x/y/b" + String.fromCharCode(7) + "c.pdf")).toBe("bc.pdf");
    expect(fileName("  ")).toBe("file");
    expect(fileName("n".repeat(300))).toHaveLength(255);
  });

  it("knows who may not send media: those a group's rules or their restrictions bar, not admins", () => {
    expect(mediaBanned(make(Api.Chat, { defaultBannedRights: { sendMedia: true } }))).toBe(true);
    expect(mediaBanned(make(Api.Chat, { defaultBannedRights: { sendMedia: true }, adminRights: {} }))).toBe(false);
    expect(mediaBanned(make(Api.Channel, { megagroup: true, bannedRights: { sendMedia: true } }))).toBe(true);
    expect(mediaBanned(make(Api.Channel, { megagroup: true, creator: true, bannedRights: { sendMedia: true } }))).toBe(false);
    expect(mediaBanned(make(Api.Channel, { megagroup: true }))).toBe(false);
    expect(mediaBanned(make(Api.User))).toBe(false);
  });

  describe("through the client", () => {
    let client: InstanceType<typeof h.FakeClient>;
    let api: ReturnType<typeof createGramApi>;
    beforeEach(() => {
      api = createGramApi({ apiId: 1, apiHash: "h" }, "", { os: "linux", appVersion: "1" });
      client = h.FakeClient.instances.at(-1)!;
      client.invoke.mockResolvedValue(true);
      client.sendFile.mockResolvedValue(make(Api.Message, { id: 9, date: 1, out: true, message: "cap" }));
    });

    it("uploads a small file in parts and sends it with its caption, formatting and reply", async () => {
      const file = source("dir/a.png", UPLOAD_PART + 10, "image/png");
      await expect(api.sendFile("-7", file, { text: "cap", entities: [{ type: "bold", offset: 0, length: 3 }] }, 4)).resolves.toMatchObject({ id: 9, chatId: "-7" });
      const parts = client.invoke.mock.calls.map((c) => c[0] as { fileId: unknown; filePart: number; bytes: Buffer });
      expect(parts.map((p) => [p.constructor, p.filePart, p.bytes.length, p.fileId])).toEqual([
        [Api.upload.SaveFilePart, 0, UPLOAD_PART, 8000n],
        [Api.upload.SaveFilePart, 1, 10, 8000n],
      ]);
      expect(file.read).toHaveBeenCalledWith(0, UPLOAD_PART + 10);
      const [peer, options] = client.sendFile.mock.calls[0]! as unknown as [bigint, { file: { file: { parts: number; name: string } }; caption: string; replyTo: number; formattingEntities: unknown[] }];
      expect(peer).toBe(-7n);
      expect(options).toMatchObject({ caption: "cap", replyTo: 4 });
      expect(options.formattingEntities[0]).toBeInstanceOf(Api.MessageEntityBold);
      expect(options.file).toBeInstanceOf(Api.InputMediaUploadedPhoto);
      expect(options.file.file).toBeInstanceOf(Api.InputFile);
      expect(options.file.file).toMatchObject({ parts: 2, name: "a.png" });
    });

    it("uploads a big file as one, reading a few parts at a time", async () => {
      const size = 20 * UPLOAD_PART + 1;
      const file = source("big.bin", size, "application/octet-stream");
      await api.sendFile("7", file, { text: "", entities: [] });
      expect(file.read.mock.calls).toEqual([[0, 16 * UPLOAD_PART], [16 * UPLOAD_PART, size]]);
      const parts = client.invoke.mock.calls.map((c) => c[0] as { filePart: number; fileTotalParts: number; bytes: Buffer });
      expect(parts).toHaveLength(21);
      expect(parts.every((p) => p instanceof Api.upload.SaveBigFilePart && p.fileTotalParts === 21)).toBe(true);
      expect(parts[20]!.bytes.length).toBe(1);
      // Parts 16 to 20 come from the second read.
      expect(parts[17]!.bytes[0]).toBe(16);
      const options = client.sendFile.mock.calls[0]![1] as { file: { file: unknown } };
      expect(options.file.file).toBeInstanceOf(Api.InputFileBig);
    });

    it("stops when a file changed while it was read", async () => {
      const file = source("a.txt", 100, "text/plain");
      file.read.mockResolvedValue(new Uint8Array(50));
      await expect(api.sendFile("7", file, { text: "", entities: [] })).rejects.toThrow("a.txt changed while it was sent");
      expect(client.sendFile).not.toHaveBeenCalled();
    });
  });
});

describe("forum topics", () => {
  const header = (props: Record<string, unknown>) => make(Api.MessageReplyHeader, props);
  const inForum = (replyTo: unknown) => toMessage(make(Api.Message, { id: 30, date: 1, message: "x", replyTo }), "-1005");

  it("knows forums, and those where only admins start topics", () => {
    expect(forumOf(make(Api.Channel, { megagroup: true, forum: true }))).toEqual({ forum: true, noTopics: false });
    expect(forumOf(make(Api.Channel, { megagroup: true, forum: true, defaultBannedRights: { manageTopics: true } }))).toEqual({ forum: true, noTopics: true });
    expect(forumOf(make(Api.Channel, { megagroup: true, forum: true, creator: true, defaultBannedRights: { manageTopics: true } }))).toEqual({ forum: true, noTopics: false });
    expect(forumOf(make(Api.Channel, { megagroup: true }))).toEqual({ forum: false, noTopics: false });
    expect(forumOf(make(Api.Channel, { forum: true }))).toEqual({ forum: false, noTopics: false });
    expect(forumOf(make(Api.Chat))).toEqual({ forum: false, noTopics: false });
  });

  it("places messages in their topic, and answers only where they answer one", () => {
    // In a topic: pointing at its first message, no answer.
    expect(inForum(header({ forumTopic: true, replyToMsgId: 10 }))).toMatchObject({ topicId: 10 });
    expect(inForum(header({ forumTopic: true, replyToMsgId: 10 }))).not.toHaveProperty("replyToId");
    // An answer within a topic.
    expect(inForum(header({ forumTopic: true, replyToMsgId: 12, replyToTopId: 10 }))).toMatchObject({ topicId: 10, replyToId: 12 });
    // General has no topic id.
    expect(inForum(header({ forumTopic: true, replyToMsgId: 1 }))).not.toHaveProperty("topicId");
    expect(inForum(undefined)).not.toHaveProperty("topicId");
    expect(inForum(header({ replyToMsgId: 3 }))).toMatchObject({ replyToId: 3 });
  });

  it("lists topics with their counts and last activity, leaving out deleted ones", () => {
    const topics = [
      make(Api.ForumTopic, { id: 1, title: "General", unreadCount: 2, unreadMentionsCount: 1, topMessage: 40, date: 5, pinned: true, readInboxMaxId: 38 }),
      make(Api.ForumTopic, { id: 10, title: "", unreadCount: -1, topMessage: 99, date: 7 }),
      make(Api.ForumTopic, { id: 11, title: "x".repeat(200), topMessage: 41, date: 8 }),
      make(Api.ForumTopicDeleted, { id: 12 }),
      make(Api.ForumTopic, { id: 0, title: "zero" }),
      make(Api.ForumTopic, { id: 1.5, title: "half" }),
    ];
    const messages = [make(Api.Message, { id: 40, date: 400 }), make(Api.MessageService, { id: 41, date: 410 }), {}];
    expect(topicsOf(topics, messages)).toEqual([
      { id: 1, title: "General", unreadCount: 2, unreadMentions: 1, date: 400, pinned: true, readUpTo: 38 },
      { id: 10, title: "Topic", unreadCount: 0, unreadMentions: 0, date: 7 },
      { id: 11, title: "x".repeat(128), unreadCount: 0, unreadMentions: 0, date: 410 },
    ]);
  });

  it("sends into topics: plain into General, as a reply to the topic's first message elsewhere", () => {
    expect(topicReply(undefined, undefined)).toEqual({});
    expect(topicReply(5, undefined)).toEqual({ replyTo: 5 });
    expect(topicReply(undefined, 1)).toEqual({});
    expect(topicReply(5, 1)).toEqual({ replyTo: 5 });
    expect(topicReply(undefined, 10)).toEqual({ replyTo: 10 });
    expect(topicReply(12, 10)).toEqual({ replyTo: 12, topMsgId: 10 });
  });

  it("reads which topic someone types in", () => {
    const typing = make(Api.SendMessageTypingAction);
    const from = make(Api.PeerUser, { userId: 8n });
    expect(typingOf(make(Api.UpdateChannelUserTyping, { channelId: 5n, fromId: from, action: typing, topMsgId: 10 }))).toEqual({ type: "typing", chatId: "-1005", userId: "8", active: true, topicId: 10 });
    expect(typingOf(make(Api.UpdateChannelUserTyping, { channelId: 5n, fromId: from, action: typing, topMsgId: 1 }))).toEqual({ type: "typing", chatId: "-1005", userId: "8", active: true });
  });

  describe("through the client", () => {
    let client: InstanceType<typeof h.FakeClient>;
    let api: ReturnType<typeof createGramApi>;
    beforeEach(() => {
      api = createGramApi({ apiId: 1, apiHash: "h" }, "", { os: "linux", appVersion: "1" });
      client = h.FakeClient.instances.at(-1)!;
    });

    it("marks forums in the dialog list", async () => {
      client.getDialogs.mockResolvedValue([
        { dialog: {}, id: -1005n, unreadCount: 0, unreadMentionsCount: 0, date: 1, entity: make(Api.Channel, { title: "Club", megagroup: true, forum: true, defaultBannedRights: { manageTopics: true } }) },
      ]);
      await expect(api.dialogs(5)).resolves.toEqual({ dialogs: [expect.objectContaining({ chatId: "-1005", forum: true, noTopics: true })] });
    });

    it("lists a forum's topics", async () => {
      client.invoke.mockResolvedValue({ topics: [make(Api.ForumTopic, { id: 1, title: "General", topMessage: 3, date: 2 }), make(Api.ForumTopic, { id: 9, title: "B", date: 1 })], messages: [] });
      await expect(api.topics("-1005", 1)).resolves.toEqual([{ id: 1, title: "General", unreadCount: 0, unreadMentions: 0, date: 2 }]);
      const request = client.invoke.mock.calls[0]![0] as Record<string, unknown>;
      expect(request).toBeInstanceOf(Api.channels.GetForumTopics);
      expect(request).toMatchObject({ channel: -1005n, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 1 });
    });

    it("reads topics' own mutes, and mutes a topic through its notify peer", async () => {
      const settings = (props: Record<string, unknown>) => make(Api.PeerNotifySettings, props);
      const topics = [
        make(Api.ForumTopic, { id: 2, title: "A", date: 1, notifySettings: settings({ muteUntil: 2147483647 }) }),
        make(Api.ForumTopic, { id: 3, title: "B", date: 1, notifySettings: settings({ muteUntil: 0 }) }),
        make(Api.ForumTopic, { id: 4, title: "C", date: 1, notifySettings: settings({}) }),
        make(Api.ForumTopic, { id: 5, title: "D", date: 1, notifySettings: settings({ muteUntil: -5 }) }),
      ];
      expect(topicsOf(topics, []).map((t) => t.mutedUntil)).toEqual([2147483647, 0, undefined, 0]);
      client.invoke.mockResolvedValue({});
      await api.mute("-1005", 0, 10);
      const request = client.invoke.mock.calls[0]![0] as { peer: { peer: unknown; topMsgId: number }; settings: { muteUntil: number } };
      expect(request.peer).toBeInstanceOf(Api.InputNotifyForumTopic);
      expect(request.peer).toMatchObject({ peer: { input: -1005n }, topMsgId: 10 });
      expect(request.settings.muteUntil).toBe(0);
    });

    it("starts a topic and finds its id in Telegram's answer", async () => {
      const created = make(Api.MessageService, { id: 77, action: make(Api.MessageActionTopicCreate) });
      client.invoke.mockResolvedValue(make(Api.Updates, { updates: [make(Api.UpdateNewChannelMessage, { message: make(Api.MessageService, { id: 5 }) }), {}, make(Api.UpdateNewChannelMessage, { message: created })] }));
      await expect(api.createTopic("-1005", "New")).resolves.toBe(77);
      const request = client.invoke.mock.calls[0]![0] as Record<string, unknown>;
      expect(request).toBeInstanceOf(Api.channels.CreateForumTopic);
      expect(request).toMatchObject({ channel: -1005n, title: "New", randomId: 8000n });
      client.invoke.mockResolvedValue(make(Api.UpdatesCombined, { updates: [make(Api.UpdateNewMessage, { message: created })] }));
      await expect(api.createTopic("-1005", "New")).resolves.toBe(77);
      client.invoke.mockResolvedValue({});
      await expect(api.createTopic("-1005", "New")).rejects.toThrow("Telegram did not say which topic it started");
    });

    it("reads a topic's history, and sends, uploads and types into it", async () => {
      client.getMessages.mockResolvedValue([]);
      await api.history("-1005", 50, 20, 10);
      expect(client.getMessages).toHaveBeenCalledWith(-1005n, { limit: 20, offsetId: 50, replyTo: 10 });
      client.sendMessage.mockResolvedValue(make(Api.Message, { id: 1, date: 1, message: "a" }));
      await api.send("-1005", { text: "a", entities: [] }, 12, 10);
      expect(client.sendMessage).toHaveBeenCalledWith(-1005n, { message: "a", replyTo: 12, topMsgId: 10, formattingEntities: [] });
      client.invoke.mockResolvedValue(true);
      client.sendFile.mockResolvedValue(make(Api.Message, { id: 2, date: 1, message: "" }));
      await api.sendFile("-1005", { filename: "a.txt", size: 1, contentType: "text/plain", read: async () => new Uint8Array(1) }, { text: "", entities: [] }, undefined, 10);
      expect(client.sendFile.mock.calls[0]![1]).toMatchObject({ replyTo: 10 });
      client.invoke.mockClear();
      await api.typing("-1005", true, 10);
      await api.typing("-1005", true, 1);
      const [inTopic, inGeneral] = client.invoke.mock.calls.map((c) => c[0] as { topMsgId?: number });
      expect(inTopic!.topMsgId).toBe(10);
      expect(inGeneral).not.toHaveProperty("topMsgId");
    });

    it("reads a topic as the discussion under its first message, with its mentions", async () => {
      client.invoke.mockResolvedValue(true);
      await api.markRead("-1005", 40, 10);
      expect(client.markAsRead).not.toHaveBeenCalled();
      const [read, mentions] = client.invoke.mock.calls.map((c) => c[0] as Record<string, unknown>);
      expect(read).toBeInstanceOf(Api.messages.ReadDiscussion);
      expect(read).toMatchObject({ peer: { input: -1005n }, msgId: 10, readMaxId: 40 });
      expect(mentions).toBeInstanceOf(Api.messages.ReadMentions);
      expect(mentions).toMatchObject({ topMsgId: 10 });
    });
  });
});

describe("stickers", () => {
  const sticker = (id: unknown, mimeType: string, props: Record<string, unknown> = {}, alt: unknown = "😀") =>
    make(Api.Document, { id, mimeType, attributes: [make(Api.DocumentAttributeSticker, { alt })], ...props });

  it("reads sticker documents: static, animated vector and video ones, and which need Premium", () => {
    expect(stickerOf(sticker(5n, "image/webp", { size: 3000 }))).toEqual({ id: "5", emoji: "😀", format: "webp", size: 3000 });
    expect(stickerOf(sticker(-6n, "application/x-tgsticker", {}, ""))).toEqual({ id: "-6", emoji: "", format: "lottie" });
    expect(stickerOf(sticker(7n, "video/webm", { videoThumbs: [make(Api.VideoSize, { type: "f" })] }, "x".repeat(33)))).toEqual({ id: "7", emoji: "", format: "webm", premium: true });
    expect(stickerOf(sticker(8n, "video/webm", { videoThumbs: [make(Api.VideoSize, { type: "v" }), { type: "f" }] }))).not.toHaveProperty("premium");
  });

  it("leaves out what is not a sticker the picker can show", () => {
    expect(stickerOf(undefined)).toBeUndefined();
    expect(stickerOf(sticker(5n, "image/png"))).toBeUndefined();
    expect(stickerOf(sticker(5n, "constructor"))).toBeUndefined();
    expect(stickerOf(make(Api.Document, { id: 5n, mimeType: "image/webp", attributes: [] }))).toBeUndefined();
    expect(stickerOf(sticker(10n ** 21n, "image/webp"))).toBeUndefined();
  });

  it("lists regular installed sets, not archived ones, masks or custom emoji", () => {
    const set = (id: unknown, props: Record<string, unknown> = {}) => make(Api.StickerSet, { id, accessHash: 9n, title: `Set ${id}`, ...props });
    const sets = stickerSetsOf([set(1n), set(2n, { archived: true }), set(3n, { masks: true }), set(4n, { emojis: true }), set(10n ** 21n), {}, set(5n, { title: "" }), set(6n, { title: "t".repeat(200) })]);
    expect(sets.map((s) => s.set)).toEqual([
      { id: "1", title: "Set 1" },
      { id: "5", title: "Stickers" },
      { id: "6", title: "t".repeat(100) },
    ]);
    expect(sets[0]!.input).toBeInstanceOf(Api.InputStickerSetID);
    expect(sets[0]!.input).toMatchObject({ id: 1n, accessHash: 9n });
  });

  it("knows who may not send stickers: those barred from them or from all media, not admins", () => {
    expect(stickersBanned(make(Api.Chat, { defaultBannedRights: { sendStickers: true } }))).toBe(true);
    expect(stickersBanned(make(Api.Chat, { defaultBannedRights: { sendMedia: true } }))).toBe(true);
    expect(stickersBanned(make(Api.Channel, { megagroup: true, bannedRights: { sendStickers: true } }))).toBe(true);
    expect(stickersBanned(make(Api.Channel, { megagroup: true, adminRights: {}, bannedRights: { sendStickers: true } }))).toBe(false);
    expect(stickersBanned(make(Api.Chat, { defaultBannedRights: { sendGifs: true } }))).toBe(false);
    expect(stickersBanned(make(Api.User))).toBe(false);
  });

  it("finds the largest thumbnail GramJS downloads", () => {
    expect(thumbIndex(undefined)).toBeUndefined();
    expect(thumbIndex([make(Api.PhotoPathSize)])).toBeUndefined();
    expect(thumbIndex([make(Api.PhotoPathSize), {}, {}])).toBe(1);
  });

  describe("through the client", () => {
    let client: InstanceType<typeof h.FakeClient>;
    let api: ReturnType<typeof createGramApi>;
    const request = () => client.invoke.mock.calls.at(-1)![0] as Record<string, unknown>;
    beforeEach(() => {
      api = createGramApi({ apiId: 1, apiHash: "h" }, "", { os: "linux", appVersion: "1" });
      client = h.FakeClient.instances.at(-1)!;
    });

    it("lists the installed sets, asking again with Telegram's hash and keeping them while unchanged", async () => {
      client.invoke.mockResolvedValueOnce({});
      await expect(api.stickerSets()).resolves.toEqual([]);
      expect(request()).toBeInstanceOf(Api.messages.GetAllStickers);
      expect(request()).toMatchObject({ hash: 0n });
      client.invoke.mockResolvedValueOnce(make(Api.messages.AllStickers, { hash: 77n, sets: [make(Api.StickerSet, { id: 1n, accessHash: 2n, title: "Cats" })] }));
      await expect(api.stickerSets()).resolves.toEqual([{ id: "1", title: "Cats" }]);
      client.invoke.mockResolvedValueOnce({}); // not modified
      await expect(api.stickerSets()).resolves.toEqual([{ id: "1", title: "Cats" }]);
      expect(request()).toMatchObject({ hash: 77n });
    });

    it("lists a set's stickers, and the user's recent and favourite ones, leaving out what is not a sticker", async () => {
      client.invoke.mockResolvedValueOnce(make(Api.messages.AllStickers, { hash: 1n, sets: [make(Api.StickerSet, { id: 1n, accessHash: 2n, title: "Cats" })] }));
      await api.stickerSets();
      client.invoke.mockResolvedValueOnce(make(Api.messages.StickerSet, { documents: [sticker(5n, "image/webp"), make(Api.Document, { attributes: [] })] }));
      await expect(api.stickers("1")).resolves.toEqual([{ id: "5", emoji: "😀", format: "webp" }]);
      expect(request()).toBeInstanceOf(Api.messages.GetStickerSet);
      expect(request().stickerset).toBeInstanceOf(Api.InputStickerSetID);
      client.invoke.mockResolvedValueOnce({});
      await expect(api.stickers("1")).resolves.toEqual([]);
      client.invoke.mockResolvedValueOnce(make(Api.messages.RecentStickers, { stickers: [sticker(6n, "video/webm")] }));
      await expect(api.stickers("recent")).resolves.toMatchObject([{ id: "6", format: "webm" }]);
      expect(request()).toBeInstanceOf(Api.messages.GetRecentStickers);
      client.invoke.mockResolvedValueOnce({});
      await expect(api.stickers("recent")).resolves.toEqual([]);
      client.invoke.mockResolvedValueOnce(make(Api.messages.FavedStickers, { stickers: [sticker(7n, "application/x-tgsticker")] }));
      await expect(api.stickers("faved")).resolves.toMatchObject([{ id: "7", format: "lottie" }]);
      expect(request()).toBeInstanceOf(Api.messages.GetFavedStickers);
      client.invoke.mockResolvedValueOnce({});
      await expect(api.stickers("faved")).resolves.toEqual([]);
      await expect(api.stickers("99")).rejects.toThrow("Telegram did not list this sticker set");
    });

    it("downloads a listed sticker, or its largest thumbnail; never one it did not list", async () => {
      const document = sticker(5n, "application/x-tgsticker", { thumbs: [make(Api.PhotoPathSize), {}] });
      client.invoke.mockResolvedValueOnce(make(Api.messages.RecentStickers, { stickers: [document, sticker(6n, "image/webp")] }));
      await api.stickers("recent");
      client.downloadMedia.mockResolvedValue(new Uint8Array([1]));
      await expect(api.stickerFile("5", true)).resolves.toEqual(new Uint8Array([1]));
      const [media, options] = client.downloadMedia.mock.calls.at(-1)! as unknown as [{ document: unknown }, unknown];
      expect(media).toBeInstanceOf(Api.MessageMediaDocument);
      expect(media.document).toBe(document);
      expect(options).toEqual({ thumb: 0 });
      await api.stickerFile("5", false);
      expect(client.downloadMedia).toHaveBeenLastCalledWith(expect.anything(), {});
      client.downloadMedia.mockClear();
      // No thumbnail: nothing, rather than the animation itself.
      await expect(api.stickerFile("6", true)).resolves.toBeUndefined();
      expect(client.downloadMedia).not.toHaveBeenCalled();
      await expect(api.stickerFile("8", false)).rejects.toThrow("Telegram did not list this sticker");
    });

    it("sends a listed sticker as itself, into a topic or as a reply", async () => {
      client.invoke.mockResolvedValueOnce(make(Api.messages.FavedStickers, { stickers: [sticker(5n, "image/webp", { accessHash: 3n, fileReference: "ref" })] }));
      await api.stickers("faved");
      client.sendFile.mockResolvedValue(make(Api.Message, { id: 9, date: 1, out: true, message: "" }));
      await expect(api.sendSticker("-1005", "5", 4, 10)).resolves.toMatchObject({ id: 9, chatId: "-1005" });
      const [peer, options] = client.sendFile.mock.calls[0]! as unknown as [bigint, { file: { id: unknown }; caption: string; replyTo: number; topMsgId: number }];
      expect(peer).toBe(-1005n);
      expect(options).toMatchObject({ caption: "", replyTo: 4, topMsgId: 10 });
      expect(options.file).toBeInstanceOf(Api.InputMediaDocument);
      expect(options.file.id).toBeInstanceOf(Api.InputDocument);
      expect(options.file.id).toMatchObject({ id: 5n, accessHash: 3n, fileReference: "ref" });
    });

    it("lists a sticker afresh once when its file reference expired", async () => {
      client.invoke.mockResolvedValueOnce(make(Api.messages.FavedStickers, { stickers: [sticker(5n, "image/webp", { fileReference: "old" })] }));
      await api.stickers("faved");
      client.sendFile.mockRejectedValueOnce({ errorMessage: "FILE_REFERENCE_EXPIRED" }).mockResolvedValueOnce(make(Api.Message, { id: 9, date: 1 }));
      client.invoke.mockResolvedValueOnce(make(Api.messages.FavedStickers, { stickers: [sticker(5n, "image/webp", { fileReference: "new" })] }));
      await expect(api.sendSticker("7", "5")).resolves.toMatchObject({ id: 9 });
      const options = client.sendFile.mock.calls.at(-1)![1] as unknown as { file: { id: { fileReference: string } } };
      expect(options.file.id.fileReference).toBe("new");
      // Gone from where it was listed: the error stands.
      client.sendFile.mockRejectedValueOnce({ errorMessage: "FILE_REFERENCE_EXPIRED" });
      client.invoke.mockResolvedValueOnce(make(Api.messages.FavedStickers, { stickers: [] }));
      await expect(api.sendSticker("7", "5")).rejects.toEqual({ errorMessage: "FILE_REFERENCE_EXPIRED" });
      // Other errors are not retried.
      client.sendFile.mockClear().mockRejectedValueOnce({ errorMessage: "CHAT_SEND_STICKERS_FORBIDDEN" });
      await expect(api.sendSticker("7", "5")).rejects.toEqual({ errorMessage: "CHAT_SEND_STICKERS_FORBIDDEN" });
      expect(client.sendFile).toHaveBeenCalledTimes(1);
    });
  });
});
