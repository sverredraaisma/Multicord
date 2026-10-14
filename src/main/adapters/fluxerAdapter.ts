import type { DirectConversation, HomeBadge, PlatformAdapter, RailServer } from "../../shared/adapter";
import type { NativeAction, NativeMessage, NativeSidebarItem, NativeViewState } from "../../shared/native";
import { solveAltcha } from "../fluxer/captcha";
import { discoverInstance, type FluxerInstance } from "../fluxer/discovery";
import { FluxerGateway, type GatewayStatus, type SocketFactory } from "../fluxer/gateway";
import { FluxerRest, type LoginResult, type RestOptions } from "../fluxer/rest";
import { FluxerState } from "../fluxer/state";
import { ChannelType, TEXT_CHANNEL_TYPES, displayName, type FluxerChannel, type FluxerMessage } from "../fluxer/types";
import type { PlatformDef } from "../platforms";
import { BaseAdapter } from "./baseAdapter";

export const FOLDER_PREFIX = "folder:";
const PAGE_SIZE = 50;
const PUBLISH_DELAY_MS = 100;
const ACK_DELAY_MS = 750;
const FLUXER_EPOCH = 1420070400000n;

export interface SecretStore {
  load(key: string): string | undefined;
  save(key: string, value: string): void;
  delete(key: string): void;
}

export interface FluxerAdapterDeps {
  def: PlatformDef;
  fetch: typeof fetch;
  createSocket: SocketFactory;
  secrets: SecretStore;
  /** Sends display state to the native view. */
  render(state: NativeViewState): void;
  rest?: Partial<RestOptions>;
  platform?: string;
}

type Selection = { kind: "home" } | { kind: "guild"; guildId: string };

const timestampOf = (id: string | undefined): number => (id ? Number((BigInt(id) >> 22n) + FLUXER_EPOCH) : 0);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Native Fluxer adapter: talks to the Fluxer API from the main process and
 * renders in Multicord's own chat view. Login (with Fluxer's proof-of-work
 * captcha and TOTP), the gateway session and the token all stay here.
 */
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
  private selection: Selection = { kind: "home" };
  private selectedChannelId: string | undefined;
  private readonly lastChannel = new Map<string, string>();
  private readonly hasOlder = new Map<string, boolean>();
  private readonly loading = new Set<string>();
  private readonly expanded = new Set<string>();
  private readonly ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private visible = false;

  constructor(private readonly deps: FluxerAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
    this.state.changed.on(() => this.schedulePublish());
    this.state.incoming.on((message) => {
      if (message.channelId === this.selectedChannelId) this.ackSoon(message.channelId);
      this.notify(message);
    });
  }

  private get secretKey(): string {
    return `fluxer:${this.account.instance}:token`;
  }

  /** Discovers the instance and resumes a saved session, else shows the login screen. */
  async start(): Promise<void> {
    if (!(await this.ensureInstance())) return this.render();
    const token = this.deps.secrets.load(this.secretKey);
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
        return this.send(action.content);
      case "loadOlder":
        return this.loadOlder();
      case "logout":
        return this.logout();
    }
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
      this.deps.secrets.save(this.secretKey, result.token);
      this.openSession(result.token);
      return;
    }
    if (!result.totp) throw new Error("This account needs a security key, which Multicord does not support yet.");
    this.mfaTicket = result.ticket;
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
    this.deps.secrets.delete(this.secretKey);
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
    if (!channel || !TEXT_CHANNEL_TYPES.has(channel.type)) return;
    this.selectedChannelId = channelId;
    this.lastChannel.set(channel.guildId ?? "home", channelId);
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

  private async send(content: string): Promise<void> {
    const channelId = this.selectedChannelId;
    if (!channelId || !this.rest) return;
    const nonce = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
    try {
      const sent = await this.rest.sendMessage(channelId, content, nonce);
      if (sent) this.state.addHistory(channelId, [sent], false);
    } catch (error) {
      this.error = `Message not sent: ${messageOf(error)}`;
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

  /** DMs and mentions notify, like Fluxer's default notification settings. */
  private notify(message: FluxerMessage): void {
    const channel = this.state.channels.get(message.channelId);
    const me = this.state.me;
    if (!channel || !me) return;
    const isDm = channel.type === ChannelType.Dm || channel.type === ChannelType.GroupDm;
    if (!isDm && !message.mentionEveryone && !message.mentionIds.includes(me.id)) return;
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
    return this.state.privateChannels().map((c) => ({
      key: c.id,
      account: this.account,
      title: this.channelTitle(c),
      avatarUrl: this.dmAvatar(c),
      lastActivity: timestampOf(c.lastMessageId),
      unread: this.state.isUnread(c),
      mentions: this.state.mentions(c.id),
    }));
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
    return {
      id: message.id,
      author: displayName(this.state.users.get(message.author.id) ?? message.author),
      avatarUrl: this.iconUrl("avatars", message.author.id, message.author.avatar, 64),
      content: this.renderContent(message.content),
      timestamp: message.timestamp,
      edited: message.edited,
      mine: message.author.id === this.state.me?.id,
      attachments: message.attachments.map((a) => ({
        name: a.filename,
        url: a.url,
        image: Boolean(a.url && a.contentType?.startsWith("image/")),
      })),
    };
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
    return this.state
      .guildChannels(this.selection.guildId)
      .filter((c) => c.type === ChannelType.GuildCategory || TEXT_CHANNEL_TYPES.has(c.type))
      .map((c) => item(c, c.type === ChannelType.GuildCategory ? "category" : "text"));
  }

  viewState(): NativeViewState {
    const platform = this.deps.def.name;
    switch (this.screen) {
      case "login":
        return { screen: "login", platform, identity: this.instance?.identity ?? "email", busy: this.busy, status: this.status, error: this.error };
      case "mfa":
        return { screen: "mfa", platform, busy: this.busy, error: this.error };
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
              }
            : null,
          error: this.error ?? (this.connection === "reconnecting" ? "Connection lost. Reconnecting…" : undefined),
        };
      }
    }
  }

  private render(): void {
    this.deps.render(this.viewState());
  }
}
