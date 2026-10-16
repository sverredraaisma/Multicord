import type { NativeMember, NativeMemberList, NativePresence, NativeProfile } from "../../shared/native";
import { avatar } from "./avatar";
import { el, setColor } from "./dom";

export const PRESENCE_LABEL: Record<NativePresence, string> = { online: "Online", idle: "Idle", dnd: "Do not disturb", offline: "Offline" };

/** A picture with a presence dot in its corner, when the platform says one. */
export function presenceAvatar(doc: Document, url: string | undefined, name: string, presence: NativePresence | undefined): HTMLElement {
  const holder = el(doc, "span", "presence-avatar");
  holder.append(avatar(doc, url, name));
  if (presence) {
    const dot = el(doc, "span", `presence ${presence}`);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", PRESENCE_LABEL[presence]);
    dot.title = PRESENCE_LABEL[presence];
    holder.append(dot);
  }
  return holder;
}

/** One member: picture with presence, name in their colour, and a status line; a button where it opens their profile. */
export function memberRow(doc: Document, member: NativeMember, onOpen?: (member: NativeMember) => void): HTMLElement {
  const li = el(doc, "li", "member-row");
  const row = onOpen ? el(doc, "button", "member") : el(doc, "div", "member");
  row.dataset.id = member.id;
  const text = el(doc, "span", "member-text");
  const name = el(doc, "span", "member-name", member.name);
  setColor(name, "--member-color", member.color);
  text.append(name);
  if (member.status) text.append(el(doc, "span", "member-status", member.status));
  row.append(presenceAvatar(doc, member.avatarUrl, member.name, member.presence), text);
  if (onOpen) {
    (row as HTMLButtonElement).type = "button";
    row.addEventListener("click", () => onOpen(member));
  }
  li.append(row);
  return li;
}

export interface MemberPanelHandlers {
  /** Opens a member's profile; rows are plain where it is left out. */
  onOpen?(member: NativeMember): void;
  onLoadMore(): void;
}

/**
 * The member panel's contents: a heading and list per section, then what is
 * not listed ("N more"), a "Load more" button while there are further pages,
 * and loading and error notes. The list is bounded by memberList().
 */
export function memberPanel(doc: Document, list: NativeMemberList, handlers: MemberPanelHandlers): HTMLElement[] {
  const parts: HTMLElement[] = [];
  let listed = 0;
  list.sections.forEach((section, index) => {
    const id = `member-section-${index}`;
    const heading = el(doc, "h3", "member-section", `${section.name} — ${section.members.length}`);
    heading.id = id;
    const ul = el(doc, "ul", "member-list");
    ul.setAttribute("aria-labelledby", id);
    ul.append(...section.members.map((m) => memberRow(doc, m, handlers.onOpen)));
    listed += section.members.length;
    parts.push(heading, ul);
  });
  if (list.error) parts.push(el(doc, "p", "member-error", list.error));
  if (list.loading) parts.push(el(doc, "p", "member-note", "Loading members…"));
  else if (listed === 0 && !list.error) parts.push(el(doc, "p", "member-note", "No members to show."));
  if (list.more) parts.push(el(doc, "p", "member-note", `${list.more.toLocaleString("en")} more`));
  if (list.hasMore && !list.loading) {
    const more = el(doc, "button", "member-more", "Load more");
    more.type = "button";
    more.addEventListener("click", () => {
      more.disabled = true;
      handlers.onLoadMore();
    });
    parts.push(more);
  }
  return parts;
}

/** What a profile card shows: the profile, with at least a name. */
export type ProfileCardData = NativeProfile & { name: string; color?: string };

/**
 * A person's profile card: picture with presence, name, username, status,
 * roles and about text, and a close button. A dialog the view places over
 * the conversation; Escape closes it too.
 */
export function profileCard(doc: Document, profile: ProfileCardData, onClose: () => void): HTMLElement[] {
  const close = el(doc, "button", "profile-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", onClose);
  const name = el(doc, "h2", "profile-name", profile.name);
  name.id = "profile-name";
  setColor(name, "--member-color", profile.color);
  const parts: HTMLElement[] = [close, presenceAvatar(doc, profile.avatarUrl, profile.name, profile.presence), name];
  if (profile.username) parts.push(el(doc, "p", "profile-username", profile.username));
  const status = [profile.presence ? PRESENCE_LABEL[profile.presence] : undefined, profile.status].filter(Boolean).join(" · ");
  if (status) parts.push(el(doc, "p", "profile-status", status));
  if (profile.roles?.length) {
    const roles = el(doc, "ul", "profile-roles");
    roles.setAttribute("aria-label", "Roles");
    for (const role of profile.roles) {
      const chip = el(doc, "li", "profile-role", role.name);
      setColor(chip, "--role-color", role.color);
      roles.append(chip);
    }
    parts.push(roles);
  }
  if (profile.about) parts.push(el(doc, "p", "profile-about", profile.about));
  if (profile.loading) parts.push(el(doc, "p", "member-note", "Loading…"));
  return parts;
}
