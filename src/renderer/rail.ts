import type { RailEntry, RailState } from "../shared/ipc";
import type { ShellApi } from "../preload/shell";
import { countBadge, el, setColor } from "./components/dom";
import { serverIcon } from "./components/serverIcon";

export { initials } from "./components/dom";

const isPersonal = (entry: RailEntry): boolean => entry.kind === "home" || entry.kind === "dm";

/**
 * Separators split each platform's home and DM bubbles, and those from the
 * servers. Servers are one list in the user's order, whatever their
 * platform (their module labels tell them apart), or, when grouped, one
 * run per platform with a separator between runs.
 */
function needsSeparator(previous: RailEntry | undefined, entry: RailEntry, grouped: boolean): boolean {
  if (!previous) return false;
  // Grouped per platform: a separator where the next platform's servers start.
  if (!isPersonal(previous)) return grouped && previous.platform !== entry.platform;
  return !isPersonal(entry) || previous.platform !== entry.platform;
}

/**
 * Renders the unified rail. An expanded group wraps its folder button and
 * members in one tinted container. Top-level servers and groups are marked
 * as draggable units for reordering.
 */
export function renderRail(root: HTMLElement, state: RailState, onOpen: (key: string) => void): void {
  const doc = root.ownerDocument;
  const children: HTMLElement[] = [];
  let previous: RailEntry | undefined;
  let openGroup: HTMLElement | undefined;
  for (const entry of state.entries) {
    const element = serverIcon(doc, entry, { active: entry.key === state.activeKey, onOpen });
    if (entry.parentKey && openGroup?.dataset.group === entry.parentKey) {
      openGroup.append(element);
      continue;
    }
    openGroup = undefined;
    if (needsSeparator(previous, entry, state.grouped === true)) children.push(el(doc, "hr", "rail-separator"));
    previous = entry;
    let unit: HTMLElement = element;
    if (entry.kind === "group" && entry.expanded) {
      openGroup = el(doc, "div", "rail-folder-open");
      openGroup.dataset.group = entry.key;
      setColor(openGroup, "--folder-color", entry.color);
      openGroup.append(element);
      unit = openGroup;
    }
    if (!isPersonal(entry)) {
      unit.dataset.unit = entry.key;
      unit.draggable = true;
    }
    children.push(unit);
  }
  root.replaceChildren(...children);
}

/** The order after moving `dragged` before or after `target`. */
export function moveKey(keys: string[], dragged: string, target: string, after: boolean): string[] {
  if (dragged === target) return keys;
  const rest = keys.filter((k) => k !== dragged);
  const at = rest.indexOf(target);
  if (at < 0) return keys;
  rest.splice(after ? at + 1 : at, 0, dragged);
  return rest;
}

/**
 * Drag-and-drop reordering of top-level servers and groups. Dropping on the
 * upper half of a unit places the dragged one before it, the lower half after.
 */
export function attachReordering(root: HTMLElement, reorder: (keys: string[]) => void): void {
  let dragged: string | undefined;
  const clearMarks = () => {
    for (const marked of root.querySelectorAll(".drop-before, .drop-after")) marked.classList.remove("drop-before", "drop-after");
  };
  const targetOf = (event: DragEvent): { unit: HTMLElement; after: boolean } | undefined => {
    const unit = (event.target as Element).closest<HTMLElement>("[data-unit]");
    if (!unit || !dragged || unit.dataset.unit === dragged) return undefined;
    const rect = unit.getBoundingClientRect();
    return { unit, after: event.clientY > rect.top + rect.height / 2 };
  };

  root.addEventListener("dragstart", (event) => {
    const unit = (event.target as Element).closest<HTMLElement>("[data-unit]");
    if (!unit) return;
    dragged = unit.dataset.unit;
    unit.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", dragged!);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  root.addEventListener("dragover", (event) => {
    const target = targetOf(event);
    if (!target) return;
    event.preventDefault();
    clearMarks();
    target.unit.classList.add(target.after ? "drop-after" : "drop-before");
  });
  root.addEventListener("drop", (event) => {
    const target = targetOf(event);
    if (!target) return;
    event.preventDefault();
    const keys = [...root.querySelectorAll<HTMLElement>(":scope > [data-unit]")].map((u) => u.dataset.unit!);
    reorder(moveKey(keys, dragged!, target.unit.dataset.unit!, target.after));
  });
  root.addEventListener("dragend", () => {
    root.querySelector(".dragging")?.classList.remove("dragging");
    clearMarks();
    dragged = undefined;
  });
}

/**
 * Shows item names on hover. The rail view is only as wide as the rail, so
 * the label is drawn by a separate overlay view in the main process.
 */
export function attachTooltips(root: HTMLElement, tooltip: ShellApi["tooltip"]): void {
  let current: Element | null = null;
  const hide = (): void => {
    if (current === null) return;
    current = null;
    tooltip(null);
  };
  const show = (target: EventTarget | null): void => {
    const item = target instanceof Element ? target.closest<HTMLElement>(".rail-item") : null;
    if (item === current) return;
    if (!item) return hide();
    current = item;
    const rect = item.getBoundingClientRect();
    tooltip({ text: item.dataset.tooltip ?? item.getAttribute("aria-label") ?? "", y: rect.top + rect.height / 2 });
  };
  root.addEventListener("mouseover", (event) => show(event.target));
  root.addEventListener("mouseleave", hide);
  // Keyboard users see the names too: the label follows focus through the rail.
  root.addEventListener("focusin", (event) => show(event.target));
  root.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node && root.contains(event.relatedTarget))) hide();
  });
  root.addEventListener("scroll", hide);
  root.addEventListener("dragstart", hide);
}

/** A rail button for a shell page (settings, Messages): opens it, or goes back when it is open. */
export function attachPageButton(button: HTMLElement, toggle: (open: boolean) => void): (open: boolean) => void {
  let open = false;
  button.addEventListener("click", () => toggle(!open));
  return (next) => {
    open = next;
    button.classList.toggle("active", open);
    button.setAttribute("aria-pressed", String(open));
  };
}

/** Shows the unread state of every direct message on the Messages button. */
export function setMessagesBadge(button: HTMLElement, badge: RailState["messagesBadge"]): void {
  const doc = button.ownerDocument;
  button.querySelector(".badge")?.remove();
  button.classList.toggle("unread", badge?.unread === true);
  const count = countBadge(doc, badge?.mentions ?? 0);
  if (count) button.append(count);
}

export function startRail(doc: Document, api: ShellApi): void {
  const root = doc.getElementById("rail")!;
  const messagesButton = doc.getElementById("messages-button")!;
  const setSettingsOpen = attachPageButton(doc.getElementById("settings-button")!, (open) => api.settings(open));
  const setMessagesOpen = attachPageButton(messagesButton, (open) => api.messages(open));
  for (const area of [root, doc.getElementById("rail-header")!, doc.getElementById("rail-footer")!]) {
    attachTooltips(area, (request) => api.tooltip(request));
  }
  attachReordering(root, (keys) => api.reorder(keys));
  api.onRail((state) => {
    const pageOpen = state.settingsOpen === true || state.messagesOpen === true;
    renderRail(root, { ...state, activeKey: pageOpen ? null : state.activeKey }, (key) => api.open(key));
    setSettingsOpen(state.settingsOpen === true);
    setMessagesOpen(state.messagesOpen === true);
    setMessagesBadge(messagesButton, state.messagesBadge);
  });
  api.ready();
}
