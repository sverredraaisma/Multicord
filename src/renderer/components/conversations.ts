import type { Conversation } from "../../shared/ipc";
import { avatar } from "./avatar";
import { countBadge, el, setColor } from "./dom";
import { formatRecent } from "./format";

/**
 * One row of the unified Messages list: picture, name, the module it comes
 * from, the last message where known, when it was, and unread state.
 */
export function conversationItem(
  doc: Document,
  conversation: Conversation,
  options: { active?: boolean; now?: number; onOpen?: (key: string) => void } = {},
): HTMLLIElement {
  const item = el(doc, "li", "conversation");
  item.dataset.key = conversation.key;
  const button = el(doc, "button", "conversation-button");
  button.type = "button";
  button.classList.toggle("active", options.active === true);
  button.classList.toggle("unread", conversation.unread);
  if (options.active) button.setAttribute("aria-current", "true");

  const main = el(doc, "span", "conversation-main");
  const top = el(doc, "span", "conversation-top");
  top.append(el(doc, "span", "conversation-title", conversation.title));
  if (conversation.module) {
    const module = el(doc, "span", "module-tag", conversation.module.label);
    setColor(module, "--module-color", conversation.module.color);
    top.append(module);
  }
  main.append(top, el(doc, "span", "conversation-preview", conversation.preview ?? ""));

  const meta = el(doc, "span", "conversation-meta");
  const when = el(doc, "time", "conversation-time", conversation.lastActivity > 0 ? formatRecent(conversation.lastActivity, options.now) : "");
  if (conversation.lastActivity > 0) when.dateTime = new Date(conversation.lastActivity).toISOString();
  meta.append(when);
  const badge = countBadge(doc, conversation.mentions, "conversation-badge");
  if (badge) meta.append(badge);
  else if (conversation.unread) meta.append(el(doc, "span", "conversation-dot"));

  button.append(avatar(doc, conversation.avatarUrl, conversation.title), main, meta);
  button.addEventListener("click", () => options.onOpen?.(conversation.key));
  item.append(button);
  return item;
}

/** Conversations whose name or last message contains every word of the query. */
export function filterConversations(conversations: readonly Conversation[], query: string): Conversation[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...conversations];
  return conversations.filter((c) => {
    const haystack = `${c.title} ${c.preview ?? ""} ${c.module?.label ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
