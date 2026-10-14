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
  button.title = entry.name;
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

/** Renders the unified rail; a separator marks each change of platform. */
export function renderRail(root: HTMLElement, state: RailState, onOpen: (key: string) => void): void {
  const doc = root.ownerDocument;
  const children: HTMLElement[] = [];
  let platform: string | undefined;
  for (const entry of state.entries) {
    if (platform !== undefined && entry.platform !== platform) {
      const separator = doc.createElement("hr");
      separator.className = "rail-separator";
      children.push(separator);
    }
    platform = entry.platform;
    children.push(renderEntry(doc, entry, entry.key === state.activeKey, onOpen));
  }
  root.replaceChildren(...children);
}

export function startRail(doc: Document, api: ShellApi): void {
  const root = doc.getElementById("rail")!;
  api.onRail((state) => renderRail(root, state, (key) => api.open(key)));
  api.ready();
}
