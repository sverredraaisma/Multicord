import type { NativeReaction } from "../../shared/native";
import { el } from "./dom";

/** Reactions offered on a message without opening the full emoji picker. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

/** One reaction chip: emoji (or custom emoji image) and count, highlighted when it is ours. Without onToggle it only shows. */
export function reactionChip(doc: Document, reaction: NativeReaction, onToggle?: (key: string, add: boolean) => void): HTMLElement {
  const button = el(doc, "button", "reaction");
  button.classList.toggle("me", reaction.me);
  button.title = reaction.label;
  if (reaction.imageUrl) {
    const img = el(doc, "img");
    img.src = reaction.imageUrl;
    img.alt = reaction.label;
    button.append(img);
  } else {
    button.append(el(doc, "span", undefined, reaction.label));
  }
  button.append(el(doc, "span", "count", String(reaction.count)));
  if (onToggle) button.addEventListener("click", () => onToggle(reaction.key, !reaction.me));
  else button.disabled = true;
  return button;
}

/**
 * The quick reaction palette; picking an emoji we already used removes it.
 * With onMore, a last button opens the full emoji picker.
 */
export function quickReactions(
  doc: Document,
  reactions: NativeReaction[],
  onToggle: (key: string, add: boolean) => void,
  onMore?: () => void,
): HTMLElement {
  const palette = el(doc, "span", "quick-reactions");
  for (const emoji of QUICK_REACTIONS) {
    const own = reactions.find((r) => r.key === emoji)?.me ?? false;
    const button = el(doc, "button", "reaction", emoji);
    button.addEventListener("click", () => onToggle(emoji, !own));
    palette.append(button);
  }
  if (onMore) {
    const more = el(doc, "button", "reaction more", "…");
    more.title = "More emoji";
    more.setAttribute("aria-label", "More emoji");
    more.addEventListener("click", onMore);
    palette.append(more);
  }
  return palette;
}

/** Whether a reaction key is already ours on this message. */
export function isOwnReaction(reactions: NativeReaction[], key: string): boolean {
  return reactions.some((r) => r.key === key && r.me);
}
