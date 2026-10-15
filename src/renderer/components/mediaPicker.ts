import { mediaUrl, type Favourite, type FavouritesAction, type FavouritesState, type FavouriteKind } from "../../shared/favourites";
import type { NativeGif, NativeGifResults, NativeSticker, NativeStickerPack, PickerEmoji } from "../../shared/native";
import { el } from "./dom";
import { emojiPicker, sourceBadge, sourceHeading, type PickedEmoji, type SourceBadge } from "./emojiPicker";

export type PickerTab = "emoji" | "stickers" | "gifs" | "favourites";
const TABS: { id: PickerTab; label: string }[] = [
  { id: "emoji", label: "Emoji" },
  { id: "stickers", label: "Stickers" },
  { id: "gifs", label: "GIFs" },
  { id: "favourites", label: "Favourites" },
];

/** A GIF (or looping video) seen in the open conversation's messages. */
export interface RecentMedia {
  url: string;
  name: string;
  video: boolean;
}

/** What the picker offers in the open conversation; everything in it is usable there. */
export interface MediaPickerData {
  /** The module this view belongs to, for the badges on its own emoji and stickers. */
  module?: SourceBadge;
  emoji: readonly PickerEmoji[];
  stickers: readonly NativeStickerPack[];
  /** The module sends its own stickers as stickers here. */
  nativeStickers: boolean;
  /** Files may be sent here: favourites, and stickers that cannot go as stickers. */
  files: boolean;
  /** The platform searches GIFs (can.gifs). */
  gifSearch: boolean;
  gifs?: NativeGifResults;
  recent: readonly RecentMedia[];
  favourites?: FavouritesState;
}

export interface MediaPickerHandlers {
  onEmoji(emoji: PickedEmoji): void;
  onSticker(sticker: NativeSticker, pack: NativeStickerPack): void;
  onGif(gif: NativeGif): void;
  onRecent(media: RecentMedia): void;
  onFavourite(item: Favourite): void;
  onSearchGifs(query: string): void;
  onLoadMedia(key: string): void;
  onFavourites(action: FavouritesAction): void;
  onClose(): void;
}

/** Items per row, for moving through them with the arrow keys. */
export const PICKER_COLUMNS = 4;
/** How long typing pauses before a GIF search goes out. */
export const GIF_SEARCH_DELAY_MS = 350;

/** How a sticker goes where it cannot be sent as one. */
export function fallbackNote(format: NativeSticker["format"]): string {
  switch (format) {
    case "lottie":
      return "sent as a still picture";
    case "webm":
      return "sent as a video";
    case "apng":
    case "gif":
      return "sent as an animated picture";
    default:
      return "sent as a picture";
  }
}

/** A picture, or a silent looping video, to show in the picker. */
function thumb(doc: Document, url: string, video: boolean, alt: string): HTMLElement {
  if (video) {
    const clip = el(doc, "video", "picker-media");
    Object.assign(clip, { src: url, autoplay: true, loop: true, muted: true, playsInline: true });
    clip.setAttribute("aria-label", alt);
    return clip;
  }
  const img = el(doc, "img", "picker-media");
  img.src = url;
  img.alt = alt;
  img.loading = "lazy";
  return img;
}

const matches = (query: string, ...texts: (string | undefined)[]): boolean => query === "" || texts.some((t) => t?.toLowerCase().includes(query));

/**
 * The composer's picker: emoji, stickers, GIFs and the user's favourites,
 * each shown with where it comes from (the module's badge and the server
 * or pack, or "Your favourites" with the platform it was saved from).
 * Only what can be used in the open conversation is offered. Updates keep
 * the tab, search and open menus.
 */
export class MediaPicker {
  readonly element: HTMLElement;
  private tab: PickerTab = "emoji";
  private readonly search: HTMLInputElement;
  private readonly tabs: HTMLElement;
  private readonly body: HTMLElement;
  private emojiPane: HTMLElement | undefined;
  private emojiKey = "";
  /** The favourites category shown, or all. */
  private category: string | undefined;
  private managing = false;
  /** The favourite whose menu is open. */
  private menuFor: string | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSearch: string | undefined;

