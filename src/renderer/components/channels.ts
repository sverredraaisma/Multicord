import type { NativeSidebarItem, NativeVoiceMember } from "../../shared/native";
import { avatar } from "./avatar";
import { countBadge, el } from "./dom";

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
}

/**
 * One sidebar row: a category heading, or a text, thread, forum, voice or DM
 * channel with its unread state, mention badge and (for voice) members.
 */
export function channelItem(doc: Document, item: NativeSidebarItem, handlers: ChannelHandlers): HTMLElement {
  if (item.kind === "category") return el(doc, "li", "category", item.name);
  const li = el(doc, "li");
  const button = el(doc, "button", "channel");
  button.dataset.id = item.id;
  button.classList.add(item.kind);
  button.classList.toggle("active", item.active);
  button.classList.toggle("unread", item.unread);
  if (item.kind === "dm") button.append(avatar(doc, item.iconUrl, item.name));
  button.append(el(doc, "span", "name", `${CHANNEL_PREFIX[item.kind]}${item.name}`));
  const badge = countBadge(doc, item.mentions);
  if (badge) button.append(badge);
  button.addEventListener("click", () => (item.kind === "voice" ? handlers.onJoinVoice(item.id) : handlers.onSelect(item.id)));
  li.append(button);
  if (item.members?.length) li.append(voiceMembers(doc, item.members));
  return li;
}

/** A whole channel list. */
export function channelList(doc: Document, items: NativeSidebarItem[], handlers: ChannelHandlers): HTMLElement[] {
  return items.map((item) => channelItem(doc, item, handlers));
}
