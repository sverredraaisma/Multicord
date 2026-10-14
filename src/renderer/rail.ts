import type { RailEntry, RailState } from "../shared/ipc";
import type { ShellApi } from "../preload/shell";

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 3).map((w) => [...w][0]!.toUpperCase()).join("") || "?";
}

function renderEntry(doc: Document, entry: RailEntry, active: boolean, onOpen: (key: string) => void): HTMLElement {
  const button = doc.createElement("button");
  button.className = "rail-item";
  button.dataset.key = entry.key;
  button.dataset.kind = entry.kind;
  // No title attribute: the shell's tooltip overlay shows the name instead.
  button.setAttribute("aria-label", entry.name);
  button.classList.toggle("active", active);
  button.classList.toggle("unread", entry.unread);

  if (entry.iconUrl) {
    const img = doc.createElement("img");
    img.src = entry.iconUrl;
    img.alt = "";
    button.append(img);
  } else {
    const label = doc.createElement("span");
    label.className = "initials";
    label.textContent = entry.kind === "home" ? "DM" : initials(entry.name);
    button.append(label);
  }

  if (entry.mentions > 0) {
    const badge = doc.createElement("span");
    badge.className = "badge";
    badge.textContent = entry.mentions > 99 ? "99+" : String(entry.mentions);
    button.append(badge);
  }

  button.addEventListener("click", () => onOpen(entry.key));
  return button;
}

function needsSeparator(previous: RailEntry | undefined, entry: RailEntry): boolean {
  if (!previous) return false;
  return previous.platform !== entry.platform || (previous.kind !== "server" && entry.kind === "server");
}

/**
 * Renders the unified rail. Separators mark each change of platform and the
 * step from a platform's home and DM bubbles to its servers.
 */
export function renderRail(root: HTMLElement, state: RailState, onOpen: (key: string) => void): void {
  const doc = root.ownerDocument;
  const children: HTMLElement[] = [];
  let previous: RailEntry | undefined;
  for (const entry of state.entries) {
    if (needsSeparator(previous, entry)) {
      const separator = doc.createElement("hr");
      separator.className = "rail-separator";
      children.push(separator);
    }
    previous = entry;
    children.push(renderEntry(doc, entry, entry.key === state.activeKey, onOpen));
  }
  root.replaceChildren(...children);
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
  root.addEventListener("mouseover", (event) => {
    const item = (event.target as Element).closest(".rail-item");
    if (item === current) return;
    if (!item) return hide();
    current = item;
    const rect = item.getBoundingClientRect();
    tooltip({ text: item.getAttribute("aria-label") ?? "", y: rect.top + rect.height / 2 });
  });
  root.addEventListener("mouseleave", hide);
  root.addEventListener("scroll", hide);
}

export function startRail(doc: Document, api: ShellApi): void {
  const root = doc.getElementById("rail")!;
  attachTooltips(root, (request) => api.tooltip(request));
  api.onRail((state) => renderRail(root, state, (key) => api.open(key)));
  api.ready();
}
