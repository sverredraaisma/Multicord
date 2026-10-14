import type { RailEntry, RailModule } from "../../shared/ipc";
import { countBadge, el, icon, ICONS, initials, setColor } from "./dom";

/**
 * The module a server comes from, as a small coloured dot with the module's
 * initial. The shell only shows it while the icon is hovered; the tooltip
 * spells the module out.
 */
export function moduleLabel(doc: Document, module: RailModule): HTMLElement {
  const label = el(doc, "span", "module-label", module.label.charAt(0).toUpperCase());
  label.dataset.module = module.label;
  label.setAttribute("aria-hidden", "true");
  setColor(label, "--module-color", module.color);
  return label;
}

/** A collapsed group previews up to four member icons in a 2x2 grid; otherwise a folder glyph. */
function groupFace(doc: Document, entry: RailEntry): Element {
  const previews = entry.previewIconUrls ?? [];
  if (entry.expanded || previews.length === 0) return icon(doc, "folder-glyph", ICONS.folder);
  const grid = el(doc, "span", "folder-grid");
  for (const url of previews.slice(0, 4)) {
    const img = el(doc, "img");
    img.src = url;
    img.alt = "";
    grid.append(img);
  }
  return grid;
}

/** Tooltip text: the name, plus which module it comes from. */
export function serverTooltip(entry: Pick<RailEntry, "name" | "module">): string {
  return entry.module ? `${entry.name} · ${entry.module.label}` : entry.name;
}

/**
 * A server, group, home or DM icon as used in the rail: face (image,
 * initials, folder tile or glyph), unread and active state, mention badge
 * and module label.
 */
export function serverIcon(doc: Document, entry: RailEntry, options: { active?: boolean; onOpen?: (key: string) => void } = {}): HTMLButtonElement {
  const button = el(doc, "button", "rail-item");
  button.dataset.key = entry.key;
  button.dataset.kind = entry.kind;
  // No title attribute: the shell's tooltip overlay shows the name instead.
  button.setAttribute("aria-label", entry.name);
  button.dataset.tooltip = serverTooltip(entry);
  button.classList.toggle("active", options.active === true);
  button.classList.toggle("unread", entry.unread);

  if (entry.kind === "group") {
    button.classList.add("rail-folder");
    button.setAttribute("aria-expanded", String(entry.expanded === true));
    setColor(button, "--folder-color", entry.color);
    button.append(groupFace(doc, entry));
  } else if (entry.iconUrl) {
    const img = el(doc, "img");
    img.src = entry.iconUrl;
    img.alt = "";
    button.append(img);
  } else {
    button.append(el(doc, "span", "initials", entry.kind === "home" ? "DM" : initials(entry.name)));
  }

  const badge = countBadge(doc, entry.mentions);
  if (badge) button.append(badge);
  if (entry.module) button.append(moduleLabel(doc, entry.module));
  if (options.onOpen) button.addEventListener("click", () => options.onOpen!(entry.key));
  return button;
}
