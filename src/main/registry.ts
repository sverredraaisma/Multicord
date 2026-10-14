import type { DirectConversation, PlatformAdapter, PlatformNotification, RailServer } from "../shared/adapter";
import { MAX_RAIL_ORDER, type Conversation, type RailEntry, type RailModule, type RailState } from "../shared/ipc";
import { Emitter } from "../shared/emitter";

export const HOME_KEY = "home";
export const DM_PREFIX = "dm:";
/** Unread DMs shown as rail bubbles; mentions beyond this fold into the home badge. */
export const MAX_DM_BUBBLES = 10;
/** Conversations in the unified Messages list. */
export const MAX_CONVERSATIONS = 500;
const MAX_PREVIEW = 200;

interface Registered {
  adapter: PlatformAdapter;
  name: string;
  module?: RailModule;
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
  /** The user's order of top-level servers and groups, across platforms. */
  private order: string[] = [];

  async add(adapter: PlatformAdapter, name: string, module?: RailModule): Promise<void> {
    const registered: Registered = { adapter, name, module, servers: [], directs: [] };
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
    // Account changes show in the settings page, which follows registry changes.
    adapter.onAccountChanged?.(() => this.emit());
    registered.directs = await adapter.listDirectConversations();
    applyServers(await adapter.listServers());
  }

  onChange(cb: (state: RailState) => void): () => void {
    return this.changed.on(cb);
  }

  getOrder(): string[] {
    return [...this.order];
  }

  /**
   * Sets the user's server order. Keys of servers that are gone are kept, so
   * a server that comes back (e.g. after signing in again) keeps its place.
   */
  setOrder(keys: string[]): void {
    const unique = [...new Set(keys)];
    const listed = new Set(unique);
    this.order = [...unique, ...this.order.filter((k) => !listed.has(k))].slice(0, MAX_RAIL_ORDER);
    this.emit();
  }

  /**
   * The rail: each platform's home and DM bubbles first, then every
   * platform's top-level servers and groups in one list, in the user's order;
   * servers the order does not know yet follow in platform order.
   */
  state(): RailState {
    const entries: RailEntry[] = [];
    const units: RailEntry[][] = [];
    const tag = (entry: RailEntry, module: RailModule | undefined): RailEntry => (module ? { ...entry, module } : entry);
    for (const { adapter, name, module, servers, directs } of this.platforms.values()) {
      if (adapter.openHome) {
        const unreadDms = directs.filter((d) => d.unread).sort((a, b) => b.lastActivity - a.lastActivity);
        const shown = unreadDms.slice(0, MAX_DM_BUBBLES);
        const hidden = unreadDms.slice(MAX_DM_BUBBLES);
        const badge = adapter.homeBadge?.() ?? { unread: false, mentions: 0 };
        const hiddenMentions = hidden.reduce((sum, d) => sum + d.mentions, 0);
        entries.push(tag({
          key: railKey(adapter.platform, HOME_KEY),
          platform: adapter.platform,
          kind: "home",
          name: `${name} direct messages`,
          unread: badge.unread || hidden.length > 0,
          mentions: badge.mentions + hiddenMentions,
        }, module));
        for (const dm of shown) {
          entries.push(tag({
            key: railKey(adapter.platform, DM_PREFIX + dm.key),
            platform: adapter.platform,
            kind: "dm",
            name: dm.title,
            iconUrl: dm.avatarUrl,
            unread: dm.unread,
            mentions: dm.mentions,
          }, module));
        }
      }
      for (const entry of servers) {
        if (entry.parentKey) units.at(-1)!.push(tag(entry, module));
        else units.push([tag(entry, module)]);
      }
    }
    const rank = new Map(this.order.map((key, index) => [key, index]));
    const position = (unit: RailEntry[], natural: number) => rank.get(unit[0]!.key) ?? this.order.length + natural;
    const ranked = units.map((unit, natural) => ({ unit, at: position(unit, natural) }));
    ranked.sort((a, b) => a.at - b.at);
    for (const { unit } of ranked) entries.push(...unit);
    return { entries, activeKey: this.activeKey };
  }

  /** Every platform's direct conversations in one list, most recently active first. */
  conversations(): Conversation[] {
    const all: Conversation[] = [];
    for (const { adapter, module, directs } of this.platforms.values()) {
      for (const dm of directs) {
        const conversation: Conversation = {
          key: railKey(adapter.platform, DM_PREFIX + dm.key),
          platform: adapter.platform,
          title: dm.title,
          lastActivity: dm.lastActivity,
          unread: dm.unread,
          mentions: dm.mentions,
        };
        if (dm.avatarUrl) conversation.avatarUrl = dm.avatarUrl;
        if (dm.preview) conversation.preview = dm.preview.slice(0, MAX_PREVIEW);
        if (module) conversation.module = module;
        all.push(conversation);
      }
    }
    return all.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, MAX_CONVERSATIONS);
  }

  get activeKeyValue(): string | null {
    return this.activeKey;
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

  /** Opens a notification's conversation; returns the platform whose view must be shown. */
  async openNotification(platform: string, notification: PlatformNotification): Promise<string | undefined> {
    const registered = this.platforms.get(platform);
    if (!registered) return undefined;
    await registered.adapter.openConversation(notification.target);
    if (notification.railKey) this.activeKey = railKey(platform, notification.railKey);
    this.emit();
    return platform;
  }

  private emit(): void {
    this.changed.emit(this.state());
  }
}
