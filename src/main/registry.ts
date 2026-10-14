import type { PlatformAdapter, RailServer } from "../shared/adapter";
import type { RailEntry, RailState } from "../shared/ipc";
import { Emitter } from "./adapters/emitter";

export const HOME_KEY = "home";

interface Registered {
  adapter: PlatformAdapter;
  name: string;
  servers: RailEntry[];
}

export function railKey(platform: string, local: string): string {
  return `${platform}:${local}`;
}

export function splitRailKey(key: string): { platform: string; local: string } | undefined {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return undefined;
  return { platform: key.slice(0, at), local: key.slice(at + 1) };
}

/** Aggregates every adapter into one rail; adding a platform never touches shell code. */
export class PlatformRegistry {
  private readonly platforms = new Map<string, Registered>();
  private readonly changed = new Emitter<RailState>();
  private activeKey: string | null = null;

  async add(adapter: PlatformAdapter, name: string): Promise<void> {
    const registered: Registered = { adapter, name, servers: [] };
    this.platforms.set(adapter.platform, registered);
    const apply = (servers: RailServer[]): void => {
      registered.servers = servers.map((s) => ({
        key: railKey(adapter.platform, s.key),
        platform: adapter.platform,
        kind: "server",
        name: s.name,
        iconUrl: s.iconUrl,
        unread: s.unread,
        mentions: s.mentions,
      }));
      this.emit();
    };
    adapter.onServersChanged(apply);
    apply(await adapter.listServers());
  }

  onChange(cb: (state: RailState) => void): () => void {
    return this.changed.on(cb);
  }

  state(): RailState {
    const entries: RailEntry[] = [];
    for (const { adapter, name, servers } of this.platforms.values()) {
      if (adapter.openHome) {
        const badge = adapter.homeBadge?.() ?? { unread: false, mentions: 0 };
        entries.push({
          key: railKey(adapter.platform, HOME_KEY),
          platform: adapter.platform,
          kind: "home",
          name: `${name} direct messages`,
          unread: badge.unread,
          mentions: badge.mentions,
        });
      }
      entries.push(...servers);
    }
    return { entries, activeKey: this.activeKey };
  }

  totals(): { unread: boolean; mentions: number } {
    const entries = this.state().entries;
    return {
      unread: entries.some((e) => e.unread),
      mentions: entries.reduce((sum, e) => sum + e.mentions, 0),
    };
  }

  /** Routes a rail click to its adapter; returns the platform whose view must be shown. */
  async open(key: string): Promise<string | undefined> {
    const parts = splitRailKey(key);
    const registered = parts && this.platforms.get(parts.platform);
    if (!parts || !registered) return undefined;
    const { adapter } = registered;
    if (parts.local === HOME_KEY && adapter.openHome) await adapter.openHome();
    else await adapter.openServer(parts.local);
    this.activeKey = key;
    this.emit();
    return parts.platform;
  }

  private emit(): void {
    this.changed.emit(this.state());
  }
}
