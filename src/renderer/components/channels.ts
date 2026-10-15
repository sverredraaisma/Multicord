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
}

/**
 * One sidebar row: a category heading, or a text, thread, forum, voice or DM
 * channel with its unread state, mention badge, whether it is muted and (for
 * voice) members. Where the module can mute it, a bell beside it does.
 */
export function channelItem(doc: Document, item: NativeSidebarItem, handlers: ChannelHandlers): HTMLElement {
  if (item.kind === "category") return el(doc, "li", "category", item.name);
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
  if (item.members?.length) li.append(voiceMembers(doc, item.members));
  return li;
}

/** A whole channel list. */
export function channelList(doc: Document, items: NativeSidebarItem[], handlers: ChannelHandlers): HTMLElement[] {
  return items.map((item) => channelItem(doc, item, handlers));
}