  constructor(
    private readonly doc: Document,
    private readonly handlers: MediaPickerHandlers,
    private data: MediaPickerData,
  ) {
    const root = el(doc, "div", "media-picker");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Emoji, stickers and GIFs");
    root.addEventListener("keydown", (event) => this.onKey(event));
    this.tabs = el(doc, "div", "picker-tabs");
    this.tabs.setAttribute("role", "tablist");
    for (const { id, label } of TABS) {
      const tab = el(doc, "button", "picker-tab", label);
      tab.type = "button";
      tab.id = `picker-tab-${id}`;
      tab.dataset.tab = id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", "picker-panel");
      tab.addEventListener("click", () => this.show(id));
      this.tabs.append(tab);
    }
    this.search = el(doc, "input", "picker-search");
    this.search.type = "search";
    this.search.setAttribute("aria-label", "Search");
    this.search.addEventListener("input", () => {
      this.render();
      if (this.tab === "gifs") this.searchGifsSoon();
    });
    this.body = el(doc, "div", "picker-body");
    this.body.id = "picker-panel";
    this.body.setAttribute("role", "tabpanel");
    root.append(this.tabs, this.search, this.body);
    this.element = root;
    this.render();
  }

  /** New data from the module or the favourites; the tab, search and menus stay. */
  update(data: MediaPickerData): void {
    this.data = data;
    this.render();
  }

  /** Switches tabs; the GIF tab asks the platform for its GIFs the first time. */
  show(tab: PickerTab): void {
    this.tab = tab;
    this.search.value = "";
    this.menuFor = undefined;
    if (tab === "gifs" && this.data.gifSearch && this.lastSearch === undefined) this.searchGifs("");
    this.render();
    this.tabs.querySelector<HTMLElement>(`[data-tab="${tab}"]`)!.focus();
  }

  /** Stops a pending GIF search. */
  close(): void {
    clearTimeout(this.searchTimer);
  }

  private get query(): string {
    return this.search.value.trim().toLowerCase();
  }

