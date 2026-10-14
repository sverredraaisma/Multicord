// Reads Discord's guild bar from the DOM and drives navigation through it.
// The guild bar stays rendered but hidden, so its items remain the source of
// truth and clicking them goes through Discord's own router.
//
// Selectors here are the hooks most likely to break when Discord ships a
// redesign; keep them in this file so a health check can target them.

import {
  isSnowflake,
  parseTitleBadge,
  type BridgePayload,
  type DiscordFolder,
  type DiscordGuild,
  type DiscordState,
  type DiscordTarget,
  type GuildInfo,
  type LayoutEntry,
} from "../../shared/ipc";

export const GUILD_ITEM_PREFIX = "guildsnav___";
export const STYLE_ID = "multicord-style";

/** Set on <html> while the view sits beside the unified Messages list. */
export const COMPACT_CLASS = "multicord-compact";

/**
 * Hides the guild bar always, and Discord's sidebar (DM list, channel list
 * and user panel) in compact mode, where the Messages list replaces it.
 */
export const HIDE_GUILD_BAR_CSS = `
nav[class*="guilds_"] { display: none !important; }
html.${COMPACT_CLASS} [class^="sidebar_"], html.${COMPACT_CLASS} [class*=" sidebar_"] { display: none !important; }
`;

const MENTION_PREFIX = /^\s*(\d+)\s+mentions?,\s*/i;
const UNREAD_PREFIX = /^\s*unread,\s*/i;

export function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HIDE_GUILD_BAR_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Parses an item's aria-label such as "unread, 3 mentions, Server". */
export function parseGuildLabel(label: string): { name: string; unread: boolean; mentions: number } {
  let rest = label;
  let unread = false;
  let mentions = 0;
  for (;;) {
    const unreadMatch = UNREAD_PREFIX.exec(rest);
    if (unreadMatch) {
      unread = true;
      rest = rest.slice(unreadMatch[0].length);
      continue;
    }
    const mentionMatch = MENTION_PREFIX.exec(rest);
    if (mentionMatch) {
      mentions = Number(mentionMatch[1]);
      rest = rest.slice(mentionMatch[0].length);
      continue;
    }
    break;
  }
  return { name: rest.trim(), unread: unread || mentions > 0, mentions };
}

function badgeCount(item: Element): number {
  const container = item.closest('[class*="listItem_"]') ?? item;
  const text = container.querySelector('[class*="numberBadge_"]')?.textContent ?? "";
  const value = Number.parseInt(text, 10);
  return Number.isNaN(value) ? 0 : value;
}

/** First non-empty accessible label on or inside a guild item. */
function itemLabel(item: Element): string {
  const candidates = [
    item.getAttribute("aria-label"),
    item.querySelector("[aria-label]")?.getAttribute("aria-label"),
    item.querySelector('[class*="hiddenVisually"]')?.textContent,
  ];
  return candidates.find((c) => c && c.trim() !== "")?.trim() ?? "";
}

/** Name-only fallbacks: the drag-and-drop name on the wrapper, then the icon's alt text. */
function itemName(item: Element): string {
  const dnd = item.closest("[data-dnd-name]") ?? item.querySelector("[data-dnd-name]");
  const candidates = [dnd?.getAttribute("data-dnd-name"), item.querySelector("img")?.getAttribute("alt")];
  return candidates.find((c) => c && c.trim() !== "")?.trim() ?? "";
}

/** Folder guilds are rendered inside `<ul id="folder-items-<folderId>">` while expanded. */
const FOLDER_ITEMS_PREFIX = "folder-items-";
const MAX_PREVIEWS = 4;

type Slot = { type: "guild"; guild: DiscordGuild } | { type: "folder"; id: string; header: Element };

function httpsImages(element: Element): string[] {
  return [...element.querySelectorAll("img")]
    .map((img) => img.getAttribute("src") ?? "")
    .filter((src) => src.startsWith("https://"));
}

