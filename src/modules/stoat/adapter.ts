import type { DirectConversation, HomeBadge, PlatformAdapter, RailServer } from "../../shared/adapter";
import { MAX_ATTACHMENTS, type NativeAction, type NativeCustomEmoji, type NativeEmbed, type NativeListedMessage, type NativeMember, type NativeMemberList, type NativeMemberSection, type NativePresence, type NativeProfile, MEMBER_ROWS_SHOWN, type NativeMessage, type NativeMessageList, type NativeSearchResults, type NativeSidebarItem, type NativeUnread, type NativeViewState } from "../../shared/native";
import type { PickedFile } from "../../shared/engine";
import type { AccountStatus } from "../../shared/settings";
import type { AsyncSecretStore, EngineFiles, FileSource } from "../../engine/runtime";
import { BaseAdapter } from "../../shared/baseAdapter";
import { StoatEvents, type EventsStatus, type SocketFactory } from "./events";
import { discoverInstance, instanceHosts, StoatApiError, StoatRest, type LoginResult, type RestOptions, type StoatInstance } from "./rest";
import { StoatState, TYPING_MS } from "./state";
import { ChannelType, TEXT_CHANNEL_TYPES, compareIds, displayName, idTime, isId, withChannelLevel, type StoatChannel, type StoatEmbed, type StoatFile, type StoatMember, type StoatMessage, type StoatRole, type StoatServer, type StoatUser } from "./types";

const PAGE_SIZE = 50;
/** The longest search Stoat takes. */
export const MAX_SEARCH = 64;
/** The longest message Stoat takes, which a forwarded copy is cut to. */
export const FORWARD_LENGTH = 2000;
const PUBLISH_DELAY_MS = 100;
const ACK_DELAY_MS = 750;
/** Typing is re-announced this often while the user keeps typing, and ended after this long idle. */
const TYPING_REPEAT_MS = 8_000;
const TYPING_IDLE_MS = 5_000;
/** Stoat's default message_attachments limit. */
const MAX_FILES = Math.min(5, MAX_ATTACHMENTS);
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
/** Originals of replies fetched at most per page of messages, and kept at most. */
export const ORIGINALS_PER_PAGE = 10;
const MAX_ORIGINALS = 500;

/** Which instance this is: the engine's own info. */
export interface StoatInstanceDef {
  id: string;
  name: string;
  /** The instance origin, e.g. https://stoat.chat; its API is at /api. */
  url: string;
}

export interface StoatAdapterDeps {
  def: StoatInstanceDef;
  fetch: typeof fetch;
  createSocket: SocketFactory;
  /** This instance's own secrets. */
  secrets: AsyncSecretStore;
  /** Sends display state to the native view. */
  render(state: NativeViewState): void;
  rest?: Partial<RestOptions>;
  /** Lets the user pick files; the engine reads only what was picked. */
  files?: EngineFiles;
  /** Narrows what the engine may reach to these hosts, once they are known. */
  lockHosts?(hosts: string[]): Promise<void>;
}

