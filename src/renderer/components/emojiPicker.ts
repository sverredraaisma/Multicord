import { EMOJI, EMOJI_GROUPS, searchEmoji } from "../../shared/emoji";
import type { PickerEmoji } from "../../shared/native";
import { el, setColor } from "./dom";

/** A platform's custom emoji as the pickers show it (customEmojiList in shared/native). */
export type CustomEmoji = Pick<PickerEmoji, "id" | "name" | "animated" | "url" | "source" | "text" | "key">;

export interface PickedEmoji {
  /** What to insert into a message: the emoji itself, or the module's text for a custom one. */
  text: string;
  /** The reaction key: the emoji itself, or the module's key for a custom one. */
  key: string;
}

/** A module's badge: its short label on its colour, as on the rail. */
export interface SourceBadge {
  label: string;
  color: string;
  /** The module's full name, for screen readers and tooltips. */
  name: string;
}

const SEARCH_LIMIT = 120;

/** The module's badge, saying where something comes from. */
export function sourceBadge(doc: Document, badge: SourceBadge): HTMLElement {
  const span = el(doc, "span", "source-badge", badge.label);
  // The module's colour, darkened in CSS so the white label stays readable on any of them.
  setColor(span, "--module-color", badge.color);
  span.title = badge.name;
  span.setAttribute("aria-label", badge.name);
  return span;
}

/** A heading for things from one place: the module's badge and the server or pack name. */
export function sourceHeading(doc: Document, badge: SourceBadge | undefined, place: string): HTMLElement {
  const heading = el(doc, "div", "picker-heading");
  if (badge) heading.append(sourceBadge(doc, badge));
  heading.append(el(doc, "span", "picker-place", place));
  return heading;
}

/**
 * A searchable emoji picker: the platform's custom emoji usable here first,
 * under the server or pack each comes from, then Unicode emoji by group.
 * Search matches shortcodes, names and tags.
 */
export function emojiPicker(doc: Document, onPick: (emoji: PickedEmoji) => void, custom: readonly CustomEmoji[] = [], badge?: SourceBadge): HTMLElement {
  const picker = el(doc, "div", "emoji-picker");
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", "Emoji picker");
  const search = el(doc, "input", "emoji-search");
  search.type = "search";
  search.placeholder = "Search emoji";
  search.setAttribute("aria-label", "Search emoji");
  const tabs = el(doc, "div", "emoji-tabs");
  const grid = el(doc, "div", "emoji-grid");
  let group: number | "custom" = custom.length > 0 ? "custom" : EMOJI_GROUPS[0]!.id;

  const unicodeButton = (unicode: string, name: string, shortcode?: string) => {
    const button = el(doc, "button", "emoji-option", unicode);
    button.title = shortcode ? `:${shortcode}:` : name;
    button.addEventListener("click", () => onPick({ text: unicode, key: unicode }));
    return button;
  };
  const customButton = (emoji: CustomEmoji) => {
    const button = el(doc, "button", "emoji-option custom");
    const from = [emoji.source, badge?.name].filter(Boolean).join(", ");
    button.title = from ? `:${emoji.name}: from ${from}` : `:${emoji.name}:`;
    const img = el(doc, "img");
    img.src = emoji.url;
    img.alt = `:${emoji.name}:`;
    button.append(img);
    button.addEventListener("click", () => onPick({ text: emoji.text, key: emoji.key }));
    return button;
  };
  /** Custom emoji under the place each comes from, in the order the module lists them. */
  const customSections = (emoji: readonly CustomEmoji[]): HTMLElement[] => {
    const places = new Map<string, CustomEmoji[]>();
    for (const e of emoji) places.set(e.source ?? "", [...(places.get(e.source ?? "") ?? []), e]);
    return [...places].flatMap(([place, list]) => [sourceHeading(doc, badge, place || "Custom emoji"), ...list.map(customButton)]);
  };

  const render = () => {
    const query = search.value.trim().toLowerCase();
    let options: HTMLElement[];
    if (query) {
      const customMatches = customSections(custom.filter((e) => e.name.toLowerCase().includes(query)));
      const unicodeMatches = searchEmoji(query, SEARCH_LIMIT).map((e) => unicodeButton(e.unicode, e.name, e.shortcodes[0]));
      options = [...customMatches, ...unicodeMatches];
    } else if (group === "custom") {
      options = customSections(custom);
    } else {
      options = EMOJI.filter((e) => e.group === group).map((e) => unicodeButton(e.unicode, e.name, e.shortcodes[0]));
    }
    grid.replaceChildren(...(options.length > 0 ? options : [el(doc, "p", "emoji-empty", "No emoji found")]));
    for (const tab of tabs.children) tab.classList.toggle("active", !query && (tab as HTMLElement).dataset.group === String(group));
  };

  const tab = (id: number | "custom", label: string, glyph: Node) => {
    const button = el(doc, "button", "emoji-tab");
    button.dataset.group = String(id);
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(glyph);
    button.addEventListener("click", () => {
      group = id;
      search.value = "";
      render();
    });
    tabs.append(button);
  };
  if (custom.length > 0) {
    const img = el(doc, "img");
    img.src = custom[0]!.url;
    img.alt = "";
    tab("custom", badge ? `Custom emoji from ${badge.name}` : "Custom emoji", img);
  }
  for (const g of EMOJI_GROUPS) {
    tab(g.id, g.name, doc.createTextNode(EMOJI.find((e) => e.group === g.id)!.unicode));
  }

  search.addEventListener("input", render);
  picker.append(search, tabs, grid);
  render();
  return picker;
}
