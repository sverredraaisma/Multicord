import type { MessagesApi } from "../preload/messages";
import type { MessagesState } from "../shared/ipc";
import { conversationItem, filterConversations } from "./components/conversations";
import { el } from "./components/dom";

/** Times like "14:05" or "Tue" go stale; redraw the list this often. */
export const REFRESH_MS = 60_000;

/**
 * The unified Messages page: every platform's direct conversations in one
 * list, most recent first. Picking one opens it beside the list in its
 * platform's view. The search box is built once, so typing survives updates.
 */
export class MessagesPage {
  private state: MessagesState = { conversations: [], activeKey: null };
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: Pick<MessagesApi, "open">,
    private readonly now: () => number = Date.now,
  ) {
    const doc = root.ownerDocument;
    const header = el(doc, "header", "messages-header");
    this.search = el(doc, "input", "messages-search");
    this.search.type = "search";
    this.search.placeholder = "Search conversations";
    this.search.setAttribute("aria-label", "Search conversations");
    this.search.addEventListener("input", () => this.renderList());
    header.append(el(doc, "h1", undefined, "Messages"), this.search);
    this.list = el(doc, "ul", "conversation-list");
    this.list.setAttribute("aria-label", "Direct messages");
    this.empty = el(doc, "p", "messages-empty");
    root.replaceChildren(header, this.list, this.empty);
    this.renderList();
  }

  render(state: MessagesState): void {
    this.state = state;
    this.renderList();
  }

  renderList(): void {
    const doc = this.root.ownerDocument;
    const now = this.now();
    const shown = filterConversations(this.state.conversations, this.search.value);
    this.list.replaceChildren(
      ...shown.map((conversation) =>
        conversationItem(doc, conversation, { active: conversation.key === this.state.activeKey, now, onOpen: (key) => this.api.open(key) }),
      ),
    );
    this.empty.hidden = shown.length > 0;
    this.empty.textContent =
      this.state.conversations.length === 0
        ? "No direct messages yet. Sign in to a service and its conversations show up here, newest first."
        : "No conversations match your search.";
  }
}

export function startMessages(doc: Document, api: MessagesApi): MessagesPage {
  const page = new MessagesPage(doc.getElementById("messages")!, api);
  api.onState((state) => page.render(state));
  doc.defaultView!.setInterval(() => page.renderList(), REFRESH_MS);
  api.ready();
  return page;
}
