import type { AsyncSecretStore } from "../../engine/runtime";
import type { DirectConversation, HomeBadge, PlatformAdapter } from "../../shared/adapter";
import { BaseAdapter } from "../../shared/baseAdapter";
import { escapeMarkdown } from "../../shared/markdown";
import type { NativeAction, NativeAttachment, NativeMessage, NativePrompt, NativeSidebarItem, NativeViewState } from "../../shared/native";
import type { AccountStatus, ServiceSettingStatus } from "../../shared/settings";
import { telegramError, type TelegramApi, type TelegramCredentials, type TgDialog, type TgFile, type TgMessage, type TgUpdate, type TgUser } from "./api";

export const DIALOG_LIMIT = 100;
export const PAGE_SIZE = 50;
/** Profile pictures fetched per refresh; the rest show initials. */
export const AVATAR_LIMIT = 40;
/** Largest media shown in the view (it travels as a data: URL); bigger files say so. */
export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
/** Media kept in memory for the view, all files together; the oldest go first. */
export const MEDIA_CACHE_BYTES = 200 * 1024 * 1024;
const SESSION_KEY = "session";
const CREDENTIALS_KEY = "api";
/** The Settings action (manifest `settings`) that forgets the API ID the user entered. */
export const FORGET_API_ID = "forgetApiId";
const DIALOG_REFRESH_MS = 1000;
const BAD_CREDENTIALS = new Set(["API_ID_INVALID", "API_ID_PUBLISHED_FLOOD"]);

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
  /** Bytes of loaded media kept for the view (default MEDIA_CACHE_BYTES). */
  mediaBudget?: number;
}

type Step = "api" | "phone" | "code" | "password" | "connecting" | "chat";

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

/** "📷 Photo" and such after the text, so media-only messages still say something. */
export function messageText(message: TgMessage): string {
  return [message.text, message.media].filter(Boolean).join("\n");
}

/**
 * Native Telegram adapter: signs in with phone number, code and two-step
 * password, lists one-to-one chats as direct messages (in the rail and the
 * unified Messages page) and renders them in Multicord's chat view. Runs in
 * its sandboxed engine; the session is kept in the instance's own secrets.
 */