function domGuild(item: Element, id: string, info: ReadonlyMap<string, GuildInfo>): DiscordGuild {
  const parsed = parseGuildLabel(itemLabel(item));
  const known = info.get(id);
  const icon = httpsImages(item)[0];
  const mentions = Math.max(parsed.mentions, badgeCount(item));
  const guild: DiscordGuild = {
    id,
    name: known?.name || parsed.name || itemName(item) || id,
    iconUrl: icon ?? known?.iconUrl,
    unread: parsed.unread || mentions > 0,
    mentions,
  };
  const folderId = item.closest(`[id^="${FOLDER_ITEMS_PREFIX}"]`)?.id.slice(FOLDER_ITEMS_PREFIX.length);
  if (isSnowflake(folderId)) guild.folderId = folderId;
  return guild;
}

/**
 * Walks the hidden guild bar in order. Folder headers are recognised by a
 * known folder id or an aria-expanded attribute; ids in `exclude` (unread DM
 * blobs) are skipped.
 */
function scanBar(
  doc: Document,
  exclude: ReadonlySet<string>,
  info: ReadonlyMap<string, GuildInfo>,
  folderIds: ReadonlySet<string>,
): Slot[] {
  const seen = new Set<string>();
  const slots: Slot[] = [];
  for (const item of doc.querySelectorAll(`[data-list-item-id^="${GUILD_ITEM_PREFIX}"]`)) {
    const id = item.getAttribute("data-list-item-id")!.slice(GUILD_ITEM_PREFIX.length);
    if (!isSnowflake(id) || seen.has(id) || exclude.has(id)) continue;
    seen.add(id);
    if (folderIds.has(id) || item.hasAttribute("aria-expanded")) slots.push({ type: "folder", id, header: item });
    else slots.push({ type: "guild", guild: domGuild(item, id, info) });
  }
  return slots;
}

function headerExpanded(header: Element | undefined): boolean | undefined {
  const value = header?.getAttribute("aria-expanded") ?? header?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded");
  return value == null ? undefined : value === "true";
}

interface FolderParts {
  id: string;
  name?: string;
  color?: string;
  expanded: boolean;
  children: DiscordGuild[];
  header?: Element;
  index: number;
}

/** Folder badge: the children's state where known, else what the header shows. */
function makeFolder({ id, name, color, expanded, children, header, index }: FolderParts): DiscordFolder {
  const parsed = header ? parseGuildLabel(itemLabel(header)) : { name: "", unread: false, mentions: 0 };
  const headerMentions = header ? Math.max(parsed.mentions, badgeCount(header)) : 0;
  const childMentions = children.reduce((sum, g) => sum + g.mentions, 0);
  const childNames = children.slice(0, 3).map((g) => g.name).join(", ");
  const childIcons = children.flatMap((g) => (g.iconUrl ? [g.iconUrl] : []));
  const icons = childIcons.length > 0 ? childIcons : header ? httpsImages(header) : [];
  const folder: DiscordFolder = {
    id,
    name: name || parsed.name || childNames || "Folder",
    expanded,
    unread: parsed.unread || headerMentions > 0 || children.some((g) => g.unread),
    mentions: Math.max(headerMentions, childMentions),
    iconUrls: icons.slice(0, MAX_PREVIEWS),
    index,
  };
  if (color) folder.color = color;
  return folder;
}

/** Builds the bar from SortedGuildStore's layout, which also knows collapsed folders' guilds. */
function fromLayout(
  layout: LayoutEntry[],
  slots: Slot[],
  info: ReadonlyMap<string, GuildInfo>,
): { guilds: DiscordGuild[]; folders: DiscordFolder[] } {
  const rendered = new Map<string, DiscordGuild>();
  const headers = new Map<string, Element>();
  for (const slot of slots) {
    if (slot.type === "guild") rendered.set(slot.guild.id, slot.guild);
    else headers.set(slot.id, slot.header);
  }
  // Rendered guilds have live DOM state; the rest fall back to the store.
  const guildOf = (id: string): DiscordGuild => {
    const dom = rendered.get(id);
    if (dom) return { id, name: dom.name, iconUrl: dom.iconUrl, unread: dom.unread, mentions: dom.mentions };
    const known = info.get(id);
    return {
      id,
      name: known?.name || id,
      iconUrl: known?.iconUrl,
      unread: known?.unread ?? (known?.mentions ?? 0) > 0,
      mentions: known?.mentions ?? 0,
    };
  };

  const guilds: DiscordGuild[] = [];
  const folders: DiscordFolder[] = [];
  for (const entry of layout) {
    if (!entry.folderId) {
      guilds.push(...entry.guildIds.map(guildOf));
      continue;
    }
    const folderId = entry.folderId;
    const children = entry.guildIds.map(guildOf);
    const header = headers.get(folderId);
    const expanded = entry.expanded ?? headerExpanded(header) ?? entry.guildIds.some((id) => rendered.has(id));
    folders.push(makeFolder({ id: folderId, name: entry.name, color: entry.color, expanded, children, header, index: guilds.length }));
    if (expanded) guilds.push(...children.map((g) => ({ ...g, folderId })));
  }
  return { guilds, folders };
}

