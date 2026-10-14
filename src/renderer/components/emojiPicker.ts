import { EMOJI, EMOJI_GROUPS, searchEmoji } from "../../shared/emoji";
import { el } from "./dom";

export interface CustomEmoji {
  id: string;
  name: string;
  animated: boolean;
  url: string;
}

export interface PickedEmoji {
  /** What to insert into a message: the emoji itself, or <:name:id> for custom emoji. */
  text: string;
  /** The reaction key: the emoji itself, or name:id. */
  key: string;
}

const SEARCH_LIMIT = 120;

/**
 * A searchable emoji picker: the platform's custom emoji first, then Unicode
 * emoji by group. Search matches shortcodes, names and tags.
 */
export function emojiPicker(doc: Document, onPick: (emoji: PickedEmoji) => void, custom: CustomEmoji[] = []): HTMLElement {
  const picker = el(doc, "div", "emoji-picker");
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", "Emoji picker");
  const search = el(doc, "input", "emoji-search");
  search.type = "search";
  search.placeholder = "Search emoji";
  search.setAttribute("aria-label", "Search emoji");
  const tabs = el(doc, "div", "emoji-tabs");
  const grid = el(doc, "div", "emoji-grid");
  let group: number | "custom" = custom.length > 0 ? "custom" : (EMOJI_GROUPS[0]?.id ?? 0);

  const unicodeButton = (unicode: string, name: string, shortcode?: string) => {
    const button = el(doc, "button", "emoji-option", unicode);
    button.title = shortcode ? `:${shortcode}:` : name;
    button.addEventListener("click", () => onPick({ text: unicode, key: unicode }));
    return button;
  };
  const customButton = (emoji: CustomEmoji) => {
    const button = el(doc, "button", "emoji-option custom");
    button.title = `:${emoji.name}:`;
    const img = el(doc, "img");
    img.src = emoji.url;
    img.alt = `:${emoji.name}:`;
    button.append(img);
    button.addEventListener("click", () =>
      onPick({ text: `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`, key: `${emoji.name}:${emoji.id}` }),
    );
    return button;
  };

  const render = () => {
    const query = search.value.trim().toLowerCase();
    let options: HTMLElement[];
    if (query) {
      const customMatches = custom.filter((e) => e.name.toLowerCase().includes(query)).map(customButton);
      const unicodeMatches = searchEmoji(query, SEARCH_LIMIT).map((e) => unicodeButton(e.unicode, e.name, e.shortcodes[0]));
      options = [...customMatches, ...unicodeMatches];
    } else if (group === "custom") {
      options = custom.map(customButton);
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
    tab("custom", "Server emoji", img);
  }
  for (const g of EMOJI_GROUPS) {
    tab(g.id, g.name, doc.createTextNode(EMOJI.find((e) => e.group === g.id)?.unicode ?? "?"));
  }

  search.addEventListener("input", render);
  picker.append(search, tabs, grid);
  render();
  return picker;
}
