import type { DirectConversation, HealthCheck, HomeBadge, PlatformAdapter, RailServer } from "../../shared/adapter";
import {
  MAX_ATTACHMENTS,
  MAX_LISTED_MESSAGES,
  type NativeAction,
  type NativeAttachment,
  type NativeCustomEmoji,
  type NativeEmbed,
  type NativeListedMessage,
  type NativeMember,
  type NativeMemberList,
  type NativeMessage,
  type NativeMessageList,
  type NativeProfile,
  type NativeSidebarItem,
  type NativeUnread,
  type NativeViewState,
} from "../../shared/native";
import type { PickedFile } from "../../shared/engine";
import { TYPING_SETTING, type AccountStatus, type ServiceSettingValues } from "../../shared/settings";
import type { AsyncSecretStore, EngineFiles, FileSource } from "../../engine/runtime";
import { BaseAdapter } from "../../shared/baseAdapter";
import { discoverInstance, instanceHosts, type SpacebarInstance } from "./discovery";
import { SpacebarGateway, type GatewayStatus, type SocketFactory } from "./gateway";
import { MEMBER_PAGE, PAGE_SIZE, SpacebarApiError, SpacebarRest, type LoginStep, type RestOptions } from "./rest";
import { SpacebarState, TYPING_MS } from "./state";
import {
  ChannelType,
  MessageType,
  TEXT_CHANNEL_TYPES,
  compareIds,
  displayName,
  emojiKey,
  isRecord,
  roleColor,
  timestampOf,
  type ReactionEmoji,
  type SpacebarChannel,
  type SpacebarLinkEmbed,
  type SpacebarMember,
  type SpacebarMessage,
  type SpacebarUser,
} from "./types";

const PUBLISH_DELAY_MS = 100;
const ACK_DELAY_MS = 750;
/** Spacebar shows typing for about 10 s, so once per 8 s is enough. */
const TYPING_REPEAT_MS = 8_000;
/** Members listed at most, in pages of MEMBER_PAGE: what the view shows. */
const MAX_MEMBERS = 200;
/** The sign-in step that takes a token instead of a password. */
const TOKEN_PROMPT = "token";

/** How often the instance is asked whether its API and CDN answer. */
export const HEALTH_INTERVAL_MS = 5 * 60_000;

/** What the module offers the shell; its manifest must declare the same (tested). Spacebar's voice is not offered (see the README). */
export const CAPABILITIES: PlatformAdapter["capabilities"] = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

/** Which instance this is: the engine's own info. */
export interface SpacebarInstanceDef {
  id: string;
  name: string;
  /** The address the user gave: the instance's site or its API's origin. */
  url: string;
}

export interface SpacebarAdapterDeps {
  def: SpacebarInstanceDef;
  fetch: typeof fetch;
  createSocket: SocketFactory;
  /** This instance's own secrets. */
  secrets: AsyncSecretStore;
  /** Sends display state to the native view. */
  render(state: NativeViewState): void;
  /** Narrows what the engine may reach to these hosts. */
  lockHosts?(hosts: string[]): Promise<void>;
  rest?: Partial<RestOptions>;
  platform?: string;
  /** Lets the user pick files; the engine reads only what was picked. */
  files?: EngineFiles;
  /** This instance's settings values (TYPING_SETTING); changes come through applySettings(). */
  settings?: ServiceSettingValues;
}