export class TelegramAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

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
  private selected: string | undefined;
  private visible = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counts sign-outs, so work started for one account stops for the next. */
  private session = 0;

  constructor(private readonly deps: TelegramAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: "telegram.org", accountId: "default" });
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
    await this.refreshDialogs();
    void this.loadAvatars();
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

  homeBadge(): HomeBadge {
    return { unread: false, mentions: 0 }; // DM bubbles carry their own badges.
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
    if (visible && this.selected) void this.markRead(this.selected);
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
    this.session++;
    this.selected = undefined;
    this.directsChanged.emit([]);
    // A fresh client for the next sign-in, starting at the phone step.
    if (this.credentials) return this.open("");
    this.step = "api";
    this.render();
  }

  async handleAction(action: NativeAction): Promise<void> {
    switch (action.type) {
      case "ready":
        return this.render();
      case "prompt":
        return this.answer(action.id, action.values);
      case "cancelPrompt":
        if (action.id === "code" || action.id === "password") {
          this.step = "phone";
          this.error = undefined;
          this.render();
        }
        return;
      case "select":
        return this.select(action.channelId);
      case "send":
        return this.send(action.content, action.replyTo);
      case "edit":
        return this.edit(action.messageId, action.content);
      case "delete":
        return this.remove(action.messageId);
      case "loadOlder":
        return this.loadOlder();
      case "loadMedia":
        return this.loadMedia(action.key);
      case "logout":
        return this.signOut();
      default:
        // Reactions, uploads, forums and voice are not offered for Telegram.
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
      default:
        return {
          id: "phone",
          title: "Sign in to Telegram",
          description: "Multicord is a third-party Telegram client. Your number and code go only to Telegram, and your session is stored encrypted on this device.",
          fields: [{ name: "phone", label: "Phone number", type: "tel", autocomplete: "tel", placeholder: "+31 6 12345678" }],
          submit: "Send code",
        };
    }
  }

  // --- Chats --------------------------------------------------------------------

  private async refreshDialogs(): Promise<void> {
    this.dialogs = (await this.api!.dialogs(DIALOG_LIMIT)).sort((a, b) => b.date - a.date);
    this.publish();
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

  private async select(chatId: string): Promise<void> {
    if (!this.dialog(chatId)) return;
    this.selected = chatId;
    this.render();
    if (!this.messages.has(chatId)) await this.fetchHistory(chatId, undefined);
    if (this.visible) await this.markRead(chatId);
  }

  private async fetchHistory(chatId: string, beforeId: number | undefined): Promise<void> {
    if (this.loading.has(chatId)) return;
    this.loading.add(chatId);
    this.render();
    try {
      const page = await this.api!.history(chatId, beforeId, PAGE_SIZE);
      this.hasOlder.set(chatId, page.length === PAGE_SIZE);
      const known = this.messages.get(chatId) ?? [];
      const ids = new Set(known.map((m) => m.id));
      const fresh = page.filter((m) => !ids.has(m.id));
      this.messages.set(chatId, beforeId === undefined ? [...known, ...fresh].sort((a, b) => a.id - b.id) : [...fresh, ...known]);
    } catch (error) {
      this.error = `Could not load messages: ${friendly(error)}`;
    }
    this.loading.delete(chatId);
    this.render();
  }

  private async loadOlder(): Promise<void> {
    const chatId = this.selected;
    const oldest = chatId ? this.messages.get(chatId)?.[0] : undefined;
    if (chatId && oldest && this.hasOlder.get(chatId)) await this.fetchHistory(chatId, oldest.id);
  }

  private async markRead(chatId: string): Promise<void> {
    const dialog = this.dialog(chatId);
    const last = this.messages.get(chatId)?.at(-1) ?? dialog?.lastMessage;
    if (!dialog || !last || dialog.unreadCount === 0) return;
    dialog.unreadCount = 0;
    this.publish();
    await this.api?.markRead(chatId, last.id).catch(() => undefined);
  }

  private async attempt(what: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.error = `${what}: ${friendly(error)}`;
      this.render();
    }
  }

  private async send(content: string, replyTo?: string): Promise<void> {
    const chatId = this.selected;
    if (!chatId || content.trim() === "" || !this.api) return;
    await this.attempt("Message not sent", async () => {
      const sent = await this.api!.send(chatId, content, replyTo ? Number(replyTo) : undefined);
      this.onUpdate({ type: "message", message: sent });
    });
  }

  private async edit(messageId: string, content: string): Promise<void> {
    const chatId = this.selected;
    if (!chatId || !this.api) return;
    await this.attempt("Message not edited", async () => {
      const edited = await this.api!.edit(chatId, Number(messageId), content);
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
        // A chat we do not list yet (someone new, or a group): refresh the list.
        if (!dialog) return this.refreshSoon();
        const cached = this.messages.get(message.chatId);
        if (cached && !cached.some((m) => m.id === message.id)) cached.push(message);
        if (message.id >= (dialog.lastMessage?.id ?? 0)) {
          dialog.lastMessage = message;
          dialog.date = message.date;
        }
        const inView = this.visible && this.selected === message.chatId;
        if (!message.out) {
          // In view: read at once, on the server too (there is no unread count to clear here).
          if (inView) void this.api?.markRead(message.chatId, message.id).catch(() => undefined);
          else dialog.unreadCount++;
          this.notifications.emit({
            title: dialog.title,
            body: messageText(message).slice(0, 200),
            target: message.chatId,
            railKey: `dm:${message.chatId}`,
            inView,
          });
        }
        this.dialogs.sort((a, b) => b.date - a.date);
        return this.publish();
      }
      case "edit": {
        const { message } = update;
        const cached = this.messages.get(message.chatId);
        const index = cached?.findIndex((m) => m.id === message.id) ?? -1;
        if (index >= 0) cached![index] = message;
        const dialog = this.dialog(message.chatId);
        if (dialog?.lastMessage?.id === message.id) dialog.lastMessage = message;
        return this.publish();
      }
      case "delete": {
        // Private-chat deletions carry no chat id: message ids are unique per account there.
        const ids = new Set(update.ids);
        for (const [chatId, cached] of this.messages) {
          if (update.chatId && update.chatId !== chatId) continue;
          this.messages.set(chatId, cached.filter((m) => !ids.has(m.id)));
        }
        for (const dialog of this.dialogs) if (dialog.lastMessage && ids.has(dialog.lastMessage.id)) dialog.lastMessage = undefined;
        return this.publish();
      }
    }
  }

  // --- Output -------------------------------------------------------------------

  directs(): DirectConversation[] {
    return this.dialogs.map((d) => {
      const direct: DirectConversation = {
        key: d.chatId,
        account: this.account,
        title: d.title,
        lastActivity: d.date * 1000,
        unread: d.unreadCount > 0,
        mentions: d.unreadCount,
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
    const replied = message.replyToId ? this.messages.get(message.chatId)?.find((m) => m.id === message.replyToId) : undefined;
    const native: NativeMessage = {
      id: String(message.id),
      author: message.out ? (this.me?.name ?? "You") : (message.sender ?? dialog.title),
      // Shown media speaks for itself; a label stays for what is not shown (locations, polls…).
      content: escapeMarkdown(message.file ? message.text : messageText(message)),
      timestamp: new Date(message.date * 1000).toISOString(),
      edited: message.edited,
      mine: message.out,
      canEdit: message.out && message.text !== "",
      canDelete: message.out,
      reactions: [],
      attachments: message.file ? [this.attachment(message, message.file)] : [],
    };
    if (native.canEdit) native.source = message.text;
    if (replied) native.reply = { author: replied.out ? (this.me?.name ?? "You") : (replied.sender ?? dialog.title), content: messageText(replied).slice(0, 100) };
    return native;
  }

  private attachment(message: TgMessage, file: TgFile): NativeAttachment {
    const key = `tg:${message.chatId}:${message.id}`;
    const shown: NativeAttachment = { name: file.name, kind: file.kind, mime: file.mime, size: file.size, width: file.width, height: file.height };
    if (file.loop) shown.loop = true;
    const url = this.media.get(key);
    if (url) shown.url = url;
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
    const message = this.messages.get(chatId!)?.find((m) => m.id === Number(id));
    if (!message?.file) return;
    this.mediaLoading.add(key);
    try {
      const bytes = await this.api.download(chatId!, message.id, message.file.thumbnailOnly === true);
      if (!bytes) this.mediaFailed.set(key, "not available");
      else if (bytes.length > MAX_MEDIA_BYTES) this.mediaFailed.set(key, "too large to show here; open it in Telegram");
      else this.remember(key, `data:${message.file.mime ?? "application/octet-stream"};base64,${toBase64(bytes)}`);
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

  private viewState(): NativeViewState {
    const platform = this.deps.def.name;
    if (this.step === "connecting") return { screen: "connecting", platform, status: this.status ?? "Connecting…" };
    if (this.step !== "chat") return { screen: "prompt", platform, prompt: this.prompt(), busy: this.busy, status: this.status, error: this.error };
    const sidebar: NativeSidebarItem[] = this.dialogs.map((d) => {
      const item: NativeSidebarItem = { id: d.chatId, name: d.title, kind: "dm", unread: d.unreadCount > 0, mentions: d.unreadCount, active: d.chatId === this.selected };
      const avatar = this.avatars.get(d.chatId);
      if (avatar) item.iconUrl = avatar;
      return item;
    });
    const dialog = this.selected ? this.dialog(this.selected) : undefined;
    return {
      screen: "chat",
      platform,
      title: "Direct messages",
      me: this.me?.name ?? "",
      sidebar,
      channel: dialog
        ? {
            id: dialog.chatId,
            name: dialog.title,
            messages: (this.messages.get(dialog.chatId) ?? []).map((m) => this.toNative(m, dialog)),
            loading: this.loading.has(dialog.chatId),
            hasOlder: this.hasOlder.get(dialog.chatId) ?? false,
            typing: [],
            pending: [],
            uploading: false,
          }
        : null,
      voice: null,
      error: this.error,
    };
  }

  private render(): void {
    this.deps.render(this.viewState());
  }
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