type Selection = { kind: "home" } | { kind: "server"; serverId: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the module offers the shell; its manifest must declare the same (tested). */
export const CAPABILITIES: PlatformAdapter["capabilities"] = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

/**
 * Native Stoat adapter: talks to a Stoat (Revolt) instance from its sandboxed
 * engine and renders in Multicord's own chat view. Sign-in (with
 * authenticator or recovery codes), the events connection and the session
 * token all stay here.
 */
export class StoatAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = CAPABILITIES;

  readonly state = new StoatState();
  private instance: StoatInstance | undefined;
  private rest: StoatRest | undefined;
  private events: StoatEvents | undefined;
  private screen: "login" | "mfa" | "connecting" | "chat" = "login";
  private connection: EventsStatus = "closed";
  private busy = false;
  private status: string | undefined;
  private error: string | undefined;
  private mfaTicket: string | undefined;
  private mfaCodes: "totp" | "backup" = "totp";
  private selection: Selection = { kind: "home" };
  private selectedChannelId: string | undefined;
  private readonly lastChannel = new Map<string, string>();
  private readonly hasOlder = new Map<string, boolean>();
  /** Where the open channel's news began when it was opened: the last message read then, if any. */
  private unreadAt: { channelId: string; after?: string } | undefined;
  /** The open channel's pinned messages, while its pins panel is open. */
  private pins: { channelId: string; list: NativeMessageList } | undefined;
  /** The open channel's search results, until the search ends; and a count that drops answers to earlier searches. */
  private search: { channelId: string; results: NativeSearchResults } | undefined;
  private searchCount = 0;
  private readonly loading = new Set<string>();
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  /** Our own typing: where, since when, and the timer that ends it. */
  private ownTyping: { channelId: string; sent: number; stop: ReturnType<typeof setTimeout> } | undefined;
  private readonly pending = new Map<string, FileSource[]>();
  private readonly uploading = new Set<string>();
  /** Whether a session token is stored, so the account shows as signed in before it connects. */
  private hasToken = false;
  private visible = false;
  /** The view's member panel is open: the open conversation's members are fetched and shown. */
  private membersOpen = false;
  /** Member fetches by server id (or group channel id): under way, done, or failed. */
  private readonly memberFetches = new Map<string, { loading: boolean; error?: string }>();
  /** The profile card the view asked for last. */
  private profile: NativeProfile | undefined;
  /** Counts sign-outs and new sessions, so answers for an earlier one are dropped. */
  private session = 0;
  /** Originals of replies that are not loaded, by id: fetched, or null where Stoat has none (deleted). */
  private readonly originals = new Map<string, StoatMessage | null>();
  private readonly fetchingOriginals = new Set<string>();

  constructor(private readonly deps: StoatAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
    this.state.changed.on(() => this.schedulePublish());
    // Typing indicators expire on their own; re-render when they may have.
    this.state.changed.on(() => {
      clearTimeout(this.typingTimer);
      if (this.state.typing.size > 0) this.typingTimer = setTimeout(() => this.render(), TYPING_MS);
    });
    this.state.incoming.on((message) => {
      if (message.channelId === this.selectedChannelId) {
        this.ackSoon(message.channelId);
        void this.fetchOriginals(message.channelId);
      }
      this.notify(message);
    });
  }

  /** The secret store is this instance's own, so two accounts on one Stoat instance stay apart. */
  private get secretKey(): string {
    return `${this.account.instance}:token`;
  }

  /** Reads the instance's configuration and resumes a saved session, else shows the sign-in screen. */
  async start(): Promise<void> {
    if (!(await this.ensureInstance())) return this.render();
    const token = await this.deps.secrets.load(this.secretKey);
    this.hasToken = token !== undefined;
    if (token) this.openSession(token, undefined);
    else this.render();
  }

  async handleAction(action: NativeAction): Promise<void> {
    switch (action.type) {
      case "ready":
        return this.render();
      case "login":
        return this.login(action.identity, action.password);
      case "mfa":
        return this.submitMfa(action.code);
      case "cancelMfa":
        this.mfaTicket = undefined;
        this.screen = "login";
        this.error = undefined;
        return this.render();
      case "select":
        return this.selectChannel(action.channelId);
      case "send":
        return this.send(action.content, action.replyTo);
      case "edit":
        return this.edit(action.messageId, action.content);
      case "delete":
        return this.remove(action.messageId);
      case "react":
        return this.react(action.messageId, action.emoji, action.add);
      case "mute":
        return this.mute(action.channelId, action.mute);
      case "loadOlder":
        return this.loadOlder();
      case "typing":
        return this.sendTyping();
      case "attach":
        return this.attach();
      case "sendFile":
        return this.sendShared(action.file, action.replyTo);
      case "removeAttachment":
        this.pending.get(this.selectedChannelId ?? "")?.splice(action.index, 1);
        return this.render();
      case "pins":
        return this.showPins(action.open);
      case "forward":
        return this.forward(action.messageId, action.channelId);
      case "search":
        return this.searchMessages(action.query);
      case "pin":
        return this.pin(action.messageId, action.pin);
      case "members":
        return this.setMembersOpen(action.open);
      case "profile":
        return this.showProfile(action.id);
      case "logout":
        return this.logout();
      default:
        return; // Forums, voice and prompts do not exist here.
    }
  }

  accountStatus(): AccountStatus {
    const signedIn = this.screen === "connecting" || this.screen === "chat" || this.hasToken;
    if (!signedIn) return { state: "signed-out" };
    return this.state.me ? { state: "signed-in", name: displayName(this.state.me) } : { state: "signed-in" };
  }

  /** Ends the session on the server too, so the token cannot be reused. */
  signOut(): Promise<void> {
    return this.logout();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.selectedChannelId) this.ackSoon(this.selectedChannelId);
  }

  // --- PlatformAdapter -------------------------------------------------------

  override async listDirectConversations(): Promise<DirectConversation[]> {
    return this.directs();
  }

  homeBadge(): HomeBadge {
    return { unread: false, mentions: 0 }; // DM bubbles carry their own badges.
  }

  async openHome(): Promise<void> {
    this.selection = { kind: "home" };
    this.selectedChannelId = this.lastChannel.get("home");
    this.render();
  }

  async openServer(key: string): Promise<void> {
    if (!this.state.servers.has(key)) throw new Error(`Unknown Stoat server: ${key}`);
    this.selection = { kind: "server", serverId: key };
    const first = this.state.serverEntries(key).find((e) => "channel" in e);
    const channelId = this.lastChannel.get(key) ?? (first && "channel" in first ? first.channel.id : undefined);
    if (channelId) await this.selectChannel(channelId);
    else {
      this.selectedChannelId = undefined;
      this.render();
    }
  }

  /** Opens any text channel: a DM at home, or a server channel inside its server. */
  async openConversation(key: string): Promise<void> {
    const serverId = this.state.channels.get(key)?.serverId;
    this.selection = serverId ? { kind: "server", serverId } : { kind: "home" };
    await this.selectChannel(key);
  }

  // --- Session ---------------------------------------------------------------

  private async ensureInstance(): Promise<StoatInstance | undefined> {
    if (this.instance) return this.instance;
    try {
      this.instance = await discoverInstance(this.deps.def.url, this.deps.fetch);
      // From here on the engine needs only this instance's own hosts.
      await this.deps.lockHosts?.(instanceHosts(this.instance)).catch((error: unknown) => console.warn(`[stoat] host lock refused: ${messageOf(error)}`));
      this.rest = new StoatRest(this.instance, { fetch: this.deps.fetch, ...this.deps.rest });
      this.error = undefined;
      return this.instance;
    } catch (error) {
      this.error = `Could not reach ${this.deps.def.name}: ${messageOf(error)}`;
      return undefined;
    }
  }

  private async login(email: string, password: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = "Signing in…";
    this.error = undefined;
    this.render();
    if (!(await this.ensureInstance())) return this.finishAttempt();
    try {
      this.onLoginResult(await this.rest!.login(email, password));
    } catch (error) {
      this.error = messageOf(error);
    }
    this.finishAttempt();
  }

  /** Six digits are an authenticator code; anything else is taken as a recovery code. */
  private async submitMfa(code: string): Promise<void> {
    if (this.busy || !this.mfaTicket) return;
    this.busy = true;
    this.error = undefined;
    this.render();
    const trimmed = code.replace(/\s+/g, "");
    const response = this.mfaCodes === "totp" && /^\d{6}$/.test(trimmed) ? { totp_code: trimmed } : { recovery_code: code.trim() };
    try {
      this.onLoginResult(await this.rest!.loginMfa(this.mfaTicket, response));
    } catch (error) {
      this.error = messageOf(error);
    }
    this.finishAttempt();
  }

  private finishAttempt(): void {
    this.busy = false;
    this.status = undefined;
    this.render();
  }

  private onLoginResult(result: LoginResult): void {
    if ("token" in result) {
      this.mfaTicket = undefined;
      this.hasToken = true;
      void this.deps.secrets.save(this.secretKey, result.token);
      this.openSession(result.token, result.userId);
      return;
    }
    if (!result.totp && !result.recovery) throw new Error("This account's two-factor method is not supported here.");
    this.mfaTicket = result.ticket;
    this.mfaCodes = result.totp ? "totp" : "backup";
    this.screen = "mfa";
  }

  private openSession(token: string, userId: string | undefined): void {
    this.rest!.token = token;
    this.state.meId = userId;
    this.screen = "connecting";
    this.events = new StoatEvents(this.instance!.ws, token, this.deps.createSocket, {
      dispatch: (type, data) => {
        this.state.apply(type, data);
        if (type === "Ready") this.onReady();
        // A message in the channel whose pins are listed was pinned or unpinned.
        const changed = type === "MessageUpdate" && typeof data === "object" && data !== null ? (data as { channel?: unknown; data?: { pinned?: unknown }; clear?: unknown }) : undefined;
        if (this.pins && changed?.channel === this.pins.channelId && (changed.data?.pinned !== undefined || (Array.isArray(changed.clear) && changed.clear.includes("Pinned")))) void this.loadPins(this.pins.channelId);
      },
      status: (status) => {
        this.connection = status;
        this.render();
      },
      authFailed: () => this.endSession("Your session has ended. Please sign in again."),
    });
    this.events.connect();
    this.render();
  }

  /** Ready replaces everything we knew: fill in what it lacks and reload the open channel. */
  private onReady(): void {
    this.screen = "chat";
    this.hasOlder.clear();
    // Ready dropped the member lists; the open panel fetches its list again.
    this.session++;
    this.memberFetches.clear();
    this.originals.clear();
    this.fetchingOriginals.clear();
    if (this.membersOpen) void this.fetchMembers();
    this.render();
    if (!this.state.unreadsLoaded) {
      void this.rest!.unreads().then((unreads) => this.state.setUnreads(unreads), () => undefined);
    }
    void this.rest!.settings(["notifications"]).then((settings) => this.state.setNotifySettings(settings.notifications), () => undefined);
    if (this.selectedChannelId) void this.fetchHistory(this.selectedChannelId, undefined);
  }

  private async logout(): Promise<void> {
    await this.rest?.logout().catch(() => undefined);
    this.endSession(undefined);
  }

  private endSession(error: string | undefined): void {
    this.events?.disconnect();
    this.events = undefined;
    if (this.rest) this.rest.token = undefined;
    this.hasToken = false;
    void this.deps.secrets.delete(this.secretKey);
    this.state.reset();
    this.session++;
    this.memberFetches.clear();
    this.originals.clear();
    this.fetchingOriginals.clear();
    this.membersOpen = false;
    this.profile = undefined;
    this.selection = { kind: "home" };
    this.selectedChannelId = undefined;
    this.lastChannel.clear();
    this.pending.clear();
    this.screen = "login";
    this.error = error;
    this.setServers([]);
    this.directsChanged.emit([]);
    this.render();
  }

  // --- Channels and messages -------------------------------------------------

  private async selectChannel(channelId: string): Promise<void> {
    const channel = this.state.channels.get(channelId);
    if (!channel || !TEXT_CHANNEL_TYPES.has(channel.type)) return;
    // Noted before it is read: where its news began.
    if (channelId !== this.selectedChannelId) this.unreadAt = this.state.isUnread(channel) ? { channelId, after: this.state.unreads.get(channelId)?.lastId } : undefined;
    if (this.pins?.channelId !== channelId) this.pins = undefined;
    if (this.search?.channelId !== channelId) this.search = undefined;
    this.selectedChannelId = channelId;
    this.lastChannel.set(channel.serverId ?? "home", channelId);
    this.error = undefined;
    this.render();
    if (this.membersOpen) void this.fetchMembers();
    if (!this.state.messages.has(channelId)) await this.fetchHistory(channelId, undefined);
    this.ackSoon(channelId);
  }

  /**
   * The open channel's unread marker: the first message from someone else
   * after the last one read when it was opened, once the loaded messages
   * reach back that far (or there are no older ones); none when they do and
   * hold nothing new from others after all. Stoat gives no count.
   */
  private unreadView(channelId: string, at: NonNullable<StoatAdapter["unreadAt"]>): NativeUnread | undefined {
    const messages = this.state.messages.get(channelId) ?? [];
    // ULIDs sort as text, so an empty one comes before them all.
    const after = at.after ?? "";
    const reach = !(this.hasOlder.get(channelId) ?? false) || messages.some((m) => compareIds(m.id, after) <= 0);
    if (!reach) return {};
    const first = messages.find((m) => compareIds(m.id, after) > 0 && m.authorId !== this.state.meId);
    return first && { firstId: first.id };
  }

  private async fetchHistory(channelId: string, before: string | undefined): Promise<void> {
    if (this.loading.has(channelId)) return;
    this.loading.add(channelId);
    this.render();
    try {
      const page = await this.rest!.messages(channelId, before);
      this.hasOlder.set(channelId, page.messages.length === PAGE_SIZE);
      // A fresh first page replaces what we had (e.g. after a reconnect).
      if (before === undefined) this.state.messages.delete(channelId);
      this.state.addHistory(channelId, page.messages, page.users, before !== undefined);
    } catch (error) {
      this.error = `Could not load messages: ${messageOf(error)}`;
    }
    this.loading.delete(channelId);
    this.render();
    void this.fetchOriginals(channelId);
  }

  /**
   * Fetches the originals of replies in a channel that are not loaded, the
   * latest ORIGINALS_PER_PAGE at a time, so their previews show. One Stoat
   * no longer has shows as deleted; one that failed to load is tried again
   * with the next page or message.
   */
  private async fetchOriginals(channelId: string): Promise<void> {
    const messages = this.state.messages.get(channelId) ?? [];
    const loaded = new Set(messages.map((m) => m.id));
    const wanted = [...new Set(messages.flatMap((m) => m.replies.slice(0, 1)))]
      .filter((id) => !loaded.has(id) && !this.originals.has(id) && !this.fetchingOriginals.has(id))
      .slice(-ORIGINALS_PER_PAGE);
    if (wanted.length === 0) return;
    const session = this.session;
    for (const id of wanted) this.fetchingOriginals.add(id);
    for (const id of wanted) {
      let found: StoatMessage | null | undefined;
      try {
        found = (await this.rest!.message(channelId, id)) ?? null;
      } catch (error) {
        found = error instanceof StoatApiError && error.status === 404 ? null : undefined;
      }
      // Answers for an earlier session are dropped.
      if (session !== this.session) return;
      this.fetchingOriginals.delete(id);
      if (found === undefined) continue;
      this.originals.set(id, found);
      if (this.originals.size > MAX_ORIGINALS) this.originals.delete(this.originals.keys().next().value!);
    }
    this.render();
  }

  private async loadOlder(): Promise<void> {
    const channelId = this.selectedChannelId;
    const oldest = channelId ? this.state.messages.get(channelId)?.[0] : undefined;
    if (channelId && oldest && this.hasOlder.get(channelId)) await this.fetchHistory(channelId, oldest.id);
  }

  /**
   * Forwards a message of the open channel into another channel, DM or
   * group: Stoat has no forwarding, so a new message says who wrote it and
   * quotes the text, with links to the files. Mentions in it are made plain
   * text, so the copy pings nobody.
   */
  private async forward(messageId: string, target: string): Promise<void> {
    const message = this.state.findMessage(this.selectedChannelId, messageId);
    const to = this.state.channels.get(target);
    if (!message || !to || !TEXT_CHANNEL_TYPES.has(to.type)) return;
    const quiet = String.fromCharCode(0x200b);
    const text = this.renderContent(message.content)
      .replace(new RegExp(`<@(${ULID})>`, "g"), "@someone")
      .replace(/@(everyone|online)\b/g, `@${quiet}$1`);
    const quoted = text === "" ? [] : text.split("\n").map((line) => `> ${line}`);
    const files = message.attachments.flatMap((a) => this.fileUrl(a) ?? []);
    const content = [`Forwarded from ${this.authorName(message)}:`, ...quoted, ...files].join("\n").slice(0, FORWARD_LENGTH);
    await this.attempt("Message not forwarded", async () => {
      const sent = await this.rest!.sendMessage(to.id, content, `multicord-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
      if (sent) this.state.addSent(sent);
    });
  }

  private async send(content: string, replyTo?: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest || this.uploading.has(channelId)) return;
    const files = this.pending.get(channelId) ?? [];
    if (content.trim() === "" && files.length === 0) return;
    this.stopTyping();
    const nonce = `multicord-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    this.uploading.add(channelId);
    this.render();
    await this.attempt("Message not sent", async () => {
      const attachments: string[] = [];
      for (const file of files) attachments.push(await this.rest!.upload(file));
      const sent = await this.rest!.sendMessage(channelId, content, nonce, replyTo, attachments);
      this.pending.delete(channelId);
      if (sent) {
        this.state.addSent(sent);
        // Stoat does not mark the sender's own message read; without this, the next session shows the channel unread.
        void this.rest!.ack(channelId, sent.id).catch(() => undefined);
      }
    });
    this.uploading.delete(channelId);
    this.render();
  }

  /** Adds files from the OS picker to the open channel's next message. */
  private async attach(): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.deps.files) return;
    if (!this.instance?.autumn) {
      this.error = `This ${this.deps.def.name} instance does not accept files.`;
      return this.render();
    }
    await this.attempt("Could not attach", async () => {
      const picked = await this.deps.files!.pick();
      const list = this.pending.get(channelId) ?? [];
      for (const file of picked) {
        if (list.length >= MAX_FILES) {
          this.error = `At most ${MAX_FILES} files per message.`;
          break;
        }
        list.push(file);
      }
      this.pending.set(channelId, list);
      this.render();
    });
  }

  /**
   * A file the shell hands over (a favourite, or a sticker sent as a
   * picture): it goes out at once, or waits with files already picked.
   */
  private async sendShared(file: PickedFile, replyTo?: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.deps.files?.open || this.uploading.has(channelId)) return;
    if (!this.instance?.autumn) {
      this.error = `This ${this.deps.def.name} instance does not accept files.`;
      return this.render();
    }
    const list = this.pending.get(channelId) ?? [];
    if (list.length >= MAX_FILES) {
      this.error = `At most ${MAX_FILES} files per message.`;
      return this.render();
    }
    list.push(this.deps.files.open(file));
    this.pending.set(channelId, list);
    if (list.length === 1) return this.send("", replyTo);
    this.render();
  }

  private async edit(messageId: string, content: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest) return;
    await this.attempt("Message not edited", async () => {
      const edited = await this.rest!.editMessage(channelId, messageId, content);
      if (edited && this.state.replaceMessage(edited)) this.state.changed.emit();
    });
  }

  private async remove(messageId: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest) return;
    await this.attempt("Message not deleted", async () => {
      await this.rest!.deleteMessage(channelId, messageId);
      this.state.removeMessage(channelId, messageId);
    });
  }

  /** Opens the open channel's pins panel and fetches its pins, or closes it. */
  private async showPins(open: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    this.pins = open && channelId ? { channelId, list: { messages: [], loading: true } } : undefined;
    this.render();
    if (this.pins) await this.loadPins(this.pins.channelId);
  }

  /** Fetches the pins of a channel whose pins panel is open (Stoat finds them by search); a reply for a panel since closed is dropped. */
  private async loadPins(channelId: string): Promise<void> {
    let list: NativeMessageList;
    try {
      const found = await this.rest!.search(channelId, { pinned: true });
      const users = new Map(found.users.map((u) => [u.id, u]));
      list = { messages: found.messages.map((m) => this.listedMessage(m, users)), loading: false };
    } catch (error) {
      list = { messages: [], loading: false, error: `Could not load pinned messages: ${messageOf(error)}` };
    }
    if (this.pins?.channelId !== channelId) return;
    this.pins = { channelId, list };
    this.render();
  }

  /**
   * Searches the open channel on the instance (its newest 100 matches), or
   * ends the search with an empty query. Stoat takes at most 64 characters.
   */
  private async searchMessages(query: string): Promise<void> {
    const channelId = this.selectedChannelId;
    const count = ++this.searchCount;
    const trimmed = query.trim();
    this.search = channelId && trimmed !== "" ? { channelId, results: { query: trimmed, messages: [], loading: true } } : undefined;
    this.render();
    if (!this.search || !channelId) return;
    let results: NativeSearchResults;
    try {
      const found = await this.rest!.search(channelId, { query: trimmed.slice(0, MAX_SEARCH) });
      const users = new Map(found.users.map((u) => [u.id, u]));
      results = { query: trimmed, messages: found.messages.map((m) => this.listedMessage(m, users)), loading: false };
      if (trimmed.length > MAX_SEARCH) results.note = `Stoat searches for the first ${MAX_SEARCH} characters only.`;
    } catch (error) {
      results = { query: trimmed, messages: [], loading: false, error: `Search failed: ${messageOf(error)}` };
    }
    if (count !== this.searchCount || this.search?.channelId !== channelId) return;
    this.search = { channelId, results };
    this.render();
  }

  /** Pins or unpins a message; Stoat decides whether the user may. The server's MessageUpdate refreshes an open list. */
  private async pin(messageId: string, pin: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest) return;
    await this.attempt(pin ? "Message not pinned" : "Message not unpinned", async () => {
      await this.rest!.pin(channelId, messageId, pin);
      const message = this.state.findMessage(channelId, messageId);
      if (message) message.pinned = pin;
      this.render();
    });
  }

  /** A message as the pins list shows it: its text, or its first file's name. */
  private listedMessage(message: StoatMessage, users: Map<string, StoatUser>): NativeListedMessage {
    const user = this.state.users.get(message.authorId) ?? users.get(message.authorId);
    const listed: NativeListedMessage = {
      id: message.id,
      author: message.masquerade ?? (user ? displayName(user) : "Unknown user"),
      content: this.renderContent(message.system ?? message.content) || (message.attachments[0] ? `📎 ${message.attachments[0].filename}` : ""),
      timestamp: new Date(idTime(message.id)).toISOString(),
    };
    const avatar = message.masquerade ? undefined : this.fileUrl(user?.avatar);
    if (avatar) listed.avatarUrl = avatar;
    return listed;
  }

  /** Applied locally once the server accepts it; the server's echo changes nothing more. */
  private async react(messageId: string, emoji: string, add: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    const me = this.state.meId;
    if (!channelId || !this.rest || !me) return;
    await this.attempt("Reaction failed", async () => {
      await this.rest!.react(channelId, messageId, emoji, add);
      this.state.applyReaction(channelId, messageId, emoji, me, add);
    });
  }

  /**
   * Mutes a channel, DM or group in the user's Stoat notification settings,
   * or unmutes it: its own level goes, or becomes "mention" where its server
   * is muted. The setting is fetched fresh, so changes made elsewhere stay.
   */
  private async mute(channelId: string, mute: boolean): Promise<void> {
    const channel = this.state.channels.get(channelId);
    if (!channel || !this.rest || (this.state.notifyLevel(channel) === "muted") === mute) return;
    await this.attempt(mute ? "Could not mute" : "Could not unmute", async () => {
      const current = await this.rest!.settings(["notifications"]);
      const serverMuted = channel.serverId !== undefined && this.state.notifySettings.servers.get(channel.serverId) === "muted";
      const text = withChannelLevel(current.notifications, channelId, mute ? "muted" : serverMuted ? "mention" : undefined);
      const now = Date.now();
      await this.rest!.setSettings({ notifications: text }, now);
      this.state.setNotifySettings([now, text]);
      this.schedulePublish();
    });
  }

  /**
   * Tells others we are typing. Stoat shows it until told to stop, so it is
   * re-announced while typing goes on and ended after a pause or on send.
   */
  private sendTyping(now: number = Date.now()): void {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.events) return;
    const current = this.ownTyping?.channelId === channelId ? this.ownTyping : undefined;
    if (!current) this.stopTyping();
    // Said again once the last notice is old enough; a keystroke in the same millisecond is no reason.
    const renew = !current || now - current.sent >= TYPING_REPEAT_MS;
    const sent = renew ? now : current.sent;
    if (renew) this.events.command({ type: "BeginTyping", channel: channelId });
    clearTimeout(current?.stop);
    this.ownTyping = { channelId, sent, stop: setTimeout(() => this.stopTyping(), TYPING_IDLE_MS) };
  }

  private stopTyping(): void {
    const typing = this.ownTyping;
    if (!typing) return;
    clearTimeout(typing.stop);
    this.ownTyping = undefined;
    this.events?.command({ type: "EndTyping", channel: typing.channelId });
  }

  /** Runs a user action, showing a failure in the view's banner. */
  private async attempt(failure: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.error = `${failure}: ${messageOf(error)}`;
      this.render();
    }
  }

  /** Marks the open channel read, debounced. */
  private ackSoon(channelId: string): void {
    if (!this.visible || this.ackTimers.has(channelId)) return;
    this.ackTimers.set(
      channelId,
      setTimeout(() => {
        this.ackTimers.delete(channelId);
        const channel = this.state.channels.get(channelId);
        const last = channel?.lastMessageId;
        if (!channel || !last || (!this.state.isUnread(channel) && this.state.mentions(channelId) === 0)) return;
        this.state.markRead(channelId, last);
        void this.rest?.ack(channelId, last).catch(() => undefined);
      }, ACK_DELAY_MS),
    );
  }

  /** Notifies as the user's Stoat notification settings say (see StoatState.shouldNotify). */
  private notify(message: StoatMessage): void {
    const channel = this.state.channels.get(message.channelId);
    if (!channel || !this.state.shouldNotify(message)) return;
    const server = channel.serverId ? this.state.servers.get(channel.serverId) : undefined;
    const where =
      channel.type === ChannelType.DirectMessage ? "" : server ? ` in #${channel.name ?? channel.id} (${server.name})` : ` in ${this.channelTitle(channel)}`;
    const text = this.renderContent(message.system ?? message.content).trim();
    this.notifications.emit({
      title: `${this.authorName(message)}${where}`,
      body: (text || (message.attachments.length ? "Sent an attachment" : "New message")).slice(0, 200),
      target: channel.id,
      railKey: server ? server.id : `dm:${channel.id}`,
      inView: this.visible && this.selectedChannelId === channel.id,
    });
  }

  // --- Members and profiles --------------------------------------------------

  /** The view's member panel opened (fetching the open conversation's members where needed) or closed. */
  private async setMembersOpen(open: boolean): Promise<void> {
    this.membersOpen = open;
    this.render();
    if (open) await this.fetchMembers();
  }

  /**
   * Fetches what the open conversation's member list lacks: a server's
   * members (Stoat sends the whole list, kept current by member events
   * afterwards), or a group's users where some are unknown. DMs need nothing.
   */
  private async fetchMembers(): Promise<void> {
    const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
    const rest = this.rest!;
    if (!channel) return;
    const key = channel.serverId ?? channel.id;
    const needed = channel.serverId ? !this.state.members.has(key) : channel.type === ChannelType.Group && channel.recipients.some((id) => !this.state.users.has(id));
    if (!needed || this.memberFetches.get(key)?.loading) return;
    this.memberFetches.set(key, { loading: true });
    this.render();
    const session = this.session;
    let done: { loading: boolean; error?: string } = { loading: false };
    let apply = () => {};
    try {
      if (channel.serverId) {
        const found = await rest.members(key);
        apply = () => this.state.setMembers(key, found.members, found.users);
      } else {
        const users = await rest.groupMembers(key);
        apply = () => this.state.addUsers(users);
      }
    } catch (error) {
      done = { loading: false, error: `Could not load members: ${messageOf(error)}` };
    }
    // Answers for an earlier session are dropped.
    if (session !== this.session) return;
    apply();
    this.memberFetches.set(key, done);
    this.render();
  }

  /** The member panel's list: a server's members by hoisted role, then online, then offline; a DM's or group's people, those online first. */
  private memberView(channel: StoatChannel): NativeMemberList | undefined {
    if (!this.membersOpen) return undefined;
    const fetch = this.memberFetches.get(channel.serverId ?? channel.id);
    const status = { loading: fetch?.loading ?? false, ...(fetch?.error ? { error: fetch.error } : {}) };
    const server = channel.serverId ? this.state.servers.get(channel.serverId) : undefined;
    if (server) {
      const members = this.state.members.get(server.id);
      return members ? { ...this.serverMembers(server, [...members.values()]), ...status } : { sections: [], hasMore: false, ...status };
    }
    // Recipients include the user.
    const rows = channel.recipients.flatMap((id) => {
      const user = this.state.users.get(id);
      return user ? [this.memberRow(user, undefined, [])] : [];
    });
    const rank = (row: NativeMember) => (row.presence === undefined || row.presence === "offline" ? 1 : 0);
    rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return { sections: [{ name: "Members", members: rows }], hasMore: false, ...status };
  }

  /** A server's members: online ones under their highest hoisted role, else "Online"; then "Offline". At most MEMBER_ROWS_SHOWN, the rest counted. */
  private serverMembers(server: StoatServer, members: StoatMember[]): Omit<NativeMemberList, "loading"> {
    const byRank = [...server.roles].sort((a, b) => a.rank - b.rank);
    const groups = new Map<string, NativeMember[]>([...byRank.filter((r) => r.hoist).map((r): [string, NativeMember[]] => [r.id, []]), ["online", []], ["offline", []]]);
    for (const member of members) {
      const user = this.state.users.get(member.userId);
      if (!user) continue;
      const row = this.memberRow(user, member, byRank);
      const hoisted = byRank.find((r) => r.hoist && member.roles.includes(r.id));
      const group = row.presence === "offline" || row.presence === undefined ? "offline" : (hoisted?.id ?? "online");
      groups.get(group)!.push(row);
    }
    let room = MEMBER_ROWS_SHOWN;
    let listed = 0;
    const sections: NativeMemberSection[] = [];
    for (const [id, rows] of groups) {
      if (rows.length === 0 || room === 0) continue;
      const name = id === "online" ? "Online" : id === "offline" ? "Offline" : byRank.find((r) => r.id === id)!.name;
      const shown = rows.sort((a, b) => a.name.localeCompare(b.name)).slice(0, room);
      room -= shown.length;
      listed += shown.length;
      sections.push({ name: `${name} — ${rows.length}`, members: shown });
    }
    const total = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0);
    return { sections, hasMore: false, ...(total > listed ? { more: total - listed } : {}) };
  }

  /** How present someone is: offline unless Stoat says they are connected, then the presence they chose. */
  private presenceOf(user: StoatUser): NativePresence | undefined {
    if (user.online === undefined) return undefined;
    if (!user.online || user.presence === "Invisible") return "offline";
    return user.presence === "Idle" ? "idle" : user.presence === "Busy" || user.presence === "Focus" ? "dnd" : "online";
  }

  /** A member row; Stoat's syntax mentions them as <@id>. Roles are a server's, highest first, for their name's colour. */
  private memberRow(user: StoatUser, member: StoatMember | undefined, roles: readonly StoatRole[]): NativeMember {
    const row: NativeMember = { id: user.id, name: member?.nickname ?? displayName(user), mention: `<@${user.id}>` };
    const avatar = this.fileUrl(member?.avatar ?? user.avatar);
    if (avatar) row.avatarUrl = avatar;
    const presence = this.presenceOf(user);
    if (presence) row.presence = presence;
    const colour = roles.find((r) => r.colour && member?.roles.includes(r.id))?.colour;
    if (colour) row.color = colour;
    const status = user.statusText ?? (user.bot ? "Bot" : undefined);
    if (status) row.status = status;
    return row;
  }

  /**
   * Someone's profile card: what is known at once, then their user, their
   * roles in the open server and what they wrote about themselves, from Stoat.
   */
  private async showProfile(id: string): Promise<void> {
    const rest = this.rest;
    if (!isId(id) || !rest) return;
    const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
    const server = channel?.serverId ? this.state.servers.get(channel.serverId) : undefined;
    let member = server ? this.state.members.get(server.id)?.get(id) : undefined;
    const known = this.state.users.get(id);
    const profile: NativeProfile = { id, loading: true, ...(known ? this.profileView(known, member, server) : {}) };
    this.profile = profile;
    this.render();
    const current = () => this.profile === profile;
    try {
      const user = known ?? (await rest.user(id));
      if (server && !member) member = await rest.member(server.id, id).catch(() => undefined);
      const about = await rest.profile(id);
      if (!current()) return;
      if (user) Object.assign(profile, this.profileView(user, member, server));
      if (about) profile.about = about;
    } catch {
      // Stoat may not show this user from here: the card keeps what it has.
    }
    if (!current()) return;
    delete profile.loading;
    this.render();
  }

  private profileView(user: StoatUser, member: StoatMember | undefined, server: StoatServer | undefined): Partial<NativeProfile> {
    const view: Partial<NativeProfile> = { name: member?.nickname ?? displayName(user), username: user.discriminator ? `${user.username}#${user.discriminator}` : `@${user.username}` };
    const avatar = this.fileUrl(member?.avatar ?? user.avatar);
    if (avatar) view.avatarUrl = avatar;
    const presence = this.presenceOf(user);
    if (presence) view.presence = presence;
    const status = user.statusText ?? (user.bot ? "Bot" : undefined);
    if (status) view.status = status;
    const roles = (server?.roles ?? []).filter((r) => member?.roles.includes(r.id)).sort((a, b) => a.rank - b.rank);
    if (roles.length > 0) view.roles = roles.map((r) => ({ name: r.name, ...(r.colour ? { color: r.colour } : {}) }));
    return view;
  }

  // --- Rail and view ---------------------------------------------------------

  private schedulePublish(): void {
    if (this.publishTimer !== undefined) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.setServers(this.railServers());
      this.directsChanged.emit(this.directs());
      this.render();
    }, PUBLISH_DELAY_MS);
  }

  /** A file on the instance's file server (Autumn). */
  private fileUrl(file: StoatFile | undefined): string | undefined {
    return file && this.instance?.autumn ? `${this.instance.autumn}/${file.tag}/${file.id}` : undefined;
  }

  /** A custom emoji's picture, as Stoat's own client links it. */
  private emojiUrl(id: string): string | undefined {
    return this.instance?.autumn ? `${this.instance.autumn}/emojis/${id}` : undefined;
  }

  /** The picker's custom emoji for a channel: messages carry them as :id:, reactions by id. */
  private customEmoji(channel: StoatChannel): NativeCustomEmoji[] {
    return this.state.usableEmoji(channel).flatMap((emoji) => {
      const url = this.emojiUrl(emoji.id);
      if (!url) return [];
      const source = this.state.servers.get(emoji.serverId!)!.name;
      return [{ id: emoji.id, name: emoji.name, animated: emoji.animated, url, source, text: `:${emoji.id}:`, key: emoji.id }];
    });
  }

  railServers(): RailServer[] {
    return [...this.state.servers.values()].map((server) => ({
      key: server.id,
      account: this.account,
      name: server.name,
      iconUrl: this.fileUrl(server.icon),
      unread: this.state.serverUnread(server.id),
      mentions: this.state.serverMentions(server.id),
    }));
  }

  private userName(id: string): string {
    const user = this.state.users.get(id);
    return user ? displayName(user) : "Unknown user";
  }

  private authorName(message: StoatMessage): string {
    const user = this.state.users.get(message.authorId) ?? message.author;
    return message.masquerade ?? (user ? displayName(user) : message.system !== undefined ? "System" : "Unknown user");
  }

  /** The other person in a DM. */
  private dmPartner(channel: StoatChannel): string | undefined {
    return channel.type === ChannelType.DirectMessage ? (channel.recipients.find((r) => r !== this.state.meId) ?? channel.recipients[0]) : undefined;
  }

  private channelTitle(channel: StoatChannel): string {
    const partner = this.dmPartner(channel);
    if (partner) return this.userName(partner);
    if (channel.type === ChannelType.Group) {
      const names = channel.recipients.filter((r) => r !== this.state.meId).map((r) => this.userName(r));
      return channel.name ?? (names.join(", ") || "Group");
    }
    return channel.name ?? channel.id;
  }

  private dmAvatar(channel: StoatChannel): string | undefined {
    const partner = this.dmPartner(channel);
    return partner ? this.fileUrl(this.state.users.get(partner)?.avatar) : this.fileUrl(channel.icon);
  }

  directs(): DirectConversation[] {
    return this.state.privateChannels().map((c) => {
      const direct: DirectConversation = {
        key: c.id,
        account: this.account,
        title: this.channelTitle(c),
        avatarUrl: this.dmAvatar(c),
        lastActivity: idTime(c.lastMessageId),
        unread: this.state.isUnread(c),
        mentions: this.state.mentions(c.id),
      };
      // Ready carries no message text; the preview is known once the last message has arrived or been loaded.
      const last = this.state.latest.get(c.id);
      if (last && last.id === c.lastMessageId) direct.preview = this.previewText(last);
      return direct;
    });
  }

  /** One line for the Messages list: the text with mentions resolved, else the attachment names. */
  private previewText(message: StoatMessage): string {
    const text = this.renderContent(message.system ?? message.content).replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 500);
    return message.attachments.map((a) => `📎 ${a.filename}`).join(", ").slice(0, 500);
  }

  /**
   * Message text with user and channel mentions resolved to names, and
   * custom emoji to their names, or, given `shown`, to <:name:id> for the
   * view to draw, noting each such emoji in `shown`.
   */
  private renderContent(content: string, shown?: Set<string>): string {
    return content
      .replace(new RegExp(`<@(${ULID})>`, "g"), (match, id: string) => (this.state.users.has(id) ? `@${this.userName(id)}` : match))
      .replace(new RegExp(`<#(${ULID})>`, "g"), (match, id: string) => {
        const channel = this.state.channels.get(id);
        return channel?.name ? `#${channel.name}` : match;
      })
      .replace(new RegExp(`:(${ULID}):`, "g"), (match, id: string) => {
        const emoji = this.state.emojis.get(id);
        if (!emoji) return match;
        if (!shown || !this.emojiUrl(id)) return `:${emoji.name}:`;
        shown.add(id);
        return `<${emoji.animated ? "a" : ""}:${emoji.name}:${id}>`;
      });
  }

  private viewMessage(message: StoatMessage, shown: Set<string>): NativeMessage {
    const mine = message.authorId === this.state.meId;
    const editable = mine && message.system === undefined;
    const replyId = message.replies[0];
    // A loaded original, else one fetched for its preview; null where Stoat no longer has it.
    const reply = replyId ? (this.state.findMessage(message.channelId, replyId) ?? this.originals.get(replyId)) : undefined;
    const author = this.state.users.get(message.authorId) ?? message.author;
    return {
      id: message.id,
      author: this.authorName(message),
      avatarUrl: message.masquerade ? undefined : this.fileUrl(author?.avatar),
      content: this.renderContent(message.system ?? message.content, shown),
      timestamp: new Date(idTime(message.id)).toISOString(),
      edited: message.edited,
      mine,
      canEdit: editable,
      source: editable ? message.content : undefined,
      canDelete: mine,
      ...(!mine && this.state.mentionsMe(message) ? { mentionsMe: true } : {}),
      ...(message.pinned ? { pinned: true } : {}),
      // Whether this user may pin here is the server's to say; system messages cannot be pinned.
      canPin: message.system === undefined,
      // Who wrote it, and Stoat's syntax for mentioning them; not for system messages or names a bridge or bot put on.
      ...(message.system === undefined && !message.masquerade ? { authorId: message.authorId, authorMention: `<@${message.authorId}>` } : {}),
      // Originals not fetched (yet) show no preview rather than "deleted"; a preview leads to its original.
      reply: reply ? { author: this.authorName(reply), content: this.renderContent(reply.system ?? reply.content), id: reply.id, timestamp: new Date(idTime(reply.id)).toISOString() } : reply,
      reactions: message.reactions.map((r) => {
        const custom = isId(r.emoji) ? this.state.emojis.get(r.emoji) : undefined;
        return {
          key: r.emoji,
          label: isId(r.emoji) ? `:${custom?.name ?? "emoji"}:` : r.emoji,
          imageUrl: isId(r.emoji) ? this.emojiUrl(r.emoji) : undefined,
          count: r.userIds.length,
          me: this.state.meId !== undefined && r.userIds.includes(this.state.meId),
        };
      }),
      attachments: message.attachments.map((a) => ({
        name: a.filename,
        kind: a.kind,
        url: this.fileUrl(a),
        width: a.width,
        height: a.height,
        size: a.size,
        mime: a.contentType,
      })),
      ...(message.embeds.length > 0 ? { embeds: message.embeds.map((e) => this.viewEmbed(e)) } : {}),
    };
  }

  /** A link preview; a site's picture only through the instance's proxy, so showing it does not reach the site. */
  private viewEmbed(embed: StoatEmbed): NativeEmbed {
    const { media, image, ...text } = embed;
    const view: NativeEmbed = text;
    const january = this.instance?.january;
    if (media) view.image = { url: this.fileUrl(media), width: media.width, height: media.height };
    else if (image && january) view.image = { url: `${january}/proxy?url=${encodeURIComponent(image.url)}`, width: image.width, height: image.height, thumbnail: image.thumbnail };
    return view;
  }

  private sidebar(): NativeSidebarItem[] {
    const item = (channel: StoatChannel, kind: NativeSidebarItem["kind"]): NativeSidebarItem => ({
      id: channel.id,
      name: this.channelTitle(channel),
      kind,
      iconUrl: kind === "dm" ? this.dmAvatar(channel) : undefined,
      unread: this.state.isUnread(channel),
      mentions: this.state.mentions(channel.id),
      active: channel.id === this.selectedChannelId,
      muted: this.state.notifyLevel(channel) === "muted",
      canMute: true,
    });
    if (this.selection.kind === "home") return this.state.privateChannels().map((c) => item(c, "dm"));
    return this.state.serverEntries(this.selection.serverId).map((entry) =>
      "channel" in entry
        ? item(entry.channel, "text")
        : { id: entry.category.id, name: entry.category.title, kind: "category", unread: false, mentions: 0, active: false },
    );
  }

  viewState(): NativeViewState {
    const platform = this.deps.def.name;
    switch (this.screen) {
      case "login":
        return { screen: "login", platform, identity: "email", busy: this.busy, status: this.status, error: this.error };
      case "mfa":
        return { screen: "mfa", platform, codes: this.mfaCodes, busy: this.busy, error: this.error };
      case "connecting":
        return { screen: "connecting", platform, status: this.connection === "reconnecting" ? "Reconnecting…" : "Connecting…" };
      case "chat": {
        const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
        const server = this.selection.kind === "server" ? this.state.servers.get(this.selection.serverId) : undefined;
        const shown = new Set<string>();
        const members = channel ? this.memberView(channel) : undefined;
        return {
          screen: "chat",
          platform,
          title: server?.name ?? "Direct Messages",
          me: this.state.me ? displayName(this.state.me) : "",
          sidebar: this.sidebar(),
          channel: channel
            ? {
                id: channel.id,
                name: this.channelTitle(channel),
                messages: (this.state.messages.get(channel.id) ?? []).map((m) => this.viewMessage(m, shown)),
                loading: this.loading.has(channel.id),
                hasOlder: this.hasOlder.get(channel.id) ?? false,
                typing: this.state.typingIn(channel.id).map((u) => displayName(u)),
                pending: (this.pending.get(channel.id) ?? []).map((f) => ({ name: f.filename, size: f.size })),
                uploading: this.uploading.has(channel.id),
                ...(this.unreadAt?.channelId === channel.id ? { unread: this.unreadView(channel.id, this.unreadAt) } : {}),
                ...(this.pins?.channelId === channel.id ? { pins: this.pins.list } : {}),
                ...(this.search?.channelId === channel.id ? { search: this.search.results } : {}),
                ...(members ? { members } : {}),
                // Files need the instance's file server (Autumn).
                can: { reply: true, react: true, attach: this.deps.files !== undefined && Boolean(this.instance?.autumn), typing: true, members: true, pins: true, search: true, forward: true },
              }
            : null,
          customEmoji: channel ? this.customEmoji(channel) : [],
          // Pictures of the custom emoji in the messages above; only emoji with a picture were noted.
          emojiUrls: Object.fromEntries([...shown].map((id) => [id, this.emojiUrl(id)!])),
          voice: null,
          ...(this.profile ? { profile: this.profile } : {}),
          error: this.error ?? (this.connection === "reconnecting" ? "Connection lost. Reconnecting…" : undefined),
        };
      }
    }
  }

  private render(): void {
    this.deps.render(this.viewState());
  }
}
