import type { DirectConversation, HomeBadge, RailServer } from "../../shared/adapter";
import { isSnowflake, type DiscordGuild, type DiscordState, type DiscordTarget, type DiscordUser, type TitleBadge } from "../../shared/ipc";
import type { AccountStatus } from "../../shared/settings";
import { BaseAdapter } from "../../shared/baseAdapter";

export const FOLDER_PREFIX = "folder:";

/**
 * Hidden-engine adapter: Discord's web client does all the work; the preload
 * reports its guild bar and DMs, and we send navigation back.
 */
export class DiscordAdapter extends BaseAdapter {
  readonly capabilities = { directMessages: true, messagePreviews: false, voice: true, screenShare: true };
  private badge: TitleBadge = { unread: false, mentions: 0 };
  private directs: DirectConversation[] | undefined;
  private user: DiscordUser | null | undefined;
  /** Channels whose call is ringing us; each call is reported once, when it starts. */
  private ringing = new Set<string>();

  /** `id` tells accounts apart: each Discord account is its own platform instance. */
  constructor(
    private readonly navigate: (target: DiscordTarget) => void,
    id = "discord",
  ) {
    super(id, { platform: id, instance: "discord.com", accountId: "default" });
  }

  update(state: DiscordState): void {
    this.badge = state.badge;
    if (state.user !== undefined) this.user = state.user;
    if (state.calls) {
      const now = new Set(state.calls.map((c) => c.channelId));
      for (const call of state.calls) {
        if (!this.ringing.has(call.channelId)) this.incomingCalls.emit({ conversationKey: call.channelId, from: call.from, video: false });
      }
      this.ringing = now;
    }
    if (state.dms) {
      this.directs = state.dms.map((dm) => ({
        key: dm.id,
        account: this.account,
        title: dm.title,
        avatarUrl: dm.avatarUrl,
        lastActivity: dm.lastActivity,
        unread: dm.unread,
        mentions: dm.mentions,
      }));
      this.directsChanged.emit(this.directs);
    }
    this.setServers(this.toServers(state));
  }

  /** Nests guilds under their folders; a folder sits before `guilds[folder.index]`. */
  private toServers(state: DiscordState): RailServer[] {
    const server = (g: DiscordGuild): RailServer => ({
      key: g.id,
      account: this.account,
      name: g.name,
      iconUrl: g.iconUrl,
      unread: g.unread,
      mentions: g.mentions,
    });
    const folders = state.folders ?? [];
    const groups = new Map<string, RailServer>();
    const servers: RailServer[] = [];
    const placeFolders = (index: number): void => {
      for (const f of folders.filter((folder) => folder.index === index)) {
        const group: RailServer = {
          key: FOLDER_PREFIX + f.id,
          account: this.account,
          name: f.name,
          unread: f.unread,
          mentions: f.mentions,
          kind: "group",
          children: [],
          expanded: f.expanded,
          color: f.color,
          previewIconUrls: f.iconUrls,
        };
        groups.set(f.id, group);
        servers.push(group);
      }
    };
    state.guilds.forEach((g, index) => {
      placeFolders(index);
      const group = g.folderId ? groups.get(g.folderId) : undefined;
      (group?.children ?? servers).push(server(g));
    });
    placeFolders(state.guilds.length);
    return servers;
  }

  async toggleGroup(key: string): Promise<void> {
    const id = key.startsWith(FOLDER_PREFIX) ? key.slice(FOLDER_PREFIX.length) : "";
    if (!isSnowflake(id)) throw new Error(`Not a Discord folder: ${key}`);
    this.navigate(`folder:${id}`);
  }

  override async listDirectConversations(): Promise<DirectConversation[]> {
    return this.directs ?? [];
  }

  /**
   * Mentions not covered by DM bubbles. Once DMs are known they carry their
   * own badges; before that, whatever the title count leaves after guilds.
   */
  homeBadge(): HomeBadge {
    if (this.directs) return { unread: false, mentions: 0 };
    const guildMentions = this.servers.reduce((sum, s) => sum + s.mentions, 0);
    const mentions = Math.max(0, this.badge.mentions - guildMentions);
    return { unread: mentions > 0, mentions };
  }

  /** Known once the store bridge reports; Discord's own client handles signing in. */
  accountStatus(): AccountStatus {
    if (this.user === undefined) return { state: "unknown" };
    return this.user ? { state: "signed-in", name: this.user.name } : { state: "signed-out" };
  }

  async openHome(): Promise<void> {
    this.navigate("home");
  }

  async openServer(key: string): Promise<void> {
    if (!isSnowflake(key)) throw new Error(`Not a Discord guild id: ${key}`);
    this.navigate(key);
  }

  async openConversation(key: string): Promise<void> {
    if (!isSnowflake(key)) throw new Error(`Not a Discord channel id: ${key}`);
    this.navigate(`dm:${key}`);
  }
}
