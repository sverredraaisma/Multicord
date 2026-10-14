import type { HomeBadge } from "../../shared/adapter";
import { isSnowflake, type DiscordState, type DiscordTarget, type TitleBadge } from "../../shared/ipc";
import { WebViewAdapter } from "./webViewAdapter";

/**
 * Hidden-engine adapter: Discord's web client does all the work; the preload
 * reports its guild bar and we send navigation back.
 */
export class DiscordAdapter extends WebViewAdapter {
  readonly capabilities = { directMessages: true, messagePreviews: false, voice: true, screenShare: true };
  private badge: TitleBadge = { unread: false, mentions: 0 };

  constructor(private readonly navigate: (target: DiscordTarget) => void) {
    super("discord", { platform: "discord", instance: "discord.com", accountId: "default" });
  }

  update(state: DiscordState): void {
    this.badge = state.badge;
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

  /** The title count covers all mentions; whatever the guilds do not account for are DMs. */
  homeBadge(): HomeBadge {
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

  async openConversation(_key: string): Promise<void> {
    // DM bubbles (study level 2) are the next milestone.
    throw new Error("Discord conversations are not supported yet");
  }
}
