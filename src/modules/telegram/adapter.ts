import type { AsyncSecretStore, EngineFiles, FileSource } from "../../engine/runtime";
import type { DirectConversation, HomeBadge, PlatformAdapter } from "../../shared/adapter";
import { BaseAdapter } from "../../shared/baseAdapter";
import { customEmojiIds, escapeText, fromMarkdown, toMarkdown } from "./format";
import type { NativeAction, NativeAttachment, NativeChannelView, NativeEmbed, NativeFolder, NativeForumPost, NativeListedMessage, NativeMember, NativeMemberList, NativeMessage, NativeMessageList, NativePoll, NativePollOption, NativeSearchResults, NativeProfile, NativePrompt, NativeReaction, NativeSidebarItem, NativeSticker, NativeStickerPack, NativeUnread, NativeViewState } from "../../shared/native";
import { MAX_HTTP_BODY, type PickedFile } from "../../shared/engine";
import { MAX_ATTACHMENTS, MAX_CUSTOM_EMOJI, MAX_FOLDERS } from "../../shared/native";
import { TYPING_SETTING, type AccountStatus, type ServiceSettingStatus, type ServiceSettingValues } from "../../shared/settings";
import { ALL_CHATS, CUSTOM_EMOJI_BATCH, customReaction, FAVED_STICKERS, GENERAL_TOPIC, isChannelPeer, RECENT_STICKERS, reactionEmoji, telegramError, viewEmoji, type TelegramApi, type TelegramCredentials, type TgAllowedReactions, type TgChatKind, type TgCustomEmoji, type TgDialog, type TgDialogCursor, type TgFile, type TgFolder, type TgMember, type TgMessage, type TgNotifyDefaults, type TgPoll, type TgPreview, type TgProfile, type TgQrLogin, type TgReaction, type TgSticker, type TgText, type TgTopic, type TgUpdate, type TgUser } from "./api";

/**
 * Chats listed: one-to-one chats, groups and channels together, most recent
 * first. The first page comes at sign-in, the rest a page at a time in the
 * background, up to the limit.
 */
export const DIALOG_LIMIT = 1000;
export const DIALOG_PAGE = 100;
export const DIALOG_PAGE_MS = 2000;
export const PAGE_SIZE = 50;
/** Profile pictures fetched per refresh; the rest show initials. */
export const AVATAR_LIMIT = 40;
/** Reactions a Premium user may give one message; others give one. Telegram's default (reactions_user_max_premium). */
export const PREMIUM_REACTIONS = 3;
/** How long someone shows as typing unless they say so again, as in Telegram's apps; and how often the user's own typing is repeated. */
export const TYPING_SHOWN_MS = 6000;
export const TYPING_REPEAT_MS = 5000;
/** Most people shown typing in one chat. */
const MAX_TYPING = 10;
/**
 * Largest file sent: what the engine's bridge carries in one request, as for
 * every module's uploads (Telegram itself takes 2 GB).
 */
export const MAX_UPLOAD_BYTES = MAX_HTTP_BODY;
/** Longest caption, Telegram's default (Premium allows 4096); longer text goes in a message of its own after the files. */
export const CAPTION_LIMIT = 1024;
const PREMIUM_CAPTION_LIMIT = 4096;
/** Topics listed per forum, most recently active first. */
export const TOPIC_LIMIT = 50;
/** Pinned messages listed at most, newest first. */
export const PINS_LIMIT = 50;
/** Search results listed at most, newest first. */
export const SEARCH_LIMIT = 50;
/** Members fetched per page, and at most for one chat: big groups list their first ones and count the rest. */
export const MEMBER_PAGE = 50;
export const MEMBER_LIMIT = 200;
/** A mute that does not end: the latest time Telegram takes, as its apps send for "mute forever". */
export const MUTE_FOREVER = 2 ** 31 - 1;
/** Members' profile pictures fetched per chat; the rest show initials. */
export const MEMBER_AVATAR_LIMIT = 30;
/** Largest media shown in the view (it travels as a data: URL); bigger files say so. */
export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
/** Media kept in memory for the view, all files together; the oldest go first. */
export const MEDIA_CACHE_BYTES = 200 * 1024 * 1024;
/** Installed sticker sets fetched, in the user's order, and how many at once; later sets are not offered. */
export const STICKER_SET_LIMIT = 100;
const STICKER_SET_FETCHES = 3;
/** Stickers offered per pack and in all, as many as the view shows. */
export const PACK_STICKER_LIMIT = 300;
export const STICKER_LIMIT = 5000;
/**
 * Stickers' pictures kept for the picker, all together. They travel with
 * every view update, so they are kept apart from (and smaller than) the
 * messages' media; stickers past it are not offered.
 */
export const STICKER_CACHE_BYTES = 24 * 1024 * 1024;
/** Largest sticker file loaded whole (Telegram's own limit for static ones); larger static stickers show their thumbnail, larger video stickers are not offered. */
export const MAX_STICKER_BYTES = 512 * 1024;
/** Sticker pictures downloaded at once. */
const STICKER_DOWNLOADS = 4;
/** How long stickers' pictures gather before the view is updated with them. */
export const STICKER_RENDER_MS = 250;
/** Stickers are "tg:<document id>" in the view, their pictures' media keys "tgsticker:<document id>". */
const STICKER_ID = "tg:";
const STICKER_KEY = "tgsticker:";
/** What a sticker's file is, as a data: URL; thumbnails are WebP. */
const STICKER_MIME = { webp: "image/webp", webm: "video/webm", lottie: "image/webp" } as const;
/**
 * Custom emoji described per session, as many as the view takes; their
 * pictures kept, all together, and the largest one. Emoji past these show
 * as the emoji they stand for.
 */
export const EMOJI_LIMIT = MAX_CUSTOM_EMOJI;
export const EMOJI_CACHE_BYTES = 8 * 1024 * 1024;
export const MAX_EMOJI_BYTES = 128 * 1024;
/** Custom emoji pictures downloaded at once. */
const EMOJI_DOWNLOADS = 4;
const SESSION_KEY = "session";
const CREDENTIALS_KEY = "api";
/** The Settings action (manifest `settings`) that forgets the API ID the user entered. */
export const FORGET_API_ID = "forgetApiId";
/** No kind of chat muted by default. */
const UNMUTED: TgNotifyDefaults = { user: 0, group: 0, channel: 0 };
const DIALOG_REFRESH_MS = 1000;
const BAD_CREDENTIALS = new Set(["API_ID_INVALID", "API_ID_PUBLISHED_FLOOD"]);
/** How soon and how late a QR sign-in token is replaced, whatever Telegram says of its expiry. */
export const QR_REFRESH_MIN_MS = 5000;
export const QR_REFRESH_MAX_MS = 60_000;

export interface TelegramInstanceDef {
  id: string;
  name: string;
  url: string;
}

export interface TelegramAdapterDeps {
  def: TelegramInstanceDef;
  secrets: AsyncSecretStore;
  render(state: NativeViewState): void;
  /** API credentials built into this build of Multicord, if any. */
  builtInCredentials?: TelegramCredentials;
  createApi(credentials: TelegramCredentials, session: string): TelegramApi;
  /** Lets the user pick files; the engine reads only what was picked. */
  files?: EngineFiles;
  /** Bytes of loaded media kept for the view (default MEDIA_CACHE_BYTES). */
  mediaBudget?: number;
  /** Bytes of stickers' pictures kept for the picker (default STICKER_CACHE_BYTES). */
  stickerBudget?: number;
  /** Bytes of custom emoji pictures kept (default EMOJI_CACHE_BYTES). */
  emojiBudget?: number;
  /** This instance's settings values (TYPING_SETTING); changes come through applySettings(). */
  settings?: ServiceSettingValues;
}

/** A sticker pack as fetched: a set, or the user's recent or favourite stickers. */
interface StickerPack {
  id: string;
  name: string;
  stickers: TgSticker[];
}

type Step = "api" | "phone" | "code" | "password" | "qr" | "connecting" | "chat";

/** A chat's members as fetched so far. */
interface MemberList {
  members: TgMember[];
  total: number;
  /** Where the next page starts; absent once there is none, or the bound is reached. */
  next?: number;
  loading: boolean;
  error?: string;
}

/** What the user sees for Telegram's error names. */
const FRIENDLY: Record<string, string> = {
  PHONE_NUMBER_INVALID: "That phone number is not valid. Include the country code, e.g. +31.",
  PHONE_NUMBER_BANNED: "Telegram has banned this phone number.",
  PHONE_CODE_INVALID: "That code is not right.",
  PHONE_CODE_EMPTY: "Enter the code Telegram sent you.",
  PASSWORD_HASH_INVALID: "That password is not right.",
  API_ID_INVALID: "Telegram does not accept this API ID and hash.",
  API_ID_PUBLISHED_FLOOD: "Telegram does not accept this API ID and hash.",
};

function friendly(error: unknown): string {
  const name = telegramError(error);
  if (/^FLOOD_WAIT_\d+$/.test(name)) return "Too many attempts. Wait a while and try again.";
  return FRIENDLY[name] ?? name;
}

/** Bytes as base64, in pieces small enough for String.fromCharCode. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Bytes as base64url without padding, as Telegram's sign-in links carry their token. */
export const base64Url = (bytes: Uint8Array): string => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** "📷 Photo" and such after the text, so media-only messages still say something. */
export function messageText(message: TgMessage): string {
  return [message.text, message.media].filter(Boolean).join("\n");
}

/**
 * The view takes only digits as conversation ids (the shell checks them), but
 * groups' and channels' chat ids are negative. They show as this base plus
 * their magnitude, above any user id; dialog ids have at most 18 digits, so
 * the result has at most 20.
 */
const GROUP_VIEW_BASE = 10n ** 19n;

/** A chat's id in the view. */
export function viewId(chatId: string): string {
  return chatId.startsWith("-") ? String(GROUP_VIEW_BASE + BigInt(chatId.slice(1))) : chatId;
}

/** The chat a view id names; the view's ids are checked digits. */
export function chatIdOfView(id: string): string {
  const value = BigInt(id);
  return value >= GROUP_VIEW_BASE ? `-${value - GROUP_VIEW_BASE}` : id;
}

/**
 * Forum topics show in the view under ids of their own: this base plus a
 * number counted up per sign-in, below the groups' ids and above any user's.
 */
const TOPIC_VIEW_BASE = 9n * 10n ** 18n;

/** A conversation's key: a chat, or one topic of a forum. */
export const conversation = (chatId: string, topic?: number): string => (topic === undefined ? chatId : `${chatId}#${topic}`);

/** The chat and topic a conversation key names. */
function parseConversation(key: string): [string, number | undefined] {
  const at = key.indexOf("#");
  return at < 0 ? [key, undefined] : [key.slice(0, at), Number(key.slice(at + 1))];
}

/** The view's sections, in order. */
const SECTIONS: [TgChatKind, string][] = [
  ["user", "Direct messages"],
  ["group", "Groups"],
  ["channel", "Channels"],
];

/** What the module offers the shell; its manifest must declare the same (tested). */
export const CAPABILITIES: PlatformAdapter["capabilities"] = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

/**
 * Native Telegram adapter: signs in with phone number, code and two-step
 * password, lists one-to-one chats as direct messages (in the rail and the
 * unified Messages page), groups and channels under its home entry, and
 * renders them in Multicord's chat view. Runs in its sandboxed engine; the
 * session is kept in the instance's own secrets.
 */
