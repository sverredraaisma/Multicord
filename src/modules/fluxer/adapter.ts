import type { DirectConversation, HealthCheck, HomeBadge, PlatformAdapter, RailServer } from "../../shared/adapter";
import {
  MAX_ATTACHMENTS,
  MAX_CALL_PARTICIPANTS,
  MAX_CALL_SIGNALS,
  MAX_LISTED_MESSAGES,
  iceServers,
  meshSignal,
  type MeshSignal,
  type NativeAction,
  type NativeCallPeer,
  type NativeCallSignal,
  type NativeIceServer,
  type VoiceSignal,
  type NativeAttachment,
  type NativeCustomEmoji,
  type NativeGifResults,
  type NativeListedMessage,
  type NativeMember,
  type NativeMemberList,
  type NativeMemberSection,
  type NativeProfile,
  type NativeMessage,
  type NativeMessageList,
  type NativeSearchResults,
  type NativeStickerPack,
  type NativeUnread,
  type NativeSidebarItem,
  type NativeViewState,
  type NativeVoiceSession,
  type VoiceNoticeFlag,
} from "../../shared/native";
import type { PickedFile } from "../../shared/engine";
import { TYPING_SETTING, type AccountStatus, type ServiceSettingValues } from "../../shared/settings";
import type { AsyncSecretStore, EngineFiles, FileSource } from "../../engine/runtime";
import { solveAltcha } from "./captcha";
import { discoverInstance, globalExpressions, type FluxerInstance } from "./discovery";
import { FluxerGateway, type GatewayStatus, type SocketFactory } from "./gateway";
import { FluxerApiError, FluxerRest, type LoginResult, type RestOptions } from "./rest";
import { FluxerState, MEMBER_LIST_POSITIONS, TYPING_MS } from "./state";
import {
  ChannelType,
  compareIds,
  DM_SETTINGS,
  NotifyLevel,
  FORUM_TYPES,
  MessageType,
  THREAD_TYPES,
  TEXT_CHANNEL_TYPES,
  displayName,
  emojiKey,
  roleColor,
  isId,
  type FluxerMember,
  type FluxerProfile,
  type FluxerUser,
  type FluxerChannel,
  type FluxerEmoji,
  type FluxerMessage,
} from "./types";
import { BaseAdapter } from "../../shared/baseAdapter";

export const FOLDER_PREFIX = "folder:";
const PAGE_SIZE = 50;
const PUBLISH_DELAY_MS = 100;
const ACK_DELAY_MS = 750;
const FLUXER_EPOCH = 1420070400000n;
const LAZY_REQUEST = 14;
const TYPING_REPEAT_MS = 8_000;
const VOICE_STATE_UPDATE = 4;
const VOICE_JOIN_TIMEOUT_MS = 15_000;
/** GIF searches wait for a pause in typing; only the latest one is shown. */
const GIF_DEBOUNCE_MS = 300;
/** Member list positions op 14 asks for at once (Fluxer's largest range). */
const MEMBER_WINDOW = 100;
/** How long to wait for a member list before saying it did not come (Fluxer sends none where the user may not see the channel's members). */
const MEMBER_LIST_TIMEOUT_MS = 15_000;
/** Pages of 50 pins fetched at most, as the pins panel lists MAX_LISTED_MESSAGES. */
const PIN_PAGES = 2;

/** The service setting that keeps Multicord out of peer-to-peer calls, where peers learn the user's address (on unless turned off). */
export const RELAY_SETTING = "relayOnly";
/** Why a peer-to-peer call is not joined while that setting is on: Fluxer has no relay for them. */
export const P2P_NO_RELAY =
  "This call connects people directly (peer-to-peer), which shows them your IP address, and Fluxer has no relay for it. Multicord joins such calls only with \"Calls through a relay only\" turned off for this service (Settings > Services).";
/** Fluxer refused a peer-to-peer join (VOICE_P2P_UNAVAILABLE). */
const P2P_UNAVAILABLE = "Fluxer would not connect you to this call directly (peer-to-peer) right now.";
/** Op 13: a signal for another connection of a peer-to-peer call. */
const VOICE_SIGNAL = 13;
/** The largest op 13 frame Fluxer's own client sends (VOICE_SIGNAL_MAX_JSON_BYTES in its GatewaySocket.ts). */
export const MAX_SIGNAL_BYTES = 16_000;
/** Signals held per connection not yet known as in the call, as Fluxer's client holds them (INBOX_LIMIT). */
const HELD_SIGNALS = 64;

/** How often the instance's health endpoints are asked whether its services run. */
export const HEALTH_INTERVAL_MS = 5 * 60_000;

/** LiveKit wants a ws(s) URL; Fluxer's endpoint may be a bare host. */
export function liveKitUrl(endpoint: string): string {
  return /^(wss?|https?):\/\//.test(endpoint) ? endpoint : `wss://${endpoint}`;
}

interface VoiceConnection {
  /** None for a DM or group call. */
  guildId?: string;
  channelId: string;
  connectionId?: string;
  url?: string;
  token?: string;
  mute: boolean;
  deaf: boolean;
  video: boolean;
  stream: boolean;
  /** The join was sent again with p2p, as the call is peer-to-peer. */
  askedP2p?: boolean;
  /** The server published this connection's voice state. */
  stateSeen?: boolean;
  /** A peer-to-peer grant: the view connects to the others itself. */
  p2p?: {
    /** New with each grant, so the view starts its connections afresh. */
    callId: string;
    iceServers: NativeIceServer[];
    /** Signals from peers not yet rendered. */
    signals: NativeCallSignal[];
    seq: number;
    /** Signals from connections not (yet) known as in the call, by connection, with who sent them. */
    held: Map<string, { userId: string; signal: MeshSignal }[]>;
  };
}

/** Which instance this is: the engine's own info. */
export interface FluxerInstanceDef {
  id: string;
  name: string;
  /** The instance origin, e.g. https://fluxer.app. */
  url: string;
}

export interface FluxerAdapterDeps {
  def: FluxerInstanceDef;
  fetch: typeof fetch;
  createSocket: SocketFactory;
  /** This instance's own secrets. */
  secrets: AsyncSecretStore;
  /** Sends display state to the native view. */
  render(state: NativeViewState): void;
  rest?: Partial<RestOptions>;
  platform?: string;
  /** Lets the user pick files; the engine reads only what was picked. */
  files?: EngineFiles;
  /** This instance's settings values (TYPING_SETTING); changes come through applySettings(). */
  settings?: ServiceSettingValues;
}

type Selection = { kind: "home" } | { kind: "guild"; guildId: string };

/** DMs and groups have calls of their own, joined without a guild. */
const isPrivateCall = (channel: FluxerChannel): boolean => channel.type === ChannelType.Dm || channel.type === ChannelType.GroupDm;
const timestampOf = (id: string | undefined): number => (id ? Number((BigInt(id) >> 22n) + FLUXER_EPOCH) : 0);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const newNonce = (): string => String(Date.now()) + String(Math.floor(Math.random() * 1e6));

/**
 * Native Fluxer adapter: talks to the Fluxer API from its sandboxed engine
 * and renders in Multicord's own chat view. Login (with Fluxer's proof-of-work
 * captcha and TOTP), the gateway session and the token all stay here.
 */
/** What a file is by its MIME type. */
export function mediaKind(contentType: string | undefined): NativeAttachment["kind"] {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  return "file";
}

/** What the module offers the shell; its manifest must declare the same (tested). */
export const CAPABILITIES: PlatformAdapter["capabilities"] = { directMessages: true, messagePreviews: true, voice: true, screenShare: true };

