import type { NativeViewState } from "../shared/native";
import { el, icon } from "./components/dom";

/** The left arrow of the back button. */
const BACK = "M20 11H7.83L13.42 5.41 12 4 4 12 12 20 13.41 18.59 7.83 13H20V11Z";

/** What the phone's view bridge adds to the chat view's: back presses. */
export interface PaneApi {
  onState(cb: (state: NativeViewState) => void): void;
  /** The system's back: the callback says whether the view used it. */
  onBack(cb: () => boolean): void;
}

/**
 * On a phone the chat view shows one pane at a time: the conversation list,
 * or the open conversation with a back button. Opening a conversation (from
 * the list, or from the shell's drawer through the engine) shows it; back
 * returns to the list. Only the mobile host's bridge has onBack, so the
 * desktop never gets here; native.css styles the panes under `.mobile`.
 */
export function attachMobilePanes(doc: Document, api: PaneApi): { pane(): "list" | "conversation"; showList(): void } {
  const root = doc.documentElement;
  root.classList.add("mobile");
  const back = el(doc, "button", "mobile-back");
  back.type = "button";
  back.setAttribute("aria-label", "Back to conversations");
  back.append(icon(doc, "mobile-back-icon", BACK));
  doc.body.append(back);
  let pane: "list" | "conversation" = "list";
  // One main landmark per pane: the conversation's own on its pane; on the list pane, where the conversation
  // is out of sight, the chat layout (the list's navigation inside it), whose heading is then the main's
  // own, not a banner. The layout is drawn anew with each screen, so this follows every state too.
  const landmarks = (): void => {
    const layout = doc.querySelector(".chat");
    if (!layout) return;
    const header = layout.querySelector(":scope > header");
    if (pane === "list") {
      layout.setAttribute("role", "main");
      layout.setAttribute("aria-label", "Conversations");
      header?.setAttribute("role", "none");
    } else {
      layout.removeAttribute("role");
      layout.removeAttribute("aria-label");
      header?.removeAttribute("role");
    }
  };
  const show = (next: typeof pane): void => {
    pane = next;
    root.dataset.pane = next;
    back.hidden = next !== "conversation";
    landmarks();
  };
  show("list");
  back.addEventListener("click", () => show("list"));
  // A conversation picked from the list: even the one already open shows again.
  doc.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".channels button.channel")) show("conversation");
  });
  let open: string | null = null;
  api.onState((state) => {
    const id = state.screen === "chat" ? (state.channel?.id ?? null) : null;
    landmarks();
    if (id === open) return;
    open = id;
    show(id === null ? "list" : "conversation");
  });
  api.onBack(() => {
    if (pane !== "conversation") return false;
    show("list");
    return true;
  });
  return { pane: () => pane, showList: () => show("list") };
}