  private searchGifsSoon(): void {
    if (!this.data.gifSearch) return;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.searchGifs(this.search.value.trim()), GIF_SEARCH_DELAY_MS);
  }

  private searchGifs(query: string): void {
    this.lastSearch = query;
    this.handlers.onSearchGifs(query);
  }

  private render(): void {
    for (const tab of this.tabs.children) {
      const selected = (tab as HTMLElement).dataset.tab === this.tab;
      tab.setAttribute("aria-selected", String(selected));
      (tab as HTMLElement).tabIndex = selected ? 0 : -1;
    }
    this.body.setAttribute("aria-labelledby", `picker-tab-${this.tab}`);
    // The emoji tab has a search of its own.
    this.search.hidden = this.tab === "emoji";
    this.search.placeholder = this.tab === "gifs" ? "Search GIFs" : `Search ${this.tab}`;
    const focused = this.doc.activeElement;
    const focusKey = focused instanceof HTMLElement && this.body.contains(focused) ? focused.dataset.key : undefined;
    switch (this.tab) {
      case "emoji":
        this.body.replaceChildren(this.emojiTab());
        break;
      case "stickers":
        this.body.replaceChildren(...this.stickerTab());
        break;
      case "gifs":
        this.body.replaceChildren(...this.gifTab());
        break;
      case "favourites":
        this.body.replaceChildren(...this.favouritesTab());
        break;
    }
    // Rebuilt: give focus back to the control that had it.
    if (focusKey) [...this.body.querySelectorAll<HTMLElement>("[data-key]")].find((e) => e.dataset.key === focusKey)?.focus();
  }

  /** Kept across updates unless the emoji change, so its search survives. */
  private emojiTab(): HTMLElement {
    const key = JSON.stringify(this.data.emoji.map((e) => [e.id, e.url, e.source]));
    if (!this.emojiPane || key !== this.emojiKey) {
      this.emojiKey = key;
      this.emojiPane = emojiPicker(this.doc, (picked) => this.handlers.onEmoji(picked), this.data.emoji, this.data.module);
    }
    return this.emojiPane;
  }

  private item(key: string, label: string, media: HTMLElement, onPick: (() => void) | undefined): HTMLButtonElement {
    const button = el(this.doc, "button", "picker-item");
    button.type = "button";
    button.dataset.key = key;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(media);
    if (onPick) button.addEventListener("click", onPick);
    else button.disabled = true;
    return button;
  }

  /** A star that keeps this media as a favourite, or shows it is one. */
  private star(key: string, url: string, kind: FavouriteKind, name: string, place: string | undefined): HTMLButtonElement {
    const saved = this.data.favourites?.items.find((i) => i.origin === url);
    const saving = this.data.favourites?.saving.includes(url) ?? false;
    const star = el(this.doc, "button", "picker-star", saved ? "★" : "☆");
    star.type = "button";
    star.dataset.key = `star:${key}`;
    star.setAttribute("aria-pressed", String(Boolean(saved)));
    star.setAttribute("aria-label", saved ? `Remove ${name} from favourites` : `Add ${name} to favourites`);
    star.title = saving ? "Saving…" : saved ? "Remove from favourites" : "Add to favourites";
    star.disabled = saving;
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      this.handlers.onFavourites(saved ? { type: "remove", id: saved.id } : place ? { type: "add", url, kind, name, place } : { type: "add", url, kind, name });
    });
    return star;
  }

  private cell(button: HTMLElement, star?: HTMLElement): HTMLElement {
    const cell = el(this.doc, "div", "picker-cell");
    cell.append(button);
    if (star) cell.append(star);
    return cell;
  }

  private grid(cells: HTMLElement[]): HTMLElement {
    const grid = el(this.doc, "div", "picker-grid");
    grid.append(...cells);
    return grid;
  }

  private stickerTab(): HTMLElement[] {
    const { module, files, nativeStickers } = this.data;
    const query = this.query;
    const out: HTMLElement[] = [];
    // The module's stickers go as stickers, or as files where files go; nowhere else.
    if (nativeStickers || files) {
      for (const pack of this.data.stickers) {
        const stickers = pack.stickers.filter((s) => matches(query, s.name, s.emoji, pack.name));
        if (stickers.length === 0) continue;
        const heading = sourceHeading(this.doc, module, pack.name);
        if (!nativeStickers) heading.append(el(this.doc, "span", "picker-note", "Sent as pictures here"));
        out.push(heading, this.grid(stickers.map((sticker) => this.stickerCell(sticker, pack))));
      }
    }
    out.push(...this.favouriteSection("sticker"));
    if (out.length === 0) out.push(el(this.doc, "p", "picker-empty", this.emptyText("stickers")));
    return out;
  }

  private stickerCell(sticker: NativeSticker, pack: NativeStickerPack): HTMLElement {
    const key = `sticker:${pack.id}:${sticker.id}`;
    const how = this.data.nativeStickers ? "" : `, ${fallbackNote(sticker.format)}`;
    const label = `${sticker.name} (${pack.name}${this.data.module ? `, ${this.data.module.name}` : ""}${how})`;
    if (!sticker.url) {
      this.handlers.onLoadMedia(sticker.mediaKey!);
      return this.cell(this.item(key, label, el(this.doc, "span", "picker-loading", "…"), undefined));
    }
    const media = thumb(this.doc, sticker.url, sticker.format === "webm", sticker.name);
    const button = this.item(key, label, media, () => this.handlers.onSticker(sticker, pack));
    if (sticker.format === "lottie") button.append(el(this.doc, "span", "picker-tag", "still"));
    // A still of a Lottie sticker is not the sticker: it is not kept.
    const star = sticker.format === "lottie" ? undefined : this.star(key, sticker.url, "sticker", sticker.name, pack.name);
    return this.cell(button, star);
  }

  private gifTab(): HTMLElement[] {
    const { module, gifSearch, gifs, files } = this.data;
    const out: HTMLElement[] = [];
    if (gifSearch) {
      out.push(sourceHeading(this.doc, module, gifs?.query ? `Results for “${gifs.query}”` : "Trending"));
      if (gifs?.error) out.push(el(this.doc, "p", "picker-error", gifs.error));
      else if (!gifs || (gifs.loading && gifs.results.length === 0)) out.push(el(this.doc, "p", "picker-empty", "Loading GIFs…"));
      else if (gifs.results.length === 0) out.push(el(this.doc, "p", "picker-empty", "No GIFs found"));
      else
        out.push(
          this.grid(
            gifs.results.map((gif) => {
              const key = `gif:${gif.id}`;
              const name = gif.name ?? "GIF";
              const button = this.item(key, `${name}${module ? ` (${module.name} GIF search)` : ""}`, thumb(this.doc, gif.preview, gif.video, name), () => this.handlers.onGif(gif));
              return this.cell(button, this.star(key, gif.preview, "gif", name, undefined));
            }),
          ),
        );
    }
    out.push(...this.favouriteSection("gif"));
    const query = this.query;
    const recent = files ? this.data.recent.filter((m) => matches(query, m.name)) : [];
    if (recent.length > 0) {
      out.push(
        sourceHeading(this.doc, module, "Seen in this conversation"),
        this.grid(
          recent.map((media) => {
            const key = `recent:${media.url}`;
            const button = this.item(key, `${media.name} (seen in this conversation)`, thumb(this.doc, media.url, media.video, media.name), () => this.handlers.onRecent(media));
            return this.cell(button, this.star(key, media.url, "gif", media.name, undefined));
          }),
        ),
      );
    }
    if (out.length === 0) out.push(el(this.doc, "p", "picker-empty", this.emptyText("GIFs")));
    return out;
  }

  private emptyText(what: string): string {
    return this.data.files ? `No ${what} here yet. Star one in a message to keep it.` : `This conversation takes no files, so no ${what} can be sent here.`;
  }

  /** The favourites of one kind, under "Your favourites", where files may be sent. */
  private favouriteSection(kind: FavouriteKind): HTMLElement[] {
    const items = this.data.files ? this.favouriteItems().filter((i) => i.kind === kind) : [];
    if (items.length === 0) return [];
    return [this.favouritesHeading(), this.grid(items.map((item) => this.favouriteCell(item, false)))];
  }

  private favouritesHeading(): HTMLElement {
    const heading = el(this.doc, "div", "picker-heading favourites");
    heading.append(el(this.doc, "span", "picker-star-mark", "★"), el(this.doc, "span", "picker-place", "Your favourites"));
    return heading;
  }

  /** Favourites matching the search, in the open category, newest first. */
  private favouriteItems(): Favourite[] {
    const query = this.query;
    return (this.data.favourites?.items ?? []).filter((i) => matches(query, i.name, i.source.place, i.source.platform) && (!this.category || i.categories.includes(this.category)));
  }

  private favouriteCell(item: Favourite, withMenu: boolean): HTMLElement {
    const key = `fav:${item.id}`;
    const from = `${item.source.platform}${item.source.place ? `, ${item.source.place}` : ""}`;
    const media = thumb(this.doc, mediaUrl(item.id), item.mime.startsWith("video/"), item.name);
    const button = this.item(key, `${item.name} (your favourite, from ${from})`, media, this.data.files ? () => this.handlers.onFavourite(item) : undefined);
    button.append(sourceBadge(this.doc, { label: item.source.label, color: item.source.color, name: `From ${from}` }));
    const cell = this.cell(button);
    if (!withMenu) return cell;
    const more = el(this.doc, "button", "picker-more", "⋯");
    more.type = "button";
    more.dataset.key = `more:${item.id}`;
    more.setAttribute("aria-label", `Options for ${item.name}`);
    more.setAttribute("aria-expanded", String(this.menuFor === item.id));
    more.addEventListener("click", () => {
      this.menuFor = this.menuFor === item.id ? undefined : item.id;
      this.render();
    });
    cell.append(more);
    if (this.menuFor === item.id) cell.append(this.favouriteMenu(item));
    return cell;
  }

  /** Which categories a favourite is in, and removing it. */
  private favouriteMenu(item: Favourite): HTMLElement {
    const menu = el(this.doc, "div", "picker-menu");
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", `Categories of ${item.name}`);
    for (const category of this.data.favourites!.categories) {
      const label = el(this.doc, "label", "picker-check");
      const box = el(this.doc, "input");
      box.type = "checkbox";
      box.checked = item.categories.includes(category.id);
      box.dataset.key = `assign:${item.id}:${category.id}`;
      box.addEventListener("change", () => this.handlers.onFavourites({ type: "assign", id: item.id, category: category.id, on: box.checked }));
      label.append(box, this.doc.createTextNode(category.name));
      menu.append(label);
    }
    const remove = el(this.doc, "button", "picker-remove", "Remove from favourites");
    remove.type = "button";
    remove.addEventListener("click", () => {
      this.menuFor = undefined;
      this.handlers.onFavourites({ type: "remove", id: item.id });
    });
    menu.append(remove);
    return menu;
  }

  private favouritesTab(): HTMLElement[] {
    const favourites = this.data.favourites;
    const out: HTMLElement[] = [];
    if (favourites?.error) out.push(el(this.doc, "p", "picker-error", favourites.error));
    if (favourites && favourites.saving.length > 0) out.push(el(this.doc, "p", "picker-note", "Saving…"));
    if (!this.data.files) out.push(el(this.doc, "p", "picker-note", "This conversation takes no files, so favourites cannot be sent here."));
    const categories = favourites?.categories ?? [];
    if (this.category && !categories.some((c) => c.id === this.category)) this.category = undefined;
    const bar = el(this.doc, "div", "picker-categories");
    bar.setAttribute("aria-label", "Categories");
    const chip = (id: string | undefined, name: string) => {
      const button = el(this.doc, "button", "picker-category", name);
      button.type = "button";
      button.dataset.key = `category:${id ?? ""}`;
      button.setAttribute("aria-pressed", String(this.category === id));
      button.addEventListener("click", () => {
        this.category = id;
        this.render();
      });
      return button;
    };
    bar.append(chip(undefined, "All"), ...categories.map((c) => chip(c.id, c.name)));
    const manage = el(this.doc, "button", "picker-manage", this.managing ? "Done" : "Edit categories");
    manage.type = "button";
    manage.dataset.key = "manage";
    manage.setAttribute("aria-expanded", String(this.managing));
    manage.addEventListener("click", () => {
      this.managing = !this.managing;
      this.render();
    });
    bar.append(manage);
    out.push(bar);
    if (this.managing) out.push(this.categoryEditor(categories));
    const items = this.favouriteItems();
    out.push(
      items.length > 0
        ? this.grid(items.map((item) => this.favouriteCell(item, true)))
        : el(this.doc, "p", "picker-empty", favourites?.items.length ? "Nothing in this category matches." : "No favourites yet. Star a GIF, sticker or picture in a message to keep it here."),
    );
    return out;
  }

  /** Making, renaming, reordering and deleting categories. */
  private categoryEditor(categories: readonly { id: string; name: string }[]): HTMLElement {
    const editor = el(this.doc, "div", "picker-editor");
    categories.forEach((category, index) => {
      const row = el(this.doc, "div", "picker-editor-row");
      const name = el(this.doc, "input", "picker-category-name");
      name.value = category.name;
      name.maxLength = 40;
      name.dataset.key = `rename:${category.id}`;
      name.setAttribute("aria-label", `Name of ${category.name}`);
      const rename = () => {
        const value = name.value.trim();
        if (value && value !== category.name) this.handlers.onFavourites({ type: "renameCategory", id: category.id, name: value });
      };
      name.addEventListener("change", rename);
      const button = (text: string, label: string, key: string, run: () => void, disabled = false) => {
        const b = el(this.doc, "button", "picker-editor-button", text);
        b.type = "button";
        b.dataset.key = `${key}:${category.id}`;
        b.setAttribute("aria-label", label);
        b.disabled = disabled;
        b.addEventListener("click", run);
        return b;
      };
      row.append(
        name,
        button("↑", `Move ${category.name} up`, "up", () => this.handlers.onFavourites({ type: "moveCategory", id: category.id, index: index - 1 }), index === 0),
        button("↓", `Move ${category.name} down`, "down", () => this.handlers.onFavourites({ type: "moveCategory", id: category.id, index: index + 1 }), index === categories.length - 1),
        button("✕", `Delete ${category.name} (its favourites stay)`, "delete", () => this.handlers.onFavourites({ type: "deleteCategory", id: category.id })),
      );
      editor.append(row);
    });
    const form = el(this.doc, "form", "picker-new-category");
    const input = el(this.doc, "input", "picker-category-name");
    input.placeholder = "New category";
    input.maxLength = 40;
    input.dataset.key = "new-category";
    input.setAttribute("aria-label", "New category");
    const add = el(this.doc, "button", "picker-editor-button", "Add");
    add.type = "submit";
    form.append(input, add);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      input.value = "";
      this.handlers.onFavourites({ type: "createCategory", name });
    });
    editor.append(form);
    return editor;
  }

  /** Escape closes; arrows move between tabs, and between items in a grid. */
  private onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      return this.handlers.onClose();
    }
    const target = event.target as HTMLElement;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -PICKER_COLUMNS, ArrowDown: PICKER_COLUMNS }[event.key];
    if (step === undefined) return;
    if (target.getAttribute("role") === "tab") {
      if (Math.abs(step) !== 1) return;
      const index = TABS.findIndex((t) => t.id === target.dataset.tab);
      event.preventDefault();
      return this.show(TABS[(index + step + TABS.length) % TABS.length]!.id);
    }
    if (!target.classList.contains("picker-item")) return;
    const items = [...target.closest(".picker-grid")!.querySelectorAll<HTMLButtonElement>(".picker-item")];
    const next = items[items.indexOf(target as HTMLButtonElement) + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }
}
