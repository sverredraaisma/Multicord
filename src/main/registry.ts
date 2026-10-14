import type { DirectConversation, PlatformAdapter, RailServer } from "../shared/adapter";
import type { RailEntry, RailState } from "../shared/ipc";
import { Emitter } from "./adapters/emitter";

export const HOME_KEY = "home";
export const DM_PREFIX = "dm:";
/** Unread DMs shown as rail bubbles; mentions beyond this fold into the home badge. */
export const MAX_DM_BUBBLES = 10;

interface Registered {
  adapter: PlatformAdapter;
  name: string;
  servers: RailEntry[];
  directs: DirectConversation[];
}

export function railKey(platform: string, local: string): string {
  return `${platform}:${local}`;
}

export function splitRailKey(key: string): { platform: string; local: string } | undefined {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return undefined;
  return { platform: key.slice(0, at), local: key.slice(at + 1) };
}

/**
 * Flattens servers for the rail. A group's own badge only counts while it is
 * collapsed; once expanded its children carry their badges, as in Discord.
 */
export function flattenServers(platform: string, servers: RailServer[]): RailEntry[] {
  const entries: RailEntry[] = [];
  const server = (s: RailServer, parentKey?: string): RailEntry => {
    const entry: RailEntry = {
      key: railKey(platform, s.key),
      platform,
      kind: "server",
      name: s.name,
      iconUrl: s.iconUrl,
      unread: s.unread,
      mentions: s.mentions,
    };
    if (parentKey) entry.parentKey = parentKey;
    return entry;
  };
  for (const s of servers) {
    if (s.kind !== "group") {
      entries.push(server(s));
      continue;
    }
    const key = railKey(platform, s.key);
    const expanded = s.expanded === true;
    entries.push({
      key,
      platform,
      kind: "group",
      name: s.name,
      color: s.color,
      expanded,
      previewIconUrls: s.previewIconUrls ?? [],
      unread: !expanded && s.unread,
      mentions: expanded ? 0 : s.mentions,
    });
    if (expanded) for (const child of s.children ?? []) entries.push(server(child, key));
  }
  return entries;
}

/** Aggregates every adapter into one rail; adding a platform never touches shell code. */
export class PlatformRegistry {
  private readonly platforms = new Map<string, Registered>();
  private readonly changed = new Emitter<RailState>();
  private activeKey: string | null = null;

  async add(adapter: PlatformAdapter, name: string): Promise<void> {
    const registered: Registered = { adapter, name, servers: [], directs: [] };
    this.platforms.set(adapter.platform, registered);
    const applyServers = (servers: RailServer[]): void => {
      registered.servers = flattenServers(adapter.platform, servers);
      this.emit();
    };
    const applyDirects = (directs: DirectConversation[]): void => {
      registered.directs = directs;
      this.emit();
    };
    adapter.onServersChanged(applyServers);
    adapter.onDirectsChanged(applyDirects);
    registered.directs = await adapter.listDirectConversations();
    applyServers(await adapter.listServers());
  }

  onChange(cb: (state: RailState) => void): () => void {
    return this.changed.on(cb);
  }

  state(): RailState {
    const entries: RailEntry[] = [];
    for (const { adapter, name, servers, directs } of this.platforms.values()) {
      if (adapter.openHome) {
        const unreadDms = directs.filter((d) => d.unread).sort((a, b) => b.lastActivity - a.lastActivity);
        const shown = unreadDms.slice(0, MAX_DM_BUBBLES);
        const hidden = unreadDms.slice(MAX_DM_BUBBLES);
        const badge = adapter.homeBadge?.() ?? { unread: false, mentions: 0 };
        const hiddenMentions = hidden.reduce((sum, d) => sum + d.mentions, 0);
        entries.push({
          key: railKey(adapter.platform, HOME_KEY),
          platform: adapter.platform,
          kind: "home",
          name: `${name} direct messages`,
          unread: badge.unread || hidden.length > 0,
          mentions: badge.mentions + hiddenMentions,
        });
        for (const dm of shown) {
          entries.push({
            key: railKey(adapter.platform, DM_PREFIX + dm.key),
            platform: adapter.platform,
            kind: "dm",
            name: dm.title,
            iconUrl: dm.avatarUrl,
            unread: dm.unread,
            mentions: dm.mentions,
          });
        }
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

  /**
   * Routes a rail click to its adapter; returns the platform whose view must
   * be shown. Clicking a group only expands or collapses it.
   */
  async open(key: string): Promise<string | undefined> {
    const parts = splitRailKey(key);
    const registered = parts && this.platforms.get(parts.platform);
    if (!parts || !registered) return undefined;
    const { adapter } = registered;
    if (registered.servers.some((e) => e.key === key && e.kind === "group")) {
      await adapter.toggleGroup?.(parts.local);
      return undefined;
    }
    if (parts.local === HOME_KEY && adapter.openHome) await adapter.openHome();
    else if (parts.local.startsWith(DM_PREFIX)) await adapter.openConversation(parts.local.slice(DM_PREFIX.length));
    else await adapter.openServer(parts.local);
    this.activeKey = key;
    this.emit();
    return parts.platform;
  }

  private emit(): void {
    this.changed.emit(this.state());
  }
}