/** Builds the bar from the DOM alone; collapsed folders then only show what their header shows. */
function fromDom(slots: Slot[]): { guilds: DiscordGuild[]; folders: DiscordFolder[] } {
  const guilds: DiscordGuild[] = [];
  const folders: DiscordFolder[] = [];
  for (const slot of slots) {
    if (slot.type === "guild") {
      guilds.push(slot.guild);
      continue;
    }
    const children = slots.flatMap((s) => (s.type === "guild" && s.guild.folderId === slot.id ? [s.guild] : []));
    const expanded = headerExpanded(slot.header) ?? children.length > 0;
    folders.push(makeFolder({ id: slot.id, expanded, children, header: slot.header, index: guilds.length }));
  }
  return { guilds, folders };
}

/** Reads the guild bar's guilds in order, using the DOM only. */
export function readGuilds(
  doc: Document,
  exclude: ReadonlySet<string> = new Set(),
  info: ReadonlyMap<string, GuildInfo> = new Map(),
): DiscordGuild[] {
  return fromDom(scanBar(doc, exclude, info, new Set())).guilds;
}

/**
 * Combines the hidden guild bar with the store bridge: the store gives names,
 * folders and guilds hidden in collapsed folders; the DOM gives live unread
 * state for what is rendered.
 */
export function readState(doc: Document, bridge?: BridgePayload): DiscordState {
  const exclude = new Set(bridge?.dms.map((dm) => dm.id));
  const info = new Map(bridge?.guilds.map((g) => [g.id, g]));
  const layout = bridge?.layout?.length ? bridge.layout : undefined;
  const folderIds = new Set(layout?.flatMap((e) => (e.folderId ? [e.folderId] : [])));
  const slots = scanBar(doc, exclude, info, folderIds);
  const { guilds, folders } = layout ? fromLayout(layout, slots, info) : fromDom(slots);

  const state: DiscordState = { guilds, badge: parseTitleBadge(doc.title) };
  if (bridge) state.dms = bridge.dms;
  if (bridge?.user !== undefined) state.user = bridge.user;
  if (bridge?.calls) state.calls = bridge.calls;
  if (folders.length > 0) state.folders = folders;
  return state;
}

export function targetPath(target: DiscordTarget): string {
  if (target === "home") return "/channels/@me";
  if (target.startsWith("dm:")) return `/channels/@me/${target.slice(3)}`;
  return `/channels/${target}`;
}

/**
 * Navigates without reloading, preferring elements Discord's router already
 * handles: a link to the route (the DM sidebar), then the hidden guild bar
 * item (guilds, home and unread DM blobs), else pushState plus popstate.
 * Folder targets click the hidden folder header, so Discord itself expands
 * or collapses it and remembers the state.
 */
export function navigate(doc: Document, win: Window, target: DiscordTarget): "click" | "history" | "none" {
  if (target.startsWith("folder:")) {
    const header = doc.querySelector<HTMLElement>(`[data-list-item-id="${GUILD_ITEM_PREFIX}${target.slice(7)}"]`);
    header?.click();
    return header ? "click" : "none";
  }
  const path = targetPath(target);
  const itemId = target.startsWith("dm:") ? target.slice(3) : target;
  const element =
    doc.querySelector<HTMLElement>(`a[href="${path}"]`) ??
    doc.querySelector<HTMLElement>(`[data-list-item-id="${GUILD_ITEM_PREFIX}${itemId}"]`);
  if (element) {
    element.click();
    return "click";
  }
  win.history.pushState({}, "", path);
  win.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  return "history";
}
