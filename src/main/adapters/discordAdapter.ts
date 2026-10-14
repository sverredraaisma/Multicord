import type { DirectConversation, HomeBadge } from "../../shared/adapter";
import { isSnowflake, type DiscordState, type DiscordTarget, type TitleBadge } from "../../shared/ipc";
import { WebViewAdapter } from "./webViewAdapter";

/**
 * Hidden-engine adapter: Discord's web client does all the work; the preload
 * reports its guild bar and DMs, and we send navigation back.
 */
export class DiscordAdapter extends WebViewAdapter {
  readonly capabilities = { directMessages: true, messagePreviews: false, voice: true, screenShare: true };
  private badge: TitleBadge = { unread: false, mentions: 0 };
  private directs: DirectConversation[] | undefined;

  constructor(private readonly navigate: (target: DiscordTarget) => void) {
    super("discord", { platform: "discord", instance: "discord.com", accountId: "default" });
  }

  update(state: DiscordState): void {
    this.badge = state.badge;
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
    this.setServers(
      state.guilds.map((g) => ({
        key: g.id,
        account: this.account,
        name: g.name,
        iconUrl: g.iconUrl,
        unread: g.unread,
        mentions: g.mentions,
      })),
    );
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
