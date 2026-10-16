import type { DirectConversation, HealthCheck, HomeBadge, PlatformAdapter, RailServer } from "../../shared/adapter";
import {
  MAX_ATTACHMENTS,
  MAX_CALL_PARTICIPANTS,
  MAX_CALL_SIGNALS,
  voiceSignal,
  type NativeAction,
  type NativeCallPeer,
  type NativeCallSignal,
  type NativeIceServer,
  type NativeIncomingCall,
  type NativeVoiceMember,
  type NativeVoiceSession,
  type MeshSignal,
  type VoiceSignal,
  type NativeAttachment,
  type NativeCustomEmoji,
  type NativeEmbed,
  type NativeListedMessage,
  type NativeMember,
  type NativeMemberList,
  type NativeMessage,
  type NativeMessageList,
  type NativeSearchResults,
  type NativePresence,
  type NativeProfile,
  type NativeSidebarItem,
  type NativeUnread,
  type NativeViewState,
} from "../../shared/native";
import type { PickedFile } from "../../shared/engine";
import { TYPING_SETTING, type AccountStatus, type ServiceSettingValues } from "../../shared/settings";
import type { AsyncSecretStore, EngineFiles, FileSource } from "../../engine/runtime";
import { BaseAdapter } from "../../shared/baseAdapter";
import { emojiMarkup, toMarkdown, toPlainLine, type MarkupNames } from "./markup";
import { MAX_SEARCH, NerimityApiError, NerimityRest, PAGE_SIZE, PIN_PAGE, type ReactionTarget, type RestOptions } from "./rest";
import { NerimitySocket, type SocketFactory, type SocketStatus } from "./socket";
import { NerimityState, TYPING_MS } from "./state";
import { CLOUDFLARE_ICE_HOSTS, hasRelay, iceServersFrom, TURN_REUSE_MS } from "./voice";
import {
  ChannelType,
  MessageType,
  NotifyMode,
  TEXT_CHANNEL_TYPES,
  UserStatus,
  displayName,
  emojiFile,
  isRecord,
  parseVoiceUser,
  reactionKey,
  type NerimityChannel,
  type NerimityLinkEmbed,
  type NerimityMember,
  type NerimityMessage,
  type NerimityRole,
  type NerimityUser,
} from "./types";

const PUBLISH_DELAY_MS = 100;
const READ_DELAY_MS = 750;
/** Nerimity shows typing for 5 s, and its own client repeats it every 4 s. */
const TYPING_REPEAT_MS = 4_000;
/** Member rows listed at most (the view shows 200); the rest are counted. */
const MAX_MEMBERS = 200;
/** Nerimity takes messages up to 2,000 characters. */
const MAX_CONTENT = 2_000;
/** An upload token is good for a few minutes; Nerimity's client reuses one for two. */
const CDN_TOKEN_MS = 2 * 60_000;
/** Pages of pins fetched at most: the server allows ten pin lists per 30 seconds. */
const PIN_PAGES = 3;
const SIGN_IN_PROMPT = "signin";
const TOKEN_PROMPT = "token";

/** How often the server is asked whether its API and CDN answer. */
export const HEALTH_INTERVAL_MS = 5 * 60_000;

/** What the module offers the shell; its manifest must declare the same (tested). Calls are Nerimity's own peer-to-peer WebRTC, with the microphone and camera; no screen sharing. */
export const CAPABILITIES: PlatformAdapter["capabilities"] = { directMessages: true, messagePreviews: true, voice: true, screenShare: false };

/** The service setting that keeps calls to Nerimity's TURN relay, so peers never learn the user's addresses (on unless turned off). */
export const RELAY_SETTING = "relayOnly";
/** People in a call the sidebar lists under its conversation. */
const CALL_MEMBERS_SHOWN = 25;
export const NO_RELAY = "Nerimity gave no relay (TURN) server, and this service's calls go through a relay only (Settings > Services).";

/** The call the user is in, or joining. */
interface NerimityCall {
  channelId: string;
  /** New with each join, so the view starts its connections afresh. */
  callId: string;
  /** The server took the join: the view may connect. */
  joined: boolean;
  mute: boolean;
  deaf: boolean;
  video: boolean;
  /** The relay setting as it was at the join. */
  relayOnly: boolean;
  iceServers: NativeIceServer[];
  /** Who was in the call before the user, once the server said the user joined: they make the offers, and the user offers to anyone after. */
  existing?: Set<string>;
  /** Signals from peers not yet rendered. */
  signals: NativeCallSignal[];
  seq: number;
}

/** Which instance this is: the engine's own info. */
export interface NerimityInstanceDef {
  id: string;
  name: string;
  /** The site's address, e.g. https://nerimity.com; its API is under /api, its CDN at cdn.<host>. */
  url: string;
}

export interface NerimityAdapterDeps {
  def: NerimityInstanceDef;
  fetch: typeof fetch;
  createSocket: SocketFactory;
  /** This instance's own secrets. */
  secrets: AsyncSecretStore;
  /** Sends display state to the native view. */
  render(state: NativeViewState): void;
  /** Narrows what the engine may reach to these hosts. */
  lockHosts?(hosts: string[]): Promise<void>;
  rest?: Partial<RestOptions>;
  /** Lets the user pick files; the engine reads only what was picked. */
  files?: EngineFiles;
  /** This instance's settings values (TYPING_SETTING); changes come through applySettings(). */
  settings?: ServiceSettingValues;
}

type Selection = { kind: "home" } | { kind: "server"; serverId: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What a file is by its MIME type. */
export function mediaKind(contentType: string | undefined): NativeAttachment["kind"] {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  return "file";
}

/** How present someone is, in the view's terms: looking to play counts as online, away as idle. */
export function presenceOf(status: number | undefined): NativePresence {
  switch (status) {
    case UserStatus.Online:
    case UserStatus.LookingToPlay:
      return "online";
    case UserStatus.Away:
      return "idle";
    case UserStatus.DoNotDisturb:
      return "dnd";
    default:
      return "offline";
  }
}

/** Nevula's mentions and quotes ([@:id], [@:e], [r:id], [q:id]), which notify whom they name. */
const PINGS = /\[(@|r|q):([^\]\n]{1,300})\]/g;

/** Markdown quote: each line after "> ". */
const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** System messages, which Nerimity writes from their type rather than text. */
const SYSTEM_TEXT: Record<number, string> = {
  [MessageType.JoinServer]: "joined the server.",
  [MessageType.LeaveServer]: "left the server.",
  [MessageType.KickUser]: "was kicked.",
  [MessageType.BanUser]: "was banned.",
  [MessageType.CallStarted]: "started a call.",
  [MessageType.BumpServer]: "bumped the server.",
  [MessageType.PinnedMessage]: "pinned a message.",
};

/**
 * Native Nerimity adapter: talks to a Nerimity server's API and socket.io
 * events from its sandboxed engine and renders in Multicord's own chat view.
 * Sign-in, the socket session and the token all stay here.
 */
