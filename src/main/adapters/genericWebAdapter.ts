import type { RailServer } from "../../shared/adapter";
import { parseTitleBadge } from "../../shared/ipc";
import type { PlatformDef } from "../platforms";
import { BaseAdapter } from "./baseAdapter";

export const APP_KEY = "app";

/** Shallow tier: the whole platform is one rail entry, unread state read from the page title. */
export class GenericWebAdapter extends BaseAdapter {
  readonly capabilities = { directMessages: false, messagePreviews: false, voice: true, screenShare: false };

  constructor(private readonly def: PlatformDef) {
    super(def.id, { platform: def.id, instance: new URL(def.url).host, accountId: "default" });
    this.servers = [this.entry(false, 0)];
  }

  updateTitle(title: string): void {
    const { unread, mentions } = parseTitleBadge(title);
    const current = this.servers[0]!;
    if (current.unread === unread && current.mentions === mentions) return;
    this.setServers([this.entry(unread, mentions)]);
  }

  async openServer(_key: string): Promise<void> {
    // Showing the view is enough; the shell does that.
  }

  async openConversation(_key: string): Promise<void> {
    throw new Error(`${this.def.name} conversations are not supported in web view mode`);
  }

  private entry(unread: boolean, mentions: number): RailServer {
    return { key: APP_KEY, account: this.account, name: this.def.name, iconUrl: this.def.iconUrl, unread, mentions };
  }
}
