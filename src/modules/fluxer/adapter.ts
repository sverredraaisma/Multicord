import type { DirectConversation, HomeBadge, PlatformAdapter, RailServer } from "../../shared/adapter";
import {
  MAX_ATTACHMENTS,
  type NativeAction,
  type NativeAttachment,
  type NativeMessage,
  type NativeSidebarItem,
  type NativeViewState,
  type NativeVoiceSession,
  type VoiceNoticeFlag,
} from "../../shared/native";
import type { AccountStatus } from "../../shared/settings";
import type { AsyncSecretStore, FileSource } from "../../engine/runtime";
import { solveAltcha } from "./captcha";
import { discoverInstance, type FluxerInstance } from "./discovery";
import { FluxerGateway, type GatewayStatus, type SocketFactory } from "./gateway";
import { FluxerRest, type LoginResult, type RestOptions } from "./rest";
import { FluxerState, TYPING_MS } from "./state";
import {
  ChannelType,
  FORUM_TYPES,
  MessageType,
  THREAD_TYPES,
  TEXT_CHANNEL_TYPES,
  displayName,
  emojiKey,
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

/** LiveKit wants a ws(s) URL; Fluxer's endpoint may be a bare host. */
export function liveKitUrl(endpoint: string): string {
  return /^(wss?|https?):\/\//.test(endpoint) ? endpoint : `wss://${endpoint}`;
}

interface VoiceConnection {
  guildId: string;
  channelId: string;
  connectionId?: string;
  url?: string;
  token?: string;
  mute: boolean;
  deaf: boolean;
  video: boolean;
  stream: boolean;
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
  files?: { pick(): Promise<FileSource[]> };
}

type Selection = { kind: "home" } | { kind: "guild"; guildId: string };

const timestampOf = (id: string | undefined): number => (id ? Number((BigInt(id) >> 22n) + FLUXER_EPOCH) : 0);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

export class FluxerAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

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
  private readonly loading = new Set<string>();
  private readonly expanded = new Set<string>();
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly typingSent = new Map<string, number>();
  private readonly pending = new Map<string, FileSource[]>();
  /** Whether a session token is stored, so the account shows as signed in before it connects. */
  private hasToken = false;
  private readonly uploading = new Set<string>();
  private voice: VoiceConnection | undefined;
  private voiceTimer: ReturnType<typeof setTimeout> | undefined;
  private visible = false;

  constructor(private readonly deps: FluxerAdapterDeps) {
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

  /** The secret store is this instance's own, so two accounts on one Fluxer instance stay apart. */
  private get secretKey(): string {
    return `${this.account.instance}:token`;
  }

  /** Discovers the instance and resumes a saved session, else shows the login screen. */
  async start(): Promise<void> {
    if (!(await this.ensureInstance())) return this.render();
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
      case "removeAttachment":
        this.pending.get(this.selectedChannelId ?? "")?.splice(action.index, 1);
        return this.render();
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
          if (event === "READY") {
            // A fresh session has no voice connection of ours.
            if (this.voice) this.dropVoice("Voice disconnected when the connection was reset.");
            this.screen = "chat";
            this.render();
          }
          if ((event === "READY" || event === "RESUMED") && this.selection.kind === "guild") this.subscribe(this.selection.guildId);
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
    this.selectedChannelId = channelId;
    this.lastChannel.set(channel.guildId ?? "home", channelId);
    this.error = undefined;
    this.render();
    if (forum) return; // A forum lists its posts; it has no messages of its own.
    if (!this.state.messages.has(channelId)) await this.fetchHistory(channelId, undefined);
    this.ackSoon(channelId);
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
    const nonce = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
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

  // --- Voice -----------------------------------------------------------------

  /**
   * Joins a guild voice channel: op 4 asks the server for a connection, and
   * VOICE_SERVER_UPDATE answers with a LiveKit endpoint and token, which the
   * view uses to carry the audio and video.
   */
  private async joinVoice(channelId: string): Promise<void> {
    const channel = this.state.channels.get(channelId);
    if (!channel?.guildId || channel.type !== ChannelType.GuildVoice || !this.gateway) return;
    if (!this.instance!.voiceEnabled) {
      this.error = `Voice is turned off on this ${this.deps.def.name} instance.`;
      return this.render();
    }
    if (this.voice?.channelId === channelId) return;
    if (this.voice) this.leaveVoice(undefined);
    const mute = false;
    const deaf = false;
    this.voice = { guildId: channel.guildId, channelId, mute, deaf, video: false, stream: false };
    this.error = undefined;
    this.gateway.command(VOICE_STATE_UPDATE, {
      guild_id: channel.guildId,
      channel_id: channelId,
      self_mute: mute,
      self_deaf: deaf,
      self_video: false,
      self_stream: false,
    });
    this.voiceTimer = setTimeout(() => {
      if (this.voice && !this.voice.token) this.leaveVoice("Could not join voice: the server did not answer.");
    }, VOICE_JOIN_TIMEOUT_MS);
    this.render();
  }

  private onVoiceServer(data: unknown): void {
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const voice = this.voice;
    if (!voice || d.channel_id !== voice.channelId) {
      // Only the requesting session gets this event, so it answers a join we have since abandoned: leave it.
      if (typeof d.guild_id === "string" && typeof d.connection_id === "string") {
        this.gateway?.command(VOICE_STATE_UPDATE, { guild_id: d.guild_id, channel_id: null, connection_id: d.connection_id });
      }
      return;
    }
    if (typeof d.token !== "string" || typeof d.endpoint !== "string") return;
    if (typeof d.connection_id === "string") voice.connectionId = d.connection_id;
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
      guild_id: voice.guildId,
      channel_id: voice.channelId,
      connection_id: voice.connectionId,
      self_mute: voice.mute,
      self_deaf: voice.deaf,
      self_video: voice.video,
      self_stream: voice.stream,
    });
    this.render();
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
      this.gateway?.command(VOICE_STATE_UPDATE, { guild_id: voice.guildId, channel_id: null, connection_id: voice.connectionId });
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
      channelName: this.state.channels.get(voice.channelId)?.name ?? "Voice",
      guildName: this.state.guilds.get(voice.guildId)?.name ?? "",
      url: voice.url,
      token: voice.token,
      mute: voice.mute,
      deaf: voice.deaf,
      video: voice.video,
      stream: voice.stream,
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

  /** Tells others we are typing; Fluxer shows it for ~10 s, so once per 8 s is enough. */
  private async sendTyping(now: number = Date.now()): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest || now - (this.typingSent.get(channelId) ?? -Infinity) < TYPING_REPEAT_MS) return;
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
      .replace(/<#(\d{1,20})>/g, (match, id: string) => {
        const channel = this.state.channels.get(id);
        return channel?.name ? `#${channel.name}` : match;
      });
  }

  private viewMessage(message: FluxerMessage): NativeMessage {
    const mine = message.author.id === this.state.me?.id;
    const editable = message.type === undefined || message.type === MessageType.Default || message.type === MessageType.Reply;
    const reply = message.replyTo;
    return {
      id: message.id,
      author: displayName(this.state.users.get(message.author.id) ?? message.author),
      avatarUrl: this.iconUrl("avatars", message.author.id, message.author.avatar, 64),
      content: this.renderContent(message.content),
      timestamp: message.timestamp,
      edited: message.edited,
      mine,
      canEdit: mine && editable,
      source: mine && editable ? message.content : undefined,
      canDelete: mine,
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
    };
  }

  /** A message's files, stickers and media link previews, as the view shows them. */
  private media(message: FluxerMessage): NativeAttachment[] {
    const files: NativeAttachment[] = message.attachments.map((a) => ({
      name: a.filename,
      kind: mediaKind(a.contentType),
      url: a.url,
      width: a.width,
      height: a.height,
      size: a.size,
      mime: a.contentType,
    }));
    for (const sticker of message.stickers) {
      // Lottie stickers (format 3) cannot be drawn here; their name stands in.
      const lottie = sticker.format === 3;
      files.push({
        name: sticker.name,
        kind: "sticker",
        url: lottie || !this.instance ? undefined : `${this.instance.media}/stickers/${sticker.id}.${sticker.format === 4 ? "gif" : "webp"}?size=160`,
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
    });
    if (this.selection.kind === "home") return this.state.privateChannels().map((c) => item(c, "dm"));
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
          entry.members = this.state.voiceMembers(c.id).map(({ user, state }) => ({
            name: displayName(user),
            avatarUrl: this.iconUrl("avatars", user.id, user.avatar, 64),
            muted: state.selfMute || state.selfDeaf,
            video: state.selfVideo || state.selfStream,
          }));
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
          customEmoji: guild ? (this.state.emojis.get(guild.id) ?? []) : [],
          error: this.error ?? (this.connection === "reconnecting" ? "Connection lost. Reconnecting…" : undefined),
        };
      }
    }
  }

  private render(): void {
    this.deps.render(this.viewState());
  }
}