export class NerimityAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = CAPABILITIES;

  readonly state = new NerimityState();
  private readonly origin: string;
  /** The CDN: avatars, icons, emoji and files. */
  private readonly cdn: string;
  private readonly rest: NerimityRest;
  private socket: NerimitySocket | undefined;
  private screen: "signin" | "token" | "connecting" | "chat" = "signin";
  private connection: SocketStatus = "closed";
  private queuePosition = 0;
  private busy = false;
  private error: string | undefined;
  private locked = false;
  private selection: Selection = { kind: "home" };
  private selectedChannelId: string | undefined;
  private readonly lastChannel = new Map<string, string>();
  private readonly hasOlder = new Map<string, boolean>();
  /** Where the open channel's news began when it was opened: when it was last read then. */
  private unreadAt: { channelId: string; after: number } | undefined;
  private readonly loading = new Set<string>();
  private readonly readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly typingSent = new Map<string, number>();
  /** Settings' "Send typing indicators" for this service. */
  private typingIndicators: boolean;
  private readonly pending = new Map<string, FileSource[]>();
  private readonly uploading = new Set<string>();
  private readonly cdnTokens = new Map<string, { token: string; at: number }>();
  /** Whether a session token is stored, so the account shows as signed in before it connects. */
  private hasToken = false;
  private visible = false;
  private membersOpen = false;
  /** The profile card the view asked for last. */
  private profile: NativeProfile | undefined;
  private checks: HealthCheck[] = [];
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  /** The open channel's pinned messages, while its pins panel is open. */
  private pins: { channelId: string; list: NativeMessageList } | undefined;
  /** The open channel's search results, until the search ends; and a count that drops answers to earlier searches. */
  private search: { channelId: string; results: NativeSearchResults } | undefined;
  private searchCount = 0;
  /** Settings' "Calls through a relay only" for this service. */
  private relayOnly: boolean;
  private voice: NerimityCall | undefined;
  /** Counts joins and leaves, so the answer to a join given up is not taken for the call now. */
  private voiceJoins = 0;
  /** TURN credentials from the server, while they may be reused. */
  private turn: { servers: NativeIceServer[]; at: number } | undefined;
  /** DM calls that started while signed in: they ring until joined, declined or over. */
  private readonly ringing = new Set<string>();
  private readonly declined = new Set<string>();

  constructor(private readonly deps: NerimityAdapterDeps) {
    const url = new URL(deps.def.url);
    super(deps.def.id, { platform: deps.def.id, instance: url.host, accountId: "default" });
    this.origin = url.origin;
    this.cdn = `https://cdn.${url.host}`;
    this.rest = new NerimityRest(`${this.origin}/api`, { fetch: deps.fetch, ...deps.rest });
    this.typingIndicators = deps.settings?.[TYPING_SETTING] !== false;
    this.relayOnly = deps.settings?.[RELAY_SETTING] !== false;
    this.state.changed.on(() => this.schedulePublish());
    // Typing indicators expire on their own; re-render when they may have.
    this.state.changed.on(() => {
      clearTimeout(this.typingTimer);
      if (this.state.typing.size > 0) this.typingTimer = setTimeout(() => this.render(), TYPING_MS);
    });
    this.state.incoming.on((message) => {
      if (message.channelId === this.selectedChannelId) this.readSoon(message.channelId);
      this.notify(message);
    });
  }

  /** Settings changed: whether to send typing indicators (one already sent runs out by itself), and whether calls go through a relay only (from the next join). */
  applySettings(values: ServiceSettingValues): void {
    this.typingIndicators = values[TYPING_SETTING] !== false;
    this.relayOnly = values[RELAY_SETTING] !== false;
    this.render();
  }

  /** Locks the engine to the server's hosts, and resumes a saved session or shows sign-in. */
  async start(): Promise<void> {
    this.healthTimer ??= setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    await this.lock();
    void this.checkHealth();
    const token = await this.deps.secrets.load("token");
    this.hasToken = token !== undefined;
    if (token) this.openSession(token);
    else this.render();
  }

  async handleAction(action: NativeAction): Promise<void> {
    switch (action.type) {
      case "ready":
        return this.render();
      case "prompt":
        if (action.id === SIGN_IN_PROMPT) return this.signIn(action.values.identity ?? "", action.values.password ?? "");
        return action.id === TOKEN_PROMPT ? this.useToken(action.values.token ?? "") : undefined;
      case "cancelPrompt":
        // The sign-in form's second button offers a token; the token form's goes back.
        this.screen = action.id === SIGN_IN_PROMPT ? "token" : "signin";
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
      case "removeAttachment":
        this.pending.get(this.selectedChannelId ?? "")?.splice(action.index, 1);
        return this.render();
      case "members":
        this.membersOpen = action.open;
        return this.render();
      case "profile":
        return this.showProfile(action.id);
      case "pins":
        return this.showPins(action.open);
      case "pin":
        return this.pin(action.messageId, action.pin);
      case "search":
        return this.searchMessages(action.query);
      case "mute":
        return this.mute(action.channelId, action.mute);
      case "forward":
        return this.forward(action.messageId, action.channelId);
      case "joinVoice":
        return this.joinVoice(action.channelId);
      case "leaveVoice":
        return this.leaveVoice(undefined);
      case "voiceState":
        return this.setVoiceFlags(action);
      case "voiceError":
        return this.leaveVoice(`Call failed: ${action.message}`);
      case "voiceNotice":
        return this.voiceNotice(action.message, action.off === "video");
      case "voiceSignal":
        return this.sendSignal(action.to, action.signal);
      case "declineCall":
        return this.declineCall(action.channelId);
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
    if (visible && this.selectedChannelId) this.readSoon(this.selectedChannelId);
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
    if (!this.state.servers.has(key)) throw new Error(`Unknown Nerimity server: ${key}`);
    this.selection = { kind: "server", serverId: key };
    const first = this.state.serverChannels(key).find((c) => TEXT_CHANNEL_TYPES.has(c.type));
    const channelId = this.lastChannel.get(key) ?? first?.id;
    if (channelId) return this.selectChannel(channelId);
    this.selectedChannelId = undefined;
    this.render();
  }

  /** Opens any text channel: a DM at home, or a server channel inside its server. */
  async openConversation(key: string): Promise<void> {
    const serverId = this.state.channels.get(key)?.serverId;
    this.selection = serverId ? { kind: "server", serverId } : { kind: "home" };
    await this.selectChannel(key);
  }

  // --- Session ---------------------------------------------------------------

  /** For Settings > Diagnostics: whether the API and the CDN answer. */
  health(): HealthCheck[] {
    return this.checks;
  }

  /** Asks the API (any answer below 500 will do) and the CDN's front page whether they answer; nothing is sent with them. */
  private async checkHealth(): Promise<void> {
    const probes = [
      { name: "API answers", url: `${this.origin}/api/`, ok: (status: number) => status < 500, breaks: "Signing in, history and sending fail." },
      { name: "CDN answers", url: `${this.cdn}/`, ok: (status: number) => status >= 200 && status < 300, breaks: "Pictures, avatars and files do not load, and files cannot be sent." },
    ];
    this.checks = await Promise.all(
      probes.map(async ({ name, url, ok, breaks }): Promise<HealthCheck> => {
        try {
          const response = await this.deps.fetch(url);
          return ok(response.status) ? { name, ok: true } : { name, ok: false, detail: `It answered HTTP ${response.status}. ${breaks}` };
        } catch (error) {
          return { name, ok: false, detail: `It could not be reached (${messageOf(error)}). ${breaks}` };
        }
      }),
    );
    this.render();
  }

  /** Locks the engine to the site (its API and socket) and its CDN, once. */
  private async lock(): Promise<void> {
    if (this.locked) return;
    this.locked = true;
    try {
      await this.deps.lockHosts?.([new URL(this.origin).hostname, new URL(this.cdn).hostname]);
    } catch (error) {
      // Refused, e.g. for a private address: the shell's general rules still apply.
      console.warn(`[nerimity] host lock refused: ${messageOf(error)}`);
    }
  }

  private async signIn(identity: string, password: string): Promise<void> {
    const login = identity.trim();
    if (!login.includes("@") && !/^[^:\s]+:[^:\s]+$/.test(login)) {
      this.error = "Enter your email address, or your username and tag as name:1234.";
      return this.render();
    }
    await this.signInStep(async () => this.onToken(await this.rest.login(login, password)));
  }

  /** Signs in with a token copied from Nerimity's own app, checked with the server first. */
  private async useToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (trimmed === "" || /\s/.test(trimmed)) {
      this.error = "Paste the whole token, without spaces.";
      return this.render();
    }
    await this.signInStep(async () => {
      this.rest.token = trimmed;
      try {
        if (!(await this.rest.me())) throw new Error("The server did not say who this token belongs to.");
      } catch (error) {
        this.rest.token = undefined;
        throw error instanceof NerimityApiError && error.status === 401 ? new Error("The server did not accept this token.") : error;
      }
      this.onToken(trimmed);
    });
  }

  /** Runs one sign-in step with the form busy, showing what went wrong. */
  private async signInStep(step: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    this.render();
    try {
      await step();
    } catch (error) {
      this.error = messageOf(error);
    }
    this.busy = false;
    this.render();
  }

  private onToken(token: string): void {
    this.hasToken = true;
    void this.deps.secrets.save("token", token);
    this.openSession(token);
  }

  private openSession(token: string): void {
    this.rest.token = token;
    this.screen = "connecting";
    this.socket = new NerimitySocket(this.origin, token, this.deps.createSocket, {
      event: (name, data) => this.onEvent(name, data),
      status: (status) => {
        this.connection = status;
        this.render();
      },
      queue: (position) => {
        this.queuePosition = position;
        this.render();
      },
      authFailed: (message) => this.endSession(message === "Invalid token." ? "Your session has ended. Please sign in again." : `Nerimity refused the session: ${message}`),
    });
    this.socket.connect();
    this.render();
  }

  private onEvent(name: string, data: unknown): void {
    // Someone else joining a DM's call that no one was in starts a call there, which rings.
    const starting = name === "voice:user_joined" && this.callStarting(data);
    this.state.apply(name, data);
    // Someone pinned or unpinned in the channel whose pins are listed.
    if (name === "message:updated" && this.pins && isRecord(data) && data.channelId === this.pins.channelId && isRecord(data.updated) && typeof data.updated.pinned === "boolean")
      void this.loadPins(this.pins.channelId);
    if (name === "voice:user_joined" || name === "voice:user_left") return this.onVoiceUser(name, data, starting);
    if (name === "voice:signal_received") return this.receiveSignal(data);
    if (name !== "user:authenticated") return;
    // The server may hand out a new token with the session; later connections use it.
    const fresh = isRecord(data) ? data.newToken : undefined;
    if (typeof fresh === "string" && fresh !== "" && !/\s/.test(fresh)) {
      this.rest.token = fresh;
      this.socket!.token = fresh;
      void this.deps.secrets.save("token", fresh);
    }
    this.queuePosition = 0;
    this.screen = "chat";
    // The server ended the call with the old connection: join it again on this one, as Nerimity's client does.
    const voice = this.voice;
    if (!voice) return this.render();
    this.voice = undefined;
    void this.joinVoice(voice.channelId, voice);
  }

  private async logout(): Promise<void> {
    if (this.rest.token) await this.rest.logout().catch(() => undefined);
    this.endSession(undefined);
  }

  private endSession(error: string | undefined): void {
    this.socket?.disconnect();
    this.socket = undefined;
    this.rest.token = undefined;
    this.hasToken = false;
    void this.deps.secrets.delete("token");
    this.state.reset();
    this.membersOpen = false;
    this.profile = undefined;
    this.pins = undefined;
    this.search = undefined;
    this.pending.clear();
    this.cdnTokens.clear();
    // The server ends the call with the connection.
    this.voice = undefined;
    this.voiceJoins++;
    this.turn = undefined;
    this.ringing.clear();
    this.declined.clear();
    this.selection = { kind: "home" };
    this.selectedChannelId = undefined;
    this.lastChannel.clear();
    this.screen = "signin";
    this.error = error;
    this.setServers([]);
    this.directsChanged.emit([]);
    this.render();
  }

  // --- Channels and messages -------------------------------------------------

  private async selectChannel(channelId: string): Promise<void> {
    const channel = this.state.channels.get(channelId);
    if (!channel || !TEXT_CHANNEL_TYPES.has(channel.type) || !this.state.canSee(channel)) return;
    if (channelId !== this.selectedChannelId) {
      // Noted before it is read: where its news began.
      this.unreadAt = this.state.isUnread(channel) ? { channelId, after: this.state.lastSeen.get(channelId) ?? 0 } : undefined;
      this.profile = undefined;
      this.pins = undefined;
      this.search = undefined;
    }
    this.selectedChannelId = channelId;
    this.lastChannel.set(channel.serverId ?? "home", channelId);
    this.error = undefined;
    this.render();
    if (!this.state.messages.has(channelId)) await this.fetchHistory(channelId, undefined);
    this.readSoon(channelId);
  }

  /**
   * The open channel's unread marker: the first message from someone else
   * after the channel was last read when it was opened, once the loaded
   * messages reach back that far. Nerimity gives no count.
   */
  private unreadView(channelId: string, after: number): NativeUnread | undefined {
    const messages = this.state.messages.get(channelId) ?? [];
    const reach = !(this.hasOlder.get(channelId) ?? false) || messages.some((m) => m.createdAt <= after);
    if (!reach) return {};
    const first = messages.find((m) => m.createdAt > after && m.author?.id !== this.state.me?.id);
    return first && { firstId: first.id };
  }

  private async fetchHistory(channelId: string, before: string | undefined): Promise<void> {
    if (this.loading.has(channelId)) return;
    this.loading.add(channelId);
    this.render();
    try {
      const page = await this.rest.messages(channelId, before);
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

  /**
   * Sends the composer's text and the files waiting with it. Nerimity takes
   * one file per message, so each file goes as its own message, the first
   * with the text (and the reply).
   */
  private async send(content: string, replyTo?: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || this.uploading.has(channelId)) return;
    const files = this.pending.get(channelId) ?? [];
    if (content.trim() === "" && files.length === 0) return;
    if (content.length > MAX_CONTENT) {
      this.error = "Nerimity takes messages up to 2,000 characters.";
      return this.render();
    }
    this.uploading.add(channelId);
    this.render();
    await this.attempt(files.length > 0 ? "File not sent" : "Message not sent", async () => {
      if (files.length === 0) return this.addSent(channelId, await this.rest.sendMessage(channelId, content, replyTo));
      while (files.length > 0) {
        const fileId = await this.rest.upload(this.cdn, channelId, await this.cdnToken(channelId), files[0]!);
        this.addSent(channelId, await this.rest.sendMessage(channelId, content, replyTo, fileId));
        // Sent: it leaves the waiting files (one that fails stays), and the text and reply went with the first.
        files.shift();
        content = "";
        replyTo = undefined;
      }
      this.pending.delete(channelId);
    });
    this.uploading.delete(channelId);
    this.render();
  }

  /** Forwards a loaded message of the open channel into another channel or DM the user may see, as a quoted copy (Nerimity has no forward of its own). */
  private async forward(messageId: string, target: string): Promise<void> {
    const from = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
    const message = from && this.state.findMessage(from.id, messageId);
    const to = this.state.channels.get(target);
    if (!from || !message || !to || !TEXT_CHANNEL_TYPES.has(to.type) || !this.state.canSee(to)) return;
    await this.attempt("Message not forwarded", async () => {
      const sent = await this.rest.sendMessage(to.id, this.forwardText(message, from));
      // Only into history already loaded; otherwise it comes with the rest when the channel opens.
      if (this.state.messages.has(to.id)) this.addSent(to.id, sent);
    });
  }

  /**
   * A message as a new message elsewhere: who wrote it and where, then its
   * text and file links quoted, cut to what Nerimity takes. Mentions and
   * quotes become plain text, so a forward notifies no one.
   */
  private forwardText(message: NerimityMessage, from: NerimityChannel): string {
    const server = from.serverId ? this.state.servers.get(from.serverId) : undefined;
    const where = server ? `#${this.channelTitle(from)} (${server.name})` : "a DM";
    const author = message.author ? this.authorName(message.author, from.serverId) : "Deleted user";
    const system = SYSTEM_TEXT[message.type];
    const files = message.attachments.flatMap((a) => (a.path && a.provider === "local" ? [`📎 ${this.attachmentView(a).name}: ${this.cdn}/${a.path}`] : []));
    const text = [system ? `*${system}*` : message.content, ...files].filter(Boolean).join("\n");
    // A name put in place of a mention loses its brackets, so it cannot make a mention of its own.
    const plain = (name: string): string => `@${name.replace(/[[\]]/g, "")}`;
    const full = `*Forwarded from ${author} in ${where}:*\n${quote(text)}`.replace(PINGS, (_match, type: string, value: string) => {
      if (type === "q") return "";
      if (type === "r") return plain([...this.state.roles.values()].flat().find((r) => r.id === value)?.name ?? "unknown role");
      if (value === "e") return "@everyone";
      if (value === "s") return "@someone";
      const user = this.state.users.get(value);
      return plain(user ? this.authorName(user, from.serverId) : "unknown user");
    });
    if (full.length <= MAX_CONTENT) return full;
    // Cut short, without splitting a character made of two code units.
    const high = full.charCodeAt(MAX_CONTENT - 2);
    return `${full.slice(0, high >= 0xd800 && high <= 0xdbff ? MAX_CONTENT - 2 : MAX_CONTENT - 1)}…`;
  }

  private addSent(channelId: string, sent: NerimityMessage | undefined): void {
    if (sent) this.state.addHistory(channelId, [sent], false);
  }

  /** An upload token for a channel, reused while it is fresh: the server gives out few. */
  private async cdnToken(channelId: string, now: number = Date.now()): Promise<string> {
    const cached = this.cdnTokens.get(channelId);
    if (cached && now - cached.at < CDN_TOKEN_MS) return cached.token;
    const token = await this.rest.cdnToken(channelId);
    this.cdnTokens.set(channelId, { token, at: now });
    return token;
  }

  /** Adds files from the OS picker to the open channel's next message. */
  private async attach(): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.deps.files) return;
    await this.attempt("Could not attach", async () => {
      const list = this.pending.get(channelId) ?? [];
      for (const file of await this.deps.files!.pick()) {
        if (list.length >= MAX_ATTACHMENTS) {
          this.error = `At most ${MAX_ATTACHMENTS} files at once.`;
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
      this.error = `At most ${MAX_ATTACHMENTS} files at once.`;
      return this.render();
    }
    list.push(this.deps.files.open(file));
    this.pending.set(channelId, list);
    if (list.length === 1) return this.send("", replyTo);
    this.render();
  }

  private async edit(messageId: string, content: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId) return;
    await this.attempt("Message not edited", async () => {
      const edited = await this.rest.editMessage(channelId, messageId, content);
      if (edited && this.state.replaceMessage(edited)) this.state.changed.emit();
    });
  }

  private async remove(messageId: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId) return;
    await this.attempt("Message not deleted", async () => {
      await this.rest.deleteMessage(channelId, messageId);
      this.state.removeMessage(channelId, messageId);
    });
  }

  /** Reacts with a Unicode emoji or name:id; a custom emoji's file kind comes from the servers' emoji or the reaction already there. */
  private async react(messageId: string, key: string, add: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId) return;
    const custom = /^(\w{1,64}):(\d{1,20})$/.exec(key);
    let target: ReactionTarget = { name: key };
    if (custom) {
      const known = [...this.state.emojis.values()].flat().find((e) => e.id === custom[2]) ?? this.state.findMessage(channelId, messageId)?.reactions.find((r) => r.emojiId === custom[2]);
      target = { name: custom[1]!, emojiId: custom[2]!, gif: known?.gif ?? false, webp: known?.webp ?? true };
    }
    await this.attempt("Reaction failed", async () => {
      const result = await this.rest.react(channelId, messageId, target, add);
      if (result && this.state.setReaction(channelId, messageId, { ...target, ...result }, add)) this.state.changed.emit();
    });
  }

  /** Opens the open channel's pins panel and fetches its pins, or closes it. */
  private async showPins(open: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    this.pins = open && channelId ? { channelId, list: { messages: [], loading: true } } : undefined;
    this.render();
    if (this.pins) await this.loadPins(this.pins.channelId);
  }

  /** Fetches the pins of a channel whose pins panel is open, a page of ten at a time up to PIN_PAGES; a reply for a panel since closed is dropped. */
  private async loadPins(channelId: string): Promise<void> {
    let list: NativeMessageList;
    try {
      const found: NerimityMessage[] = [];
      let page = await this.rest.pins(channelId);
      for (let pages = 1; ; pages++) {
        found.push(...page);
        if (page.length < PIN_PAGE || pages >= PIN_PAGES) break;
        page = await this.rest.pins(channelId, page.at(-1)!.id);
      }
      list = { messages: found.map((m) => this.listedMessage(m)), loading: false };
      if (page.length === PIN_PAGE) list.note = `Only the latest ${PIN_PAGE * PIN_PAGES} pins are listed.`;
    } catch (error) {
      list = { messages: [], loading: false, error: `Could not load pinned messages: ${messageOf(error)}` };
    }
    if (this.pins?.channelId !== channelId) return;
    this.pins = { channelId, list };
    this.render();
  }

  /** Searches the open channel or DM on the server, or ends the search with an empty query. The server takes up to MAX_SEARCH characters. */
  private async searchMessages(query: string): Promise<void> {
    const channelId = this.selectedChannelId;
    const count = ++this.searchCount;
    const trimmed = query.trim();
    this.search = channelId && trimmed !== "" ? { channelId, results: { query: trimmed, messages: [], loading: true } } : undefined;
    this.render();
    if (!this.search || !channelId) return;
    let results: NativeSearchResults;
    try {
      const found = await this.rest.search(channelId, trimmed.slice(0, MAX_SEARCH));
      results = { query: trimmed, messages: found.map((m) => this.listedMessage(m)), loading: false };
      if (trimmed.length > MAX_SEARCH) results.note = `Nerimity searched for the first ${MAX_SEARCH} characters only.`;
    } catch (error) {
      results = { query: trimmed, messages: [], loading: false, error: `Search failed: ${messageOf(error)}` };
    }
    if (count !== this.searchCount || this.search?.channelId !== channelId) return;
    this.search = { channelId, results };
    this.render();
  }

  /**
   * Pins or unpins a message. The server tells the channel (message:updated),
   * which also brings the pins list up to date, so it is not fetched here.
   */
  private async pin(messageId: string, pin: boolean): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId) return;
    await this.attempt(pin ? "Message not pinned" : "Message not unpinned", async () => {
      await this.rest.pin(channelId, messageId, pin);
      const message = this.state.findMessage(channelId, messageId);
      if (message) message.pinned = pin;
      this.render();
    });
  }

  /** Tells others the user is typing, at most once per TYPING_REPEAT_MS per channel, and not while Settings turn it off. */
  private async sendTyping(now: number = Date.now()): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.typingIndicators || now - (this.typingSent.get(channelId) ?? -Infinity) < TYPING_REPEAT_MS) return;
    this.typingSent.set(channelId, now);
    await this.rest.typing(channelId).catch(() => undefined);
  }

  /**
   * Whether a channel's own mute may be changed from here: a server's text
   * channel (Nerimity's notification settings are per server member, so DMs
   * have none), in a server that is not muted as a whole, since unmuting
   * hands the channel back to its server's setting.
   */
  private canMute(channel: NerimityChannel): boolean {
    return channel.serverId !== undefined && channel.type === ChannelType.ServerText && this.state.pingModes.get(channel.serverId) !== NotifyMode.Mute;
  }

  /** Mutes a server channel's pings and sounds, as Nerimity's client does, or hands them back to the server's setting. */
  private async mute(channelId: string, mute: boolean): Promise<void> {
    const channel = this.state.channels.get(channelId);
    if (!channel?.serverId || !this.canMute(channel) || this.state.isMuted(channel) === mute) return;
    const serverId = channel.serverId;
    const mode = mute ? NotifyMode.Mute : null;
    await this.attempt(mute ? "Could not mute" : "Could not unmute", async () => {
      await this.rest.setChannelNotifications(serverId, channelId, mode);
      this.state.setPingMode(channelId, mode);
      this.state.changed.emit();
    });
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

  /** Marks the open channel read (notification:dismiss, as Nerimity's client does), debounced, while the view is in front. */
  private readSoon(channelId: string): void {
    if (!this.visible || this.readTimers.has(channelId)) return;
    this.readTimers.set(
      channelId,
      setTimeout(() => {
        this.readTimers.delete(channelId);
        const channel = this.state.channels.get(channelId);
        if (!channel || (!this.state.isUnread(channel) && this.state.mentions(channelId) === 0)) return;
        this.state.markRead(channelId);
        this.socket?.emit("notification:dismiss", { channelId });
      }, READ_DELAY_MS),
    );
  }

  /** Notifies of DMs, and of server messages that mention the user, unless their channel is muted. */
  private notify(message: NerimityMessage): void {
    const channel = this.state.channels.get(message.channelId);
    if (!channel || (channel.type !== ChannelType.Dm && !this.state.mentionsMe(message)) || this.state.isMuted(channel)) return;
    const server = channel.serverId ? this.state.servers.get(channel.serverId) : undefined;
    const author = message.author ? this.authorName(message.author, server?.id) : "Someone";
    const text = toPlainLine(this.renderContent(message));
    this.notifications.emit({
      title: server ? `${author} in #${channel.name ?? channel.id} (${server.name})` : author,
      body: (text || (message.attachments.length > 0 ? "Sent an attachment" : "New message")).slice(0, 200),
      target: channel.id,
      railKey: server ? server.id : `dm:${channel.id}`,
      inView: this.visible && this.selectedChannelId === channel.id,
    });
  }

  // --- Calls -----------------------------------------------------------------

  /**
   * Joins a DM's or a server channel's call as Nerimity's client does: TURN
   * credentials from the server, then the join with this connection's
   * socket id. The view then connects to each person in the call itself
   * (NativePeerCall), its signals passing through here and the socket. A
   * call rejoined after a reconnect keeps its mute, deafen and camera.
   */
  private async joinVoice(channelId: string, keep?: Pick<NerimityCall, "mute" | "deaf" | "video">): Promise<void> {
    const channel = this.state.channels.get(channelId);
    if (!channel || !TEXT_CHANNEL_TYPES.has(channel.type) || !this.state.canSee(channel) || !this.state.canJoinVoice(channel) || this.voice?.channelId === channelId) return;
    const socketId = this.socket?.id;
    const others = this.state.inCall(channelId).filter((id) => id !== this.state.me?.id).length;
    if (!socketId || others >= MAX_CALL_PARTICIPANTS) {
      this.error = socketId
        ? `This call has ${others} people in it: Multicord connects to each person in a call directly, at most ${MAX_CALL_PARTICIPANTS} with you.`
        : "Not connected to Nerimity; try again in a moment.";
      return this.render();
    }
    if (this.voice) this.leaveVoice(undefined);
    const join = ++this.voiceJoins;
    const voice: NerimityCall = { channelId, callId: String(join), joined: false, mute: keep?.mute ?? false, deaf: keep?.deaf ?? false, video: keep?.video ?? false, relayOnly: this.relayOnly, iceServers: [], signals: [], seq: 0 };
    this.voice = voice;
    this.ringing.delete(channelId);
    this.declined.delete(channelId);
    this.error = undefined;
    this.render();
    try {
      voice.iceServers = await this.iceServers(voice.relayOnly);
      await this.rest.joinVoice(channelId, socketId);
    } catch (error) {
      if (join !== this.voiceJoins) return;
      this.voice = undefined;
      this.error = `Could not join the call: ${messageOf(error)}`;
      return this.render();
    }
    // Given up while the server was being asked: leave there too, unless another call stands now (joining it left this one).
    if (join !== this.voiceJoins) {
      if (!this.voice) await this.rest.leaveVoice(channelId).catch(() => undefined);
      return;
    }
    voice.joined = true;
    this.render();
  }

  /**
   * TURN and STUN servers for a call: Cloudflare's, which Nerimity's server
   * hands out, or the site's own hosts, and nothing else; reused for an
   * hour, as Nerimity's client does. A relay-only call cannot go without a
   * relay; otherwise a call without one may still connect directly.
   */
  private async iceServers(relayOnly: boolean, now: number = Date.now()): Promise<NativeIceServer[]> {
    let servers = this.turn && now - this.turn.at < TURN_REUSE_MS ? this.turn.servers : undefined;
    if (!servers) {
      try {
        servers = iceServersFrom(await this.rest.turnCredentials(), [...CLOUDFLARE_ICE_HOSTS, new URL(this.origin).hostname, new URL(this.cdn).hostname]);
      } catch (error) {
        if (relayOnly) throw error;
        servers = [];
      }
      if (servers.length > 0) this.turn = { servers, at: now };
    }
    if (relayOnly && !hasRelay(servers)) throw new Error(NO_RELAY);
    return servers;
  }

  /** Leaves the call: at once here, then on the server where it was joined. */
  private leaveVoice(error: string | undefined): void {
    const voice = this.voice;
    this.voiceJoins++;
    this.voice = undefined;
    if (error) this.error = error;
    this.render();
    if (voice?.joined) void this.rest.leaveVoice(voice.channelId).catch(() => undefined);
  }

  /** Mute, deafen and camera, which the view applies; Nerimity's server keeps none of them. */
  private setVoiceFlags(flags: { mute: boolean; deaf: boolean; video: boolean }): void {
    if (!this.voice) return;
    Object.assign(this.voice, { mute: flags.mute, deaf: flags.deaf, video: flags.video });
    this.render();
  }

  /** A problem the call survives: shown, with a camera that failed turned off. */
  private voiceNotice(message: string, cameraOff: boolean): void {
    if (!this.voice) return;
    this.error = message;
    if (cameraOff) this.voice.video = false;
    this.render();
  }

  /** The view's signal for one person in the call, passed on over the socket as Nerimity's client sends it (only simple-peer's forms, which voiceSignal() keeps). */
  private sendSignal(to: string, signal: VoiceSignal | MeshSignal): void {
    const voice = this.voice;
    const clean = voiceSignal(signal);
    if (!voice?.joined || !clean || !this.callPeers(voice).peers.some((p) => p.id === to)) return;
    this.socket?.emit("voice:signal_send", { channelId: voice.channelId, toUserId: to, signal: clean });
  }

  /** A signal from someone in the user's call, checked and kept for the view, which gets each once. */
  private receiveSignal(data: unknown): void {
    const voice = this.voice;
    const d = isRecord(data) ? data : {};
    const signal = voiceSignal(d.signal);
    if (!voice || !signal || d.channelId !== voice.channelId || !this.callPeers(voice).peers.some((p) => p.id === d.fromUserId)) return;
    voice.signals.push({ seq: ++voice.seq, from: d.fromUserId as string, signal });
    // Should the view stop taking them, only the latest are kept.
    voice.signals.splice(0, voice.signals.length - MAX_CALL_SIGNALS);
    this.render();
  }

  /** Whether a voice:user_joined starts a DM's call: someone else, in a DM whose call nobody was in. */
  private callStarting(data: unknown): boolean {
    const user = parseVoiceUser(data);
    const channel = user ? this.state.channels.get(user.channelId) : undefined;
    return channel !== undefined && !channel.serverId && user!.userId !== this.state.me?.id && this.state.inCall(channel.id).length === 0;
  }

  /** Someone joined or left a call (the session's state already has it). */
  private onVoiceUser(name: string, data: unknown, starting: boolean): void {
    const user = parseVoiceUser(data);
    if (!user) return;
    const voice = this.voice;
    const me = this.state.me?.id;
    if (starting) {
      this.ringing.add(user.channelId);
      this.incomingCalls.emit({ conversationKey: user.channelId, from: this.person(user.userId, undefined).name, video: false });
    }
    if (name === "voice:user_left") {
      if (this.state.inCall(user.channelId).every((id) => id === me)) {
        this.ringing.delete(user.channelId);
        this.declined.delete(user.channelId);
      }
      // Gone from the call on the server (it was joined elsewhere, or ended): over here too.
      if (user.userId === me && voice?.joined && voice.channelId === user.channelId) {
        this.voice = undefined;
        this.voiceJoins++;
      }
    } else if (user.userId === me && voice?.channelId === user.channelId && !voice.existing) {
      voice.existing = new Set(this.state.inCall(user.channelId).filter((id) => id !== me));
    }
    // The view opens and drops connections as people come and go: at once, not with the next update.
    if (voice?.channelId === user.channelId || starting) this.render();
  }

  /** Declines a DM call ringing for the user: Nerimity has no such answer, so it only stops ringing here, until the next call there. */
  private declineCall(channelId: string): void {
    if (!this.ringing.has(channelId)) return;
    this.declined.add(channelId);
    this.render();
  }

  /** A DM call ringing for the user: one that started while signed in, with someone in it, neither joined nor declined. */
  private incomingCall(): NativeIncomingCall | undefined {
    const me = this.state.me?.id;
    for (const channelId of this.ringing) {
      const caller = this.state.inCall(channelId).find((id) => id !== me);
      if (caller && !this.declined.has(channelId)) return { channelId, from: this.person(caller, undefined).name };
    }
    return undefined;
  }

  /** Someone in a call as the view shows them: their name where the call is, and their picture. */
  private person(id: string, serverId: string | undefined): { name: string; avatarUrl?: string } {
    const user = this.state.users.get(id);
    if (!user) return { name: "Someone" };
    const avatarUrl = this.avatarUrl(user);
    return avatarUrl ? { name: this.authorName(user, serverId), avatarUrl } : { name: this.authorName(user, serverId) };
  }

  /** The others in the user's call the view connects to (the first who joined, up to the cap), and how many more there are. */
  private callPeers(voice: NerimityCall): { peers: NativeCallPeer[]; over: number } {
    const others = this.state.inCall(voice.channelId).filter((id) => id !== this.state.me?.id);
    const serverId = this.state.channels.get(voice.channelId)?.serverId;
    const peers = others.slice(0, MAX_CALL_PARTICIPANTS - 1).map((id) => ({ id, ...this.person(id, serverId), offer: voice.existing !== undefined && !voice.existing.has(id) }));
    return { peers, over: others.length - peers.length };
  }

  /** Who is in a conversation's call, for its sidebar row; Nerimity does not say who is muted or on camera. */
  private callMembers(channel: NerimityChannel): NativeVoiceMember[] {
    return this.state
      .inCall(channel.id)
      .slice(0, CALL_MEMBERS_SHOWN)
      .map((id) => ({ ...this.person(id, channel.serverId), muted: false, video: false }));
  }

  private voiceSession(): NativeVoiceSession | null {
    const voice = this.voice;
    if (!voice) return null;
    const channel = this.state.channels.get(voice.channelId);
    const server = channel?.serverId ? this.state.servers.get(channel.serverId) : undefined;
    const session: NativeVoiceSession = { channelId: voice.channelId, channelName: channel ? this.channelTitle(channel) : "Call", guildName: server?.name ?? "", mute: voice.mute, deaf: voice.deaf, video: voice.video, stream: false };
    if (voice.joined) {
      const { peers, over } = this.callPeers(voice);
      session.p2p = { callId: voice.callId, self: this.state.me!.id, peers, iceServers: voice.iceServers, relayOnly: voice.relayOnly, signals: voice.signals, ...(over > 0 ? { over } : {}) };
    }
    return session;
  }

  // --- Members and profiles --------------------------------------------------

  /** A member row: nickname, picture, presence, the colour of their highest coloured role, and how to mention them. */
  private memberRow(user: NerimityUser, member?: NerimityMember): NativeMember {
    const row: NativeMember = { id: user.id, name: member?.nickname ?? displayName(user), mention: `[@:${user.id}]`, presence: presenceOf(this.state.presence.get(user.id)) };
    const avatar = this.avatarUrl(user);
    if (avatar) row.avatarUrl = avatar;
    const color = member ? this.memberRoles(member).find((r) => r.color)?.color : undefined;
    if (color) row.color = color;
    if (user.bot) row.status = "Bot";
    return row;
  }

  /** A member's roles, highest first. */
  private memberRoles(member: NerimityMember): NerimityRole[] {
    return (this.state.roles.get(member.serverId) ?? []).filter((r) => member.roleIds.includes(r.id)).sort((a, b) => b.order - a.order);
  }

  /**
   * The member panel's list, as Nerimity's own: online members under their
   * highest role that is not hidden, then "Offline"; a DM's two people.
   * The session carries every member, so there is nothing to page.
   */
  private memberView(channel: NerimityChannel): NativeMemberList | undefined {
    if (!this.membersOpen) return undefined;
    if (!channel.serverId) {
      const recipient = this.state.inbox.get(channel.id)?.recipient;
      const people = [this.state.me, recipient].flatMap((u) => u ?? []);
      return { sections: [{ name: "Members", members: people.map((u) => this.memberRow(u)) }], hasMore: false, loading: false };
    }
    const all = [...(this.state.members.get(channel.serverId)?.values() ?? [])];
    const listed = all.slice(0, MAX_MEMBERS);
    const shown = (this.state.roles.get(channel.serverId) ?? []).filter((r) => !r.hidden).sort((a, b) => b.order - a.order);
    const rows = new Map<string, NativeMember[]>([...shown.map((r): [string, NativeMember[]] => [r.id, []]), ["online", []], ["offline", []]]);
    for (const member of listed) {
      const row = this.memberRow(member.user, member);
      const section = row.presence === "offline" ? "offline" : (this.memberRoles(member).find((r) => !r.hidden)?.id ?? "online");
      rows.get(section)!.push(row);
    }
    const sections = [...shown.map((r) => ({ name: r.name, members: rows.get(r.id)! })), { name: "Online", members: rows.get("online")! }, { name: "Offline", members: rows.get("offline")! }].filter((s) => s.members.length > 0);
    const view: NativeMemberList = { sections, hasMore: false, loading: false };
    if (all.length > listed.length) view.more = all.length - listed.length;
    return view;
  }

  /** A profile card from what the session knows: name, username:tag, presence, and roles in the open server. */
  private showProfile(id: string): void {
    const user = this.state.users.get(id);
    if (!user) return;
    const serverId = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId)?.serverId : undefined;
    const member = serverId ? this.state.members.get(serverId)?.get(id) : undefined;
    const profile: NativeProfile = { id, name: member?.nickname ?? displayName(user), username: `${user.username}:${user.tag}`, presence: presenceOf(this.state.presence.get(id)) };
    const avatar = this.avatarUrl(user);
    if (avatar) profile.avatarUrl = avatar;
    if (user.bot) profile.status = "Bot";
    const roles = member ? this.memberRoles(member) : [];
    if (roles.length > 0) profile.roles = roles.map((r) => ({ name: r.name, ...(r.color ? { color: r.color } : {}) }));
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

  /** Someone's name where they wrote: their nickname in that server, else their username as last heard of. */
  private authorName(user: NerimityUser, serverId: string | undefined): string {
    const member = serverId ? this.state.members.get(serverId)?.get(user.id) : undefined;
    return member?.nickname ?? displayName(this.state.users.get(user.id) ?? user);
  }

  private avatarUrl(user: NerimityUser): string | undefined {
    const avatar = (this.state.users.get(user.id) ?? user).avatar;
    return avatar ? `${this.cdn}/${avatar}` : undefined;
  }

  railServers(): RailServer[] {
    return this.state.orderedServers().map((server) => ({
      key: server.id,
      account: this.account,
      name: server.name,
      iconUrl: server.avatar ? `${this.cdn}/${server.avatar}` : undefined,
      unread: this.state.serverUnread(server.id),
      mentions: this.state.serverMentions(server.id),
    }));
  }

  private channelTitle(channel: NerimityChannel): string {
    if (channel.serverId) return channel.name ?? channel.id;
    const recipient = this.state.inbox.get(channel.id)?.recipient;
    return recipient ? displayName(this.state.users.get(recipient.id) ?? recipient) : "Direct message";
  }

  private dmAvatar(channel: NerimityChannel): string | undefined {
    const recipient = this.state.inbox.get(channel.id)?.recipient;
    return recipient && this.avatarUrl(recipient);
  }

  directs(): DirectConversation[] {
    return this.state.dms().map(({ channel }) => {
      const direct: DirectConversation = {
        key: channel.id,
        account: this.account,
        title: this.channelTitle(channel),
        avatarUrl: this.dmAvatar(channel),
        lastActivity: channel.lastMessagedAt ?? 0,
        unread: this.state.isUnread(channel),
        mentions: this.state.mentions(channel.id),
      };
      // The session carries no message text; the preview is known once the last message has arrived or been loaded.
      const last = this.state.latest.get(channel.id);
      if (last && last.createdAt >= (channel.lastMessagedAt ?? 0)) direct.preview = this.previewText(last);
      return direct;
    });
  }

  /** One line for the Messages list: the text with mentions resolved, else the attachments. */
  private previewText(message: NerimityMessage): string {
    return toPlainLine(this.renderContent(message)) || (message.attachments.length > 0 ? "📎 Attachment" : "");
  }

  /** What a message's mentions and quotes name, from the session and the message itself. */
  private names(message: NerimityMessage, depth = 0): MarkupNames {
    const serverId = this.state.channels.get(message.channelId)?.serverId;
    return {
      user: (id) => {
        const user = this.state.users.get(id);
        return user && this.authorName(user, serverId);
      },
      channel: (id) => this.state.channels.get(id)?.name,
      role: (id) => [...this.state.roles.values()].flat().find((r) => r.id === id)?.name,
      // Quotes inside quotes are left out, as in Nerimity's own client.
      quote: (id) => {
        const quote = depth === 0 ? message.quotes.find((q) => q.id === id) : undefined;
        if (!quote) return undefined;
        const author = quote.author ? `**${this.authorName(quote.author, serverId)}**: ` : "";
        return author + toMarkdown(quote.content, this.names(message, depth + 1));
      },
    };
  }

  /** A message's text in the view's markdown; system messages say what happened. */
  private renderContent(message: NerimityMessage): string {
    const system = SYSTEM_TEXT[message.type];
    if (system) return `*${system}*`;
    return toMarkdown(message.content, this.names(message));
  }

  private attachmentView(attachment: NerimityMessage["attachments"][number]): NativeAttachment {
    if (!attachment.path || attachment.provider !== "local") {
      return { name: "File on Google Drive", kind: "file", unavailable: "It is stored on Google Drive, which Multicord does not open." };
    }
    const file = attachment.path.split("/").at(-1)!;
    let name: string;
    try {
      name = decodeURIComponent(file);
    } catch {
      name = file;
    }
    const view: NativeAttachment = { name, kind: mediaKind(attachment.mime), url: `${this.cdn}/${attachment.path}` };
    if (attachment.width) view.width = attachment.width;
    if (attachment.height) view.height = attachment.height;
    if (attachment.size) view.size = attachment.size;
    if (attachment.mime) view.mime = attachment.mime;
    return view;
  }

  /** A link preview as a card; its picture comes through the CDN's proxy, as in Nerimity's own client, so it never loads from the linked site. */
  private linkPreview({ image, ...card }: NerimityLinkEmbed): NativeEmbed {
    const embed: NativeEmbed = card;
    if (image) embed.image = { url: `${this.cdn}/proxy/${encodeURIComponent(image.source)}/embed.${image.type}`, width: image.width, height: image.height, thumbnail: image.thumbnail };
    return embed;
  }

  /** A message as the pins list shows it: its text in one line, or that it carries a file. */
  private listedMessage(message: NerimityMessage): NativeListedMessage {
    const serverId = this.state.channels.get(message.channelId)?.serverId;
    const listed: NativeListedMessage = {
      id: message.id,
      author: message.author ? this.authorName(message.author, serverId) : "Deleted user",
      content: this.previewText(message),
      timestamp: new Date(message.createdAt).toISOString(),
    };
    const avatar = message.author && this.avatarUrl(message.author);
    if (avatar) listed.avatarUrl = avatar;
    return listed;
  }

  private viewMessage(message: NerimityMessage): NativeMessage {
    const serverId = this.state.channels.get(message.channelId)?.serverId;
    const author = message.author;
    const mine = author !== undefined && author.id === this.state.me?.id;
    const editable = mine && message.type === MessageType.Content;
    const reply = message.replyTo;
    const view: NativeMessage = {
      id: message.id,
      author: author ? this.authorName(author, serverId) : "Deleted user",
      content: this.renderContent(message),
      timestamp: new Date(message.createdAt).toISOString(),
      edited: message.edited,
      mine,
      canEdit: editable,
      canDelete: mine,
      reactions: message.reactions.map((r) => ({
        key: reactionKey(r),
        label: r.emojiId ? `:${r.name}:` : r.name,
        imageUrl: r.emojiId ? `${this.cdn}/emojis/${emojiFile({ id: r.emojiId, gif: r.gif, webp: r.webp })}` : undefined,
        count: r.count,
        me: r.reacted,
      })),
      attachments: message.attachments.map((a) => this.attachmentView(a)),
    };
    if (message.embed) view.embeds = [this.linkPreview(message.embed)];
    if (message.pinned) view.pinned = true;
    // Nerimity pins the user's words, in a DM by either person, in a server by whoever may manage its channels.
    view.canPin = message.type === MessageType.Content && (!serverId || this.state.canManageChannels(serverId));
    if (author) {
      view.authorId = author.id;
      view.authorMention = `[@:${author.id}]`;
      const avatar = this.avatarUrl(author);
      if (avatar) view.avatarUrl = avatar;
    }
    if (editable) view.source = message.content;
    if (!mine && this.state.mentionsMe(message)) view.mentionsMe = true;
    if (reply) {
      view.reply = {
        id: reply.id,
        author: reply.author ? this.authorName(reply.author, serverId) : "Deleted user",
        content: toMarkdown(reply.content, this.names({ ...message, quotes: [] }, 1)),
        ...(reply.createdAt ? { timestamp: new Date(reply.createdAt).toISOString() } : {}),
      };
    }
    return view;
  }

  /** The open server's custom emoji, for messages and reactions there; none in DMs, where Multicord does not offer another server's. */
  private customEmoji(serverId: string | undefined): NativeCustomEmoji[] {
    const server = serverId ? this.state.servers.get(serverId) : undefined;
    return server
      ? (this.state.emojis.get(server.id) ?? []).map((e) => ({ id: e.id, name: e.name, animated: e.gif, url: `${this.cdn}/emojis/${emojiFile(e)}`, text: emojiMarkup(e), key: `${e.name}:${e.id}`, source: server.name }))
      : [];
  }

  private sidebar(): NativeSidebarItem[] {
    const item = (channel: NerimityChannel, kind: NativeSidebarItem["kind"]): NativeSidebarItem => ({
      id: channel.id,
      name: this.channelTitle(channel),
      kind,
      iconUrl: kind === "dm" ? this.dmAvatar(channel) : undefined,
      unread: kind !== "category" && this.state.isUnread(channel),
      mentions: kind === "category" ? 0 : this.state.mentions(channel.id),
      active: channel.id === this.selectedChannelId,
      // Muted in Nerimity (the channel, or its server); the bell changes the channel's own setting where that can.
      ...(kind === "text" && this.state.isMuted(channel) ? { muted: true } : {}),
      ...(kind === "text" && this.canMute(channel) ? { canMute: true } : {}),
      // Who is in its call, if anyone.
      ...(kind !== "category" && this.state.inCall(channel.id).length > 0 ? { members: this.callMembers(channel) } : {}),
    });
    if (this.selection.kind === "home") return this.state.dms().map(({ channel }) => item(channel, "dm"));
    return this.state
      .serverChannels(this.selection.serverId)
      .filter((c) => c.type === ChannelType.Category || TEXT_CHANNEL_TYPES.has(c.type))
      .map((c) => item(c, c.type === ChannelType.Category ? "category" : "text"));
  }

  private signInPrompt(): NativeViewState {
    const platform = this.deps.def.name;
    const prompt =
      this.screen === "token"
        ? {
            id: TOKEN_PROMPT,
            title: "Sign in with a token",
            description: `Paste a session token from ${platform}'s own app. Multicord checks it with the server first.`,
            fields: [{ name: "token", label: "Token", type: "password" as const, autocomplete: "off" }],
            submit: "Sign in",
            cancel: "Back",
          }
        : {
            id: SIGN_IN_PROMPT,
            title: `Sign in to ${platform}`,
            description: "Use your email address, or your username and tag as name:1234.",
            fields: [
              { name: "identity", label: "Email or username:tag", type: "text" as const, autocomplete: "username" },
              { name: "password", label: "Password", type: "password" as const, autocomplete: "current-password" },
            ],
            submit: "Sign in",
            cancel: "Sign in with a token",
          };
    return { screen: "prompt", platform, prompt, busy: this.busy, error: this.error };
  }

  viewState(): NativeViewState {
    const platform = this.deps.def.name;
    switch (this.screen) {
      case "signin":
      case "token":
        return this.signInPrompt();
      case "connecting": {
        const status = this.queuePosition > 0 ? `Waiting to sign in (${this.queuePosition} ahead)…` : this.connection === "reconnecting" ? "Reconnecting…" : "Connecting…";
        return { screen: "connecting", platform, status };
      }
      case "chat": {
        const channel = this.selectedChannelId ? this.state.channels.get(this.selectedChannelId) : undefined;
        const server = this.selection.kind === "server" ? this.state.servers.get(this.selection.serverId) : undefined;
        const members = channel ? this.memberView(channel) : undefined;
        const ringing = this.incomingCall();
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
                typing: this.state.typingIn(channel.id).map((u) => this.authorName(u, channel.serverId)),
                pending: (this.pending.get(channel.id) ?? []).map((f) => ({ name: f.filename, size: f.size })),
                uploading: this.uploading.has(channel.id),
                ...(this.unreadAt?.channelId === channel.id ? { unread: this.unreadView(channel.id, this.unreadAt.after) } : {}),
                ...(members ? { members } : {}),
                ...(this.pins?.channelId === channel.id ? { pins: this.pins.list } : {}),
                ...(this.search?.channelId === channel.id ? { search: this.search.results } : {}),
                can: { reply: true, react: true, attach: this.deps.files !== undefined, typing: this.typingIndicators, members: true, pins: true, search: true, forward: true, call: this.state.canJoinVoice(channel) },
              }
            : null,
          voice: this.voiceSession(),
          emojiBase: `${this.cdn}/emojis`,
          customEmoji: this.customEmoji(channel?.serverId),
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
    if (state.screen === "chat" && state.voice?.p2p) this.voice!.signals = [];
  }
}