export class TelegramAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = CAPABILITIES;

  private api: TelegramApi | undefined;
  private credentials: TelegramCredentials | undefined;
  /** The credentials are ones the user entered (kept in secrets), not the built-in ones. */
  private ownCredentials = false;
  private step: Step = "phone";
  private busy = false;
  private status: string | undefined;
  private error: string | undefined;
  private phone = "";
  private codeHash = "";
  private codeViaApp = false;
  private passwordHint: string | undefined;
  /** The QR sign-in link shown (a credential), and when the next token is asked for. */
  private qr: string | undefined;
  private qrTimer: ReturnType<typeof setTimeout> | undefined;
  private me: TgUser | undefined;
  private hasSession = false;
  private dialogs: TgDialog[] = [];
  private readonly messages = new Map<string, TgMessage[]>();
  private readonly hasOlder = new Map<string, boolean>();
  private readonly loading = new Set<string>();
  private readonly avatars = new Map<string, string>();
  /** Media loaded for the view, by media key, as data: URLs; and what could not be loaded. */
  private readonly media = new Map<string, string>();
  private mediaBytes = 0;
  private readonly mediaFailed = new Map<string, string>();
  private readonly mediaLoading = new Set<string>();
  /** Messages' text as markdown; a message edited is a new object, so it is worked out again. */
  private readonly markdownOf = new WeakMap<TgMessage, { markdown: string; pictures: number }>();
  private selected: string | undefined;
  /** In a selected forum, the open topic; none shows the forum's topic list. */
  private topic: number | undefined;
  /** Where the open conversation's news began when it was opened: the last message read then, and how many were unread. */
  private unreadAt: { key: string; after?: number; count: number } | undefined;
  /** Forums' topics, once listed; forums being listed. */
  private readonly topics = new Map<string, TgTopic[]>();
  private readonly topicsLoading = new Set<string>();
  /** Topics' ids in the view, both ways. */
  private readonly topicViewIds = new Map<string, string>();
  private readonly topicsByView = new Map<string, { chatId: string; topic: number }>();
  /** The view's member panel is open: the selected chat's members are fetched and shown. */
  private membersOpen = false;
  /** The open conversation's pinned messages (a chat's, or a forum topic's), while its pins panel is open. */
  private pins: { key: string; list: NativeMessageList } | undefined;
  /** The open conversation's search results, until the search ends; and a count that drops answers to earlier searches. */
  private search: { key: string; results: NativeSearchResults } | undefined;
  private searchCount = 0;
  private readonly memberLists = new Map<string, MemberList>();
  /** Chats whose members Telegram turned out not to show the user. */
  private readonly membersHidden = new Set<string>();
  /** Users whose pictures were asked for, so none is asked twice. */
  private readonly avatarsAsked = new Set<string>();
  /** Which reactions each group or channel takes, once asked; chats asked about meanwhile. */
  private readonly allowed = new Map<string, TgAllowedReactions>();
  private readonly allowedAsked = new Set<string>();
  /** The emoji Telegram offers as reactions to this user, once asked. */
  private reactionList: string[] | undefined;
  private reactionListAsked = false;
  /** Who is typing where: conversation, then user, then until when (ms). */
  private readonly typing = new Map<string, Map<string, number>>();
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  /** The user's own typing notice: in which conversation, and when it was last sent. */
  private ownTyping: { key: string; sent: number } | undefined;
  /** Settings' "Send typing indicators" for this service. */
  private typingIndicators: boolean;
  /** Names of people typing, as Telegram told them; and those asked for. */
  private readonly names = new Map<string, string>();
  private readonly namesAsked = new Set<string>();
  /** Files picked for each conversation's next message, and the conversations whose files are being sent. */
  private readonly pending = new Map<string, FileSource[]>();
  private readonly uploading = new Set<string>();
  /** The user's sticker packs as fetched this session, in the order offered; whether they were asked for. */
  private stickerPacks: StickerPack[] = [];
  private stickersAsked = false;
  /** The view's picker is open: only then are the packs in its state. */
  private pickerOpen = false;
  /** Stickers' pictures for the picker, by sticker id, as data: URLs; those that could not be loaded or kept; and those waiting or loading. */
  private readonly stickerMedia = new Map<string, string>();
  private stickerBytes = 0;
  private readonly stickerFailed = new Set<string>();
  private readonly stickerQueue: TgSticker[] = [];
  private readonly stickerQueued = new Set<string>();
  private stickerDownloads = 0;
  private stickerRenderTimer: ReturnType<typeof setTimeout> | undefined;
  /** Custom emoji as Telegram described them this session, by document id (null where it did not); and those to ask about next, and whether that is under way. */
  private readonly emojiInfo = new Map<string, TgCustomEmoji | null>();
  private readonly emojiWanted = new Set<string>();
  private emojiDescribing = false;
  /** Custom emoji pictures as data: URLs, by document id; those that could not be loaded or kept; those waiting or loading; and how many arrived, so messages show them. */
  private readonly emojiPictures = new Map<string, string>();
  private emojiBytes = 0;
  private readonly emojiFailed = new Set<string>();
  private readonly emojiQueue: TgCustomEmoji[] = [];
  private readonly emojiQueued = new Set<string>();
  private emojiDownloads = 0;
  /** The profile card the view asked for last. */
  private profile: NativeProfile | undefined;
  /** The user's chat folders as last fetched, and the one the sidebar shows. */
  private folders: TgFolder[] = [];
  private folder = ALL_CHATS;
  /** The user's default mutes, for chats without one of their own; unmuted until Telegram says. */
  private notifyDefaults: TgNotifyDefaults = { ...UNMUTED };
  private visible = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counts sign-outs, so work started for one account stops for the next. */
  private session = 0;

  constructor(private readonly deps: TelegramAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: "telegram.org", accountId: "default" });
    this.typingIndicators = deps.settings?.[TYPING_SETTING] !== false;
  }

  /** Resumes a saved session, else starts at the first sign-in step. */
  async start(): Promise<void> {
    const saved = parseCredentials(await this.deps.secrets.load(CREDENTIALS_KEY));
    this.ownCredentials = saved !== undefined;
    this.credentials = saved ?? this.deps.builtInCredentials;
    if (!this.credentials) {
      this.step = "api";
      return this.render();
    }
    const session = (await this.deps.secrets.load(SESSION_KEY)) ?? "";
    this.hasSession = session !== "";
    await this.open(session);
  }

  private async open(session: string): Promise<void> {
    this.api = this.deps.createApi(this.credentials!, session);
    this.api.onUpdate((update) => this.onUpdate(update));
    this.step = "connecting";
    this.status = "Connecting to Telegram…";
    this.render();
    try {
      await this.api.connect();
      if (await this.api.authorized()) return await this.signedIn();
      if (session) await this.forgetSession();
      this.step = "phone";
    } catch (error) {
      this.error = `Could not reach Telegram: ${friendly(error)}`;
      if (BAD_CREDENTIALS.has(telegramError(error))) await this.resetCredentials();
      else this.step = "phone";
    }
    this.status = undefined;
    this.render();
  }

  private async signedIn(): Promise<void> {
    const api = this.api!;
    this.hasSession = true;
    await this.deps.secrets.save(SESSION_KEY, api.session());
    this.me = await api.me();
    this.step = "chat";
    this.status = undefined;
    this.error = undefined;
    await this.refreshDialogs(true);
    void this.loadAvatars();
    void this.loadFolders();
    void this.loadNotifyDefaults();
  }

  private async forgetSession(): Promise<void> {
    this.hasSession = false;
    await this.deps.secrets.delete(SESSION_KEY);
  }

  private async resetCredentials(): Promise<void> {
    await this.deps.secrets.delete(CREDENTIALS_KEY);
    this.credentials = undefined;
    this.ownCredentials = false;
    this.step = "api";
  }

  /** Settings changed: whether to send typing indicators; turned off while typing, the notice is called off. */
  applySettings(values: ServiceSettingValues): void {
    this.typingIndicators = values[TYPING_SETTING] !== false;
    if (!this.typingIndicators && this.ownTyping) this.stopTyping(this.ownTyping.key);
  }

  /** What Settings shows with "Forget API ID". Never the hash. */
  settingsStatus(): ServiceSettingStatus {
    let text = "No API ID entered yet.";
    if (this.ownCredentials) text = `Using the API ID you entered (${this.credentials!.apiId}).`;
    else if (this.deps.builtInCredentials) text = "Using Multicord's own API ID.";
    return { [FORGET_API_ID]: { text, disabled: !this.ownCredentials } };
  }

  /** Settings' "Forget API ID": drops the entered credentials and signs out, falling back to the built-in ones if any. */
  async runSettingAction(key: string): Promise<void> {
    if (key !== FORGET_API_ID || !this.ownCredentials || this.busy) return;
    await this.deps.secrets.delete(CREDENTIALS_KEY);
    this.ownCredentials = false;
    this.credentials = this.deps.builtInCredentials;
    this.error = undefined;
    await this.signOut();
  }

  // --- Shell interface ---------------------------------------------------------

  override async listDirectConversations(): Promise<DirectConversation[]> {
    return this.directs();
  }

  /**
   * Groups and channels, which live under home: unread where they would
   * notify, and every unread mention (Telegram counts those in muted chats
   * too). One-to-one chats are DM bubbles with their own badges. Archived
   * chats count only in the sidebar's Archive section (see directs()).
   */
  homeBadge(): HomeBadge {
    const rooms = this.dialogs.filter((d) => d.kind !== "user" && !d.archived);
    return {
      unread: rooms.some((d) => d.unreadCount > 0 && !this.muted(d)),
      mentions: rooms.reduce((sum, d) => sum + d.unreadMentions, 0),
    };
  }

  async openHome(): Promise<void> {
    this.render();
  }

  async openServer(key: string): Promise<void> {
    throw new Error(`Telegram has no server ${key}`);
  }

  async openConversation(key: string): Promise<void> {
    await this.select(key);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.selected) void this.markRead(conversation(this.selected, this.topic));
  }

  accountStatus(): AccountStatus {
    if (this.step === "chat") return this.me ? { state: "signed-in", name: this.me.name } : { state: "signed-in" };
    return this.hasSession ? { state: "signed-in" } : { state: "signed-out" };
  }

  async signOut(): Promise<void> {
    await this.api?.logOut().catch(() => undefined);
    await this.api?.disconnect().catch(() => undefined);
    this.api = undefined;
    await this.forgetSession();
    this.me = undefined;
    this.dialogs = [];
    this.messages.clear();
    this.hasOlder.clear();
    // Another account may sign in next; its chats must not show these pictures.
    this.avatars.clear();
    this.avatarsAsked.clear();
    this.memberLists.clear();
    this.membersHidden.clear();
    this.membersOpen = false;
    this.profile = undefined;
    this.folders = [];
    this.folder = ALL_CHATS;
    this.notifyDefaults = { ...UNMUTED };
    this.allowed.clear();
    this.allowedAsked.clear();
    this.reactionList = undefined;
    this.reactionListAsked = false;
    this.typing.clear();
    clearTimeout(this.typingTimer);
    this.typingTimer = undefined;
    this.ownTyping = undefined;
    this.endQr();
    this.names.clear();
    this.namesAsked.clear();
    this.pending.clear();
    this.uploading.clear();
    this.topics.clear();
    this.topicsLoading.clear();
    this.topicViewIds.clear();
    this.topicsByView.clear();
    // The next account has stickers of its own.
    this.stickerPacks = [];
    this.stickersAsked = false;
    this.pickerOpen = false;
    this.stickerMedia.clear();
    this.stickerBytes = 0;
    this.stickerFailed.clear();
    this.stickerQueue.length = 0;
    this.stickerQueued.clear();
    clearTimeout(this.stickerRenderTimer);
    this.stickerRenderTimer = undefined;
    this.emojiInfo.clear();
    this.emojiWanted.clear();
    this.emojiDescribing = false;
    this.emojiPictures.clear();
    this.emojiBytes = 0;
    this.emojiFailed.clear();
    this.emojiQueue.length = 0;
    this.emojiQueued.clear();
    this.session++;
    this.selected = undefined;
    this.topic = undefined;
    this.directsChanged.emit([]);
    // A fresh client for the next sign-in, starting at the phone step.
    if (this.credentials) return this.open("");
    this.step = "api";
    this.render();
  }

  async handleAction(action: NativeAction): Promise<void> {
    switch (action.type) {
      case "ready":
        // A view (re)loaded has its picker closed.
        this.pickerOpen = false;
        return this.render();
      case "picker":
        return this.setPickerOpen(action.open);
      case "prompt":
        return this.answer(action.id, action.values);
      case "cancelPrompt":
        // The phone step's other button signs in with a QR code instead.
        if (action.id === "phone" && this.step === "phone") return this.startQr();
        if (action.id === "code" || action.id === "password" || action.id === "qr") {
          this.endQr();
          this.step = "phone";
          this.error = undefined;
          this.render();
        }
        return;
      case "select": {
        const topic = this.topicsByView.get(action.channelId);
        return topic ? this.select(topic.chatId, topic.topic) : this.select(chatIdOfView(action.channelId));
      }
      case "createPost":
        return this.createTopic(action.name, action.content);
      case "send":
        return this.send(action.content, action.replyTo);
      case "edit":
        return this.edit(action.messageId, action.content);
      case "delete":
        return this.remove(action.messageId);
      case "loadOlder":
        return this.loadOlder();
      case "loadMedia":
        return action.key.startsWith(STICKER_KEY) ? this.loadSticker(action.key.slice(STICKER_KEY.length)) : this.loadMedia(action.key);
      case "sendSticker":
        return this.sendSticker(action.stickerId, action.replyTo);
      case "pins":
        return this.showPins(action.open);
      case "vote":
        return this.vote(Number(action.messageId), action.options);
      case "createPoll":
        return this.createPoll(action.question, action.answers, action.multiple, action.anonymous);
      case "endPoll":
        return this.endPoll(Number(action.messageId));
      case "forward":
        return this.forward(Number(action.messageId), action.channelId);
      case "search":
        return this.searchMessages(action.query);
      case "pin":
        return this.pin(Number(action.messageId), action.pin);
      case "members":
        return this.setMembersOpen(action.open);
      case "loadMembers":
        return this.loadMembers(action.offset);
      case "profile":
        return this.showProfile(action.id);
      case "react":
        return this.react(action.messageId, action.emoji, action.add);
      case "mute": {
        const topic = this.topicsByView.get(action.channelId);
        return topic ? this.muteTopic(topic.chatId, topic.topic, action.mute) : this.mute(chatIdOfView(action.channelId), action.mute);
      }
      case "folder":
        return this.showFolder(action.id);
      case "archive":
        return this.archive(chatIdOfView(action.channelId), action.archive);
      case "typing":
        return this.sendTyping();
      case "attach":
        return this.attach();
      case "sendFile":
        return this.sendShared(action.file, action.replyTo);
      case "removeAttachment":
        if (this.selected && !this.uploading.has(this.current()!)) this.pending.get(this.current()!)?.splice(action.index, 1);
        return this.render();
      case "logout":
        return this.signOut();
      default:
        // Voice is not offered for Telegram.
        return;
    }
  }

  // --- Signing in ---------------------------------------------------------------

  private async answer(step: string, values: Record<string, string>): Promise<void> {
    if (step !== this.step || this.busy) return;
    this.busy = true;
    this.error = undefined;
    this.render();
    try {
      switch (step) {
        case "api": {
          const credentials = parseCredentials(JSON.stringify({ apiId: Number(values.apiId), apiHash: values.apiHash }));
          if (!credentials) throw new Error("The API ID is a number and the API hash 32 letters and digits, both from my.telegram.org.");
          await this.deps.secrets.save(CREDENTIALS_KEY, JSON.stringify(credentials));
          this.credentials = credentials;
          this.ownCredentials = true;
          this.busy = false;
          return await this.open("");
        }
        case "phone": {
          const phone = (values.phone ?? "").replace(/[\s()-]/g, "");
          if (!/^\+?\d{6,15}$/.test(phone)) throw new Error(FRIENDLY.PHONE_NUMBER_INVALID);
          this.status = "Sending the code…";
          this.render();
          const sent = await this.api!.sendCode(phone);
          this.phone = phone;
          this.codeHash = sent.hash;
          this.codeViaApp = sent.viaApp;
          this.step = "code";
          break;
        }
        case "code": {
          const result = await this.api!.signIn(this.phone, this.codeHash, (values.code ?? "").replace(/\s/g, ""));
          if ("password" in result) {
            this.passwordHint = result.hint;
            this.step = "password";
          } else if ("signUp" in result) {
            this.step = "phone";
            throw new Error("This number has no Telegram account yet. Sign up in Telegram's own app first.");
          } else {
            await this.signedIn();
          }
          break;
        }
        case "password":
          await this.api!.checkPassword(values.password ?? "");
          await this.signedIn();
          break;
        case "qr":
          // A new code, where the one shown would not scan.
          await this.exportQr();
          break;
      }
    } catch (error) {
      this.error = friendly(error);
      const name = telegramError(error);
      if (name === "PHONE_CODE_EXPIRED") {
        this.step = "phone";
        this.error = "The code expired. Request a new one.";
      } else if (BAD_CREDENTIALS.has(name)) {
        // Telegram only checks the API ID once asked for something: start over with new ones.
        await this.resetCredentials();
      }
    }
    this.busy = false;
    this.status = undefined;
    this.render();
  }

  private prompt(): NativePrompt {
    switch (this.step) {
      case "api":
        return {
          id: "api",
          title: "Connect Multicord to Telegram",
          description:
            "Telegram asks every app for its own API ID. Create one at my.telegram.org under API development tools, then enter it here. It is stored encrypted on this device.",
          fields: [
            { name: "apiId", label: "API ID", type: "number" },
            { name: "apiHash", label: "API hash", type: "text", autocomplete: "off" },
          ],
          submit: "Continue",
        };
      case "code":
        return {
          id: "code",
          title: "Enter the code",
          description: this.codeViaApp ? `Telegram sent a code to your Telegram app for ${this.phone}.` : `Telegram sent a code by text message to ${this.phone}.`,
          fields: [{ name: "code", label: "Code", type: "number", autocomplete: "one-time-code" }],
          submit: "Sign in",
          cancel: "Use another number",
        };
      case "password":
        return {
          id: "password",
          title: "Two-step verification",
          description: this.passwordHint ? `Your account has a password. Hint: ${this.passwordHint}` : "Your account has a password.",
          fields: [{ name: "password", label: "Password", type: "password", autocomplete: "current-password" }],
          submit: "Sign in",
          cancel: "Use another number",
        };
      case "qr":
        return {
          id: "qr",
          title: "Sign in with a QR code",
          description: "On your phone, open Telegram, go to Settings > Devices > Link Desktop Device, and scan this code.",
          fields: [],
          submit: "Show a new code",
          cancel: "Use my phone number",
          ...(this.qr ? { qr: this.qr } : {}),
        };
      default:
        return {
          id: "phone",
          title: "Sign in to Telegram",
          description: "Multicord is a third-party Telegram client. Your number and code go only to Telegram, and your session is stored encrypted on this device.",
          fields: [{ name: "phone", label: "Phone number", type: "tel", autocomplete: "tel", placeholder: "+31 6 12345678" }],
          submit: "Send code",
          cancel: "Sign in with a QR code",
        };
    }
  }

  /** Signs in with a QR code instead of the phone number: the step shows one once Telegram gives a token. */
  private async startQr(): Promise<void> {
    if (this.busy) return;
    this.step = "qr";
    this.error = undefined;
    this.status = "Getting a code…";
    this.render();
    await this.exportQr();
  }

  /** Drops the QR code: its token is a credential, kept no longer than the step that shows it. */
  private endQr(): void {
    clearTimeout(this.qrTimer);
    this.qrTimer = undefined;
    this.qr = undefined;
  }

  /**
   * Asks Telegram for a sign-in token to show as a QR code, or, once another
   * device has accepted the one shown, signs in (after the password, where
   * the account has one). Tokens last about half a minute: a fresh one is
   * asked for as each runs out.
   */
  private async exportQr(): Promise<void> {
    clearTimeout(this.qrTimer);
    const session = this.session;
    let result: TgQrLogin;
    try {
      result = await this.api!.qrLogin();
    } catch (error) {
      if (this.step !== "qr" || session !== this.session) return;
      this.qr = undefined;
      this.status = undefined;
      this.error = `Could not get a code: ${friendly(error)}`;
      if (BAD_CREDENTIALS.has(telegramError(error))) await this.resetCredentials();
      return this.render();
    }
    // The user went back to the phone step, or this answer came after another that ended the step.
    if (this.step !== "qr" || session !== this.session) return;
    if ("token" in result) {
      this.qr = `tg://login?token=${base64Url(result.token)}`;
      this.status = undefined;
      const wait = Math.min(Math.max(result.expires * 1000 - Date.now(), QR_REFRESH_MIN_MS), QR_REFRESH_MAX_MS);
      this.qrTimer = setTimeout(() => void this.exportQr(), wait);
      return this.render();
    }
    this.endQr();
    if ("password" in result) {
      this.passwordHint = result.hint;
      this.step = "password";
      this.status = undefined;
      return this.render();
    }
    this.step = "connecting";
    this.status = "Signing in…";
    this.render();
    try {
      await this.signedIn();
    } catch (error) {
      this.step = "phone";
      this.error = `Could not sign in: ${friendly(error)}`;
    }
    this.status = undefined;
    this.render();
  }

  // --- Chats --------------------------------------------------------------------

  /**
   * Fetches the first page of dialogs afresh. Chats older than it, listed
   * from later pages, stay, so a refresh (e.g. for a message from someone
   * new) keeps them; newer ones it leaves out are gone (left or deleted).
   * After signing in, the later pages follow in the background.
   */
  private async refreshDialogs(first = false): Promise<void> {
    const page = await this.api!.dialogs(DIALOG_PAGE);
    const fresh = new Set(page.dialogs.map((d) => d.chatId));
    // A page with none after it is the whole list.
    const oldest = page.next ? Math.min(...page.dialogs.map((d) => d.date)) : -Infinity;
    const older = this.dialogs.filter((d) => !fresh.has(d.chatId) && d.date < oldest);
    this.dialogs = [...page.dialogs, ...older].sort((a, b) => b.date - a.date);
    this.publish();
    if (first && page.next) void this.pageDialogs(page.next);
  }

  /**
   * Lists the chats after the first page, a page every DIALOG_PAGE_MS, up to
   * DIALOG_LIMIT in all. Chats already listed keep what they have, which is
   * as new or newer. A page that fails ends the paging until the next sign-in.
   */
  private async pageDialogs(next: TgDialogCursor | undefined): Promise<void> {
    const session = this.session;
    while (next && this.dialogs.length < DIALOG_LIMIT) {
      await new Promise((resolve) => setTimeout(resolve, DIALOG_PAGE_MS));
      if (session !== this.session) return;
      const page = await this.api!.dialogs(DIALOG_PAGE, next).catch(() => undefined);
      if (session !== this.session || !page) return;
      const known = new Set(this.dialogs.map((d) => d.chatId));
      const added = page.dialogs.filter((d) => !known.has(d.chatId)).slice(0, DIALOG_LIMIT - this.dialogs.length);
      this.dialogs = [...this.dialogs, ...added].sort((a, b) => b.date - a.date);
      this.publish();
      next = page.next;
    }
  }

  /** Refreshes the dialog list soon, e.g. after a message from someone new. */
  private refreshSoon(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshDialogs().catch(() => undefined);
    }, DIALOG_REFRESH_MS);
  }

  private async loadAvatars(): Promise<void> {
    const session = this.session;
    for (const dialog of this.dialogs.slice(0, AVATAR_LIMIT)) {
      if (this.avatars.has(dialog.chatId) || !this.api) continue;
      const url = await this.api.avatar(dialog.chatId).catch(() => undefined);
      // Signed out meanwhile: these chats belong to the previous account.
      if (session !== this.session) return;
      if (url) this.avatars.set(dialog.chatId, url);
    }
    this.publish();
  }

  private dialog(chatId: string): TgDialog | undefined {
    return this.dialogs.find((d) => d.chatId === chatId);
  }

  /** The user muted the chat's notifications in Telegram, for now: the chat itself, or else all chats of its kind. */
  private muted(dialog: TgDialog): boolean {
    return (dialog.mutedUntil ?? this.notifyDefaults[dialog.kind]) > Date.now() / 1000;
  }

  /** A forum topic is muted by its own setting, where it has one, else as its group is. */
  private topicMuted(dialog: TgDialog, topic: TgTopic): boolean {
    return topic.mutedUntil === undefined ? this.muted(dialog) : topic.mutedUntil > Date.now() / 1000;
  }

  /**
   * A chat's badge. In a one-to-one chat every unread message counts, as
   * Telegram notifies each one, unless the chat is muted; in groups only
   * mentions and answers count, muted or not, as in Telegram's apps.
   */
  private badge(dialog: TgDialog): { unread: boolean; mentions: number } {
    const unread = dialog.unreadCount > 0;
    if (dialog.kind === "user") return { unread, mentions: this.muted(dialog) ? 0 : dialog.unreadCount };
    return { unread, mentions: dialog.unreadMentions };
  }

  /** The open conversation's key: the selected chat, or the open topic of a selected forum. */
  private current(): string | undefined {
    return this.selected === undefined ? undefined : conversation(this.selected, this.topic);
  }

  /** The conversation a message belongs to: its chat, or in a forum its topic. */
  private conversationOf(message: TgMessage): string {
    return this.dialog(message.chatId)?.forum ? conversation(message.chatId, message.topicId ?? GENERAL_TOPIC) : message.chatId;
  }

  /** A chat's loaded messages, in all its conversations. */
  private loaded(chatId: string): TgMessage[][] {
    return [...this.messages].filter(([key]) => parseConversation(key)[0] === chatId).map(([, list]) => list);
  }

  /** Opens a chat, or in a forum its topic list (no topic) or a topic. */
  private async select(chatId: string, topic?: number): Promise<void> {
    const dialog = this.dialog(chatId);
    if (!dialog || (topic !== undefined && !dialog.forum)) return;
    if (conversation(chatId, topic) !== this.current()) this.noteUnread(dialog, topic);
    if (this.pins?.key !== conversation(chatId, topic)) this.pins = undefined;
    if (this.search?.key !== conversation(chatId, topic)) this.search = undefined;
    this.selected = chatId;
    this.topic = topic;
    this.render();
    if (this.membersOpen && !this.memberLists.has(chatId)) void this.fetchMembers(chatId);
    void this.fetchAllowedReactions(chatId);
    // A forum shows its topic list; topics are opened from it, so it is listed by then.
    if (dialog.forum && topic === undefined) return this.fetchTopics(chatId);
    const key = conversation(chatId, topic);
    if (!this.messages.has(key)) await this.fetchHistory(key, undefined);
    if (this.visible) await this.markRead(key);
  }

  /** Notes where a conversation being opened has news, before it is marked read. A forum's topic list has none of its own. */
  private noteUnread(dialog: TgDialog, topic: number | undefined): void {
    const found = topic === undefined ? undefined : this.topics.get(dialog.chatId)?.find((t) => t.id === topic);
    const source = dialog.forum ? found : dialog;
    this.unreadAt = source && source.unreadCount > 0 ? { key: conversation(dialog.chatId, topic), after: source.readUpTo, count: source.unreadCount } : undefined;
  }

  /**
   * The open conversation's unread marker: the first incoming message after
   * the last one read when it was opened, once the loaded messages reach
   * back that far (or there are no older ones).
   */
  private unreadView(key: string, at: NonNullable<TelegramAdapter["unreadAt"]>): NativeUnread {
    const messages = this.messages.get(key) ?? [];
    const after = at.after ?? 0;
    const reach = !(this.hasOlder.get(key) ?? false) || messages.some((m) => m.id <= after);
    const first = reach ? messages.find((m) => m.id > after && !m.out) : undefined;
    return first ? { firstId: String(first.id), count: at.count } : { count: at.count };
  }

  /** Opens the open conversation's pins panel and fetches its pins (a forum's within its open topic), or closes it. */
  private async showPins(open: boolean): Promise<void> {
    const key = this.current();
    // A forum's topic list has no pins of its own.
    this.pins = open && key && !(this.dialog(this.selected!)?.forum && this.topic === undefined) ? { key, list: { messages: [], loading: true } } : undefined;
    this.render();
    if (this.pins) await this.loadPins(this.pins.key);
  }

  /** Fetches the pins of a conversation whose pins panel is open; a reply for a panel since closed is dropped. */
  private async loadPins(key: string): Promise<void> {
    const [chatId, topic] = parseConversation(key);
    let list: NativeMessageList;
    try {
      const dialog = this.dialog(chatId)!;
      list = { messages: (await this.api!.pinned(chatId, PINS_LIMIT, topic)).map((m) => this.listedMessage(m, dialog)), loading: false };
    } catch (error) {
      list = { messages: [], loading: false, error: `Could not load pinned messages: ${friendly(error)}` };
    }
    if (this.pins?.key !== key) return;
    this.pins = { key, list };
    this.render();
  }

  /**
   * Forwards a message of the open conversation natively, into a chat or a
   * forum's topic from the sidebar; Telegram refuses where the source
   * protects its content or the target takes no messages from the user.
   */
  private async forward(id: number, target: string): Promise<void> {
    const from = this.selected;
    const topic = this.topicsByView.get(target);
    const to = topic?.chatId ?? chatIdOfView(target);
    if (!from || !this.api || !this.dialog(to)) return;
    try {
      await this.api.forward(from, id, to, topic?.topic);
    } catch (error) {
      this.error = `Message not forwarded: ${friendly(error)}`;
      this.render();
    }
  }

  /** Searches the open conversation (in a forum, its open topic) with Telegram's search, or ends the search with an empty query. */
  private async searchMessages(query: string): Promise<void> {
    const dialog = this.selected ? this.dialog(this.selected) : undefined;
    const key = this.current();
    const topic = this.topic;
    const count = ++this.searchCount;
    const trimmed = query.trim();
    this.search = dialog && key && !(dialog.forum && topic === undefined) && trimmed !== "" ? { key, results: { query: trimmed, messages: [], loading: true } } : undefined;
    this.render();
    if (!this.search || !dialog) return;
    let results: NativeSearchResults;
    try {
      results = { query: trimmed, messages: (await this.api!.search(dialog.chatId, trimmed, SEARCH_LIMIT, topic)).map((m) => this.listedMessage(m, dialog)), loading: false };
    } catch (error) {
      results = { query: trimmed, messages: [], loading: false, error: `Search failed: ${friendly(error)}` };
    }
    if (count !== this.searchCount || this.search?.key !== key) return;
    this.search = { key, results };
    this.render();
  }

  /** Pins or unpins a message quietly; Telegram decides whether the user may, and announces the change, which updates the view. */
  private async pin(id: number, pin: boolean): Promise<void> {
    const chatId = this.selected;
    if (!chatId || !this.api) return;
    try {
      await this.api.pin(chatId, id, pin);
    } catch (error) {
      this.error = `${pin ? "Message not pinned" : "Message not unpinned"}: ${friendly(error)}`;
      return this.render();
    }
    this.onUpdate({ type: "pins", chatId, ids: [id], pinned: pin });
  }

  /** A message as the pins list shows it. */
  private listedMessage(message: TgMessage, dialog: TgDialog): NativeListedMessage {
    return {
      id: String(message.id),
      author: message.out ? (this.me?.name ?? "You") : (message.sender ?? dialog.title),
      content: messageText(message),
      timestamp: new Date(message.date * 1000).toISOString(),
    };
  }

  /** Lists a forum's topics afresh: up to TOPIC_LIMIT, most recently active first. */
  private async fetchTopics(chatId: string): Promise<void> {
    if (this.topicsLoading.has(chatId)) return;
    this.topicsLoading.add(chatId);
    this.render();
    const session = this.session;
    try {
      const topics = await this.api!.topics(chatId, TOPIC_LIMIT);
      if (session !== this.session) return;
      this.topics.set(chatId, topics.slice(0, TOPIC_LIMIT));
    } catch (error) {
      if (session !== this.session) return;
      this.error = `Could not load topics: ${friendly(error)}`;
    }
    this.topicsLoading.delete(chatId);
    this.render();
  }

  /** A topic's id in the view, given out once per sign-in. */
  private topicViewId(chatId: string, topic: number): string {
    const key = conversation(chatId, topic);
    let id = this.topicViewIds.get(key);
    if (!id) {
      id = String(TOPIC_VIEW_BASE + BigInt(this.topicViewIds.size + 1));
      this.topicViewIds.set(key, id);
      this.topicsByView.set(id, { chatId, topic });
    }
    return id;
  }

  private async fetchHistory(key: string, beforeId: number | undefined): Promise<void> {
    if (this.loading.has(key)) return;
    const [chatId, topic] = parseConversation(key);
    this.loading.add(key);
    this.render();
    try {
      const page = await this.api!.history(chatId, beforeId, PAGE_SIZE, topic);
      this.hasOlder.set(key, page.length === PAGE_SIZE);
      const known = this.messages.get(key) ?? [];
      const ids = new Set(known.map((m) => m.id));
      const fresh = page.filter((m) => !ids.has(m.id));
      this.messages.set(key, beforeId === undefined ? [...known, ...fresh].sort((a, b) => a.id - b.id) : [...fresh, ...known]);
    } catch (error) {
      this.error = `Could not load messages: ${friendly(error)}`;
    }
    this.loading.delete(key);
    this.render();
  }

  private async loadOlder(): Promise<void> {
    const key = this.current();
    const oldest = key ? this.messages.get(key)?.[0] : undefined;
    if (key && oldest && this.hasOlder.get(key)) await this.fetchHistory(key, oldest.id);
  }

  /** Marks a conversation read: a chat, or one topic of a forum (whose unread counts the chat's include). */
  private async markRead(key: string): Promise<void> {
    const [chatId, topic] = parseConversation(key);
    const dialog = this.dialog(chatId);
    if (!dialog) return;
    if (dialog.forum) {
      const found = topic === undefined ? undefined : this.topics.get(chatId)?.find((t) => t.id === topic);
      const last = this.messages.get(key)?.at(-1);
      if (!found || !last || (found.unreadCount === 0 && found.unreadMentions === 0)) return;
      dialog.unreadCount = Math.max(0, dialog.unreadCount - found.unreadCount);
      dialog.unreadMentions = Math.max(0, dialog.unreadMentions - found.unreadMentions);
      found.unreadCount = 0;
      found.unreadMentions = 0;
      found.readUpTo = last.id;
      this.publish();
      await this.api?.markRead(chatId, last.id, topic).catch(() => undefined);
      return;
    }
    const last = this.messages.get(key)?.at(-1) ?? dialog.lastMessage;
    if (!last || (dialog.unreadCount === 0 && dialog.unreadMentions === 0)) return;
    dialog.unreadCount = 0;
    dialog.unreadMentions = 0;
    dialog.readUpTo = last.id;
    this.publish();
    await this.api?.markRead(chatId, last.id).catch(() => undefined);
  }

  /** Starts a topic in the open forum with its first message, and opens it. */
  private async createTopic(title: string, content: string): Promise<void> {
    const chatId = this.selected;
    const dialog = chatId ? this.dialog(chatId) : undefined;
    const text = this.outgoing(content);
    if (!chatId || !dialog?.forum || this.topic !== undefined || !this.api || text.text.trim() === "") return;
    if (dialog.noTopics || dialog.readOnly) {
      this.error = "Only the group's admins start topics here.";
      return this.render();
    }
    await this.attempt("Topic not started", async () => {
      const topic = await this.api!.createTopic(chatId, title.trim());
      const sent = await this.api!.send(chatId, text, undefined, topic);
      // Listed at once; Telegram's own list follows when the forum is opened again.
      const topics = this.topics.get(chatId) ?? [];
      if (!topics.some((t) => t.id === topic)) this.topics.set(chatId, [{ id: topic, title: title.trim(), unreadCount: 0, unreadMentions: 0, date: sent.date }, ...topics].slice(0, TOPIC_LIMIT));
      this.messages.set(conversation(chatId, topic), [sent]);
      await this.select(chatId, topic);
    });
  }

  /**
   * The user's markdown as Telegram text for the open chat. Custom emoji go
   * as Telegram's own where the user may send them there; others as the
   * emoji they stand for.
   */
  private outgoing(content: string): TgText {
    const text = fromMarkdown(content);
    return { text: text.text, entities: text.entities.filter((e) => e.type !== "customEmoji" || this.maySendEmoji(this.emojiInfo.get(e.documentId!))) };
  }

  /**
   * Whether the user may send a custom emoji in the open chat: one Telegram
   * described this session, with Premium, or a free one, or any in Saved
   * Messages, where Telegram lets everyone try them.
   */
  private maySendEmoji(emoji: TgCustomEmoji | null | undefined): boolean {
    return emoji !== undefined && emoji !== null && (this.me?.premium === true || emoji.free === true || this.selected === this.me?.id);
  }

  private async attempt(what: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.error = `${what}: ${friendly(error)}`;
      this.render();
    }
  }

  /**
   * Sends the user's markdown as Telegram formatting, after the files picked
   * for it, each a message of its own: the text is the last one's caption
   * where it fits one, else a message after them, and a reply goes with the
   * first. Files sent are dropped from the list at once, so a failure part
   * way sends only the rest next time.
   */
  private async send(content: string, replyTo?: string): Promise<void> {
    const chatId = this.selected;
    const key = this.current();
    const dialog = chatId ? this.dialog(chatId) : undefined;
    const topic = this.topic;
    const text = this.outgoing(content);
    const files = key ? (this.pending.get(key) ?? []) : [];
    const hasText = text.text.trim() !== "";
    // A forum takes messages in its topics only.
    if (!chatId || !key || !dialog || !this.api || dialog.readOnly || (dialog.forum && topic === undefined) || this.uploading.has(key) || (!hasText && files.length === 0)) return;
    this.stopTyping(key);
    const reply = replyTo ? Number(replyTo) : undefined;
    const uploading = files.length > 0;
    if (uploading) {
      this.uploading.add(key);
      this.render();
    }
    const session = this.session;
    const captioned = uploading && hasText && text.text.length <= (this.me?.premium ? PREMIUM_CAPTION_LIMIT : CAPTION_LIMIT);
    await this.attempt("Message not sent", async () => {
      let first = true;
      while (files.length > 0) {
        const caption = files.length === 1 && captioned ? text : { text: "", entities: [] };
        const sent = await this.api!.sendFile(chatId, files[0]!, caption, first ? reply : undefined, topic);
        // Signed out meanwhile: the rest stays unsent.
        if (session !== this.session) return;
        files.shift();
        first = false;
        this.onUpdate({ type: "message", message: sent });
      }
      if (hasText && !captioned) this.onUpdate({ type: "message", message: await this.api!.send(chatId, text, first ? reply : undefined, topic) });
    });
    if (!uploading || session !== this.session) return;
    this.uploading.delete(key);
    if (files.length === 0) this.pending.delete(key);
    this.render();
  }

  /** Where the user may send files: a chat they may write in that does not bar media, with a file picker at hand. */
  private canAttach(dialog: TgDialog): boolean {
    return this.deps.files !== undefined && dialog.readOnly !== true && dialog.noMedia !== true && !(dialog.forum && this.topic === undefined);
  }

  /** Adds files from the OS picker to the open chat's next message, leaving out any that cannot be sent. */
  private async attach(): Promise<void> {
    const key = this.current();
    const dialog = this.selected ? this.dialog(this.selected) : undefined;
    if (!key || !dialog || !this.canAttach(dialog) || this.uploading.has(key)) return;
    await this.attempt("Could not attach", async () => {
      // Picked first: the shell lets the engine open the picker only right after the user asked.
      const picked = await this.deps.files!.pick();
      const list = this.pending.get(key) ?? [];
      for (const file of picked) {
        const name = file.filename.slice(0, 100) || "A file";
        if (list.length >= MAX_ATTACHMENTS) {
          this.error = `At most ${MAX_ATTACHMENTS} files per message.`;
          break;
        }
        if (file.size > MAX_UPLOAD_BYTES) this.error = `${name} is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB Multicord sends.`;
        else if (file.size <= 0) this.error = `${name} is empty.`;
        else list.push(file);
      }
      if (list.length > 0) this.pending.set(key, list);
      this.render();
    });
  }

  /**
   * A file the shell hands over (a favourite, or a sticker sent as a
   * picture): it goes out at once, or waits with files already picked.
   */
  private async sendShared(file: PickedFile, replyTo?: string): Promise<void> {
    const key = this.current();
    const dialog = this.selected ? this.dialog(this.selected) : undefined;
    if (!key || !dialog || !this.deps.files?.open || !this.canAttach(dialog) || this.uploading.has(key)) return;
    const list = this.pending.get(key) ?? [];
    if (list.length >= MAX_ATTACHMENTS) this.error = `At most ${MAX_ATTACHMENTS} files per message.`;
    else if (file.size > MAX_UPLOAD_BYTES || file.size <= 0) this.error = `${file.name.slice(0, 100)} cannot be sent.`;
    else {
      list.push(this.deps.files.open(file));
      this.pending.set(key, list);
      if (list.length === 1) return this.send("", replyTo);
    }
    this.render();
  }

  private async edit(messageId: string, content: string): Promise<void> {
    const chatId = this.selected;
    const text = this.outgoing(content);
    if (!chatId || !this.api || text.text.trim() === "") return;
    await this.attempt("Message not edited", async () => {
      const edited = await this.api!.edit(chatId, Number(messageId), text);
      this.onUpdate({ type: "edit", message: edited });
    });
  }

  private async remove(messageId: string): Promise<void> {
    const chatId = this.selected;
    if (!chatId || !this.api) return;
    await this.attempt("Message not deleted", async () => {
      await this.api!.remove(chatId, [Number(messageId)]);
      this.onUpdate({ type: "delete", chatId, ids: [Number(messageId)] });
    });
  }

  private onUpdate(update: TgUpdate): void {
    switch (update.type) {
      case "message": {
        const { message } = update;
        const dialog = this.dialog(message.chatId);
        // A chat we do not list yet (someone new, a group we were added to): refresh the list.
        if (!dialog) return this.refreshSoon();
        const key = this.conversationOf(message);
        const cached = this.messages.get(key);
        if (cached && !cached.some((m) => m.id === message.id)) cached.push(message);
        // Whoever sent it is done typing, as Telegram's apps show it.
        if (message.senderId) this.typing.get(key)?.delete(message.senderId);
        const topic = dialog.forum ? this.topics.get(message.chatId)?.find((t) => t.id === (message.topicId ?? GENERAL_TOPIC)) : undefined;
        if (topic) topic.date = Math.max(topic.date, message.date);
        if (message.id >= (dialog.lastMessage?.id ?? 0)) {
          dialog.lastMessage = message;
          dialog.date = message.date;
        }
        const inView = this.visible && this.current() === key;
        if (!message.out) {
          // In view: read at once, on the server too (there is no unread count to clear here).
          if (inView) void this.api?.markRead(message.chatId, message.id, dialog.forum ? (message.topicId ?? GENERAL_TOPIC) : undefined).catch(() => undefined);
          else {
            dialog.unreadCount++;
            if (message.mentioned && dialog.kind !== "user") dialog.unreadMentions++;
            if (topic) topic.unreadCount++;
            if (topic && message.mentioned) topic.unreadMentions++;
          }
          // A muted chat (or topic) stays quiet, except for a group message that mentions or answers the user, as in Telegram.
          if (!(topic ? this.topicMuted(dialog, topic) : this.muted(dialog)) || (message.mentioned && dialog.kind === "group")) {
            const text = messageText(message);
            this.notifications.emit({
              title: dialog.title,
              body: (dialog.kind === "group" && message.sender ? `${message.sender}: ${text}` : text).slice(0, 200),
              target: message.chatId,
              // Groups and channels live under the home entry; one-to-one chats have bubbles.
              railKey: dialog.kind === "user" ? `dm:${message.chatId}` : "home",
              inView,
            });
          }
        }
        this.dialogs.sort((a, b) => b.date - a.date);
        return this.publish();
      }
      case "edit": {
        const { message } = update;
        const cached = this.messages.get(this.conversationOf(message));
        const index = cached?.findIndex((m) => m.id === message.id) ?? -1;
        if (index >= 0) cached![index] = message;
        const dialog = this.dialog(message.chatId);
        if (dialog?.lastMessage?.id === message.id) dialog.lastMessage = message;
        return this.publish();
      }
      case "typing":
        return this.onTyping(update.chatId, update.userId, update.active, update.topicId);
      case "poll": {
        for (const list of this.messages.values()) {
          for (const [index, message] of list.entries()) {
            const poll = message.poll;
            if (poll?.id !== update.pollId) continue;
            // Results without the user's own choice keep the choice they had.
            const chosen = new Set(update.results.min ? (poll.results?.voters ?? []).filter((v) => v.chosen).map((v) => v.option) : []);
            const voters = update.results.voters.map((v) => (chosen.has(v.option) ? { ...v, chosen: true } : v));
            list[index] = { ...message, poll: { ...poll, closed: poll.closed || update.closed === true, results: { ...update.results, voters } } };
          }
        }
        return this.render();
      }
      case "archive": {
        for (const { chatId, archived } of update.peers) {
          const dialog = this.dialog(chatId);
          if (dialog && archived) dialog.archived = true;
          else if (dialog) delete dialog.archived;
        }
        // Archived chats leave the DM bubbles and the Messages page; unarchived ones come back.
        return this.publish();
      }
      case "notifyChat": {
        const dialog = this.dialog(update.chatId);
        if (!dialog) return;
        if (update.mutedUntil === undefined) delete dialog.mutedUntil;
        else dialog.mutedUntil = update.mutedUntil;
        return this.publish();
      }
      case "notifyDefault":
        this.notifyDefaults = { ...this.notifyDefaults, [update.kind]: update.mutedUntil };
        return this.publish();
      case "loginToken":
        if (this.step === "qr") void this.exportQr();
        return;
      case "folders":
        return void this.loadFolders();
      case "pins": {
        const ids = new Set(update.ids);
        for (const list of this.loaded(update.chatId)) for (const [index, message] of list.entries()) if (ids.has(message.id)) list[index] = { ...message, pinned: update.pinned };
        if (this.pins && parseConversation(this.pins.key)[0] === update.chatId) void this.loadPins(this.pins.key);
        return this.render();
      }
      case "reactions": {
        const cached = this.loaded(update.chatId).find((list) => list.some((m) => m.id === update.id));
        const index = cached?.findIndex((m) => m.id === update.id) ?? -1;
        if (index < 0) return;
        const before = cached![index]!;
        // Without the user's own choice in the update, what they gave stays as it was.
        const reactions = update.own ? update.reactions : update.reactions.map((r) => ({ ...r, chosen: before.reactions?.some((o) => o.emoji === r.emoji && o.chosen) === true }));
        cached![index] = { ...before, reactions };
        return this.render();
      }
      case "delete": {
        // Deletions in private chats and basic groups carry no chat id: message ids are unique per account
        // there. Supergroups and channels number their own messages, and name the chat.
        const ids = new Set(update.ids);
        const hit = (chatId: string) => (update.chatId ? update.chatId === chatId : !isChannelPeer(chatId));
        for (const [key, cached] of this.messages) if (hit(parseConversation(key)[0])) this.messages.set(key, cached.filter((m) => !ids.has(m.id)));
        for (const dialog of this.dialogs) if (hit(dialog.chatId) && dialog.lastMessage && ids.has(dialog.lastMessage.id)) dialog.lastMessage = undefined;
        return this.publish();
      }
    }
  }

  // --- Typing -------------------------------------------------------------------

  /** Tells the open chat the user is typing: at most once every TYPING_REPEAT_MS, as Telegram's apps repeat it. */
  private sendTyping(): void {
    const key = this.current();
    const dialog = this.selected ? this.dialog(this.selected) : undefined;
    if (!key || !dialog || dialog.readOnly || (dialog.forum && this.topic === undefined) || !this.api || !this.typingIndicators) return;
    const now = Date.now();
    if (this.ownTyping?.key === key && now - this.ownTyping.sent < TYPING_REPEAT_MS) return;
    this.ownTyping = { key, sent: now };
    // Best effort: a lost notice changes nothing shown.
    void this.api.typing(dialog.chatId, true, this.topic).catch(() => undefined);
  }

  /** Ends the user's typing notice in a conversation on sending, if it still shows. */
  private stopTyping(key: string): void {
    const own = this.ownTyping;
    if (own?.key !== key) return;
    this.ownTyping = undefined;
    const [chatId, topic] = parseConversation(key);
    if (Date.now() - own.sent < TYPING_SHOWN_MS) void this.api?.typing(chatId, false, topic).catch(() => undefined);
  }

  /** Someone started or stopped typing in a listed chat (in a forum, a topic); the user's own typing elsewhere is not shown. */
  private onTyping(chatId: string, userId: string, active: boolean, topic: number | undefined): void {
    const dialog = this.dialog(chatId);
    if (!dialog || userId === this.me?.id) return;
    const key = dialog.forum ? conversation(chatId, topic ?? GENERAL_TOPIC) : chatId;
    const people = this.typing.get(key) ?? new Map<string, number>();
    people.delete(userId);
    if (active && people.size < MAX_TYPING) people.set(userId, Date.now() + TYPING_SHOWN_MS);
    if (people.size > 0) this.typing.set(key, people);
    else this.typing.delete(key);
    if (active) void this.askName(chatId, userId);
    this.scheduleTyping();
    if (key === this.current()) this.render();
  }

  /** Re-renders when the next typing notice runs out. */
  private scheduleTyping(): void {
    clearTimeout(this.typingTimer);
    this.typingTimer = undefined;
    const next = Math.min(...[...this.typing.values()].flatMap((people) => [...people.values()]));
    if (!Number.isFinite(next)) return;
    this.typingTimer = setTimeout(() => {
      const now = Date.now();
      for (const [key, people] of this.typing) {
        for (const [userId, until] of people) if (until <= now) people.delete(userId);
        if (people.size === 0) this.typing.delete(key);
      }
      this.scheduleTyping();
      this.render();
    }, Math.max(0, next - Date.now()));
  }

  /** Who is typing in the open conversation, by name: a one-to-one chat's own title, or what is known of a group's members. */
  private typingNames(dialog: TgDialog): string[] {
    const now = Date.now();
    return [...(this.typing.get(this.current()!) ?? [])].filter(([, until]) => until > now).map(([userId]) => (dialog.kind === "user" ? dialog.title : (this.knownName(dialog.chatId, userId) ?? "Someone")));
  }

  /** A user's name from what the chat shows: its members, their messages, or what Telegram told. */
  private knownName(chatId: string, userId: string): string | undefined {
    return (
      this.memberLists.get(chatId)?.members.find((m) => m.id === userId)?.name ??
      this.loaded(chatId).flat().findLast((m) => m.senderId === userId && m.sender)?.sender ??
      this.names.get(userId)
    );
  }

  /** Asks Telegram once for the name of someone typing in a group, when the chat does not show it. */
  private async askName(chatId: string, userId: string): Promise<void> {
    if (this.dialog(chatId)?.kind === "user" || this.knownName(chatId, userId) || this.namesAsked.has(userId) || !this.api) return;
    this.namesAsked.add(userId);
    const session = this.session;
    const name = await this.api.userName(userId).catch(() => undefined);
    if (session !== this.session || !name) return;
    this.names.set(userId, name);
    this.render();
  }

  // --- Reactions ----------------------------------------------------------------

  /** Reactions are given where the user still is and the chat takes some. */
  private canReact(dialog: TgDialog): boolean {
    return dialog.left !== true && this.allowed.get(dialog.chatId)?.kind !== "none";
  }

  /** Asks once which reactions a group or channel takes, and which Telegram offers this user. */
  private async fetchAllowedReactions(chatId: string): Promise<void> {
    // Only an open chat is asked about, and chats are listed only while signed in.
    const api = this.api!;
    const session = this.session;
    if (!this.reactionListAsked) {
      this.reactionListAsked = true;
      const list = await api.reactionList().catch(() => []);
      if (session !== this.session) return;
      // Unknown, it is asked again next time; meanwhile Telegram decides when a reaction is given.
      if (list.length > 0) this.reactionList = list;
      else this.reactionListAsked = false;
    }
    if (!chatId.startsWith("-") || this.allowedAsked.has(chatId)) return;
    this.allowedAsked.add(chatId);
    try {
      const allowed = await api.allowedReactions(chatId);
      if (session !== this.session) return;
      this.allowed.set(chatId, allowed);
      this.render();
    } catch {
      // Asked again when the chat is opened next.
      if (session === this.session) this.allowedAsked.delete(chatId);
    }
  }

  /** Why a chat does not take this reaction, if it does not. Custom emoji take Premium; until a chat's rules are known, Telegram decides. */
  private refused(chatId: string, emoji: string): string | undefined {
    const allowed = this.allowed.get(chatId) ?? { kind: "all", custom: true };
    if (customReaction(emoji)) {
      if (this.me?.premium !== true) return "Reacting with custom emoji takes Telegram Premium.";
      const takes = allowed.kind === "some" ? allowed.emoji.includes(emoji) : allowed.kind === "all" && allowed.custom === true;
      return takes ? undefined : "This chat does not take this custom emoji as a reaction.";
    }
    if (allowed.kind === "some" && !allowed.emoji.includes(emoji)) return `This chat does not take ${viewEmoji(emoji)} as a reaction.`;
    if (allowed.kind === "all" && this.reactionList && !this.reactionList.includes(emoji)) return `Telegram does not offer ${viewEmoji(emoji)} as a reaction.`;
    return undefined;
  }

  /** Mutes or unmutes one topic of a forum in Telegram, for good, and follows it here at once; it then no longer follows its group. */
  private async muteTopic(chatId: string, id: number, mute: boolean): Promise<void> {
    const dialog = this.dialog(chatId);
    const topic = this.topics.get(chatId)?.find((t) => t.id === id);
    if (!dialog || !topic || !this.api || this.topicMuted(dialog, topic) === mute) return;
    await this.attempt(mute ? "Could not mute the topic" : "Could not unmute the topic", async () => {
      const until = mute ? MUTE_FOREVER : 0;
      await this.api!.mute(chatId, until, id);
      topic.mutedUntil = until;
      this.render();
    });
  }

  /** Mutes or unmutes a chat in Telegram, for good (as Telegram's apps do), and follows it here at once. */
  private async mute(chatId: string, mute: boolean): Promise<void> {
    const dialog = this.dialog(chatId);
    if (!dialog || !this.api || this.muted(dialog) === mute) return;
    await this.attempt(mute ? "Could not mute the chat" : "Could not unmute the chat", async () => {
      const until = mute ? MUTE_FOREVER : 0;
      await this.api!.mute(chatId, until);
      // Unmuted by its own setting, so a muting default no longer applies to it.
      dialog.mutedUntil = until;
      this.publish();
    });
  }

  /** Moves a chat into the archive or out of it in Telegram, and follows it here at once. Saved Messages stays out. */
  private async archive(chatId: string, archive: boolean): Promise<void> {
    const dialog = this.dialog(chatId);
    if (!dialog || !this.api || chatId === this.me?.id || (dialog.archived === true) === archive) return;
    await this.attempt(archive ? "Could not archive the chat" : "Could not move the chat out of the archive", async () => {
      await this.api!.archive(chatId, archive);
      this.onUpdate({ type: "archive", peers: [{ chatId, archived: archive }] });
    });
  }

  /**
   * Adds or removes one of the user's reactions. Telegram takes the user's
   * whole set: one reaction, or three with Premium, the oldest giving way
   * to a new one as in Telegram's apps.
   */
  private async react(messageId: string, key: string, add: boolean): Promise<void> {
    const chatId = this.selected;
    const dialog = chatId ? this.dialog(chatId) : undefined;
    const message = chatId ? this.messages.get(this.current()!)?.find((m) => m.id === Number(messageId)) : undefined;
    if (!chatId || !dialog || !message || !this.api || !this.canReact(dialog)) return;
    const emoji = reactionEmoji(key);
    const own = (message.reactions ?? []).filter((r) => r.chosen).map((r) => r.emoji);
    if (add === own.includes(emoji)) return;
    if (add) {
      const refusal = this.refused(chatId, emoji);
      if (refusal) {
        this.error = refusal;
        return this.render();
      }
    }
    const chosen = add ? [...own, emoji].slice(-(this.me?.premium ? PREMIUM_REACTIONS : 1)) : own.filter((e) => e !== emoji);
    await this.attempt("Reaction failed", async () => {
      await this.api!.react(chatId, message.id, chosen);
      this.onUpdate({ type: "reactions", chatId, id: message.id, reactions: withChosen(message.reactions ?? [], chosen), own: true });
    });
  }

  // --- Stickers -----------------------------------------------------------------

  /** Where the user may send stickers: a chat they may write in that does not bar stickers or media, in a forum within a topic. */
  private canSendStickers(dialog: TgDialog): boolean {
    return dialog.readOnly !== true && dialog.noStickers !== true && !(dialog.forum && this.topic === undefined);
  }

  /**
   * The composer's picker opened or closed. Sticker packs, with their
   * pictures as data: URLs, are in the view's state only while it is open,
   * so they do not travel with every update; they are fetched when it first
   * opens.
   */
  private setPickerOpen(open: boolean): void {
    this.pickerOpen = open;
    if (open && this.step === "chat") void this.loadStickers();
    this.render();
  }

  /**
   * Fetches the user's sticker packs once a session: their favourite and
   * recent stickers, then their installed sets, a few at once. Packs show as
   * they arrive; one that fails is left out.
   */
  private async loadStickers(): Promise<void> {
    if (this.stickersAsked) return;
    this.stickersAsked = true;
    const api = this.api!;
    const session = this.session;
    const sets = await api.stickerSets().catch(() => undefined);
    if (session !== this.session) return;
    // Asked again when the picker opens next.
    if (!sets) {
      this.stickersAsked = false;
      return;
    }
    const sources = [
      { id: FAVED_STICKERS, name: "Favourite stickers" },
      { id: RECENT_STICKERS, name: "Recent stickers" },
      ...sets.slice(0, STICKER_SET_LIMIT).map((s) => ({ id: s.id, name: s.title })),
    ];
    const packs: (StickerPack | undefined)[] = [];
    let next = 0;
    const worker = async () => {
      while (next < sources.length) {
        const index = next++;
        const source = sources[index]!;
        const stickers = await api.stickers(source.id).catch(() => []);
        if (session !== this.session) return;
        if (stickers.length === 0) continue;
        packs[index] = { id: source.id === FAVED_STICKERS || source.id === RECENT_STICKERS ? source.id : `set:${source.id}`, name: source.name, stickers };
        this.stickerPacks = packs.filter((p) => p !== undefined);
        this.renderSoon();
      }
    };
    await Promise.all(Array.from({ length: STICKER_SET_FETCHES }, worker));
  }

  /** Premium stickers only for Premium users; nothing that could not be loaded or kept, nor video stickers too large to load. */
  private offerable(sticker: TgSticker): boolean {
    // Stickers are fetched only once signed in, when the user is known.
    return (sticker.premium !== true || this.me!.premium === true) && !this.stickerFailed.has(sticker.id) && !(sticker.format === "webm" && (sticker.size ?? 0) > MAX_STICKER_BYTES);
  }

  /** The picker shows a still: an animated vector sticker's, or a static sticker too large to load whole. */
  private stillOnly(sticker: TgSticker): boolean {
    return sticker.format === "lottie" || (sticker.size ?? 0) > MAX_STICKER_BYTES;
  }

  /** The stickers offered, as many as the view shows: per pack and in all. */
  private offeredStickers(): NativeStickerPack[] {
    const packs: NativeStickerPack[] = [];
    let room = STICKER_LIMIT;
    for (const pack of this.stickerPacks) {
      const stickers: NativeSticker[] = [];
      for (const sticker of pack.stickers) {
        if (stickers.length >= PACK_STICKER_LIMIT || room <= 0) break;
        if (!this.offerable(sticker)) continue;
        stickers.push(this.nativeSticker(sticker));
        room--;
      }
      if (stickers.length > 0) packs.push({ id: pack.id, name: pack.name, stickers });
    }
    return packs;
  }

  private nativeSticker(sticker: TgSticker): NativeSticker {
    // A static sticker too large to load shows (and goes elsewhere) as its thumbnail, and says so.
    const preview = sticker.format === "webp" && this.stillOnly(sticker);
    const shown: NativeSticker = { id: STICKER_ID + sticker.id, name: `${sticker.emoji || "🙂"} sticker${preview ? " (small preview)" : ""}`, format: sticker.format };
    if (sticker.emoji) shown.emoji = sticker.emoji;
    const url = this.stickerMedia.get(sticker.id);
    if (url) shown.url = url;
    else shown.mediaKey = STICKER_KEY + sticker.id;
    return shown;
  }

  /** A sticker offered now, by its id in the view. */
  private offeredSticker(id: string): TgSticker | undefined {
    if (!this.offeredStickers().some((p) => p.stickers.some((s) => s.id === id))) return undefined;
    return this.stickerPacks.flatMap((p) => p.stickers).find((s) => STICKER_ID + s.id === id);
  }

  /**
   * Queues a sticker's picture for the open picker, once; the id comes from
   * the view's media key, so it must be one offered. Pictures are never
   * evicted (past the budget, stickers are no longer offered), so the
   * picker's requests cannot loop.
   */
  private loadSticker(id: string): void {
    const sticker = this.pickerOpen ? this.offeredSticker(STICKER_ID + id) : undefined;
    if (!sticker ||this.stickerMedia.has(id) || this.stickerQueued.has(id)) return;
    this.stickerQueued.add(id);
    this.stickerQueue.push(sticker);
    this.pumpStickers();
  }

  /** Starts queued sticker downloads, a few at once. */
  private pumpStickers(): void {
    while (this.stickerDownloads < STICKER_DOWNLOADS && this.stickerQueue.length > 0) {
      const sticker = this.stickerQueue.shift()!;
      this.stickerDownloads++;
      void this.downloadSticker(sticker).finally(() => {
        this.stickerDownloads--;
        this.pumpStickers();
      });
    }
  }

  /**
   * A sticker's picture as a data: URL: the WebP for static ones, the WebM
   * for video ones, the still thumbnail for animated vector ones (never the
   * TGS). Once the stickers' budget is spent, the rest are not offered.
   */
  private async downloadSticker(sticker: TgSticker): Promise<void> {
    const session = this.session;
    const still = this.stillOnly(sticker);
    const bytes = await this.api!.stickerFile(sticker.id, still).catch(() => undefined);
    if (session !== this.session) return;
    this.stickerQueued.delete(sticker.id);
    const url = bytes && bytes.length <= MAX_STICKER_BYTES ? `data:${still ? STICKER_MIME.lottie : STICKER_MIME[sticker.format]};base64,${toBase64(bytes)}` : undefined;
    if (url && this.stickerBytes + url.length <= (this.deps.stickerBudget ?? STICKER_CACHE_BYTES)) {
      this.stickerMedia.set(sticker.id, url);
      this.stickerBytes += url.length;
    } else {
      this.stickerFailed.add(sticker.id);
    }
    this.renderSoon();
  }

  /** Sends one of the stickers offered as a sticker, into the open chat or topic. */
  private async sendSticker(stickerId: string, replyTo?: string): Promise<void> {
    // Chats are selected only while signed in.
    const dialog = this.selected ? this.dialog(this.selected) : undefined;
    const sticker = this.offeredSticker(stickerId);
    if (!dialog || !this.canSendStickers(dialog) || !sticker) return;
    this.stopTyping(this.current()!);
    const topic = this.topic;
    await this.attempt("Sticker not sent", async () => {
      this.onUpdate({ type: "message", message: await this.api!.sendSticker(dialog.chatId, sticker.id, replyTo ? Number(replyTo) : undefined, topic) });
    });
  }

  /** Updates the view soon, gathering what arrives meanwhile (stickers' pictures, packs). */
  private renderSoon(): void {
    if (this.stickerRenderTimer) return;
    this.stickerRenderTimer = setTimeout(() => {
      this.stickerRenderTimer = undefined;
      this.render();
    }, STICKER_RENDER_MS);
  }

  // --- Custom emoji -------------------------------------------------------------

  /**
   * Pictures of the custom emoji in these messages (in their text and
   * reactions, the newest messages' first), by document id, for the view's
   * emojiUrls. Those not yet asked about are, within the session's limit.
   */
  private shownEmoji(messages: readonly TgMessage[]): Record<string, string> {
    const ids = new Set<string>();
    for (const message of [...messages].reverse()) {
      for (const id of customEmojiIds(message.entities)) ids.add(id);
      for (const r of message.reactions ?? []) ids.add(customReaction(r.emoji) ?? "");
    }
    ids.delete("");
    const shown = [...ids].slice(0, MAX_CUSTOM_EMOJI);
    this.wantEmoji(shown);
    return Object.fromEntries(shown.flatMap((id) => (this.emojiPictures.has(id) ? [[id, this.emojiPictures.get(id)!]] : [])));
  }

  /** Notes emoji to ask Telegram about, each once a session and at most EMOJI_LIMIT, and asks. */
  private wantEmoji(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.emojiInfo.has(id) || this.emojiWanted.has(id)) continue;
      if (this.emojiInfo.size + this.emojiWanted.size >= EMOJI_LIMIT) break;
      this.emojiWanted.add(id);
    }
    if (this.emojiWanted.size > 0) void this.describeEmoji();
  }

  /**
   * Asks Telegram about the wanted emoji, a batch at a time, and loads their
   * pictures. Those it does not describe (or a request that fails) show as
   * their emoji for the rest of the session, so no update asks again.
   */
  private async describeEmoji(): Promise<void> {
    if (this.emojiDescribing) return;
    this.emojiDescribing = true;
    // Emoji are wanted only while a chat shows, so while signed in.
    const api = this.api!;
    const session = this.session;
    while (this.emojiWanted.size > 0) {
      const ids = [...this.emojiWanted].slice(0, CUSTOM_EMOJI_BATCH);
      const found = await api.customEmoji(ids).catch((): TgCustomEmoji[] => []);
      if (session !== this.session) return;
      for (const id of ids) {
        this.emojiWanted.delete(id);
        this.emojiInfo.set(id, found.find((e) => e.id === id) ?? null);
      }
      for (const id of ids) {
        const emoji = this.emojiInfo.get(id);
        if (emoji) this.loadEmoji(emoji);
      }
    }
    this.emojiDescribing = false;
  }

  /** Queues a described emoji's picture, once. */
  private loadEmoji(emoji: TgCustomEmoji): void {
    if (this.emojiPictures.has(emoji.id) || this.emojiFailed.has(emoji.id) || this.emojiQueued.has(emoji.id)) return;
    this.emojiQueued.add(emoji.id);
    this.emojiQueue.push(emoji);
    this.pumpEmoji();
  }

  /** Starts queued emoji downloads, a few at once. */
  private pumpEmoji(): void {
    while (this.emojiDownloads < EMOJI_DOWNLOADS && this.emojiQueue.length > 0) {
      const emoji = this.emojiQueue.shift()!;
      this.emojiDownloads++;
      void this.downloadEmoji(emoji).finally(() => {
        this.emojiDownloads--;
        this.pumpEmoji();
      });
    }
  }

  /**
   * A custom emoji's picture as a data: URL: the WebP itself for static
   * ones, the still thumbnail for animated (TGS) and video (WebM) ones, never
   * those files. Without a picture, or past the budget, it shows as its
   * emoji. Pictures are never evicted, so the view's pictures stay put.
   */
  private async downloadEmoji(emoji: TgCustomEmoji): Promise<void> {
    const session = this.session;
    const still = emoji.format !== "webp" || (emoji.size ?? 0) > MAX_EMOJI_BYTES;
    const bytes = await this.api!.customEmojiFile(emoji.id, still).catch(() => undefined);
    if (session !== this.session) return;
    this.emojiQueued.delete(emoji.id);
    const url = bytes && bytes.length <= MAX_EMOJI_BYTES ? `data:image/webp;base64,${toBase64(bytes)}` : undefined;
    if (url && this.emojiBytes + url.length <= (this.deps.emojiBudget ?? EMOJI_CACHE_BYTES)) {
      this.emojiPictures.set(emoji.id, url);
      this.emojiBytes += url.length;
      this.renderSoon();
    } else {
      this.emojiFailed.add(emoji.id);
    }
  }

  /** A reaction as the view shows it: an emoji, or a custom emoji's picture (its emoji until the picture loads). */
  private nativeReaction(r: TgReaction): NativeReaction {
    const id = customReaction(r.emoji);
    if (!id) return { key: viewEmoji(r.emoji), label: viewEmoji(r.emoji), count: r.count, me: r.chosen };
    const reaction: NativeReaction = { key: r.emoji, label: this.emojiInfo.get(id)?.emoji || "Custom emoji", count: r.count, me: r.chosen };
    const url = this.emojiPictures.get(id);
    if (url) reaction.imageUrl = url;
    return reaction;
  }

  // --- Members and profiles -----------------------------------------------------

  /** Telegram lets the user see who is in this chat, as far as is known. */
  private canListMembers(dialog: TgDialog): boolean {
    return dialog.members === true && !this.membersHidden.has(dialog.chatId);
  }

  /** The view's member panel opened (fetching the open chat's members afresh) or closed. */
  private async setMembersOpen(open: boolean): Promise<void> {
    this.membersOpen = open;
    if (!open || !this.selected) return this.render();
    this.memberLists.delete(this.selected);
    await this.fetchMembers(this.selected);
  }

  /** The next page for the panel; `offset` is how many the view lists, so a page already asked for is not asked again. */
  private async loadMembers(offset: number): Promise<void> {
    const list = this.selected ? this.memberLists.get(this.selected) : undefined;
    if (!this.membersOpen || !list || list.loading || list.next === undefined || offset !== list.members.length) return;
    await this.fetchMembers(this.selected!);
  }

  private async fetchMembers(chatId: string): Promise<void> {
    const dialog = this.dialog(chatId);
    const api = this.api;
    if (!dialog || !api || !this.canListMembers(dialog)) return this.render();
    // A first page, or the next (loadMembers checks there is one and that it is not being fetched).
    const list = this.memberLists.get(chatId) ?? { members: [], total: 0, loading: false };
    list.loading = true;
    list.error = undefined;
    this.memberLists.set(chatId, list);
    this.render();
    const session = this.session;
    try {
      const page = await api.members(chatId, list.next ?? 0, MEMBER_PAGE);
      if (session !== this.session) return;
      if (page.hidden) return this.hideMembers(chatId);
      const known = new Set(list.members.map((m) => m.id));
      list.members.push(...page.members.filter((m) => !known.has(m.id)).slice(0, MEMBER_LIMIT - list.members.length));
      list.total = page.total;
      list.next = list.members.length < MEMBER_LIMIT ? page.next : undefined;
    } catch (error) {
      if (session !== this.session) return;
      // Groups that hide their members from all but admins.
      if (telegramError(error) === "CHAT_ADMIN_REQUIRED") return this.hideMembers(chatId);
      list.error = `Could not load members: ${friendly(error)}`;
    }
    list.loading = false;
    this.render();
    await this.loadMemberAvatars(list);
  }

  /** Telegram does not show the user this chat's members: the view stops offering them. */
  private hideMembers(chatId: string): void {
    this.membersHidden.add(chatId);
    this.memberLists.delete(chatId);
    this.render();
  }

  /** Pictures for the first members, once each; the rest show initials. */
  private async loadMemberAvatars(list: MemberList): Promise<void> {
    const session = this.session;
    let found = false;
    for (const member of list.members.slice(0, MEMBER_AVATAR_LIMIT)) {
      if (this.avatars.has(member.id) || this.avatarsAsked.has(member.id) || !this.api) continue;
      this.avatarsAsked.add(member.id);
      const url = await this.api.avatar(member.id).catch(() => undefined);
      if (session !== this.session) return;
      if (url) {
        this.avatars.set(member.id, url);
        found = true;
      }
    }
    if (found) this.render();
  }

  /** The member panel's list for a chat: admins, then members, those online first. */
  private memberView(dialog: TgDialog): NativeMemberList | undefined {
    const list = this.memberLists.get(dialog.chatId);
    if (!this.membersOpen || !list || !this.canListMembers(dialog)) return undefined;
    const rank = (m: TgMember) => (m.presence === "online" ? 0 : m.presence === "recently" ? 1 : 2);
    const sorted = [...list.members].sort((a, b) => rank(a) - rank(b));
    const admins = sorted.filter((m) => m.role).sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"));
    const others = sorted.filter((m) => !m.role);
    const sections = [];
    if (admins.length > 0) sections.push({ name: "Admins", members: admins.map((m) => this.nativeMember(m)) });
    if (others.length > 0) sections.push({ name: "Members", members: others.map((m) => this.nativeMember(m)) });
    const view: NativeMemberList = { sections, hasMore: list.next !== undefined, loading: list.loading };
    // Those not fetched: past the last page there are none to count, however Telegram counts.
    const more = list.next !== undefined || list.members.length >= MEMBER_LIMIT ? list.total - list.members.length : 0;
    if (more > 0) view.more = more;
    if (list.error) view.error = list.error;
    return view;
  }

  private nativeMember(member: TgMember): NativeMember {
    const row: NativeMember = { id: member.id, name: member.id === this.me?.id ? this.me.name : member.name, presence: member.presence === "online" ? "online" : "offline" };
    const avatar = this.avatars.get(member.id);
    if (avatar) row.avatarUrl = avatar;
    const status = member.rank ?? (member.bot ? "Bot" : member.presence === "recently" ? "last seen recently" : undefined);
    if (status) row.status = status;
    if (member.username) row.mention = `@${member.username}`;
    return row;
  }

  /**
   * A user's profile card: what the open chat's member list knows at once
   * (their role), then their name, username, bio and picture from Telegram.
   * Only what Telegram shows other users; never a phone number.
   */
  private async showProfile(id: string): Promise<void> {
    const api = this.api;
    if (!/^\d{1,18}$/.test(id) || !api) return;
    const member = this.selected ? this.memberLists.get(this.selected)?.members.find((m) => m.id === id) : undefined;
    const profile: NativeProfile = { id, loading: true };
    if (member?.role) profile.roles = [{ name: member.rank ?? (member.role === "owner" ? "Owner" : "Admin") }];
    const known = this.avatars.get(id);
    if (known) profile.avatarUrl = known;
    this.profile = profile;
    this.render();
    const session = this.session;
    const current = () => session === this.session && this.profile === profile;
    try {
      const found = await api.profile(id);
      if (!current()) return;
      Object.assign(profile, this.profileView(found));
    } catch {
      // Telegram may not know the user from here; the card keeps what the view has.
    }
    if (!current()) return;
    if (!known && !this.avatarsAsked.has(id)) {
      this.avatarsAsked.add(id);
      const url = await api.avatar(id).catch(() => undefined);
      if (!current()) return;
      if (url) this.avatars.set(id, url);
      if (url) profile.avatarUrl = url;
    }
    delete profile.loading;
    this.render();
  }

  private profileView(found: TgProfile): Partial<NativeProfile> {
    const view: Partial<NativeProfile> = { name: found.id === this.me?.id ? this.me.name : found.name, presence: found.presence === "online" ? "online" : "offline" };
    const status = found.bot ? "Bot" : found.presence === "recently" ? "last seen recently" : undefined;
    if (status) view.status = status;
    if (found.username) view.username = found.username;
    if (found.about) view.about = found.about;
    return view;
  }

  // --- Output -------------------------------------------------------------------

  /**
   * One-to-one chats for DM bubbles and the Messages page, which add to the
   * badges. Groups and channels are rooms, under home, as Matrix rooms are.
   * Archived chats stay out, as Telegram keeps them out of its chat list:
   * an unmuted one that gets a message is moved out of the archive by
   * Telegram itself (unless the user keeps such chats archived), and the
   * update that says so brings it back here. Muted ones stay archived.
   */
  directs(): DirectConversation[] {
    return this.dialogs.filter((d) => d.kind === "user" && !d.archived).map((d) => {
      const direct: DirectConversation = {
        key: d.chatId,
        account: this.account,
        title: d.title,
        lastActivity: d.date * 1000,
        ...this.badge(d),
      };
      const avatar = this.avatars.get(d.chatId);
      if (avatar) direct.avatarUrl = avatar;
      if (d.lastMessage) direct.preview = messageText(d.lastMessage).replace(/\s+/g, " ").slice(0, 200);
      return direct;
    });
  }

  private publish(): void {
    this.directsChanged.emit(this.directs());
    this.render();
  }

  private toNative(message: TgMessage, dialog: TgDialog): NativeMessage {
    const replied = message.replyToId ? this.messages.get(this.conversationOf(message))?.find((m) => m.id === message.replyToId) : undefined;
    const markdown = this.markdown(message);
    const native: NativeMessage = {
      id: String(message.id),
      author: message.out ? (this.me?.name ?? "You") : (message.sender ?? dialog.title),
      // Shown media speaks for itself; a label stays for what is not shown (locations, polls…).
      content: message.file || message.poll || !message.media ? markdown : [markdown, escapeText(message.media)].filter(Boolean).join("\n"),
      timestamp: new Date(message.date * 1000).toISOString(),
      edited: message.edited,
      mine: message.out,
      canEdit: message.out && message.text !== "",
      canDelete: message.out,
      reactions: (message.reactions ?? []).map((r) => this.nativeReaction(r)),
      attachments: message.file ? [this.attachment(message, message.file)] : [],
    };
    // Edited as the markdown it shows, so formatting survives the edit.
    // Custom emoji stay custom emoji in the edit, their pictures loaded or not.
    if (native.canEdit) native.source = message.entities?.some((e) => e.type === "customEmoji") ? toMarkdown(message.text, message.entities, () => true) : markdown;
    if (message.pinned) native.pinned = true;
    if (message.poll) native.poll = this.pollView(message.poll, dialog, message.out);
    // Who may pin in a group is up to its admins, and Telegram refuses where the user may not; in a forum, within the message's topic.
    if (!dialog.readOnly) native.canPin = true;
    // Telegram's own flag: it mentions the user, or answers one of their messages.
    if (message.mentioned && !message.out) native.mentionsMe = true;
    // Telegram turns "@username" into a mention as it is sent; people without a username are mentioned by name, as plain text.
    if (message.senderUsername && !message.out) native.authorMention = `@${message.senderUsername}`;
    const authorId = message.out ? this.me?.id : message.senderId;
    if (authorId) native.authorId = authorId;
    if (replied) native.reply = { author: replied.out ? (this.me?.name ?? "You") : (replied.sender ?? dialog.title), content: messageText(replied).slice(0, 100) };
    if (message.preview) native.embeds = [this.embed(message, message.preview)];
    return native;
  }

  /** A link preview; its photo loads on request, as the message's media. */
  private embed(message: TgMessage, preview: TgPreview): NativeEmbed {
    const { photo, ...text } = preview;
    const embed: NativeEmbed = text;
    const shown = photo && this.attachment(message, photo);
    if (shown && (shown.url || shown.mediaKey)) embed.image = { url: shown.url, mediaKey: shown.mediaKey, width: shown.width, height: shown.height, size: shown.size, thumbnail: true };
    return embed;
  }

  /** A poll as the view shows it: its answers by their place, with votes where Telegram shows them. Voting needs a chat the user is still in. */
  private pollView(poll: TgPoll, dialog: TgDialog, mine: boolean): NativePoll {
    const results = new Map((poll.results?.voters ?? []).map((v) => [v.option, v]));
    const options = poll.answers.map((answer, index): NativePollOption => {
      const option: NativePollOption = { id: String(index), text: answer.text };
      const counted = results.get(answer.option);
      if (counted) option.votes = counted.votes;
      if (counted?.chosen) option.chosen = true;
      if (counted?.correct) option.correct = true;
      return option;
    });
    const view: NativePoll = { question: poll.question, options, multiple: poll.multiple, closed: poll.closed };
    if (poll.results?.total !== undefined) view.total = poll.results.total;
    if (!poll.closed && !dialog.left) view.canVote = true;
    // The user's own polls end from here; quizzes, which they start elsewhere, stay as Telegram's apps end them.
    if (!poll.closed && !dialog.left && mine && !poll.quiz) view.canEnd = true;
    return view;
  }

  /** Where the user may start a poll: a group or channel they may write and start polls in (in a forum, a topic). */
  private canPoll(dialog: TgDialog): boolean {
    return dialog.kind !== "user" && dialog.readOnly !== true && dialog.noPolls !== true && dialog.left !== true && !(dialog.forum && this.topic === undefined);
  }

  /**
   * Starts a poll in the open chat (in a forum, in the open topic). Votes
   * stay anonymous unless the user chose otherwise in a group; channels
   * take anonymous polls only.
   */
  private async createPoll(question: string, answers: string[], multiple: boolean, anonymous: boolean | undefined): Promise<void> {
    // Chats are selected only while signed in.
    const dialog = this.selected ? this.dialog(this.selected) : undefined;
    if (!dialog || !this.canPoll(dialog)) return;
    const topic = this.topic;
    const publicVoters = dialog.kind === "group" && anonymous === false;
    await this.attempt("Poll not sent", async () => {
      this.onUpdate({ type: "message", message: await this.api!.sendPoll(dialog.chatId, { question, answers, multiple, publicVoters }, topic) });
    });
  }

  /** Ends a poll the user sent in the open conversation; it shows as ended at once, and Telegram's update brings the final results. */
  private async endPoll(messageId: number): Promise<void> {
    const key = this.current();
    const message = key ? this.messages.get(key)?.find((m) => m.id === messageId) : undefined;
    const poll = message?.poll;
    if (!poll || !message.out || poll.closed || poll.quiz || this.dialog(message.chatId)?.left) return;
    await this.attempt("Poll not ended", async () => {
      await this.api!.closePoll(message.chatId, message.id, poll);
      this.onUpdate({ type: "poll", pollId: poll.id, results: poll.results ?? { voters: [], min: true }, closed: true });
    });
  }

  /** Votes in a poll of the open conversation; Telegram's update then shows the new results. */
  private async vote(messageId: number, ids: string[]): Promise<void> {
    const key = this.current();
    const message = key ? this.messages.get(key)?.find((m) => m.id === messageId) : undefined;
    const poll = message?.poll;
    if (!poll || poll.closed) return;
    const options = ids.flatMap((id) => poll.answers[Number(id)]?.option ?? []);
    if (options.length !== ids.length || (!poll.multiple && options.length > 1)) return;
    try {
      await this.api!.vote(message.chatId, message.id, options);
    } catch (error) {
      this.error = `Vote not counted: ${friendly(error)}`;
      this.render();
    }
  }

  /**
   * A message's text as markdown for the view, worked out once per message,
   * and again for one with custom emoji as their pictures arrive: those
   * loaded show as pictures, the rest as their emoji.
   */
  private markdown(message: TgMessage): string {
    const cached = this.markdownOf.get(message);
    const pictures = this.emojiPictures.size;
    if (cached && (cached.pictures === pictures || !message.entities?.some((e) => e.type === "customEmoji"))) return cached.markdown;
    const markdown = toMarkdown(message.text, message.entities, (id) => this.emojiPictures.has(id));
    this.markdownOf.set(message, { markdown, pictures });
    return markdown;
  }

  private attachment(message: TgMessage, file: TgFile): NativeAttachment {
    const key = `tg:${message.chatId}:${message.id}`;
    const shown: NativeAttachment = { name: file.name, kind: file.kind, mime: file.mime, size: file.size, width: file.width, height: file.height };
    if (file.loop) shown.loop = true;
    const url = this.media.get(key);
    // An animated vector sticker's still: the view shows it as one, labelled.
    if (url && file.thumbnailOnly) shown.previewUrl = url;
    else if (url) shown.url = url;
    else if (this.mediaFailed.has(key)) shown.unavailable = this.mediaFailed.get(key);
    else if (file.size !== undefined && file.size > MAX_MEDIA_BYTES) shown.unavailable = "too large to show here; open it in Telegram";
    else shown.mediaKey = key;
    return shown;
  }

  /** Downloads a message's media for the view, once; keys come from the view, so they are checked. */
  private async loadMedia(key: string): Promise<void> {
    const match = /^tg:(-?\d{1,20}):(\d{1,12})$/.exec(key);
    if (!match || !this.api || this.media.has(key) || this.mediaLoading.has(key)) return;
    const [, chatId, id] = match;
    const message = this.loaded(chatId!).flat().find((m) => m.id === Number(id));
    // A message's own media, or else its link preview's photo, which Telegram downloads in its place.
    const file = message?.file ?? message?.preview?.photo;
    if (!file) return;
    this.mediaLoading.add(key);
    try {
      const bytes = await this.api.download(chatId!, message!.id, file.thumbnailOnly === true);
      if (!bytes) this.mediaFailed.set(key, "not available");
      else if (bytes.length > MAX_MEDIA_BYTES) this.mediaFailed.set(key, "too large to show here; open it in Telegram");
      else this.remember(key, `data:${file.thumbnailOnly ? STICKER_MIME.lottie : (file.mime ?? "application/octet-stream")};base64,${toBase64(bytes)}`);
    } catch (error) {
      this.mediaFailed.set(key, `could not load: ${friendly(error)}`);
    } finally {
      this.mediaLoading.delete(key);
    }
    this.render();
  }

  private remember(key: string, url: string): void {
    this.media.set(key, url);
    this.mediaBytes += url.length;
    for (const [old, kept] of this.media) {
      if (this.mediaBytes <= (this.deps.mediaBudget ?? MEDIA_CACHE_BYTES) || old === key) break;
      this.media.delete(old);
      this.mediaBytes -= kept.length;
    }
  }

  /** A forum's topics as listed: pinned ones first, then the most recently active. */
  private topicList(chatId: string): TgTopic[] {
    return [...(this.topics.get(chatId) ?? [])].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.date - a.date);
  }

  /** The open conversation: a chat, a forum's topic list, or one of its topics. */
  private channelView(dialog: TgDialog): NativeChannelView {
    const locked = dialog.readOnly ? (dialog.kind === "channel" ? "Only the channel's admins post here." : "You cannot send messages in this group.") : undefined;
    const members = this.memberView(dialog);
    const shared = { ...(locked ? { locked } : {}), ...(members ? { members } : {}) };
    if (dialog.forum && this.topic === undefined) {
      // The topic list: new topics come from its own form, messages only within topics.
      const posts = this.topicList(dialog.chatId).map((t): NativeForumPost => ({ id: this.topicViewId(dialog.chatId, t.id), name: t.title, unread: t.unreadCount > 0, mentions: t.unreadMentions }));
      return {
        id: viewId(dialog.chatId),
        name: dialog.title,
        messages: [],
        loading: this.topicsLoading.has(dialog.chatId),
        hasOlder: false,
        typing: [],
        pending: [],
        uploading: false,
        posts,
        ...shared,
        can: { reply: false, react: false, attach: false, typing: false, members: this.canListMembers(dialog) },
      };
    }
    const key = this.current()!;
    const topic = this.topic === undefined ? undefined : this.topics.get(dialog.chatId)?.find((t) => t.id === this.topic);
    return {
      id: this.topic === undefined ? viewId(dialog.chatId) : this.topicViewId(dialog.chatId, this.topic),
      name: topic ? `${dialog.title} › ${topic.title}` : dialog.title,
      messages: (this.messages.get(key) ?? []).map((m) => this.toNative(m, dialog)),
      loading: this.loading.has(key),
      hasOlder: this.hasOlder.get(key) ?? false,
      typing: this.typingNames(dialog),
      pending: (this.pending.get(key) ?? []).map((f) => ({ name: f.filename, size: f.size })),
      uploading: this.uploading.has(key),
      ...shared,
      ...(this.unreadAt?.key === key ? { unread: this.unreadView(key, this.unreadAt) } : {}),
      ...(this.pins?.key === key ? { pins: this.pins.list } : {}),
      ...(this.search?.key === key ? { search: this.search.results } : {}),
      can: { reply: !locked, react: this.canReact(dialog), attach: this.canAttach(dialog), typing: !locked && this.typingIndicators, members: this.canListMembers(dialog), stickers: this.canSendStickers(dialog), pins: true, search: true, forward: true, polls: this.canPoll(dialog), anonymousPolls: this.canPoll(dialog) && dialog.kind === "group" },
    };
  }

  // --- Folders ------------------------------------------------------------------

  /** Fetches the user's chat folders; the sidebar goes back to all chats if the one it shows is gone. */
  /** Reads the user's default mutes, which chats without a mute of their own follow; unmuted while Telegram does not answer. */
  private async loadNotifyDefaults(): Promise<void> {
    const session = this.session;
    const defaults = await this.api!.notifyDefaults().catch(() => undefined);
    if (session !== this.session || !defaults) return;
    this.notifyDefaults = defaults;
    this.publish();
  }

  private async loadFolders(): Promise<void> {
    const session = this.session;
    const folders = await this.api!.folders().catch(() => undefined);
    // Kept as they were when Telegram does not answer.
    if (session !== this.session || !folders) return;
    this.folders = folders;
    if (!folders.some((f) => f.id === this.folder)) this.folder = ALL_CHATS;
    this.render();
  }

  /** Shows a folder in the sidebar, by its tab's id. */
  private showFolder(id: string): void {
    const found = id === "all" ? ALL_CHATS : /^f\d{1,9}$/.test(id) ? this.folders.find((f) => `f${f.id}` === id)?.id : undefined;
    if (found === undefined) return;
    this.folder = found;
    this.render();
  }

  /** Whether a folder takes a chat, by Telegram's rules: named in it, else not left out, of a kind it takes, and not muted, read or archived where it leaves those out. */
  private inFolder(folder: TgFolder, d: TgDialog): boolean {
    if (folder.include.includes(d.chatId)) return true;
    if (folder.exclude.includes(d.chatId)) return false;
    const user = d.bot ? folder.bots : d.contact ? folder.contacts : folder.nonContacts;
    const kind = d.kind === "user" ? user : d.kind === "group" ? folder.groups : folder.broadcasts;
    if (kind !== true) return false;
    if (folder.excludeMuted && this.muted(d)) return false;
    if (folder.excludeRead && d.unreadCount === 0) return false;
    return !(folder.excludeArchived && d.archived);
  }

  /** The folder tabs, in the user's order, with "All chats" where they placed it; none until they have a folder. */
  private folderTabs(): NativeFolder[] | undefined {
    if (!this.folders.some((f) => f.id !== ALL_CHATS)) return undefined;
    const list = this.folders.some((f) => f.id === ALL_CHATS) ? this.folders : [{ id: ALL_CHATS, title: "All chats", include: [], exclude: [] }, ...this.folders];
    return list.slice(0, MAX_FOLDERS).map((f) => {
      const badges = this.dialogs.filter((d) => (f.id === ALL_CHATS ? true : this.inFolder(f, d))).map((d) => this.badge(d));
      return { id: f.id === ALL_CHATS ? "all" : `f${f.id}`, name: f.title, active: f.id === this.folder, unread: badges.some((b) => b.unread), mentions: badges.reduce((sum, b) => sum + b.mentions, 0) };
    });
  }

  /** A chat's row in the sidebar; an open forum lists its topics under it. */
  private sidebarRows(d: TgDialog): NativeSidebarItem[] {
    // Every chat shows its picture, so all are "dm" rows.
    const selected = d.chatId === this.selected;
    const item: NativeSidebarItem = { id: viewId(d.chatId), name: d.title, kind: "dm", ...this.badge(d), active: selected && this.topic === undefined, muted: this.muted(d), canMute: true };
    const avatar = this.avatars.get(d.chatId);
    if (avatar) item.iconUrl = avatar;
    if (d.archived) item.archived = true;
    // Saved Messages cannot be archived.
    if (d.chatId !== this.me?.id) item.canArchive = true;
    const rows = [item];
    if (d.forum && selected) {
      for (const t of this.topicList(d.chatId)) rows.push({ id: this.topicViewId(d.chatId, t.id), name: t.title, kind: "thread", unread: t.unreadCount > 0, mentions: t.unreadMentions, active: t.id === this.topic, muted: this.topicMuted(d, t), canMute: true });
    }
    return rows;
  }

  private viewState(): NativeViewState {
    const platform = this.deps.def.name;
    if (this.step === "connecting") return { screen: "connecting", platform, status: this.status ?? "Connecting…" };
    if (this.step !== "chat") return { screen: "prompt", platform, prompt: this.prompt(), busy: this.busy, status: this.status, error: this.error };
    const sidebar: NativeSidebarItem[] = [];
    const folder = this.folders.find((f) => f.id === this.folder && f.id !== ALL_CHATS);
    // A folder lists its chats by kind, archived ones among them; all chats keep the archive apart.
    const listed = this.dialogs.filter((d) => (folder ? this.inFolder(folder, d) : !d.archived));
    for (const [kind, heading] of SECTIONS) {
      const dialogs = listed.filter((d) => d.kind === kind);
      if (dialogs.length === 0) continue;
      sidebar.push({ id: `section-${kind}`, name: heading, kind: "category", unread: false, mentions: 0, active: false });
      for (const d of dialogs) sidebar.push(...this.sidebarRows(d));
    }
    // Archived chats of every kind, in a section of their own that starts folded, as in Telegram's apps.
    const archived = folder ? [] : this.dialogs.filter((d) => d.archived);
    const folders = this.folderTabs();
    if (archived.length > 0) {
      const badges = archived.map((d) => this.badge(d));
      sidebar.push({ id: "section-archive", name: "Archive", kind: "category", unread: badges.some((b) => b.unread), mentions: badges.reduce((sum, b) => sum + b.mentions, 0), active: false, collapsible: true, collapsed: true });
      for (const d of archived) sidebar.push(...this.sidebarRows(d));
    }
    const dialog = this.selected ? this.dialog(this.selected) : undefined;
    // Stickers only while the picker is open, and only where they go as stickers: elsewhere the shell would send them as files, round a chat's rules.
    const stickers = this.pickerOpen && dialog && this.canSendStickers(dialog) ? this.offeredStickers() : [];
    // Pictures of the custom emoji in the open conversation's messages, which load as they show.
    const emojiUrls = dialog && !(dialog.forum && this.topic === undefined) ? this.shownEmoji(this.messages.get(this.current()!) ?? []) : {};
    return {
      screen: "chat",
      platform,
      title: "Chats",
      me: this.me?.name ?? "",
      sidebar,
      channel: dialog ? this.channelView(dialog) : null,
      voice: null,
      ...(stickers.length > 0 ? { stickers } : {}),
      ...(Object.keys(emojiUrls).length > 0 ? { emojiUrls } : {}),
      ...(this.profile ? { profile: this.profile } : {}),
      ...(folders ? { folders } : {}),
      error: this.error,
    };
  }

  private render(): void {
    this.deps.render(this.viewState());
  }
}

/**
 * A message's reactions once the user's own are these: the ones they gave
 * up count one less (and go at none), new ones one more.
 */
export function withChosen(reactions: TgReaction[], chosen: string[]): TgReaction[] {
  const out = reactions.flatMap((r): TgReaction[] => {
    const mine = chosen.includes(r.emoji);
    const count = r.count + (mine && !r.chosen ? 1 : !mine && r.chosen ? -1 : 0);
    return count > 0 ? [{ emoji: r.emoji, count, chosen: mine }] : [];
  });
  for (const emoji of chosen) if (!out.some((r) => r.emoji === emoji)) out.push({ emoji, count: 1, chosen: true });
  return out;
}

/** Stored or entered API credentials: a positive integer id and a 32-character hex hash. */
export function parseCredentials(text: string | undefined): TelegramCredentials | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<TelegramCredentials>;
    if (Number.isInteger(value.apiId) && value.apiId! > 0 && typeof value.apiHash === "string" && /^[0-9a-f]{32}$/i.test(value.apiHash)) {
      return { apiId: value.apiId!, apiHash: value.apiHash.toLowerCase() };
    }
  } catch {
    // Not stored by us; ask again.
  }
  return undefined;
}
