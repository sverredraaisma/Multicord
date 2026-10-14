import type { DirectConversation, HealthCheck, HomeBadge, RailServer } from "../../shared/adapter";
import { isSnowflake, type DiscordGuild, type DiscordHealth, type DiscordState, type DiscordTarget, type DiscordUser, type TitleBadge } from "../../shared/ipc";
import type { AccountStatus } from "../../shared/settings";
import { BaseAdapter } from "../../shared/baseAdapter";

export const FOLDER_PREFIX = "folder:";

/**
 * Where a discord:// link (as the official client registers it) points:
 * discord://-/channels/@me, .../@me/<dm>, .../<guild> or .../<guild>/<channel>.
 */
export function discordLinkTarget(url: string): DiscordTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "discord:") return undefined;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "channels" || parts.length > 3) return parts.length === 0 ? "home" : undefined;
  const [, place, channel] = parts;
  if (place === "@me") return channel === undefined ? "home" : isSnowflake(channel) ? `dm:${channel}` : undefined;
  if (!isSnowflake(place)) return undefined;
  if (channel === undefined) return place;
  return isSnowflake(channel) ? `channel:${place}/${channel}` : undefined;
}

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
  private hooks: DiscordHealth | undefined;

  /** `id` tells accounts apart: each Discord account is its own platform instance. */
  constructor(
    private readonly navigate: (target: DiscordTarget) => void,
    id = "discord",
  ) {
    super(id, { platform: id, instance: "discord.com", accountId: "default" });
  }

  update(state: DiscordState): void {
    this.badge = state.badge;
    if (state.health) this.hooks = state.health;
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

  /**
   * The hooks into Discord's page, which a Discord update can break: the
   * hidden guild bar, and each store the bridge reads.
   */
  health(): HealthCheck[] {
    if (!this.hooks) return [{ name: "Discord's page has loaded", ok: false, detail: "Nothing reported yet; open Discord to load it." }];
    const stores = this.hooks.stores;
    const store = (name: string, what: string, detail: string): HealthCheck => ({ name: `${what} (${name})`, ok: stores?.includes(name) === true, detail });
    return [
      { name: "Server list (hidden guild bar)", ok: this.hooks.guildBar, detail: "Servers and unread badges in the rail" },
      { name: "Store bridge", ok: stores !== undefined, detail: "DM bubbles, the Messages list and server names" },
      store("ChannelStore", "Direct messages", "DM bubbles and the Messages list"),
      store("ReadStateStore", "Unread state", "Unread and mention counts for DMs"),
      store("UserStore", "Users", "DM names, avatars and who is signed in"),
      store("GuildStore", "Server names", "Server names and icons"),
      store("SortedGuildStore", "Server folders", "Folders in the rail"),
      store("GuildReadStateStore", "Server unread state", "Badges for servers inside collapsed folders"),
      store("CallStore", "Calls", "Ringing for incoming calls"),
    ];
  }

  /** Known once the store bridge reports; Discord's own client handles signing in. */
  accountStatus(): AccountStatus {
    if (this.user === undefined) return { state: "unknown" };
    return this.user ? { state: "signed-in", name: this.user.name } : { state: "signed-out" };
  }

  async openHome(): Promise<void> {
    this.navigate("home");
  }

  async openLink(url: string): Promise<boolean> {
    const target = discordLinkTarget(url);
    if (target) this.navigate(target);
    return target !== undefined;
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
