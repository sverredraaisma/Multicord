import type { DirectConversation, HomeBadge, PlatformAdapter, RailServer } from "../../shared/adapter";
import { MAX_ATTACHMENTS, type NativeAction, type NativeMessage, type NativeSidebarItem, type NativeViewState } from "../../shared/native";
import type { AccountStatus } from "../../shared/settings";
import type { AsyncSecretStore, FileSource } from "../../engine/runtime";
import { BaseAdapter } from "../../shared/baseAdapter";
import { StoatEvents, type EventsStatus, type SocketFactory } from "./events";
import { discoverInstance, instanceHosts, StoatRest, type LoginResult, type RestOptions, type StoatInstance } from "./rest";
import { StoatState, TYPING_MS } from "./state";
import { ChannelType, TEXT_CHANNEL_TYPES, displayName, idTime, isId, type StoatChannel, type StoatFile, type StoatMessage } from "./types";

const PAGE_SIZE = 50;
const PUBLISH_DELAY_MS = 100;
const ACK_DELAY_MS = 750;
/** Typing is re-announced this often while the user keeps typing, and ended after this long idle. */
const TYPING_REPEAT_MS = 8_000;
const TYPING_IDLE_MS = 5_000;
/** Stoat's default message_attachments limit. */
const MAX_FILES = Math.min(5, MAX_ATTACHMENTS);
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

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
  files?: { pick(): Promise<FileSource[]> };
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

  constructor(private readonly deps: StoatAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
    this.state.changed.on(() => this.schedulePublish());
    // Typing indicators expire on their own; re-render when they may have.
    this.state.changed.on(() => {
      clearTimeout(this.typingTimer);
      if (this.state.typing.size > 0) this.typingTimer = setTimeout(() => this.render(), TYPING_MS);
    });
    this.state.incoming.on((message) => {
      if (message.channelId === this.selectedChannelId) this.ackSoon(message.channelId);
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
      case "loadOlder":
        return this.loadOlder();
      case "typing":
        return this.sendTyping();
      case "attach":
        return this.attach();
      case "removeAttachment":
        this.pending.get(this.selectedChannelId ?? "")?.splice(action.index, 1);
        return this.render();
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
    this.selectedChannelId = channelId;
    this.lastChannel.set(channel.serverId ?? "home", channelId);
    this.error = undefined;
    this.render();
    if (!this.state.messages.has(channelId)) await this.fetchHistory(channelId, undefined);
    this.ackSoon(channelId);
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
  }

  private async loadOlder(): Promise<void> {
    const channelId = this.selectedChannelId;
    const oldest = channelId ? this.state.messages.get(channelId)?.[0] : undefined;
    if (channelId && oldest && this.hasOlder.get(channelId)) await this.fetchHistory(channelId, oldest.id);
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

  /** Message text with user and channel mentions and custom emoji resolved to names. */
  private renderContent(content: string): string {
    return content
      .replace(new RegExp(`<@(${ULID})>`, "g"), (match, id: string) => (this.state.users.has(id) ? `@${this.userName(id)}` : match))
      .replace(new RegExp(`<#(${ULID})>`, "g"), (match, id: string) => {
        const channel = this.state.channels.get(id);
        return channel?.name ? `#${channel.name}` : match;
      })
      .replace(new RegExp(`:(${ULID}):`, "g"), (match, id: string) => {
        const emoji = this.state.emojis.get(id);
        return emoji ? `:${emoji.name}:` : match;
      });
  }

  private viewMessage(message: StoatMessage): NativeMessage {
    const mine = message.authorId === this.state.meId;
    const editable = mine && message.system === undefined;
    const replyId = message.replies[0];
    const reply = replyId ? this.state.findMessage(message.channelId, replyId) : undefined;
    const author = this.state.users.get(message.authorId) ?? message.author;
    return {
      id: message.id,
      author: this.authorName(message),
      avatarUrl: message.masquerade ? undefined : this.fileUrl(author?.avatar),
      content: this.renderContent(message.system ?? message.content),
      timestamp: new Date(idTime(message.id)).toISOString(),
      edited: message.edited,
      mine,
      canEdit: editable,
      source: editable ? message.content : undefined,
      canDelete: mine,
      // Only replies to loaded messages can be previewed; others show none rather than "deleted".
      reply: reply ? { author: this.authorName(reply), content: this.renderContent(reply.system ?? reply.content) } : undefined,
      reactions: message.reactions.map((r) => {
        const custom = isId(r.emoji) ? this.state.emojis.get(r.emoji) : undefined;
        return {
          key: r.emoji,
          label: isId(r.emoji) ? `:${custom?.name ?? "emoji"}:` : r.emoji,
          imageUrl: isId(r.emoji) && this.instance?.autumn ? `${this.instance.autumn}/emojis/${r.emoji}` : undefined,
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
    };
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
                messages: (this.state.messages.get(channel.id) ?? []).map((m) => this.viewMessage(m)),
                loading: this.loading.has(channel.id),
                hasOlder: this.hasOlder.get(channel.id) ?? false,
                typing: this.state.typingIn(channel.id).map((u) => displayName(u)),
                pending: (this.pending.get(channel.id) ?? []).map((f) => ({ name: f.filename, size: f.size })),
                uploading: this.uploading.has(channel.id),
                // Files need the instance's file server (Autumn).
                can: { reply: true, react: true, attach: this.deps.files !== undefined && Boolean(this.instance?.autumn), typing: true, members: false },
              }
            : null,
          voice: null,
          error: this.error ?? (this.connection === "reconnecting" ? "Connection lost. Reconnecting…" : undefined),
        };
      }
    }
  }

  private render(): void {
    this.deps.render(this.viewState());
  }
}