export class FluxerAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = CAPABILITIES;

  readonly state = new FluxerState();
  private instance: FluxerInstance | undefined;
  private rest: FluxerRest | undefined;
  private gateway: FluxerGateway | undefined;
  private screen: "login" | "mfa" | "connecting" | "chat" = "login";
  private connection: GatewayStatus = "closed";
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
  private readonly loading = new Set<string>();
  private readonly expanded = new Set<string>();
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly typingSent = new Map<string, number>();
  /** Settings' "Send typing indicators" for this service. */
  private typingIndicators: boolean;
  private readonly pending = new Map<string, FileSource[]>();
  /** Whether a session token is stored, so the account shows as signed in before it connects. */
  private hasToken = false;
  private readonly uploading = new Set<string>();
  private voice: VoiceConnection | undefined;
  private voiceTimer: ReturnType<typeof setTimeout> | undefined;
  private visible = false;
  private gifResults: NativeGifResults | undefined;
  private gifTimer: ReturnType<typeof setTimeout> | undefined;
  private gifSearch = 0;
  /** The open channel's pinned messages, while its pins panel is open. */
  private pins: { channelId: string; list: NativeMessageList } | undefined;
  /** The open channel's search results, until the search ends; and a count that drops answers to earlier searches. */
  private search: { channelId: string; results: NativeSearchResults } | undefined;
  private searchCount = 0;
  /** The view's member panel is open: the open channel's members are asked for and shown. */
  private membersOpen = false;
  /** Windows of the open guild channel's member list asked for (loadMembers adds one). */
  private memberWindows = 1;
  private memberTimer: ReturnType<typeof setTimeout> | undefined;
  /** The guild channel whose member list is subscribed to. */
  private watched: { channelId: string; guildId: string } | undefined;
  private memberError: string | undefined;
  /** The profile card the view asked for last. */
  private profile: NativeProfile | undefined;
  /** DM and group calls the user declined while they rang, and those already announced to the shell. */
  private readonly declined = new Set<string>();
  private readonly announced = new Set<string>();
  /** Settings' "Calls through a relay only" for this service: Fluxer has no relay, so on, peer-to-peer calls are not joined. */
  private relayOnly: boolean;
  /** Counts peer-to-peer grants, for their call ids. */
  private p2pGrants = 0;
  /** Whether the instance's services answered their health checks last time. */
  private checks: HealthCheck[] = [];
  private healthTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: FluxerAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
    this.typingIndicators = deps.settings?.[TYPING_SETTING] !== false;
    this.relayOnly = deps.settings?.[RELAY_SETTING] !== false;
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

  /** Settings changed: whether to send typing indicators (Fluxer has no way to end one early; it runs out by itself), and whether to join peer-to-peer calls (from the next join). */
  applySettings(values: ServiceSettingValues): void {
    this.typingIndicators = values[TYPING_SETTING] !== false;
    this.relayOnly = values[RELAY_SETTING] !== false;
  }

  /** The secret store is this instance's own, so two accounts on one Fluxer instance stay apart. */
  private get secretKey(): string {
    return `${this.account.instance}:token`;
  }

  /** Discovers the instance and resumes a saved session, else shows the login screen. */
  async start(): Promise<void> {
    this.healthTimer ??= setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    const found = await this.ensureInstance();
    void this.checkHealth();
    if (!found) return this.render();
    const token = await this.deps.secrets.load(this.secretKey);
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
      case "sendFile":
        return this.sendShared(action.file, action.replyTo);
      case "sendSticker":
        return this.sendSticker(action.stickerId, action.replyTo);
      case "searchGifs":
        return this.searchGifs(action.query);
      case "createPost":
        return this.createPost(action.name, action.content);
      case "joinVoice":
        return this.joinVoice(action.channelId);
      case "leaveVoice":
        return this.leaveVoice(undefined);
      case "voiceState":
        return this.setVoiceFlags(action);
      case "voiceError":
        return this.leaveVoice(`Voice failed: ${action.message}`);
      case "voiceNotice":
        return this.voiceNotice(action.message, action.off);
      case "voiceSignal":
        return this.sendSignal(action.to, action.signal);
      case "declineCall":
        return this.declineCall(action.channelId);
      case "mute":
        return this.mute(action.channelId, action.mute);
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
      case "loadMembers":
        return this.loadMembers(action.offset);
      case "profile":
        return this.showProfile(action.id);
      case "logout":
        return this.logout();
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
    if (!this.state.guilds.has(key)) throw new Error(`Unknown Fluxer guild: ${key}`);
    this.selection = { kind: "guild", guildId: key };
    this.subscribe(key);
    const first = this.state.guildChannels(key).find((c) => TEXT_CHANNEL_TYPES.has(c.type));
    const channelId = this.lastChannel.get(key) ?? first?.id;
    if (channelId) await this.selectChannel(channelId);
    else {
      this.selectedChannelId = undefined;
      this.render();
    }
  }

  /** Opens any text channel: a DM at home, or a guild channel inside its guild. */
  async openConversation(key: string): Promise<void> {
    const guildId = this.state.channels.get(key)?.guildId;
    this.selection = guildId ? { kind: "guild", guildId } : { kind: "home" };
    if (guildId) this.subscribe(guildId);
    await this.selectChannel(key);
  }

  async toggleGroup(key: string): Promise<void> {
    const id = key.startsWith(FOLDER_PREFIX) ? key.slice(FOLDER_PREFIX.length) : "";
    if (!this.state.folders?.some((f) => f.id === id)) throw new Error(`Unknown Fluxer folder: ${key}`);
    if (!this.expanded.delete(id)) this.expanded.add(id);
    this.setServers(this.railServers());
  }

  // --- Session ---------------------------------------------------------------

  /** For Settings > Diagnostics: whether the instance's API, gateway and media servers answer. */
  health(): HealthCheck[] {
    return this.checks;
  }

  /**
   * Asks the instance's documented health endpoints (/_health on its API,
   * gateway and media proxy) whether they run. Nothing is sent with them.
   */
  private async checkHealth(): Promise<void> {
    const instance = await this.ensureInstance();
    const status = instance?.statusPage ? ` Its status page: ${instance.statusPage}` : "";
    if (!instance) {
      this.checks = [{ name: "Instance found", ok: false, detail: `${this.error ?? "It did not answer."} Nothing works until it does.` }];
      return this.render();
    }
    const probes = [
      { name: "API answers", url: `${instance.api.replace(/\/v1$/, "")}/_health`, breaks: "Signing in, history and sending fail." },
      { name: "Gateway answers", url: `${instance.gateway.replace(/^wss:/, "https:")}/_health`, breaks: "New messages, typing and calls do not arrive." },
      { name: "Media answers", url: `${instance.media}/_health`, breaks: "Pictures, avatars and files do not load." },
    ];
    this.checks = await Promise.all(
      probes.map(async ({ name, url, breaks }): Promise<HealthCheck> => {
        try {
          const response = await this.deps.fetch(url);
          return response.ok ? { name, ok: true } : { name, ok: false, detail: `It answered HTTP ${response.status}. ${breaks}${status}` };
        } catch (error) {
          return { name, ok: false, detail: `It could not be reached (${messageOf(error)}). ${breaks}${status}` };
        }
      }),
    );
    this.render();
  }

  private async ensureInstance(): Promise<FluxerInstance | undefined> {
    if (this.instance) return this.instance;
    try {
      this.instance = await discoverInstance(this.deps.def.url, this.deps.fetch);
      this.rest = new FluxerRest(this.instance.api, {
        fetch: this.deps.fetch,
        ...this.deps.rest,
        solveCaptcha: async (challenge) => {
          this.status = "Checking you are human…";
          this.render();
          return (this.deps.rest?.solveCaptcha ?? solveAltcha)(challenge);
        },
      });
      this.error = undefined;
      return this.instance;
    } catch (error) {
      this.error = `Could not reach ${this.deps.def.name}: ${messageOf(error)}`;
      return undefined;
    }
  }

  private async login(identity: string, password: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = "Signing in…";
    this.error = undefined;
    this.render();
    const instance = await this.ensureInstance();
    if (!instance) return this.finishAttempt();
    try {
      this.onLoginResult(await this.rest!.login(instance.identity, identity, password));
    } catch (error) {
      this.error = messageOf(error);
    }
    this.finishAttempt();
  }

  private async submitMfa(code: string): Promise<void> {
    if (this.busy || !this.mfaTicket) return;
    this.busy = true;
    this.error = undefined;
    this.render();
    try {
      this.onLoginResult(await this.rest!.loginTotp(code, this.mfaTicket));
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
      this.openSession(result.token);
      return;
    }
    // Security keys are bound to Fluxer's own web origin, so they cannot work here; backup codes go through the code endpoint.
    if (!result.totp && !result.backupCodes) {
      throw new Error("This account only accepts a security key, which only works in Fluxer's own apps.");
    }
    this.mfaTicket = result.ticket;
    this.mfaCodes = result.totp ? "totp" : "backup";
    this.screen = "mfa";
  }

  private openSession(token: string): void {
    this.rest!.token = token;
    this.screen = "connecting";
    this.gateway = new FluxerGateway(
      this.instance!.gateway,
      token,
      this.deps.createSocket,
      {
        dispatch: (event, data) => {
          this.state.apply(event, data);
          if (event === "VOICE_SERVER_UPDATE") this.onVoiceServer(data);
          if (event === "VOICE_SIGNAL") this.receiveSignal(data);
          if (event === "VOICE_STATE_UPDATE" || event.startsWith("CALL_")) this.onCallChange();
          if (event === "READY" || event.startsWith("CALL_")) this.announceRinging();
          // Someone pinned or unpinned in the channel whose pins are listed.
          if (event === "CHANNEL_PINS_UPDATE" && this.pins && typeof data === "object" && data !== null && (data as { channel_id?: unknown }).channel_id === this.pins.channelId) void this.loadPins(this.pins.channelId);
          if (event === "READY") {
            // A fresh session has no voice connection of ours.
            if (this.voice) this.dropVoice("Voice disconnected when the connection was reset.");
            this.screen = "chat";
            this.render();
          }
          if ((event === "READY" || event === "RESUMED") && this.selection.kind === "guild") this.subscribe(this.selection.guildId);
          // A new session has no member list subscription of ours.
          if ((event === "READY" || event === "RESUMED") && this.membersOpen) this.requestMembers();
        },
        status: (status) => {
          this.connection = status;
          this.render();
        },
        authFailed: () => this.endSession("Your session has ended. Please sign in again."),
        voiceRefused: (code) => this.voiceRefused(code),
      },
      this.deps.platform,
    );
    this.gateway.connect();
    this.render();
  }

  /**
   * In guilds over 250 members a session is passive and only gets its own
   * messages and mentions; op 14 makes the open guild active, with typing.
   */
  private subscribe(guildId: string): void {
    this.gateway?.command(LAZY_REQUEST, { subscriptions: { [guildId]: { active: true, typing: true } } });
  }

  private async logout(): Promise<void> {
    await this.rest?.logout().catch(() => undefined);
    this.endSession(undefined);
  }

  private endSession(error: string | undefined): void {
    this.dropVoice(undefined);
    this.gateway?.disconnect();
    this.gateway = undefined;
    if (this.rest) this.rest.token = undefined;
    this.hasToken = false;
    void this.deps.secrets.delete(this.secretKey);
    this.state.reset();
    clearTimeout(this.gifTimer);
    this.gifResults = undefined;
    this.membersOpen = false;
    clearTimeout(this.memberTimer);
    this.profile = undefined;
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
    const forum = channel !== undefined && FORUM_TYPES.has(channel.type);
    if (!channel || (!forum && !TEXT_CHANNEL_TYPES.has(channel.type))) return;
    // Noted before it is read: where its news began.
    if (channelId !== this.selectedChannelId) this.unreadAt = !forum && this.state.isUnread(channel) ? { channelId, after: this.state.readStates.get(channelId)?.lastMessageId } : undefined;
    if (this.pins?.channelId !== channelId) this.pins = undefined;
    if (this.search?.channelId !== channelId) this.search = undefined;
    const changed = channelId !== this.selectedChannelId;
    this.selectedChannelId = channelId;
    if (changed && this.membersOpen) this.requestMembers();
    this.lastChannel.set(channel.guildId ?? "home", channelId);
    this.error = undefined;
    this.render();
    if (forum) return; // A forum lists its posts; it has no messages of its own.
    if (!this.state.messages.has(channelId)) await this.fetchHistory(channelId, undefined);
    this.ackSoon(channelId);
  }

  /**
   * The open channel's unread marker: the first message from someone else
   * after the last one read when it was opened, once the loaded messages
   * reach back that far (or there are no older ones); none when they do and
   * hold nothing new from others after all. Fluxer gives no count.
   */
  private unreadView(channelId: string, at: NonNullable<FluxerAdapter["unreadAt"]>): NativeUnread | undefined {
    const messages = this.state.messages.get(channelId) ?? [];
    const after = at.after ?? "0";
    const reach = !(this.hasOlder.get(channelId) ?? false) || messages.some((m) => compareIds(m.id, after) <= 0);
    if (!reach) return {};
    const first = messages.find((m) => compareIds(m.id, after) > 0 && m.author.id !== this.state.me?.id);
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
    if (files.length > 0 && !this.instance!.presignedUploads) {
      this.error = "This instance only accepts inline uploads, which Multicord does not support yet.";
      return this.render();
    }
    const nonce = newNonce();
    this.uploading.add(channelId);
    this.render();
    await this.attempt("Message not sent", async () => {
      const attachments = files.length > 0 ? await this.rest!.upload(channelId, files) : [];
      const sent = await this.rest!.sendMessage(channelId, content, nonce, replyTo, attachments);
      this.pending.delete(channelId);
      if (sent) this.state.addHistory(channelId, [sent], false);
    });
    this.uploading.delete(channelId);
    this.render();
  }

  // --- Emoji, stickers and GIFs ---------------------------------------------

  /** The guild of the open conversation, whose emoji and stickers are always usable there; undefined in DMs. */
  private expressionGuild(): string | undefined {
    const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
    return channel ? channel.guildId : this.selection.kind === "guild" ? this.selection.guildId : undefined;
  }

  /** Whether this account may use emoji and stickers outside their own guild (Fluxer: premium, per the instance's limits). */
  private globalExpressions(): boolean {
    return this.instance !== undefined && globalExpressions(this.instance, this.state.traits);
  }

  /**
   * Guilds whose emoji and stickers work in the open conversation, as
   * Fluxer's server checks them: the open guild's own, and every other
   * guild's only with global expressions (in DMs too). The guild's
   * "use external emoji/stickers" permission is not tracked here.
   */
  private expressionGuilds(): string[] {
    const own = this.expressionGuild();
    const others = this.globalExpressions() ? this.state.guildLayout().flatMap((slot) => slot.guildIds).filter((id) => id !== own) : [];
    return (own ? [own, ...others] : others).filter((id) => this.state.guilds.has(id));
  }

  private customEmoji(guilds: string[]): NativeCustomEmoji[] {
    return guilds.flatMap((guildId) =>
      (this.state.emojis.get(guildId) ?? []).map((emoji) => ({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated,
        // Fluxer serves emoji as WebP and animates them on request.
        url: `${this.instance!.media}/emojis/${emoji.id}.webp?size=48${emoji.animated ? "&animated=true" : ""}`,
        source: this.state.guilds.get(guildId)!.name,
      })),
    );
  }

  private stickerPacks(guilds: string[]): NativeStickerPack[] {
    return guilds
      .map((guildId) => ({
        id: guildId,
        name: this.state.guilds.get(guildId)!.name,
        stickers: (this.state.stickers.get(guildId) ?? []).map((sticker) => ({
          id: sticker.id,
          name: sticker.name,
          format: "webp" as const,
          url: this.stickerUrl(sticker.id, sticker.animated),
        })),
      }))
      .filter((pack) => pack.stickers.length > 0);
  }

  /** Fluxer stores stickers as WebP, still or animated. */
  private stickerUrl(id: string, animated: boolean): string {
    return `${this.instance!.media}/stickers/${id}.webp?size=160${animated ? "&animated=true" : ""}`;
  }

  /** Sends one of the stickers offered here as a sticker; any other id is ignored. */
  private async sendSticker(stickerId: string, replyTo?: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.stickerPacks(this.expressionGuilds()).some((p) => p.stickers.some((s) => s.id === stickerId))) return;
    await this.attempt("Sticker not sent", async () => {
      const sent = await this.rest!.sendMessage(channelId, "", newNonce(), replyTo, [], [stickerId]);
      if (sent) this.state.addHistory(channelId, [sent], false);
    });
  }

  /** Searches the instance's GIFs once typing pauses; an empty query shows the trending ones. */
  private searchGifs(query: string): void {
    if (!this.instance?.gifs || !this.rest) return;
    const search = ++this.gifSearch;
    const trimmed = query.trim().slice(0, 100);
    this.gifResults = { query: trimmed, results: this.gifResults?.results ?? [], loading: true };
    clearTimeout(this.gifTimer);
    this.gifTimer = setTimeout(() => void this.loadGifs(trimmed, search), GIF_DEBOUNCE_MS);
    this.render();
  }

  private async loadGifs(query: string, search: number): Promise<void> {
    let results: NativeGifResults["results"] = [];
    let error: string | undefined;
    try {
      results = (await this.rest!.gifs(query)).map((g) => ({ id: g.id, url: g.url, preview: g.preview, video: g.video, width: g.width, height: g.height, name: g.title }));
    } catch (failure) {
      error = `GIF search failed: ${messageOf(failure)}`;
    }
    if (search !== this.gifSearch) return; // a newer search has started
    this.gifResults = error ? { query, results, loading: false, error } : { query, results, loading: false };
    this.render();
  }

  // --- Voice -----------------------------------------------------------------

  /**
   * Joins a guild voice channel: op 4 asks the server for a connection, and
   * VOICE_SERVER_UPDATE answers with a LiveKit endpoint and token, which the
   * view uses to carry the audio and video.
   */
  private async joinVoice(channelId: string): Promise<void> {
    const channel = this.state.channels.get(channelId);
    const call = channel !== undefined && isPrivateCall(channel);
    if (!channel || !this.gateway || !(call || (channel.guildId && channel.type === ChannelType.GuildVoice))) return;
    if (!this.instance!.voiceEnabled) {
      this.error = `Voice is turned off on this ${this.deps.def.name} instance.`;
      return this.render();
    }
    if (this.voice?.channelId === channelId) return;
    this.declined.delete(channelId);
    // A DM or group with no call yet: ringing the others starts one, which is then joined like any other.
    if (call && !this.state.calls.has(channelId)) {
      try {
        await this.rest!.ringCall(channelId);
      } catch (error) {
        if (!(error instanceof FluxerApiError && error.code === "CALL_ALREADY_EXISTS")) {
          this.error = `Could not start the call: ${messageOf(error)}`;
          return this.render();
        }
      }
      if (this.voice?.channelId === channelId) return;
    }
    if (this.voice) this.leaveVoice(undefined);
    const mute = false;
    const deaf = false;
    this.voice = { ...(call ? {} : { guildId: channel.guildId }), channelId, mute, deaf, video: false, stream: false };
    this.error = undefined;
    this.gateway.command(VOICE_STATE_UPDATE, {
      // A call's placement has no guild.
      guild_id: call ? null : channel.guildId,
      channel_id: channelId,
      self_mute: mute,
      self_deaf: deaf,
      self_video: false,
      self_stream: false,
    });
    this.voiceTimer = setTimeout(() => {
      if (this.voice && !this.voice.token && !this.voice.p2p) this.leaveVoice("Could not join voice: the server did not answer.");
    }, VOICE_JOIN_TIMEOUT_MS);
    this.render();
  }

  private onVoiceServer(data: unknown): void {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const voice = this.voice;
    if (!voice || d.channel_id !== voice.channelId) {
      // Only the requesting session gets this event, so it answers a join we have since abandoned: leave it (a call has no guild).
      if (typeof d.connection_id === "string") {
        this.gateway?.command(VOICE_STATE_UPDATE, { guild_id: typeof d.guild_id === "string" ? d.guild_id : null, channel_id: null, connection_id: d.connection_id });
      }
      return;
    }
    if (typeof d.connection_id === "string") voice.connectionId = d.connection_id;
    if (d.p2p === true) return this.onPeerGrant(voice, d.ice_servers);
    if (typeof d.token !== "string" || typeof d.endpoint !== "string") return;
    // A voice server's grant for a peer-to-peer call: someone converted it (Fluxer's Voice Server Update); the view moves to the server.
    voice.p2p = undefined;
    // Fluxer's end-to-end encrypted voice scheme is not documented; never connect unencrypted to a channel that asks for it.
    if (d.e2ee_key !== undefined && d.e2ee_key !== null) {
      return this.leaveVoice("This channel uses end-to-end encrypted voice, which Multicord does not support yet.");
    }
    clearTimeout(this.voiceTimer);
    voice.url = liveKitUrl(d.endpoint);
    voice.token = d.token;
    this.render();
  }

  private setVoiceFlags(flags: { mute: boolean; deaf: boolean; video: boolean; stream: boolean }): void {
    const voice = this.voice;
    if (!voice) return;
    Object.assign(voice, flags);
    this.gateway?.command(VOICE_STATE_UPDATE, {
      guild_id: voice.guildId ?? null,
      channel_id: voice.channelId,
      connection_id: voice.connectionId,
      self_mute: voice.mute,
      self_deaf: voice.deaf,
      self_video: voice.video,
      self_stream: voice.stream,
    });
    this.render();
  }

  /**
   * A join Fluxer refused and said why (Gateway Error): one still waiting
   * for its grant is given up. A call that is peer-to-peer refuses a join
   * that did not agree to that (VOICE_P2P_CONSENT_REQUIRED); with "Calls
   * through a relay only" off, the join is sent again agreeing, as Fluxer's
   * own client does once its user agrees.
   */
  private voiceRefused(code: string): void {
    const voice = this.voice;
    if (!voice || voice.token || voice.p2p) return;
    if (code === "VOICE_P2P_CONSENT_REQUIRED" && !voice.askedP2p && !this.relayOnly) {
      voice.askedP2p = true;
      this.gateway?.command(VOICE_STATE_UPDATE, {
        guild_id: voice.guildId ?? null,
        channel_id: voice.channelId,
        self_mute: voice.mute,
        self_deaf: voice.deaf,
        self_video: false,
        self_stream: false,
        p2p: true,
      });
      return;
    }
    const reasons: Record<string, string> = {
      VOICE_P2P_CONSENT_REQUIRED: P2P_NO_RELAY,
      VOICE_P2P_UNAVAILABLE: P2P_UNAVAILABLE,
      VOICE_CHANNEL_FULL: "Could not join: the call is full.",
    };
    this.leaveVoice(reasons[code] ?? `Could not join voice (${code}).`);
  }

  /**
   * A peer-to-peer grant, for a join that agreed to one: the view connects
   * to each other connection in the call itself (NativePeerCall, as
   * Fluxer's own client does), with only the STUN servers Fluxer named, as
   * Fluxer hands out no relay. Not taken where the setting went back on.
   */
  private onPeerGrant(voice: VoiceConnection, servers: unknown): void {
    if (!voice.askedP2p || this.relayOnly) return this.leaveVoice(P2P_NO_RELAY);
    clearTimeout(this.voiceTimer);
    // Fluxer names STUN servers only (its ICE server object); nothing else is used.
    const stun = iceServers(servers).flatMap((server) => {
      const urls = server.urls.filter((url) => url.startsWith("stun:"));
      return urls.length > 0 ? [{ urls }] : [];
    });
    voice.url = undefined;
    voice.token = undefined;
    voice.p2p = { callId: String(++this.p2pGrants), iceServers: stun, signals: [], seq: 0, held: new Map() };
    this.render();
  }

  /** The others in the user's peer-to-peer call: its other connections that are peer-to-peer, the first up to the cap, and how many more. */
  private callPeers(voice: VoiceConnection): { peers: (NativeCallPeer & { userId: string })[]; over: number } {
    const others = this.state.voiceMembers(voice.channelId).filter(({ state }) => state.guildId === voice.guildId && state.p2p && state.connectionId !== voice.connectionId);
    const peers = others.slice(0, MAX_CALL_PARTICIPANTS - 1).map(({ user, state }) => {
      const avatarUrl = this.iconUrl("avatars", user.id, user.avatar, 64);
      // The connection whose id sorts first offers, as in Fluxer's client.
      return { id: state.connectionId, userId: user.id, name: displayName(user), ...(avatarUrl ? { avatarUrl } : {}), offer: voice.connectionId! < state.connectionId, ...(state.serverMute ? { muted: true } : {}) };
    });
    return { peers, over: others.length - peers.length };
  }

  /** The view's signal for one connection in the call, passed on as op 13 (Fluxer relays it unread), within the frame size Fluxer's client keeps to. */
  private sendSignal(to: string, signal: VoiceSignal | MeshSignal): void {
    const voice = this.voice;
    const data = meshSignal(signal);
    if (!voice?.p2p || !data || !this.callPeers(voice).peers.some((p) => p.id === to)) return;
    const d = { guild_id: voice.guildId ?? null, channel_id: voice.channelId, to, data };
    if (new TextEncoder().encode(JSON.stringify({ op: VOICE_SIGNAL, d })).byteLength > MAX_SIGNAL_BYTES) {
      this.error = "A call signal was too large for Fluxer to pass on.";
      return this.render();
    }
    this.gateway?.command(VOICE_SIGNAL, d);
  }

  /**
   * A signal from another connection of the user's call (VOICE_SIGNAL),
   * checked and kept for the view, which gets each once. One from a
   * connection not yet known as in the call waits for it, as in Fluxer's
   * client; one whose sender is not that connection's user is dropped.
   */
  private receiveSignal(data: unknown): void {
    const voice = this.voice;
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const signal = meshSignal(d.data);
    const guildId = typeof d.guild_id === "string" ? d.guild_id : undefined;
    if (!voice?.p2p || !signal || d.channel_id !== voice.channelId || guildId !== voice.guildId || typeof d.from !== "string" || !isId(d.user_id) || d.from === voice.connectionId) return;
    const held = voice.p2p.held.get(d.from) ?? [];
    if (held.length === HELD_SIGNALS) return;
    held.push({ userId: d.user_id, signal });
    voice.p2p.held.set(d.from, held);
    this.releaseSignals(voice);
  }

  /** Hands the view the held signals of connections now in the call, from their own users. */
  private releaseSignals(voice: VoiceConnection): void {
    const call = voice.p2p!;
    let released = false;
    for (const peer of this.callPeers(voice).peers) {
      const held = call.held.get(peer.id);
      if (!held) continue;
      call.held.delete(peer.id);
      for (const { userId, signal } of held) if (userId === peer.userId) call.signals.push({ seq: ++call.seq, from: peer.id, signal });
      released = true;
    }
    // Should the view stop taking them, only the latest are kept.
    call.signals.splice(0, call.signals.length - MAX_CALL_SIGNALS);
    if (released) this.render();
  }

  /** Voice states or calls changed: held signals may now be the view's, and a peer-to-peer call the server ended is over here too. */
  private onCallChange(): void {
    const voice = this.voice;
    if (!voice?.p2p) return;
    // Its voice state may come after the grant; once there, its going means the call is over.
    if (this.state.voiceStates.has(voice.connectionId!)) voice.stateSeen = true;
    else if (voice.stateSeen) return this.dropVoice("The call ended.");
    this.releaseSignals(voice);
  }

  /** Declines a DM or group call ringing for the user: Fluxer stops ringing them, and the bar goes at once. */
  private async declineCall(channelId: string): Promise<void> {
    if (!this.state.calls.has(channelId) || !this.rest) return;
    this.declined.add(channelId);
    this.render();
    await this.rest.declineCall(channelId).catch((error: unknown) => {
      this.error = `Could not decline the call: ${messageOf(error)}`;
      this.render();
    });
  }

  /** A DM or group call ringing for the user, which they have neither joined nor declined. */
  private ringing(): { channelId: string; from: string } | undefined {
    const me = this.state.me?.id;
    if (!me) return undefined;
    for (const [channelId, call] of this.state.calls) {
      const channel = this.state.channels.get(channelId);
      if (!channel || !call.ringing.includes(me) || this.declined.has(channelId) || this.voice?.channelId === channelId) continue;
      // Whoever is in the call already is calling; else the DM's or group's name says who.
      const caller = this.state.voiceMembers(channelId).find(({ user }) => user.id !== me)?.user;
      return { channelId, from: caller ? displayName(caller) : this.channelTitle(channel) };
    }
    return undefined;
  }

  /** Tells the shell of a call that has started ringing for the user, once a call, so it rings while the view is not in front. */
  private announceRinging(): void {
    const me = this.state.me?.id;
    for (const id of [...this.announced]) if (!this.state.calls.get(id)?.ringing.includes(me ?? "")) this.announced.delete(id);
    for (const id of [...this.declined]) if (!this.state.calls.has(id)) this.declined.delete(id);
    const ringing = this.ringing();
    if (!ringing || this.announced.has(ringing.channelId)) return;
    this.announced.add(ringing.channelId);
    this.incomingCalls.emit({ conversationKey: ringing.channelId, from: ringing.from, video: false });
  }

  /** What the call panel calls a voice channel or a DM or group call. */
  private voiceChannelName(channelId: string): string {
    const channel = this.state.channels.get(channelId);
    if (!channel) return "Voice";
    return isPrivateCall(channel) ? this.channelTitle(channel) : (channel.name ?? "Voice");
  }

  /** A problem the call survives: shown, with the camera or screen share that failed turned off for everyone. */
  private voiceNotice(message: string, off: VoiceNoticeFlag | undefined): void {
    const voice = this.voice;
    if (!voice) return;
    this.error = message;
    if (off) this.setVoiceFlags({ mute: voice.mute, deaf: voice.deaf, video: voice.video, stream: voice.stream, [off]: false });
    else this.render();
  }

  private leaveVoice(error: string | undefined): void {
    const voice = this.voice;
    if (voice?.connectionId) {
      this.gateway?.command(VOICE_STATE_UPDATE, { guild_id: voice.guildId ?? null, channel_id: null, connection_id: voice.connectionId });
    }
    this.dropVoice(error);
  }

  /** Forgets our voice connection locally (the server already has, or will). */
  private dropVoice(error: string | undefined): void {
    clearTimeout(this.voiceTimer);
    this.voice = undefined;
    if (error) this.error = error;
    this.render();
  }

  private voiceSession(): NativeVoiceSession | null {
    const voice = this.voice;
    if (!voice) return null;
    return {
      channelId: voice.channelId,
      channelName: this.voiceChannelName(voice.channelId),
      guildName: voice.guildId ? (this.state.guilds.get(voice.guildId)?.name ?? "") : "Call",
      url: voice.url,
      token: voice.token,
      mute: voice.mute,
      deaf: voice.deaf,
      video: voice.video,
      stream: voice.stream,
      ...(voice.p2p ? { p2p: this.peerCall(voice) } : {}),
    };
  }

  /** The user's peer-to-peer call as the view gets it: Fluxer's mesh, with the user's own connection as `self`; Fluxer gives no relay. */
  private peerCall(voice: VoiceConnection): NativeVoiceSession["p2p"] {
    const call = voice.p2p!;
    const { peers, over } = this.callPeers(voice);
    return {
      callId: call.callId,
      self: voice.connectionId!,
      protocol: "fluxer-mesh",
      peers: peers.map(({ userId: _user, ...peer }) => peer),
      ...(over > 0 ? { over } : {}),
      iceServers: call.iceServers,
      relayOnly: false,
      signals: call.signals,
    };
  }

  /** Starts a post in the open forum and opens it. */
  private async createPost(name: string, content: string): Promise<void> {
    const forum = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
    if (!forum || !FORUM_TYPES.has(forum.type) || !this.rest) return;
    await this.attempt("Post not created", async () => {
      const post = await this.rest!.createPost(forum.id, name.trim(), content);
      if (!post) return;
      this.state.upsertChannel({ ...post, guildId: post.guildId ?? forum.guildId, parentId: post.parentId ?? forum.id });
      await this.selectChannel(post.id);
    });
  }

  /** Adds files from the OS picker to the open channel's next message. */
  private async attach(): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.deps.files) return;
    await this.attempt("Could not attach", async () => {
      const picked = await this.deps.files!.pick();
      const list = this.pending.get(channelId) ?? [];
      for (const file of picked) {
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

  /**
   * A file the shell hands over (a favourite, or a sticker sent as a
   * picture): it goes out at once, or waits with files already picked.
   */
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

  /** Our own reactions are applied once the server accepts them (it does not echo them in guilds). */
  private async react(messageId: string, key: string, add: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest) return;
    const custom = /^(.+):(\d{1,20})$/.exec(key);
    const emoji: FluxerEmoji = custom ? { name: custom[1]!, id: custom[2]! } : { name: key };
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
      // Fluxer pages pins by pin time, so a page can repeat one pinned at the same moment: each is listed once.
      const found = new Map<string, FluxerMessage>();
      let page = await this.rest!.pins(channelId);
      for (let pages = 1; ; pages++) {
        for (const m of page.messages) if (!found.has(m.id)) found.set(m.id, m);
        if (!page.next || pages >= PIN_PAGES) break;
        page = await this.rest!.pins(channelId, page.next);
      }
      list = { messages: [...found.values()].slice(0, MAX_LISTED_MESSAGES).map((m) => this.listedMessage(m)), loading: false };
      if (page.next) list.note = `Only the latest ${MAX_LISTED_MESSAGES} pins are listed.`;
    } catch (error) {
      list = { messages: [], loading: false, error: `Could not load pinned messages: ${messageOf(error)}` };
    }
    if (this.pins?.channelId !== channelId) return;
    this.pins = { channelId, list };
    this.render();
  }

  /** Forwards a message of the open channel into another text channel or DM, as Fluxer forwards (a FORWARD message reference). */
  private async forward(messageId: string, target: string): Promise<void> {
    const source = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
    const to = this.state.channels.get(target);
    if (!source || !to || !TEXT_CHANNEL_TYPES.has(to.type) || !this.rest) return;
    await this.attempt("Message not forwarded", async () => {
      const sent = await this.rest!.forward(to.id, { channelId: source.id, messageId, guildId: source.guildId }, newNonce());
      if (sent && this.state.messages.has(to.id)) this.state.addHistory(to.id, [sent], false);
    });
  }

  /** Searches the open channel on the instance (POST /search/messages), or ends the search with an empty query. */
  private async searchMessages(query: string): Promise<void> {
    const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
    const count = ++this.searchCount;
    const trimmed = query.trim();
    this.search = channel && trimmed !== "" ? { channelId: channel.id, results: { query: trimmed, messages: [], loading: true } } : undefined;
    this.render();
    if (!this.search || !channel) return;
    let results: NativeSearchResults;
    try {
      const found = await this.rest!.search(channel, trimmed);
      results = { query: trimmed, messages: found.messages.map((m) => this.listedMessage(m)), loading: false };
      if (found.indexing) results.note = "Fluxer is still indexing this conversation for search. Try again in a moment.";
    } catch (error) {
      results = { query: trimmed, messages: [], loading: false, error: `Search failed: ${messageOf(error)}` };
    }
    if (count !== this.searchCount || this.search?.channelId !== channel.id) return;
    this.search = { channelId: channel.id, results };
    this.render();
  }

  /** Pins or unpins a message; Fluxer decides whether the user may. */
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

  /** Tells others we are typing; Fluxer shows it for ~10 s, so once per 8 s is enough. */
  private async sendTyping(now: number = Date.now()): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest || !this.typingIndicators || now - (this.typingSent.get(channelId) ?? -Infinity) < TYPING_REPEAT_MS) return;
    this.typingSent.set(channelId, now);
    await this.rest.typing(channelId).catch(() => undefined);
  }

  /** Runs a user action, showing a failure in the view's banner. */
  /**
   * Whether a channel's own mute may be changed from here: not a thread
   * (Fluxer mutes those per thread member), and not in a server, or among
   * the DMs, that is muted as a whole, which its channel's mute cannot undo.
   */
  private canMute(channel: FluxerChannel, now: number = Date.now()): boolean {
    const whole = this.state.notifySettings.get(channel.guildId ?? DM_SETTINGS)?.mutedUntil ?? 0;
    return !THREAD_TYPES.has(channel.type) && whole <= now;
  }

  /**
   * Mutes or unmutes a channel, DM or group in the user's Fluxer
   * notification settings, for good. Fluxer takes the complete map of
   * channel overrides, so every other override goes back as it was.
   */
  private async mute(channelId: string, mute: boolean): Promise<void> {
    const channel = this.state.channels.get(channelId);
    if (!channel || !this.rest || !this.canMute(channel) || this.state.isMuted(channel) === mute) return;
    const key = channel.guildId ?? DM_SETTINGS;
    const overrides = { ...this.state.overrideInputs.get(key) };
    overrides[channelId] = { collapsed: false, message_notifications: NotifyLevel.Inherit, ...overrides[channelId], muted: mute, mute_config: null };
    await this.attempt(mute ? "Could not mute" : "Could not unmute", async () => {
      this.state.applyGuildSettings(await this.rest!.setGuildSettings(key, { channel_overrides: overrides }));
      this.state.changed.emit();
    });
  }

  private async attempt(failure: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.error = `${failure}: ${messageOf(error)}`;
      this.render();
    }
  }

  /** Marks the open channel read, debounced; the ack route allows 20 per 10 s. */
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

  /** Notifies as the user's Fluxer notification settings say (see FluxerState.shouldNotify). */
  private notify(message: FluxerMessage): void {
    const channel = this.state.channels.get(message.channelId);
    if (!channel || !this.state.shouldNotify(message)) return;
    const author = displayName(this.state.users.get(message.author.id) ?? message.author);
    const guild = channel.guildId ? this.state.guilds.get(channel.guildId) : undefined;
    const where =
      channel.type === ChannelType.Dm ? "" : guild ? ` in #${channel.name ?? channel.id} (${guild.name})` : ` in ${this.channelTitle(channel)}`;
    const text = this.renderContent(message.content).trim();
    this.notifications.emit({
      title: `${author}${where}`,
      body: (text || (message.attachments.length ? "Sent an attachment" : "New message")).slice(0, 200),
      target: channel.id,
      railKey: guild ? guild.id : `dm:${channel.id}`,
      inView: this.visible && this.selectedChannelId === channel.id,
    });
  }

  // --- Members and profiles --------------------------------------------------

  /** Where the member panel's list comes from: a guild text channel's member list (gateway), a DM's recipients; none for forums, threads and voice. */
  private memberSource(channel: FluxerChannel): "guild" | "dm" | undefined {
    if (channel.type === ChannelType.Dm || channel.type === ChannelType.GroupDm) return "dm";
    return channel.guildId && TEXT_CHANNEL_TYPES.has(channel.type) && !THREAD_TYPES.has(channel.type) ? "guild" : undefined;
  }

  /** The view's member panel opened (asking for the open channel's list afresh) or closed (ending the subscription). */
  private setMembersOpen(open: boolean): void {
    this.membersOpen = open;
    if (open) this.requestMembers();
    else this.dropMembers();
    this.render();
  }

  /** Subscribes to the open guild channel's member list (op 14), its first window; DMs need nothing fetched. */
  private requestMembers(): void {
    this.dropMembers();
    this.memberWindows = 1;
    this.memberError = undefined;
    const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
    if (!channel || this.memberSource(channel) !== "guild") return;
    this.watched = { channelId: channel.id, guildId: channel.guildId! };
    this.state.watchMembers(channel.id, channel.guildId!);
    this.askMembers(this.watched);
  }

  private askMembers(watched: { channelId: string; guildId: string }): void {
    const ranges = Array.from({ length: this.memberWindows }, (_, i) => [i * MEMBER_WINDOW, (i + 1) * MEMBER_WINDOW - 1]);
    this.gateway?.command(LAZY_REQUEST, { subscriptions: { [watched.guildId]: { active: true, typing: true, member_list_channels: { [watched.channelId]: ranges } } } });
    if (this.memberWindows > 1) return;
    clearTimeout(this.memberTimer);
    this.memberTimer = setTimeout(() => {
      if (this.watched !== watched || this.state.memberLists.get(watched.channelId)?.synced) return;
      this.memberError = "Fluxer did not send this channel's members.";
      this.render();
    }, MEMBER_LIST_TIMEOUT_MS);
  }

  /** Forgets the list being kept, and tells Fluxer to stop sending it (an empty range list). */
  private dropMembers(): void {
    clearTimeout(this.memberTimer);
    const watched = this.watched;
    this.watched = undefined;
    if (!watched) return;
    this.state.memberLists.delete(watched.channelId);
    this.gateway?.command(LAZY_REQUEST, { subscriptions: { [watched.guildId]: { member_list_channels: { [watched.channelId]: [] } } } });
  }

  /** The next window of the list; `offset` is how many the view lists, so a window is never asked twice. */
  private loadMembers(offset: number): void {
    const channel = this.watched && this.state.channels.get(this.watched.channelId);
    const view = channel ? this.memberView(channel) : undefined;
    if (!view?.hasMore || offset !== view.sections.reduce((sum, s) => sum + s.members.length, 0)) return;
    this.memberWindows++;
    this.askMembers(this.watched!);
    this.render();
  }

  /** The member panel's list: Fluxer's own grouping (hoisted roles, then online, then offline) for guild channels; recipients for DMs. */
  private memberView(channel: FluxerChannel): NativeMemberList | undefined {
    if (!this.membersOpen) return undefined;
    if (this.memberSource(channel) === "dm") return this.dmMembers(channel);
    const list = this.watched?.channelId === channel.id ? this.state.memberLists.get(channel.id) : undefined;
    if (!list) return undefined;
    const asked = Math.min(this.memberWindows * MEMBER_WINDOW, MEMBER_LIST_POSITIONS);
    const sections: NativeMemberSection[] = [];
    let listed = 0;
    for (const item of list.items.slice(0, asked)) {
      if (!item) continue;
      if ("group" in item) {
        sections.push({ name: `${this.groupName(list.guildId, item.group.id)} — ${item.group.count}`, members: [] });
        continue;
      }
      if (sections.length === 0) sections.push({ name: "Members", members: [] });
      sections.at(-1)!.members.push(this.guildMember(list.guildId, item.member));
      listed++;
    }
    const loading = !list.synced || list.reach < Math.min(list.positions, asked);
    const view: NativeMemberList = { sections: sections.filter((s) => s.members.length > 0), hasMore: !loading && asked < Math.min(list.positions, MEMBER_LIST_POSITIONS), loading };
    if (list.synced && list.memberCount > listed) view.more = list.memberCount - listed;
    if (this.memberError && !list.synced) view.error = this.memberError;
    return view;
  }

  private groupName(guildId: string, id: string): string {
    if (id === "online") return "Online";
    if (id === "offline") return "Offline";
    return this.state.roles.get(guildId)?.find((r) => r.id === id)?.name ?? "Members";
  }

  /** Someone's highest role with a colour, for their name. */
  private topColor(guildId: string, roleIds: readonly string[]): string | undefined {
    const roles = (this.state.roles.get(guildId) ?? []).filter((r) => r.color > 0 && roleIds.includes(r.id));
    return roleColor(roles.sort((a, b) => b.position - a.position)[0]);
  }

  private guildMember(guildId: string, member: FluxerMember): NativeMember {
    const row = this.memberRow(member.user, member.presence.status, member.presence.text);
    if (member.nick) row.name = member.nick;
    const color = this.topColor(guildId, member.roles);
    if (color) row.color = color;
    return row;
  }

  /** A member row; Fluxer's syntax mentions them as <@id>. */
  private memberRow(user: FluxerUser, presence: NativeMember["presence"], text: string | undefined): NativeMember {
    const row: NativeMember = { id: user.id, name: displayName(this.state.users.get(user.id) ?? user), mention: `<@${user.id}>` };
    const avatar = this.iconUrl("avatars", user.id, user.avatar, 64);
    if (avatar) row.avatarUrl = avatar;
    if (presence) row.presence = presence;
    const status = text ?? (user.bot ? "Bot" : undefined);
    if (status) row.status = status;
    return row;
  }

  /** A DM's or group DM's people, the user included, those online first; presence as far as Fluxer has told. */
  private dmMembers(channel: FluxerChannel): NativeMemberList {
    const people = [...channel.recipients, ...(this.state.me ? [this.state.me] : [])].filter((u, i, all) => all.findIndex((o) => o.id === u.id) === i);
    const rank = (row: NativeMember) => (row.presence === undefined || row.presence === "offline" ? 1 : 0);
    const rows = people
      .map((u) => {
        const presence = this.state.presences.get(u.id);
        return this.memberRow(u, presence?.status, presence?.text);
      })
      .sort((a, b) => rank(a) - rank(b));
    return { sections: [{ name: "Members", members: rows }], hasMore: false, loading: false };
  }

  /**
   * Someone's profile card: what is known at once (name, picture, presence),
   * then their profile from Fluxer, with their nickname and roles in the open
   * guild. Fluxer refuses profiles of people the user shares nothing with.
   */
  private async showProfile(id: string): Promise<void> {
    if (!isId(id) || !this.rest) return;
    const guildId = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId)?.guildId : undefined;
    const profile: NativeProfile = { id, loading: true };
    const user = this.state.users.get(id);
    if (user) Object.assign(profile, this.profileView(user, undefined, guildId));
    this.profile = profile;
    this.render();
    try {
      const found = await this.rest.profile(id, guildId);
      if (this.profile !== profile) return;
      if (found) Object.assign(profile, this.profileView(found.user, found, guildId));
    } catch {
      // Not shown to this user (403), or gone: the card keeps what the view has.
    }
    if (this.profile !== profile) return;
    delete profile.loading;
    this.render();
  }

  private profileView(user: FluxerUser, found: FluxerProfile | undefined, guildId: string | undefined): Partial<NativeProfile> {
    const view: Partial<NativeProfile> = { name: found?.nick ?? displayName(user), username: found?.discriminator ? `${user.username}#${found.discriminator}` : `@${user.username}` };
    const avatar = this.iconUrl("avatars", user.id, user.avatar, 128);
    if (avatar) view.avatarUrl = avatar;
    const presence = this.state.presences.get(user.id);
    if (presence) view.presence = presence.status;
    const status = presence?.text ?? found?.pronouns ?? (user.bot ? "Bot" : undefined);
    if (status) view.status = status;
    if (found?.bio) view.about = found.bio;
    const roles = guildId && found?.roles ? (this.state.roles.get(guildId) ?? []).filter((r) => r.id !== guildId && found.roles!.includes(r.id)) : [];
    if (roles.length > 0) view.roles = roles.sort((a, b) => b.position - a.position).map((r) => ({ name: r.name, ...(roleColor(r) ? { color: roleColor(r) } : {}) }));
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

  private iconUrl(kind: "icons" | "avatars", id: string, hash: string | undefined, size: number): string | undefined {
    return hash && this.instance ? `${this.instance.media}/${kind}/${id}/${hash}.png?size=${size}` : undefined;
  }

  private guildServer(guildId: string): RailServer {
    const guild = this.state.guilds.get(guildId)!;
    return {
      key: guild.id,
      account: this.account,
      name: guild.name,
      iconUrl: this.iconUrl("icons", guild.id, guild.icon, 96),
      unread: this.state.guildUnread(guild.id),
      mentions: this.state.guildMentions(guild.id),
    };
  }

  railServers(): RailServer[] {
    return this.state.guildLayout().map((slot): RailServer => {
      if (!slot.id) return this.guildServer(slot.guildIds[0]!);
      const children = slot.guildIds.map((id) => this.guildServer(id));
      return {
        key: FOLDER_PREFIX + slot.id,
        account: this.account,
        name: slot.name || children.slice(0, 3).map((c) => c.name).join(", "),
        unread: children.some((c) => c.unread),
        mentions: children.reduce((sum, c) => sum + c.mentions, 0),
        kind: "group",
        children,
        expanded: this.expanded.has(slot.id),
        color: slot.color,
        previewIconUrls: children.flatMap((c) => (c.iconUrl ? [c.iconUrl] : [])).slice(0, 4),
      };
    });
  }

  private channelTitle(channel: FluxerChannel): string {
    if (channel.type === ChannelType.Dm || channel.type === ChannelType.GroupDm) {
      const names = channel.recipients.map((r) => displayName(this.state.users.get(r.id) ?? r));
      return channel.name ?? (names.join(", ") || "Direct message");
    }
    return channel.name ?? channel.id;
  }

  private dmAvatar(channel: FluxerChannel): string | undefined {
    const user = channel.type === ChannelType.Dm ? channel.recipients[0] : undefined;
    return user ? this.iconUrl("avatars", user.id, user.avatar, 64) : undefined;
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
  private previewText(message: FluxerMessage): string {
    const text = this.renderContent(message.content).replace(/\s+/g, " ").trim();
    if (text) return text;
    return message.attachments.map((a) => `📎 ${a.filename}`).join(", ");
  }

  /** Message text with user and channel mentions resolved to names. */
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

  /** A message's text for the view; a forward's copy of the original follows, quoted under "Forwarded". */
  private messageContent(message: FluxerMessage): string {
    const own = this.renderContent(message.content);
    const forwarded = message.forwarded;
    if (!forwarded) return own;
    const quoted = forwarded.content === "" ? "" : this.renderContent(forwarded.content).split("\n").map((line) => `> ${line}`).join("\n");
    return [own, "*Forwarded*", quoted].filter(Boolean).join("\n");
  }

  /** A message as the pins list shows it: its text, or what it carries when it has none. */
  private listedMessage(message: FluxerMessage): NativeListedMessage {
    const carried = message.attachments.length > 0 ? `📎 ${message.attachments[0]!.filename}` : message.stickers.length > 0 ? `${message.stickers[0]!.name} (sticker)` : "";
    return {
      id: message.id,
      author: displayName(this.state.users.get(message.author.id) ?? message.author),
      avatarUrl: this.iconUrl("avatars", message.author.id, message.author.avatar, 64),
      content: this.messageContent(message) || carried,
      timestamp: message.timestamp,
    };
  }

  private viewMessage(message: FluxerMessage): NativeMessage {
    const mine = message.author.id === this.state.me?.id;
    const editable = message.type === undefined || message.type === MessageType.Default || message.type === MessageType.Reply;
    const reply = message.replyTo;
    return {
      id: message.id,
      author: displayName(this.state.users.get(message.author.id) ?? message.author),
      avatarUrl: this.iconUrl("avatars", message.author.id, message.author.avatar, 64),
      content: this.messageContent(message),
      timestamp: message.timestamp,
      edited: message.edited,
      mine,
      canEdit: mine && editable,
      source: mine && editable ? message.content : undefined,
      canDelete: mine,
      ...(!mine && this.state.mentionsMe(message) ? { mentionsMe: true } : {}),
      ...(message.pinned ? { pinned: true } : {}),
      // Fluxer pins ordinary messages and replies; whether this user may is the server's to say.
      canPin: editable,
      // Who wrote it, and Fluxer's syntax for mentioning them (shown as @name).
      authorId: message.author.id,
      authorMention: `<@${message.author.id}>`,
      reply:
        reply === undefined
          ? undefined
          : reply && { author: displayName(this.state.users.get(reply.author.id) ?? reply.author), content: this.renderContent(reply.content) },
      reactions: (message.reactions ?? []).map((r) => ({
        key: emojiKey(r.emoji),
        label: r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name,
        imageUrl: r.emoji.id && this.instance ? `${this.instance.media}/emojis/${r.emoji.id}.webp?size=32` : undefined,
        count: r.count,
        me: r.me,
      })),
      attachments: this.media(message),
      ...(message.links.length > 0 ? { embeds: message.links } : {}),
    };
  }

  /** A message's files, stickers and media link previews, as the view shows them. */
  private media(message: FluxerMessage): NativeAttachment[] {
    const files: NativeAttachment[] = [...message.attachments, ...(message.forwarded?.attachments ?? [])].map((a) => ({
      name: a.filename,
      kind: mediaKind(a.contentType),
      url: a.url,
      width: a.width,
      height: a.height,
      size: a.size,
      mime: a.contentType,
    }));
    for (const sticker of message.stickers) {
      // Lottie stickers (Discord's format 3) cannot be drawn here; their name stands in.
      // Fluxer serves every other sticker as WebP; APNG and GIF ones (formats 2 and 4) animate.
      const lottie = sticker.format === 3;
      files.push({
        name: sticker.name,
        kind: "sticker",
        url: lottie || !this.instance ? undefined : this.stickerUrl(sticker.id, sticker.animated || sticker.format === 2 || sticker.format === 4),
      });
    }
    for (const embed of message.embeds) {
      files.push({
        name: embed.kind === "image" ? "Image" : embed.kind === "gifv" ? "GIF" : "Video",
        kind: embed.kind === "image" ? "image" : "video",
        url: embed.url,
        previewUrl: embed.previewUrl,
        width: embed.width,
        height: embed.height,
        loop: embed.kind === "gifv" || undefined,
      });
    }
    return files;
  }

  private sidebar(): NativeSidebarItem[] {
    const item = (channel: FluxerChannel, kind: NativeSidebarItem["kind"]): NativeSidebarItem => ({
      id: channel.id,
      name: this.channelTitle(channel),
      kind,
      iconUrl: kind === "dm" ? this.dmAvatar(channel) : undefined,
      unread: kind !== "category" && this.state.isUnread(channel),
      mentions: kind === "category" ? 0 : this.state.mentions(channel.id),
      active: channel.id === this.selectedChannelId,
      // Muted in Fluxer (the channel, or its server); the bell changes the channel's own mute where that can.
      ...(kind !== "category" && this.state.isMuted(channel) ? { muted: true } : {}),
      ...(kind !== "category" && kind !== "voice" && this.canMute(channel) ? { canMute: true } : {}),
    });
    // Who is in a voice channel or call, listed under its row.
    const inVoice = (channelId: string) =>
      this.state.voiceMembers(channelId).map(({ user, state }) => ({
        name: displayName(user),
        avatarUrl: this.iconUrl("avatars", user.id, user.avatar, 64),
        muted: state.selfMute || state.selfDeaf,
        video: state.selfVideo || state.selfStream,
      }));
    if (this.selection.kind === "home") {
      return this.state.privateChannels().map((c) => {
        const entry = item(c, "dm");
        const members = inVoice(c.id);
        return members.length > 0 ? { ...entry, members } : entry;
      });
    }
    const kindOf = (c: FluxerChannel): NativeSidebarItem["kind"] =>
      c.type === ChannelType.GuildCategory
        ? "category"
        : c.type === ChannelType.GuildVoice
          ? "voice"
          : FORUM_TYPES.has(c.type)
            ? "forum"
            : THREAD_TYPES.has(c.type)
              ? "thread"
              : "text";
    return this.state
      .guildChannels(this.selection.guildId)
      .filter(
        (c) =>
          c.type === ChannelType.GuildCategory ||
          c.type === ChannelType.GuildVoice ||
          FORUM_TYPES.has(c.type) ||
          TEXT_CHANNEL_TYPES.has(c.type),
      )
      .map((c) => {
        const entry = item(c, kindOf(c));
        if (entry.kind === "voice") {
          entry.active = c.id === this.voice?.channelId;
          entry.members = inVoice(c.id);
        }
        // A forum is unread when any of its posts is.
        if (entry.kind === "forum") {
          const posts = this.state.forumPosts(c.id);
          entry.unread = posts.some((p) => this.state.isUnread(p));
          entry.mentions = posts.reduce((sum, p) => sum + this.state.mentions(p.id), 0);
        }
        return entry;
      });
  }

  viewState(): NativeViewState {
    const platform = this.deps.def.name;
    switch (this.screen) {
      case "login":
        return { screen: "login", platform, identity: this.instance?.identity ?? "email", busy: this.busy, status: this.status, error: this.error };
      case "mfa":
        return { screen: "mfa", platform, codes: this.mfaCodes, busy: this.busy, error: this.error };
      case "connecting":
        return { screen: "connecting", platform, status: this.connection === "reconnecting" ? "Reconnecting…" : "Connecting…" };
      case "chat": {
        const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
        const guild = this.selection.kind === "guild" ? this.state.guilds.get(this.selection.guildId) : undefined;
        const expressionGuilds = this.expressionGuilds();
        const gifs = this.instance!.gifs;
        const members = channel ? this.memberView(channel) : undefined;
        const ringing = this.ringing();
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
                ...(this.unreadAt?.channelId === channel.id ? { unread: this.unreadView(channel.id, this.unreadAt) } : {}),
                ...(this.pins?.channelId === channel.id ? { pins: this.pins.list } : {}),
                ...(this.search?.channelId === channel.id ? { search: this.search.results } : {}),
                ...(members ? { members } : {}),
                can: {
                  pins: !FORUM_TYPES.has(channel.type),
                  search: !FORUM_TYPES.has(channel.type),
                  forward: !FORUM_TYPES.has(channel.type),
                  reply: true,
                  react: true,
                  attach: this.deps.files !== undefined,
                  typing: this.typingIndicators,
                  members: this.memberSource(channel) !== undefined,
                  // Fluxer allows guild stickers in DMs only with global expressions.
                  stickers: channel.guildId !== undefined || this.globalExpressions(),
                  gifs,
                  // DMs and groups have calls of their own, where the instance runs voice.
                  call: isPrivateCall(channel) && this.instance!.voiceEnabled,
                },
                posts: FORUM_TYPES.has(channel.type)
                  ? this.state.forumPosts(channel.id).map((p) => ({
                      id: p.id,
                      name: p.name ?? p.id,
                      messageCount: p.messageCount,
                      unread: this.state.isUnread(p),
                      mentions: this.state.mentions(p.id),
                    }))
                  : undefined,
              }
            : null,
          voice: this.voiceSession(),
          emojiBase: this.instance ? `${this.instance.media}/emojis` : undefined,
          customEmoji: this.customEmoji(expressionGuilds),
          stickers: this.stickerPacks(expressionGuilds),
          gifs: gifs ? this.gifResults : undefined,
          ...(this.profile ? { profile: this.profile } : {}),
          ...(ringing ? { incomingCall: ringing } : {}),
          error: this.error ?? (this.connection === "reconnecting" ? "Connection lost. Reconnecting…" : undefined),
        };
      }
    }
  }

  private render(): void {
    const state = this.viewState();
    this.deps.render(state);
    // Each render carries the signals since the last one to the view, once.
    if (state.screen === "chat" && state.voice?.p2p) this.voice!.p2p!.signals = [];
  }
}
