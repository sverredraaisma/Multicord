import { isMemberId, mentionText, type NativeMemberList, type NativeMessage } from "../../shared/native";
import { avatar } from "./avatar";
import { el } from "./dom";

/** Someone the composer can mention, and what it inserts for them. */
export interface MentionCandidate {
  id: string;
  name: string;
  avatarUrl?: string;
  /** The module's mention syntax for them, or their name where it gives none. */
  text: string;
}

/** Most suggestions the popup shows at once. */
export const MAX_MENTION_SUGGESTIONS = 8;
/** Longest name part after "@" that still asks for suggestions. */
const MAX_QUERY = 32;

/**
 * Who can be mentioned in the open conversation: the latest authors first
 * (newest message first), then the member list where the module shows one.
 * Each person once, by id; the user's own messages and rows without a usable
 * id or name are left out.
 */
export function mentionCandidates(messages: readonly NativeMessage[], members: NativeMemberList | undefined): MentionCandidate[] {
  const found = new Map<string, MentionCandidate>();
  const add = (id: unknown, name: unknown, avatarUrl: unknown, mention: unknown) => {
    if (!isMemberId(id) || found.has(id) || typeof name !== "string" || name.trim() === "") return;
    const shown = name.trim().slice(0, 100);
    const candidate: MentionCandidate = { id, name: shown, text: mentionText(mention) ?? shown };
    if (typeof avatarUrl === "string" && avatarUrl !== "") candidate.avatarUrl = avatarUrl;
    found.set(id, candidate);
  };
  for (const message of [...messages].reverse()) if (!message.mine) add(message.authorId, message.author, message.avatarUrl, message.authorMention);
  for (const section of members?.sections ?? []) for (const member of section.members) add(member.id, member.name, member.avatarUrl, member.mention);
  return [...found.values()];
}

/** The "@name" being typed just before the cursor: where its "@" is and what follows it; undefined when none is. */
export function mentionQuery(value: string, cursor: number): { start: number; query: string } | undefined {
  const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, cursor));
  if (!match || match[2]!.length > MAX_QUERY) return undefined;
  return { start: cursor - match[2]!.length - 1, query: match[2]! };
}

/** Candidates whose name (or one of its words) starts with the query, case aside; then those that merely contain it. */
export function matchMentions(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.toLowerCase();
  const starts = (c: MentionCandidate) => c.name.toLowerCase().split(/\s+/).some((word) => word.startsWith(q));
  const first = candidates.filter(starts);
  const rest = candidates.filter((c) => !starts(c) && c.name.toLowerCase().includes(q));
  return [...first, ...rest].slice(0, MAX_MENTION_SUGGESTIONS);
}

/** The id of a suggestion's row, for the composer's aria-activedescendant. */
export const mentionOptionId = (index: number): string => `mention-option-${index}`;

/**
 * The suggestion rows (options of a listbox): picture and name, the active
 * one marked. Pressing a row picks it without taking focus from the composer.
 */
export function mentionOptions(doc: Document, options: readonly MentionCandidate[], active: number, onPick: (candidate: MentionCandidate) => void): HTMLElement[] {
  return options.map((candidate, index) => {
    const row = el(doc, "li", "mention-option");
    row.id = mentionOptionId(index);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === active));
    row.append(avatar(doc, candidate.avatarUrl, candidate.name), el(doc, "span", "mention-name", candidate.name));
    if (candidate.text !== candidate.name) row.append(el(doc, "span", "mention-text", candidate.text));
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      onPick(candidate);
    });
    return row;
  });
}
