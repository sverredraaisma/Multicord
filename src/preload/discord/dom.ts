// Reads Discord's guild bar from the DOM and drives navigation through it.
// The guild bar stays rendered but hidden, so its items remain the source of
// truth and clicking them goes through Discord's own router.
//
// Selectors here are the hooks most likely to break when Discord ships a
// redesign; keep them in this file so a health check can target them.

import { isSnowflake, parseTitleBadge, type DiscordGuild, type DiscordState, type DiscordTarget } from "../../shared/ipc";

export const GUILD_ITEM_PREFIX = "guildsnav___";
export const STYLE_ID = "multicord-style";

export const HIDE_GUILD_BAR_CSS = `
nav[class*="guilds_"] { display: none !important; }
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

export function readGuilds(doc: Document): DiscordGuild[] {
  const guilds = new Map<string, DiscordGuild>();
  for (const item of doc.querySelectorAll(`[data-list-item-id^="${GUILD_ITEM_PREFIX}"]`)) {
    const id = item.getAttribute("data-list-item-id")!.slice(GUILD_ITEM_PREFIX.length);
    if (!isSnowflake(id) || guilds.has(id)) continue;
    const parsed = parseGuildLabel(item.getAttribute("aria-label") ?? "");
    const icon = item.querySelector("img")?.getAttribute("src") ?? undefined;
    const mentions = Math.max(parsed.mentions, badgeCount(item));
    guilds.set(id, {
      id,
      name: parsed.name || id,
      iconUrl: icon?.startsWith("https://") ? icon : undefined,
      unread: parsed.unread || mentions > 0,
      mentions,
    });
  }
  return [...guilds.values()];
}

export function readState(doc: Document): DiscordState {
  return { guilds: readGuilds(doc), badge: parseTitleBadge(doc.title) };
}

export function targetPath(target: DiscordTarget): string {
  return target === "home" ? "/channels/@me" : `/channels/${target}`;
}

/**
 * Navigates without reloading: clicks the hidden guild bar item so Discord's
 * router handles it, else falls back to pushState plus popstate.
 */
export function navigate(doc: Document, win: Window, target: DiscordTarget): "click" | "history" {
  const item = doc.querySelector<HTMLElement>(`[data-list-item-id="${GUILD_ITEM_PREFIX}${target}"]`);
  if (item) {
    item.click();
    return "click";
  }
  win.history.pushState({}, "", targetPath(target));
  win.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  return "history";
}