type Selection = { kind: "home" } | { kind: "guild"; guildId: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const newNonce = (): string => String(Date.now()) + String(Math.floor(Math.random() * 1e6));
const isPrivate = (channel: SpacebarChannel): boolean => channel.type === ChannelType.Dm || channel.type === ChannelType.GroupDm;

/** What a file is by its MIME type. */
export function mediaKind(contentType: string | undefined): NativeAttachment["kind"] {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  return "file";
}

/**
 * Native Spacebar adapter: talks to a Spacebar instance's Discord-compatible
 * API from its sandboxed engine and renders in Multicord's own chat view.
 * Sign-in, the gateway session and the token all stay here.
 */
export class SpacebarAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = CAPABILITIES;

  readonly state = new SpacebarState();
  private instance: SpacebarInstance | undefined;
  private rest: SpacebarRest | undefined;
  private gateway: SpacebarGateway | undefined;
  private screen: "login" | "mfa" | "token" | "connecting" | "chat" = "login";
  private connection: GatewayStatus = "closed";
  private busy = false;
  private error: string | undefined;
  private mfaTicket: string | undefined;
  private selection: Selection = { kind: "home" };
  private selectedChannelId: string | undefined;
  private readonly lastChannel = new Map<string, string>();
  private readonly hasOlder = new Map<string, boolean>();
  /** Where the open channel's news began when it was opened: the last message read then, if any. */
  private unreadAt: { channelId: string; after?: string } | undefined;
  private readonly loading = new Set<string>();
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly typingSent = new Map<string, number>();
  /** Settings' "Send typing indicators" for this service. */
  private typingIndicators: boolean;
  private readonly pending = new Map<string, FileSource[]>();
  private readonly uploading = new Set<string>();
  /** Whether a session token is stored, so the account shows as signed in before it connects. */
  private hasToken = false;
  private visible = false;
  /** The view's member panel is open, and the open guild's members as far as they are fetched. */
  private membersOpen = false;
  private members: { guildId: string; list: SpacebarMember[]; loading: boolean; hasMore: boolean; error?: string } | undefined;
  /** The profile card the view asked for last. */
  private profile: NativeProfile | undefined;
  private checks: HealthCheck[] = [];
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  /** The open channel's pinned messages, while its pins panel is open. */
  private pins: { channelId: string; list: NativeMessageList } | undefined;

  constructor(private readonly deps: SpacebarAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
    this.typingIndicators = deps.settings?.[TYPING_SETTING] !== false;
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

  /** Settings changed: whether to send typing indicators. One already sent runs out by itself. */
  applySettings(values: ServiceSettingValues): void {
    this.typingIndicators = values[TYPING_SETTING] !== false;
    this.render();
  }

  /** Discovers the instance, locks the engine to its hosts, and resumes a saved session or shows sign-in. */
  async start(): Promise<void> {
    this.healthTimer ??= setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    const found = await this.ensureInstance();
    void this.checkHealth();
    if (!found) return this.render();
    const token = await this.deps.secrets.load("token");
    this.hasToken = token !== undefined;
    if (token) this.openSession(token);
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
      case "cancelPrompt":
        this.mfaTicket = undefined;
        this.screen = "login";
        this.error = undefined;
        return this.render();
      case "prompt":
        return action.id === TOKEN_PROMPT ? this.useToken(action.values.token ?? "") : undefined;
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
      case "sendFile":
        return this.sendShared(action.file, action.replyTo);
      case "removeAttachment":
        this.pending.get(this.selectedChannelId ?? "")?.splice(action.index, 1);
        return this.render();
      case "members":
        return this.setMembersOpen(action.open);
      case "loadMembers":
        return this.loadMembers(action.offset);
      case "profile":
        return this.showProfile(action.id);
      case "pins":
        return this.showPins(action.open);
      case "pin":
        return this.pin(action.messageId, action.pin);
      case "logout":
        return this.logout();
      default:
        return; // Not offered here.
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
    if (!this.state.guilds.has(key)) throw new Error(`Unknown Spacebar guild: ${key}`);
    this.selection = { kind: "guild", guildId: key };
    const first = this.state.guildChannels(key).find((c) => TEXT_CHANNEL_TYPES.has(c.type));
    const channelId = this.lastChannel.get(key) ?? first?.id;
    if (channelId) return this.selectChannel(channelId);
    this.selectedChannelId = undefined;
    this.render();
  }

  /** Opens any text channel: a DM at home, or a guild channel inside its guild. */
  async openConversation(key: string): Promise<void> {
    const guildId = this.state.channels.get(key)?.guildId;
    this.selection = guildId ? { kind: "guild", guildId } : { kind: "home" };
    await this.selectChannel(key);
  }

  // --- Session ---------------------------------------------------------------

  /** For Settings > Diagnostics: whether the instance was found, and its API and CDN answer. */
  health(): HealthCheck[] {
    return this.checks;
  }

  /** Asks the instance's API (/api/ping) and CDN (/ping) whether they answer; nothing is sent with them. */
  private async checkHealth(): Promise<void> {
    const instance = await this.ensureInstance();
    if (!instance) {
      // ensureInstance() says why in the error.
      this.checks = [{ name: "Instance found", ok: false, detail: `${this.error} Nothing works until it does.` }];
      return this.render();
    }
    const probes = [
      { name: "API answers", url: `${instance.api.replace(/\/v\d+$/, "")}/ping`, breaks: "Signing in, history and sending fail." },
      { name: "CDN answers", url: `${instance.cdn}/ping`, breaks: "Pictures, avatars and files do not load." },
    ];
    this.checks = await Promise.all(
      probes.map(async ({ name, url, breaks }): Promise<HealthCheck> => {
        try {
          const response = await this.deps.fetch(url);
          return response.ok ? { name, ok: true } : { name, ok: false, detail: `It answered HTTP ${response.status}. ${breaks}` };
        } catch (error) {
          return { name, ok: false, detail: `It could not be reached (${messageOf(error)}). ${breaks}` };
        }
      }),
    );
    this.render();
  }

  /** Finds the instance's endpoints once, then locks the engine to their hosts. */
  private async ensureInstance(): Promise<SpacebarInstance | undefined> {
    if (this.instance) return this.instance;
    try {
      const instance = await discoverInstance(this.deps.def.url, this.deps.fetch);
      this.instance = instance;
      this.rest = new SpacebarRest(instance.api, { fetch: this.deps.fetch, ...this.deps.rest });
      this.error = undefined;
      try {
        await this.deps.lockHosts?.(instanceHosts(instance));
      } catch (error) {
        // Refused, e.g. for a private address: the shell's general rules still apply.
        console.warn(`[spacebar] host lock refused: ${messageOf(error)}`);
      }
      return instance;
    } catch (error) {
      this.error = `Could not reach ${this.deps.def.name}: ${messageOf(error)}`;
      return undefined;
    }
  }

  private async login(identity: string, password: string): Promise<void> {
    await this.signInStep(async () => {
      const result = await this.rest!.login(identity, password);
      if ("captcha" in result) {
        // hCaptcha and reCAPTCHA need the instance's own web page; a token from there signs in instead.
        this.screen = "token";
        this.error = undefined;
        return;
      }
      this.onLoginResult(result);
    });
  }

  private async submitMfa(code: string): Promise<void> {
    if (!this.mfaTicket) return;
    const ticket = this.mfaTicket;
    await this.signInStep(async () => this.onLoginResult(await this.rest!.loginTotp(code.replace(/\s/g, ""), ticket)));
  }

  /** Signs in with a token copied from a Spacebar client, checked with the instance first. */
  private async useToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (trimmed === "" || /\s/.test(trimmed)) {
      this.error = "Paste the whole token, without spaces.";
      return this.render();
    }
    await this.signInStep(async () => {
      this.rest!.token = trimmed;
      try {
        await this.rest!.me();
      } catch (error) {
        this.rest!.token = undefined;
        throw error instanceof SpacebarApiError && error.status === 401 ? new Error("The instance did not accept this token.") : error;
      }
      this.onLoginResult({ token: trimmed });
    });
  }

  /** Runs one sign-in step with the form busy, showing what went wrong. */
  private async signInStep(step: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    this.render();
    try {
      if (!(await this.ensureInstance())) throw new Error(this.error!);
      await step();
    } catch (error) {
      this.error = messageOf(error);
    }
    this.busy = false;
    this.render();
  }

  private onLoginResult(result: LoginStep): void {
    if ("token" in result) {
      this.mfaTicket = undefined;
      this.hasToken = true;
      void this.deps.secrets.save("token", result.token);
      this.openSession(result.token);
      return;
    }
    // A security key is bound to the instance's own web origin, which Multicord will not pose as.
    if (result.webauthnOnly) throw new Error("This account signs in with a security key, which only works in Spacebar's own apps.");
    this.mfaTicket = result.ticket;
    this.screen = "mfa";
  }

  private openSession(token: string): void {
    this.rest!.token = token;
    this.screen = "connecting";
    this.gateway = new SpacebarGateway(
      this.instance!.gateway,
      token,
      this.deps.createSocket,
      {
        dispatch: (event, data) => {
          this.state.apply(event, data);
          // Someone pinned or unpinned in the channel whose pins are listed.
          if (event === "CHANNEL_PINS_UPDATE" && this.pins && isRecord(data) && data.channel_id === this.pins.channelId) void this.loadPins(this.pins.channelId);
          if (event === "READY") {
            this.screen = "chat";
            this.render();
          }
        },
        status: (status) => {
          this.connection = status;
          this.render();
        },
        authFailed: () => this.endSession("Your session has ended. Please sign in again."),
      },
      this.deps.platform,
    );
    this.gateway.connect();
    this.render();
  }

  private async logout(): Promise<void> {
    await this.rest?.logout().catch(() => undefined);
    this.endSession(undefined);
  }

  private endSession(error: string | undefined): void {
    this.gateway?.disconnect();
    this.gateway = undefined;
    if (this.rest) this.rest.token = undefined;
    this.hasToken = false;
    void this.deps.secrets.delete("token");
    this.state.reset();
    this.membersOpen = false;
    this.members = undefined;
    this.profile = undefined;
    this.pins = undefined;
    this.pending.clear();
    this.selection = { kind: "home" };
    this.selectedChannelId = undefined;
    this.lastChannel.clear();
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
    if (channelId !== this.selectedChannelId) {
      // Noted before it is read: where its news began.
      this.unreadAt = this.state.isUnread(channel) ? { channelId, after: this.state.readStates.get(channelId)?.lastMessageId } : undefined;
      this.profile = undefined;
      this.pins = undefined;
    }
    this.selectedChannelId = channelId;
    this.lastChannel.set(channel.guildId ?? "home", channelId);
    this.error = undefined;
    const members = this.membersOpen ? this.fetchMembers(false) : undefined;
    this.render();
    if (!this.state.messages.has(channelId)) await this.fetchHistory(channelId, undefined);
    this.ackSoon(channelId);
    await members;
  }

  /**
   * The open channel's unread marker: the first message from someone else
   * after the last one read when it was opened, once the loaded messages
   * reach back that far. Spacebar gives no count.
   */
  private unreadView(channelId: string, after: string | undefined): NativeUnread | undefined {
    const messages = this.state.messages.get(channelId) ?? [];
    const from = after ?? "0";
    const reach = !(this.hasOlder.get(channelId) ?? false) || messages.some((m) => compareIds(m.id, from) <= 0);
    if (!reach) return {};
    const first = messages.find((m) => compareIds(m.id, from) > 0 && m.author.id !== this.state.me?.id);
    return first && { firstId: first.id };
  }

  private async fetchHistory(channelId: string, before: string | undefined): Promise<void> {
    if (this.loading.has(channelId)) return;
    this.loading.add(channelId);
    this.render();
    try {
      const page = await this.rest!.messages(channelId, before);
      this.hasOlder.set(channelId, page.length === PAGE_SIZE);
      this.state.addHistory(channelId, page, before !== undefined);
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
    this.uploading.add(channelId);
    this.render();
    await this.attempt("Message not sent", async () => {
      const sent = await this.rest!.sendMessage(channelId, content, newNonce(), replyTo, files);
      this.pending.delete(channelId);
      if (sent) this.state.addHistory(channelId, [sent], false);
    });
    this.uploading.delete(channelId);
    this.render();
  }

  /** Adds files from the OS picker to the open channel's next message. */
  private async attach(): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.deps.files) return;
    await this.attempt("Could not attach", async () => {
      const list = this.pending.get(channelId) ?? [];
      for (const file of await this.deps.files!.pick()) {
        if (list.length >= MAX_ATTACHMENTS) {
          this.error = `At most ${MAX_ATTACHMENTS} files per message.`;
          break;
        }
        list.push(file);
      }
      this.pending.set(channelId, list);
      this.render();
    });
  }

  /** A file the shell hands over (a favourite, or a sticker sent as a picture): it goes out at once, or waits with files already picked. */
  private async sendShared(file: PickedFile, replyTo?: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.deps.files?.open || this.uploading.has(channelId)) return;
    const list = this.pending.get(channelId) ?? [];
    if (list.length >= MAX_ATTACHMENTS) {
      this.error = `At most ${MAX_ATTACHMENTS} files per message.`;
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

  /** The user's own reactions are applied once the server accepts them. */
  private async react(messageId: string, key: string, add: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest) return;
    const custom = /^(\w{1,64}):(\d{1,20})$/.exec(key);
    const emoji: ReactionEmoji = custom ? { name: custom[1]!, id: custom[2]! } : { name: key };
    await this.attempt("Reaction failed", async () => {
      await this.rest!.react(channelId, messageId, key, add);
      this.state.applyReaction(channelId, messageId, emoji, true, add);
    });
  }

  /** Opens the open channel's pins panel and fetches its pins, or closes it. */
  private async showPins(open: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    this.pins = open && channelId ? { channelId, list: { messages: [], loading: true } } : undefined;
    this.render();
    if (this.pins) await this.loadPins(this.pins.channelId);
  }

  /** Fetches the pins of a channel whose pins panel is open; a reply for a panel since closed is dropped. */
  private async loadPins(channelId: string): Promise<void> {
    let list: NativeMessageList;
    try {
      const pinned = await this.rest!.pins(channelId);
      list = { messages: pinned.slice(0, MAX_LISTED_MESSAGES).map((m) => this.listedMessage(m)), loading: false };
      if (pinned.length > MAX_LISTED_MESSAGES) list.note = `Only the latest ${MAX_LISTED_MESSAGES} pins are listed.`;
    } catch (error) {
      list = { messages: [], loading: false, error: `Could not load pinned messages: ${messageOf(error)}` };
    }
    if (this.pins?.channelId !== channelId) return;
    this.pins = { channelId, list };
    this.render();
  }

  /** Pins or unpins a message; Spacebar decides whether the user may (anyone in a DM, Manage Messages in a guild). */
  private async pin(messageId: string, pin: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest) return;
    await this.attempt(pin ? "Message not pinned" : "Message not unpinned", async () => {
      await this.rest!.pin(channelId, messageId, pin);
      const message = this.state.findMessage(channelId, messageId);
      if (message) message.pinned = pin;
      this.render();
      if (this.pins?.channelId === channelId) await this.loadPins(channelId);
    });
  }

  /** Tells others the user is typing, at most once per TYPING_REPEAT_MS per channel, and not while Settings turn it off. */
  private async sendTyping(now: number = Date.now()): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest || !this.typingIndicators || now - (this.typingSent.get(channelId) ?? -Infinity) < TYPING_REPEAT_MS) return;
    this.typingSent.set(channelId, now);
    await this.rest.typing(channelId).catch(() => undefined);
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

  /** Marks the open channel read, debounced, while the view is in front. */
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

  /** Notifies of DMs, and of guild messages that mention the user. */
  private notify(message: SpacebarMessage): void {
    const channel = this.state.channels.get(message.channelId);
    if (!channel || (!isPrivate(channel) && !this.state.mentionsMe(message))) return;
    const author = this.nameOf(message.author);
    const guild = channel.guildId ? this.state.guilds.get(channel.guildId) : undefined;
    const where = channel.type === ChannelType.Dm ? "" : guild ? ` in #${channel.name ?? channel.id} (${guild.name})` : ` in ${this.channelTitle(channel)}`;
    const text = this.renderContent(message.content).trim();
    this.notifications.emit({
      title: `${author}${where}`,
      body: (text || (message.attachments.length > 0 ? "Sent an attachment" : "New message")).slice(0, 200),
      target: channel.id,
      railKey: guild ? guild.id : `dm:${channel.id}`,
      inView: this.visible && this.selectedChannelId === channel.id,
    });
  }

  // --- Members and profiles --------------------------------------------------

  /** The member panel opened (fetching the open conversation's members afresh) or closed. */
  private async setMembersOpen(open: boolean): Promise<void> {
    this.membersOpen = open;
    if (!open) this.members = undefined;
    this.render();
    if (open) await this.fetchMembers(false);
  }

  private async loadMembers(offset: number): Promise<void> {
    // Only the next page of what is listed now.
    if (this.members && !this.members.loading && this.members.hasMore && offset === this.members.list.length) await this.fetchMembers(true);
  }

  /** Fetches a page of the open guild's members (GET /guilds/{id}/members), from the start or after those listed. */
  private async fetchMembers(more: boolean): Promise<void> {
    const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
    const guildId = channel?.guildId;
    if (!guildId) {
      this.members = undefined;
      return;
    }
    if (!more && this.members?.guildId === guildId) return;
    const listed = more && this.members?.guildId === guildId ? this.members.list : [];
    this.members = { guildId, list: listed, loading: true, hasMore: false };
    this.render();
    let next: typeof this.members;
    try {
      const page = await this.rest!.members(guildId, listed.at(-1)?.user.id);
      const list = [...listed, ...page].slice(0, MAX_MEMBERS);
      next = { guildId, list, loading: false, hasMore: page.length === MEMBER_PAGE && list.length < MAX_MEMBERS };
    } catch (error) {
      next = { guildId, list: listed, loading: false, hasMore: false, error: `Could not load members: ${messageOf(error)}` };
    }
    // A reply for a panel since closed, or another guild, is dropped.
    if (!this.membersOpen || this.members?.guildId !== guildId) return;
    this.members = next;
    this.render();
  }

  /** A member row: their nickname, picture, the colour of their highest coloured role, and how to mention them. */
  private memberRow(user: SpacebarUser, guildId?: string, member?: SpacebarMember): NativeMember {
    const row: NativeMember = { id: user.id, name: member?.nick ?? this.nameOf(user), mention: `<@${user.id}>` };
    const avatar = this.avatarUrl(user);
    if (avatar) row.avatarUrl = avatar;
    const color = guildId && member ? roleColor(this.memberRoles(guildId, member).find((r) => r.color > 0)) : undefined;
    if (color) row.color = color;
    if (user.bot) row.status = "Bot";
    return row;
  }

  /** A member's roles in a guild, highest first. */
  private memberRoles(guildId: string, member: SpacebarMember) {
    return (this.state.roles.get(guildId) ?? []).filter((r) => member.roles.includes(r.id)).sort((a, b) => b.position - a.position);
  }

  /**
   * The member panel's list: a guild's members under their highest hoisted
   * role, then "Members"; a DM's or group's people. Spacebar's member list
   * route carries no presence, so none is shown.
   */
  private memberView(channel: SpacebarChannel): NativeMemberList | undefined {
    if (!this.membersOpen) return undefined;
    if (isPrivate(channel)) {
      const people = [...(this.state.me ? [this.state.me] : []), ...channel.recipients.filter((r) => r.id !== this.state.me?.id)];
      return { sections: [{ name: "Members", members: people.map((u) => this.memberRow(u)) }], hasMore: false, loading: false };
    }
    const guildId = channel.guildId!;
    const members = this.members?.guildId === guildId ? this.members : undefined;
    // Hoisted roles in their order, then everyone else, each member under their highest hoisted role.
    const hoisted = (this.state.roles.get(guildId) ?? []).filter((r) => r.hoist).sort((a, b) => b.position - a.position);
    const rows = new Map<string, NativeMember[]>([...hoisted.map((r): [string, NativeMember[]] => [r.id, []]), ["", []]]);
    for (const member of members?.list ?? []) rows.get(this.memberRoles(guildId, member).find((r) => r.hoist)?.id ?? "")!.push(this.memberRow(member.user, guildId, member));
    const sections = [...hoisted.map((r) => ({ name: r.name, members: rows.get(r.id)! })), { name: "Members", members: rows.get("")! }].filter((s) => s.members.length > 0);
    const view: NativeMemberList = { sections, hasMore: members?.hasMore ?? false, loading: members?.loading ?? true };
    if (members?.error) view.error = members.error;
    return view;
  }

  /** A profile card from what the session knows: the user's name and username, and their roles in the open guild. */
  private showProfile(id: string): void {
    const user = this.state.users.get(id) ?? this.members?.list.find((m) => m.user.id === id)?.user;
    if (!user) return;
    const guildId = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId)?.guildId : undefined;
    const member = guildId && this.members?.guildId === guildId ? this.members.list.find((m) => m.user.id === id) : undefined;
    const profile: NativeProfile = { id, name: member?.nick ?? displayName(user), username: `@${user.username}` };
    const avatar = this.avatarUrl(user);
    if (avatar) profile.avatarUrl = avatar;
    if (user.bot) profile.status = "Bot";
    const roles = guildId && member ? this.memberRoles(guildId, member) : [];
    if (roles.length > 0) profile.roles = roles.map((r) => ({ name: r.name, ...(roleColor(r) ? { color: roleColor(r) } : {}) }));
    this.profile = profile;
    this.render();
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

  /** The CDN: everything shown from the instance is after discovery. */
  private get cdn(): string {
    return this.instance!.cdn;
  }

  /** Someone's name as last heard of: a user update may have renamed them since a message came. */
  private nameOf(user: SpacebarUser): string {
    return displayName(this.state.users.get(user.id) ?? user);
  }

  private avatarUrl(user: SpacebarUser): string | undefined {
    return user.avatar ? `${this.cdn}/avatars/${user.id}/${user.avatar}.png?size=64` : undefined;
  }

  railServers(): RailServer[] {
    return [...this.state.guilds.values()].map((guild) => ({
      key: guild.id,
      account: this.account,
      name: guild.name,
      iconUrl: guild.icon ? `${this.cdn}/icons/${guild.id}/${guild.icon}.png?size=96` : undefined,
      unread: this.state.guildUnread(guild.id),
      mentions: this.state.guildMentions(guild.id),
    }));
  }

  private channelTitle(channel: SpacebarChannel): string {
    if (isPrivate(channel)) {
      const names = channel.recipients.filter((r) => r.id !== this.state.me?.id).map((r) => this.nameOf(r));
      return channel.name ?? (names.join(", ") || "Direct message");
    }
    return channel.name ?? channel.id;
  }

  private dmAvatar(channel: SpacebarChannel): string | undefined {
    const user = channel.type === ChannelType.Dm ? channel.recipients.find((r) => r.id !== this.state.me?.id) : undefined;
    return user && this.avatarUrl(user);
  }

  directs(): DirectConversation[] {
    return this.state.privateChannels().map((c) => {
      const direct: DirectConversation = {
        key: c.id,
        account: this.account,
        title: this.channelTitle(c),
        avatarUrl: this.dmAvatar(c),
        lastActivity: timestampOf(c.lastMessageId),
        unread: this.state.isUnread(c),
        mentions: this.state.mentions(c.id),
      };
      // READY carries no message text; the preview is known once the last message has arrived or been loaded.
      const last = this.state.latest.get(c.id);
      if (last && last.id === c.lastMessageId) direct.preview = this.previewText(last);
      return direct;
    });
  }

  /** One line for the Messages list: the text with mentions resolved, else the attachment names. */
  private previewText(message: SpacebarMessage): string {
    const text = this.renderContent(message.content).replace(/\s+/g, " ").trim();
    return text || message.attachments.map((a) => `📎 ${a.filename}`).join(", ");
  }

  /** Message text with user, role and channel mentions resolved to names. */
  private renderContent(content: string): string {
    return content
      .replace(/<@!?(\d{1,20})>/g, (match, id: string) => {
        const user = this.state.users.get(id);
        return user ? `@${displayName(user)}` : match;
      })
      .replace(/<@&(\d{1,20})>/g, (match, id: string) => {
        const role = [...this.state.roles.values()].flat().find((r) => r.id === id);
        return role ? `@${role.name}` : match;
      })
      .replace(/<#(\d{1,20})>/g, (match, id: string) => {
        const channel = this.state.channels.get(id);
        return channel?.name ? `#${channel.name}` : match;
      });
  }

  /** A message's text for the view; the line Spacebar adds for a pin says what happened. */
  private messageText(message: SpacebarMessage): string {
    return message.type === MessageType.PinnedMessage ? "*pinned a message.*" : this.renderContent(message.content);
  }

  /** A message as the pins list shows it: its text, or its first file's name when it has none. */
  private listedMessage(message: SpacebarMessage): NativeListedMessage {
    const listed: NativeListedMessage = {
      id: message.id,
      author: this.nameOf(message.author),
      content: this.messageText(message) || (message.attachments[0] ? `📎 ${message.attachments[0].filename}` : ""),
      timestamp: message.timestamp,
    };
    const avatar = this.avatarUrl(message.author);
    if (avatar) listed.avatarUrl = avatar;
    return listed;
  }

  private viewMessage(message: SpacebarMessage): NativeMessage {
    const mine = message.author.id === this.state.me?.id;
    const ordinary = message.type === MessageType.Default || message.type === MessageType.Reply;
    const editable = mine && ordinary;
    const reply = message.replyTo;
    const view: NativeMessage = {
      id: message.id,
      author: this.nameOf(message.author),
      authorId: message.author.id,
      authorMention: `<@${message.author.id}>`,
      content: this.messageText(message),
      timestamp: message.timestamp,
      edited: message.edited,
      mine,
      canEdit: editable,
      canDelete: mine,
      // Spacebar pins ordinary messages and replies; whether this user may is the server's to say.
      canPin: ordinary,
      reactions: message.reactions.map((r) => ({
        key: emojiKey(r.emoji),
        label: r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name,
        imageUrl: r.emoji.id ? `${this.cdn}/emojis/${r.emoji.id}.png` : undefined,
        count: r.count,
        me: r.me,
      })),
      attachments: message.attachments.map((a) => ({ name: a.filename, kind: mediaKind(a.contentType), url: a.url, width: a.width, height: a.height, size: a.size, mime: a.contentType })),
    };
    const embeds = this.linkPreviews(message.links);
    if (embeds.length > 0) view.embeds = embeds;
    const avatar = this.avatarUrl(message.author);
    if (avatar) view.avatarUrl = avatar;
    if (editable) view.source = message.content;
    if (!mine && this.state.mentionsMe(message)) view.mentionsMe = true;
    if (message.pinned) view.pinned = true;
    if (reply !== undefined)
      view.reply = reply && { id: reply.id, author: this.nameOf(reply.author), content: this.renderContent(reply.content), ...(reply.timestamp ? { timestamp: reply.timestamp } : {}) };
    return view;
  }

  /**
   * Link previews the instance made. A picture shows only from the
   * instance's own hosts (its CDN, or an image proxy it serves there), so
   * looking at a message never reaches the linked site; a card left with
   * nothing to show is dropped.
   */
  private linkPreviews(links: SpacebarLinkEmbed[]): NativeEmbed[] {
    const hosts = instanceHosts(this.instance!);
    return links.flatMap(({ image, ...card }) => {
      const embed: NativeEmbed = card;
      if (image && hosts.includes(new URL(image.url).hostname)) embed.image = image;
      return embed.title || embed.description || embed.image ? [embed] : [];
    });
  }

  /** The open guild's custom emoji, for messages and reactions there; none in DMs, where using a guild's emoji is not offered. */
  private customEmoji(guildId: string | undefined): NativeCustomEmoji[] {
    const guild = guildId ? this.state.guilds.get(guildId) : undefined;
    return guild ? (this.state.emojis.get(guild.id) ?? []).map((e) => ({ id: e.id, name: e.name, animated: e.animated, source: guild.name })) : [];
  }

  private sidebar(): NativeSidebarItem[] {
    const item = (channel: SpacebarChannel, kind: NativeSidebarItem["kind"]): NativeSidebarItem => ({
      id: channel.id,
      name: this.channelTitle(channel),
      kind,
      iconUrl: kind === "dm" ? this.dmAvatar(channel) : undefined,
      unread: kind !== "category" && this.state.isUnread(channel),
      mentions: kind === "category" ? 0 : this.state.mentions(channel.id),
      active: channel.id === this.selectedChannelId,
    });
    if (this.selection.kind === "home") return this.state.privateChannels().map((c) => item(c, "dm"));
    return this.state
      .guildChannels(this.selection.guildId)
      .filter((c) => c.type === ChannelType.GuildCategory || c.type === ChannelType.GuildVoice || TEXT_CHANNEL_TYPES.has(c.type))
      .map((c) => item(c, c.type === ChannelType.GuildCategory ? "category" : c.type === ChannelType.GuildVoice ? "voice" : "text"));
  }

  viewState(): NativeViewState {
    const platform = this.deps.def.name;
    switch (this.screen) {
      case "login":
        return { screen: "login", platform, identity: "email", busy: this.busy, error: this.error };
      case "mfa":
        return { screen: "mfa", platform, codes: "totp", busy: this.busy, error: this.error };
      case "token":
        return {
          screen: "prompt",
          platform,
          prompt: {
            id: TOKEN_PROMPT,
            title: "Sign in with a token",
            description: `${platform} asks for a captcha, which Multicord cannot show. Sign in on the instance's own web app, copy your token from there, and paste it here.`,
            fields: [{ name: "token", label: "Token", type: "password", autocomplete: "off" }],
            submit: "Sign in",
            cancel: "Back",
          },
          busy: this.busy,
          error: this.error,
        };
      case "connecting":
        return { screen: "connecting", platform, status: this.connection === "reconnecting" ? "Reconnecting…" : "Connecting…" };
      case "chat": {
        const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
        const guild = this.selection.kind === "guild" ? this.state.guilds.get(this.selection.guildId) : undefined;
        const members = channel ? this.memberView(channel) : undefined;
        return {
          screen: "chat",
          platform,
          title: guild?.name ?? "Direct Messages",
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
                ...(this.unreadAt?.channelId === channel.id ? { unread: this.unreadView(channel.id, this.unreadAt.after) } : {}),
                ...(members ? { members } : {}),
                ...(this.pins?.channelId === channel.id ? { pins: this.pins.list } : {}),
                can: { reply: true, react: true, attach: this.deps.files !== undefined, typing: this.typingIndicators, members: true, pins: true },
              }
            : null,
          voice: null,
          emojiBase: `${this.cdn}/emojis`,
          customEmoji: this.customEmoji(channel?.guildId),
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
