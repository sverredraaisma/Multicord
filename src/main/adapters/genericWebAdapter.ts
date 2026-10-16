import type { HealthCheck, RailServer } from "../../shared/adapter";
import { parseTitleBadge } from "../../shared/ipc";
import type { PlatformDef } from "../../core/platforms";
import { BaseAdapter } from "../../shared/baseAdapter";

export const APP_KEY = "app";

/** How often a web app's service is checked. */
export const SERVICE_CHECK_INTERVAL_MS = 5 * 60_000;

/** A web app's check of its own service: an address on its instance that should answer. */
export interface ServiceCheck {
  /** As Settings > Diagnostics names it, e.g. "Stoat's API answers". */
  name: string;
  url: string;
  /** What stops working while it fails. */
  breaks: string;
  /** Asks the address (the shell's cookie-less reach): the HTTP status, or a rejection when it could not be reached. */
  reach(url: string): Promise<number>;
}

/** Shallow tier: the whole platform is one rail entry, unread state read from the page title. */
export class GenericWebAdapter extends BaseAdapter {
  readonly capabilities = { directMessages: false, messagePreviews: false, voice: true, screenShare: false };
  private checks: HealthCheck[] = [];
  private checkTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly def: PlatformDef,
    private readonly check?: ServiceCheck,
  ) {
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

  /** Starts checking the service, now and every SERVICE_CHECK_INTERVAL_MS, where the module has a check. */
  startChecks(): void {
    if (!this.check || this.checkTimer) return;
    void this.runCheck(this.check);
    this.checkTimer = setInterval(() => void this.runCheck(this.check!), SERVICE_CHECK_INTERVAL_MS);
    this.checkTimer.unref?.();
  }

  override async disconnect(): Promise<void> {
    clearInterval(this.checkTimer);
    this.checkTimer = undefined;
  }

  /** For Settings > Diagnostics: whether the service answered its check last time; nothing before it has. */
  health(): HealthCheck[] {
    return this.checks;
  }

  private async runCheck({ name, url, breaks, reach }: ServiceCheck): Promise<void> {
    try {
      const status = await reach(url);
      // Any answer short of a server error means the service is there.
      this.checks = [status < 500 ? { name, ok: true } : { name, ok: false, detail: `It answered HTTP ${status}. ${breaks}` }];
    } catch (error) {
      this.checks = [{ name, ok: false, detail: `It could not be reached (${error instanceof Error ? error.message : String(error)}). ${breaks}` }];
    }
  }

  private entry(unread: boolean, mentions: number): RailServer {
    return { key: APP_KEY, account: this.account, name: this.def.name, iconUrl: this.def.iconUrl, unread, mentions };
  }
}
