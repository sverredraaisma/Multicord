import type { NativeSidebarItem, NativeVoiceMember } from "../../shared/native";
import { avatar } from "./avatar";
import { countBadge, el, icon, ICONS } from "./dom";

export const CHANNEL_PREFIX: Record<NativeSidebarItem["kind"], string> = {
  category: "",
  text: "# ",
  thread: "↳ ",
  forum: "☰ ",
  voice: "🔊 ",
  dm: "",
};

/** Who is in a voice channel: avatar, name, muted state and a LIVE tag for video. */
export function voiceMembers(doc: Document, members: NativeVoiceMember[]): HTMLElement {
  const list = el(doc, "ul", "voice-members");
  for (const member of members) {
    const row = el(doc, "li");
    row.classList.toggle("muted", member.muted);
    row.append(avatar(doc, member.avatarUrl, member.name), el(doc, "span", "name", member.name));
    if (member.video) row.append(el(doc, "span", "live", "LIVE"));
    list.append(row);
  }
  return list;
}

export interface ChannelHandlers {
  onSelect(channelId: string): void;
  onJoinVoice(channelId: string): void;
  /** Mutes or unmutes a conversation; without it, rows offer no mute button. */
  onMute?(channelId: string, mute: boolean): void;
  /** Archives or unarchives a conversation; without it, rows offer no archive button. */
  onArchive?(channelId: string, archive: boolean): void;
  /** Accepts an invitation or joins a joinable conversation; without it, such rows offer no button for it. */
  onJoin?(channelId: string): void;
  /** Declines an invitation; without it, invitations offer no Decline. */
  onDecline?(channelId: string): void;
  /** Folds a collapsible category's rows away, or shows them again; without it, categories do not fold. */
  onFold?(categoryId: string, collapsed: boolean): void;
}

/**
 * A category heading. A collapsible one is a button that folds its rows
 * away; folded, it shows whether they hold unread messages and mentions.
 */
function categoryItem(doc: Document, item: NativeSidebarItem, handlers: ChannelHandlers): HTMLElement {
  const li = el(doc, "li", "category");
  if (item.collapsible !== true || !handlers.onFold) {
    li.textContent = item.name;
    return li;
  }
  const collapsed = item.collapsed === true;
  const button = el(doc, "button", "category-toggle");
  button.type = "button";
  button.dataset.id = item.id;
  button.setAttribute("aria-expanded", String(!collapsed));
  button.append(el(doc, "span", "name", item.name));
  if (collapsed) {
    button.classList.toggle("unread", item.unread);
    const badge = countBadge(doc, item.mentions);
    if (badge) button.append(badge);
  }
  button.addEventListener("click", () => handlers.onFold!(item.id, !collapsed));
  li.append(button);
  return li;
}

/**
 * A conversation the user is not in yet: an invitation (who sent it, with
 * Accept and Decline) or one open to join (with Join). Its name is no
 * button, as there is nothing to open before joining.
 */
function offerItem(doc: Document, item: NativeSidebarItem, handlers: ChannelHandlers): HTMLElement {
  const li = el(doc, "li", "offer");
  const invite = typeof item.invite === "object" && item.invite !== null ? item.invite : undefined;
  const text = el(doc, "div", "offer-text");
  text.append(el(doc, "span", "name", `${CHANNEL_PREFIX[item.kind]}${item.name}`));
  if (invite) text.append(el(doc, "span", "offer-from", typeof invite.from === "string" && invite.from.trim() !== "" ? `Invited by ${invite.from.slice(0, 100)}` : "Invitation"));
  const row = el(doc, "div", "offer-row");
  if (item.kind === "dm") row.append(avatar(doc, item.iconUrl, item.name));
  row.append(text);
  const actions = el(doc, "div", "offer-actions");
  const action = (label: string, className: string, run: (channelId: string) => void) => {
    const button = el(doc, "button", className, label);
    button.type = "button";
    button.setAttribute("aria-label", `${label} ${item.name}`);
    button.addEventListener("click", () => run(item.id));
    actions.append(button);
  };
  if (handlers.onJoin) action(invite ? "Accept" : "Join", "offer-accept", handlers.onJoin);
  if (invite && handlers.onDecline) action("Decline", "offer-decline", handlers.onDecline);
  li.append(row, actions);
  return li;
}

/**
 * One sidebar row: a category heading, or a text, thread, forum, voice or DM
 * channel with its unread state, mention badge, whether it is muted and (for
 * voice) members. Where the module can mute it, a bell beside it does, and
 * where it can archive it, an archive button. An invitation or a
 * conversation open to join gets buttons instead.
 */
export function channelItem(doc: Document, item: NativeSidebarItem, handlers: ChannelHandlers): HTMLElement {
  if (item.kind === "category") return categoryItem(doc, item, handlers);
  if (item.invite || item.joinable === true) return offerItem(doc, item, handlers);
  const li = el(doc, "li");
  const button = el(doc, "button", "channel");
  button.dataset.id = item.id;
  button.classList.add(item.kind);
  button.classList.toggle("active", item.active);
  button.classList.toggle("unread", item.unread);
  const muted = item.muted === true;
  button.classList.toggle("muted", muted);
  if (item.kind === "dm") button.append(avatar(doc, item.iconUrl, item.name));
  button.append(el(doc, "span", "name", `${CHANNEL_PREFIX[item.kind]}${item.name}`));
  // Said in words too, not by the dimmed look alone.
  if (muted) {
    const mark = el(doc, "span", "muted-mark");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", "Muted");
    mark.title = "Muted";
    mark.append(icon(doc, "muted-icon", ICONS.bellOff));
    button.append(mark);
  }
  const badge = countBadge(doc, item.mentions);
  if (badge) button.append(badge);
  button.addEventListener("click", () => (item.kind === "voice" ? handlers.onJoinVoice(item.id) : handlers.onSelect(item.id)));
  li.append(button);
  if (item.canMute === true && handlers.onMute) {
    const toggle = el(doc, "button", "mute-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-pressed", String(muted));
    toggle.setAttribute("aria-label", `${muted ? "Unmute" : "Mute"} ${item.name}`);
    toggle.title = muted ? "Unmute notifications" : "Mute notifications";
    toggle.append(icon(doc, "mute-icon", muted ? ICONS.bell : ICONS.bellOff));
    toggle.addEventListener("click", () => handlers.onMute!(item.id, !muted));
    li.classList.add("mutable");
    li.append(toggle);
  }
  if (item.canArchive === true && handlers.onArchive) {
    const archived = item.archived === true;
    const toggle = el(doc, "button", "archive-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-label", `${archived ? "Unarchive" : "Archive"} ${item.name}`);
    toggle.title = archived ? "Move out of the archive" : "Archive";
    toggle.append(icon(doc, "mute-icon", archived ? ICONS.unarchive : ICONS.archive));
    toggle.addEventListener("click", () => handlers.onArchive!(item.id, !archived));
    li.classList.add("archivable");
    li.append(toggle);
  }
  if (item.members?.length) li.append(voiceMembers(doc, item.members));
  return li;
}

/** A whole channel list; a folded category hides the rows under it, except the open conversation. */
export function channelList(doc: Document, items: NativeSidebarItem[], handlers: ChannelHandlers): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let folded = false;
  for (const item of items) {
    if (item.kind === "category") folded = item.collapsible === true && item.collapsed === true && handlers.onFold !== undefined;
    else if (folded && !item.active) continue;
    rows.push(channelItem(doc, item, handlers));
  }
  return rows;
}
