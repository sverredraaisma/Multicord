// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackNote, GIF_SEARCH_DELAY_MS, MediaPicker, PICKER_COLUMNS, type MediaPickerData, type MediaPickerHandlers } from "../../src/renderer/components/mediaPicker";
import type { Favourite, FavouritesState } from "../../src/shared/favourites";

const ID = (n: number) => n.toString(16).padStart(64, "0");
const CAT = "0123456789abcdef";
const CAT2 = "fedcba9876543210";
const badge = { label: "FX", color: "#4f8cf7", name: "Fluxer" };

const favourite = (n: number, over: Partial<Favourite> = {}): Favourite => ({
  id: ID(n),
  kind: "gif",
  name: `Fav ${n}`,
  mime: "image/gif",
  animated: true,
  size: 10,
  categories: [],
  source: { platform: "Stoat", label: "ST", color: "#ff4655", place: "Lounge" },
  addedAt: n,
  cached: true,
  ...over,
});

const favourites = (over: Partial<FavouritesState> = {}): FavouritesState => ({
  categories: [
    { id: CAT, name: "Reactions" },
    { id: CAT2, name: "Memes" },
  ],
  items: [
    favourite(1, { categories: [CAT], origin: "https://cdn.example/1.gif" }),
    favourite(2, { kind: "sticker", mime: "image/webp", name: "Wave", source: { platform: "Telegram", label: "TG", color: "#2aabee" } }),
    favourite(3, { kind: "image", mime: "image/png", name: "Photo" }),
    favourite(4, { mime: "video/mp4", name: "Clip" }),
  ],
  module: badge,
  saving: [],
  ...over,
});

const data = (over: Partial<MediaPickerData> = {}): MediaPickerData => ({
  module: badge,
  emoji: [{ id: "55", name: "party", animated: false, url: "https://media/55.webp", text: "<:party:55>", key: "party:55", react: true, source: "Cats" }],
  stickers: [
    {
      id: "p1",
      name: "Cat pack",
      stickers: [
        { id: "s1", name: "Wave", format: "webp", url: "https://cdn.example/s1.webp", emoji: "👋" },
        { id: "s2", name: "Jump", format: "webm", url: "https://cdn.example/s2.webm" },
        { id: "s3", name: "Spin", format: "lottie", url: "data:image/webp;base64,AAAA" },
        { id: "s4", name: "Later", format: "png", mediaKey: "tg:4" },
      ],
    },
  ],
  nativeStickers: true,
  files: true,
  gifSearch: true,
  gifs: { query: "", results: [{ id: "g1", url: "https://gifs.example/g1", preview: "https://media.example/g1.mp4", video: true, name: "Cat" }], loading: false },
  recent: [{ url: "https://cdn.example/r.gif", name: "Recent", video: false }],
  favourites: favourites(),
  ...over,
});

let handlers: { [K in keyof MediaPickerHandlers]: ReturnType<typeof vi.fn> };
const make = (over: Partial<MediaPickerData> = {}) => {
  const picker = new MediaPicker(document, handlers as unknown as MediaPickerHandlers, data(over));
  document.body.replaceChildren(picker.element);
  return picker;
};
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const tab = (name: string) => $<HTMLButtonElement>(`.picker-tab[data-tab="${name}"]`);
const type = (text: string) => {
  const search = $<HTMLInputElement>(".picker-search");
  search.value = text;
  search.dispatchEvent(new Event("input"));
};
const key = (target: HTMLElement, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

beforeEach(() => {
  handlers = {
    onEmoji: vi.fn(),
    onSticker: vi.fn(),
    onGif: vi.fn(),
    onRecent: vi.fn(),
    onFavourite: vi.fn(),
    onSearchGifs: vi.fn(),
    onLoadMedia: vi.fn(),
    onFavourites: vi.fn(),
    onClose: vi.fn(),
  };
});
afterEach(() => vi.useRealTimers());

describe("media picker tabs", () => {
  it("is a labelled dialog with four tabs, emoji first", () => {
    make();
    expect($(".media-picker").getAttribute("role")).toBe("dialog");
    expect($$(".picker-tab").map((t) => t.textContent)).toEqual(["Emoji", "Stickers", "GIFs", "Favourites"]);
    expect(tab("emoji").getAttribute("aria-selected")).toBe("true");
    expect(tab("stickers").tabIndex).toBe(-1);
    expect($(".picker-body").getAttribute("aria-labelledby")).toBe("picker-tab-emoji");
    // The emoji tab has a search of its own.
    expect($(".picker-search").hidden).toBe(true);
  });

  it("moves between tabs with the arrow keys and closes on Escape", () => {
    make();
    key(tab("emoji"), "ArrowRight");
    expect(tab("stickers").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("stickers"));
    key(tab("stickers"), "ArrowLeft");
    key(tab("emoji"), "ArrowLeft");
    expect(tab("favourites").getAttribute("aria-selected")).toBe("true");
    key(tab("favourites"), "ArrowDown"); // not between tabs
    expect(tab("favourites").getAttribute("aria-selected")).toBe("true");
    key(tab("favourites"), "Enter"); // not a move
    key(tab("favourites"), "Escape");
    expect(handlers.onClose).toHaveBeenCalled();
    tab("gifs").click();
    expect(tab("gifs").getAttribute("aria-selected")).toBe("true");
  });
});

describe("emoji tab", () => {
  it("picks custom emoji, under where they come from, and keeps its search across updates", () => {
    const picker = make();
    expect($(".picker-heading").textContent).toBe("FXCats");
    $<HTMLButtonElement>(".emoji-option.custom").click();
    expect(handlers.onEmoji).toHaveBeenCalledWith({ text: "<:party:55>", key: "party:55" });
    const search = $<HTMLInputElement>(".emoji-search");
    search.value = "joy";
    picker.update(data());
    expect($<HTMLInputElement>(".emoji-search").value).toBe("joy");
    // Different emoji: built afresh.
    picker.update(data({ emoji: [] }));
    expect($<HTMLInputElement>(".emoji-search").value).toBe("");
  });
});

describe("stickers tab", () => {
  it("shows the module's packs with their source, and sends a sticker", () => {
    const picker = make();
    picker.show("stickers");
    const headings = $$(".picker-heading");
    expect(headings[0]!.textContent).toBe("FXCat pack");
    expect(headings[0]!.querySelector(".source-badge")!.getAttribute("aria-label")).toBe("Fluxer");
    const wave = $<HTMLButtonElement>('[data-key="sticker:p1:s1"]');
    expect(wave.title).toBe("Wave (Cat pack, Fluxer)");
    wave.click();
    expect(handlers.onSticker).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), expect.objectContaining({ id: "p1" }));
    // WebM plays as a silent loop; Lottie shows its still, labelled; unloaded ones are asked for.
    expect($('[data-key="sticker:p1:s2"] video')).not.toBeNull();
    expect($('[data-key="sticker:p1:s3"] .picker-tag').textContent).toBe("still");
    expect($('[data-key="sticker:p1:s3"]').parentElement!.querySelector(".picker-star")).toBeNull();
    expect($<HTMLButtonElement>('[data-key="sticker:p1:s4"]').disabled).toBe(true);
    expect(handlers.onLoadMedia).toHaveBeenCalledWith("tg:4");
    // Favourite stickers follow, from wherever they were saved.
    expect($$(".picker-heading.favourites")).toHaveLength(1);
    const fav = $<HTMLButtonElement>(`[data-key="fav:${ID(2)}"]`);
    expect(fav.title).toBe("Wave (your favourite, from Telegram)");
    expect(fav.querySelector(".source-badge")!.textContent).toBe("TG");
    fav.click();
    expect(handlers.onFavourite).toHaveBeenCalledWith(expect.objectContaining({ id: ID(2) }));
  });

  it("says how stickers go where they cannot be sent as stickers", () => {
    const picker = make({ nativeStickers: false });
    picker.show("stickers");
    expect($(".picker-heading .picker-note").textContent).toBe("Sent as pictures here");
    expect($<HTMLButtonElement>('[data-key="sticker:p1:s3"]').title).toBe("Spin (Cat pack, Fluxer, sent as a still picture)");
    expect($<HTMLButtonElement>('[data-key="sticker:p1:s2"]').title).toContain("sent as a video");
    expect([fallbackNote("png"), fallbackNote("gif"), fallbackNote("apng"), fallbackNote("webp"), fallbackNote("avif")]).toEqual([
      "sent as a picture",
      "sent as an animated picture",
      "sent as an animated picture",
      "sent as a picture",
      "sent as a picture",
    ]);
  });

  it("offers nothing where neither stickers nor files can go", () => {
    const picker = make({ nativeStickers: false, files: false, module: undefined });
    picker.show("stickers");
    expect($(".picker-empty").textContent).toBe("This conversation takes no files, so no stickers can be sent here.");
    const plain = make({ stickers: [], favourites: undefined });
    plain.show("stickers");
    expect($(".picker-empty").textContent).toBe("No stickers here yet. Star one in a message to keep it.");
  });

  it("works before the favourites and the module's name are known", () => {
    const picker = make({ favourites: undefined, module: undefined });
    picker.show("stickers");
    expect($<HTMLButtonElement>('[data-key="sticker:p1:s1"]').title).toBe("Wave (Cat pack)");
    expect($('[data-key="star:sticker:p1:s1"]').getAttribute("aria-pressed")).toBe("false");
  });

  it("searches stickers by name, emoji and pack", () => {
    const picker = make();
    picker.show("stickers");
    type("👋");
    expect($$(".picker-item").map((b) => b.dataset.key)).toEqual(["sticker:p1:s1"]);
    type("cat pack");
    expect($$(".picker-item")).toHaveLength(4);
    type("telegram");
    expect($$(".picker-item").map((b) => b.dataset.key)).toEqual([`fav:${ID(2)}`]);
  });

  it("stars a sticker, or unstars it, and shows saving", () => {
    const picker = make();
    picker.show("stickers");
    const star = $<HTMLButtonElement>('[data-key="star:sticker:p1:s1"]');
    expect(star.getAttribute("aria-pressed")).toBe("false");
    star.click();
    expect(handlers.onFavourites).toHaveBeenCalledWith({ type: "add", url: "https://cdn.example/s1.webp", kind: "sticker", name: "Wave", place: "Cat pack" });
    expect(handlers.onSticker).not.toHaveBeenCalled();
    picker.update(data({ favourites: favourites({ saving: ["https://cdn.example/s1.webp"] }) }));
    expect($<HTMLButtonElement>('[data-key="star:sticker:p1:s1"]').disabled).toBe(true);
    const saved = favourites();
    saved.items.push(favourite(9, { kind: "sticker", origin: "https://cdn.example/s1.webp" }));
    picker.update(data({ favourites: saved }));
    const on = $<HTMLButtonElement>('[data-key="star:sticker:p1:s1"]');
    expect(on.textContent).toBe("★");
    on.click();
    expect(handlers.onFavourites).toHaveBeenLastCalledWith({ type: "remove", id: ID(9) });
  });

  it("moves between items with the arrow keys", () => {
    const picker = make();
    picker.show("stickers");
    const items = $$(".picker-grid")[0]!.querySelectorAll<HTMLButtonElement>(".picker-item");
    items[0]!.focus();
    key(items[0]!, "ArrowRight");
    expect(document.activeElement).toBe(items[1]);
    key(items[1]!, "ArrowLeft");
    expect(document.activeElement).toBe(items[0]);
    key(items[0]!, "ArrowUp"); // nothing above
    expect(document.activeElement).toBe(items[0]);
    expect(PICKER_COLUMNS).toBe(4);
    key($(".picker-search"), "ArrowDown"); // not an item
    expect(document.activeElement).toBe(items[0]);
  });

  it("keeps focus on the same control across updates", () => {
    const picker = make();
    picker.show("stickers");
    $<HTMLButtonElement>('[data-key="sticker:p1:s2"]').focus();
    picker.update(data());
    expect(document.activeElement).toBe($('[data-key="sticker:p1:s2"]'));
  });
});

describe("GIFs tab", () => {
  it("asks the platform for trending GIFs once, then searches as the user types", () => {
    vi.useFakeTimers();
    const picker = make();
    picker.show("gifs");
    expect(handlers.onSearchGifs).toHaveBeenCalledWith("");
    picker.show("emoji");
    picker.show("gifs");
    expect(handlers.onSearchGifs).toHaveBeenCalledTimes(1);
    expect($<HTMLInputElement>(".picker-search").placeholder).toBe("Search GIFs");
    type("ca");
    type("cats");
    vi.advanceTimersByTime(GIF_SEARCH_DELAY_MS);
    expect(handlers.onSearchGifs).toHaveBeenLastCalledWith("cats");
    expect(handlers.onSearchGifs).toHaveBeenCalledTimes(2);
    type("dogs");
    picker.close();
    vi.advanceTimersByTime(GIF_SEARCH_DELAY_MS);
    expect(handlers.onSearchGifs).toHaveBeenCalledTimes(2);
  });

  it("shows results, favourite GIFs and GIFs seen here, each with where they come from", () => {
    const picker = make();
    picker.show("gifs");
    expect($$(".picker-heading").map((h) => h.textContent)).toEqual(["FXTrending", "★Your favourites", "FXSeen in this conversation"]);
    const result = $<HTMLButtonElement>('[data-key="gif:g1"]');
    expect(result.title).toBe("Cat (Fluxer GIF search)");
    expect(result.querySelector("video")).not.toBeNull();
    result.click();
    expect(handlers.onGif).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    $<HTMLButtonElement>('[data-key="star:gif:g1"]').click();
    expect(handlers.onFavourites).toHaveBeenCalledWith({ type: "add", url: "https://media.example/g1.mp4", kind: "gif", name: "Cat" });
    $<HTMLButtonElement>('[data-key="recent:https://cdn.example/r.gif"]').click();
    expect(handlers.onRecent).toHaveBeenCalledWith({ url: "https://cdn.example/r.gif", name: "Recent", video: false });
    // Favourite GIFs and videos: the mp4 one plays.
    expect($(`[data-key="fav:${ID(4)}"] video`)).not.toBeNull();
    expect($(`[data-key="fav:${ID(1)}"] img`).getAttribute("src")).toBe(`multicord-media://media/${ID(1)}`);
  });

  it("says when results load, fail or are empty", () => {
    const picker = make({ gifs: undefined, module: undefined });
    picker.show("gifs");
    expect($(".picker-empty").textContent).toBe("Loading GIFs…");
    picker.update(data({ gifs: { query: "x", results: [], loading: true } }));
    expect($(".picker-empty").textContent).toBe("Loading GIFs…");
    picker.update(data({ gifs: { query: "x", results: [], loading: false } }));
    expect($(".picker-heading").textContent).toBe("FXResults for “x”");
    expect($(".picker-empty").textContent).toBe("No GIFs found");
    picker.update(data({ gifs: { query: "x", results: [], loading: false, error: "Rate limited" } }));
    expect($(".picker-error").textContent).toBe("Rate limited");
    picker.update(data({ gifs: { query: "", results: [{ id: "g2", url: "https://g/2", preview: "https://g/2.gif", video: false }], loading: false }, module: undefined }));
    expect($<HTMLButtonElement>('[data-key="gif:g2"]').title).toBe("GIF");
  });

  it("offers favourite and recent GIFs only where files go, and no search without the platform's", () => {
    const picker = make({ gifSearch: false, files: false });
    picker.show("gifs");
    expect(handlers.onSearchGifs).not.toHaveBeenCalled();
    expect($(".picker-empty").textContent).toBe("This conversation takes no files, so no GIFs can be sent here.");
    type("x"); // no search to run
    expect($<HTMLInputElement>(".picker-search").placeholder).toBe("Search GIFs");
  });
});

describe("favourites tab", () => {
  it("lists every favourite with its source, sends one, and filters by category and search", () => {
    const picker = make();
    picker.show("favourites");
    expect($$(".picker-category").map((c) => c.textContent)).toEqual(["All", "Reactions", "Memes"]);
    expect($$(".picker-item")).toHaveLength(4);
    $<HTMLButtonElement>(`[data-key="fav:${ID(3)}"]`).click();
    expect(handlers.onFavourite).toHaveBeenCalledWith(expect.objectContaining({ id: ID(3) }));
    $<HTMLButtonElement>(`[data-key="category:${CAT}"]`).click();
    expect($(`[data-key="category:${CAT}"]`).getAttribute("aria-pressed")).toBe("true");
    expect($$(".picker-item").map((b) => b.dataset.key)).toEqual([`fav:${ID(1)}`]);
    type("photo");
    expect($(".picker-empty").textContent).toBe("Nothing in this category matches.");
    type("");
    $<HTMLButtonElement>('[data-key="category:"]').click();
    type("lounge");
    expect($$(".picker-item")).toHaveLength(3);
    // A category that disappears shows everything again.
    type("");
    $<HTMLButtonElement>(`[data-key="category:${CAT2}"]`).click();
    picker.update(data({ favourites: favourites({ categories: [{ id: CAT, name: "Reactions" }] }) }));
    expect($$(".picker-item")).toHaveLength(4);
  });

  it("puts a favourite in categories and removes it from its menu", () => {
    const picker = make();
    picker.show("favourites");
    const more = $<HTMLButtonElement>(`[data-key="more:${ID(1)}"]`);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.click();
    const boxes = $$(".picker-menu input") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    boxes[1]!.checked = true;
    boxes[1]!.dispatchEvent(new Event("change"));
    expect(handlers.onFavourites).toHaveBeenCalledWith({ type: "assign", id: ID(1), category: CAT2, on: true });
    // The menu stays open across updates.
    picker.update(data());
    expect($(".picker-menu")).not.toBeNull();
    $<HTMLButtonElement>(".picker-remove").click();
    expect(handlers.onFavourites).toHaveBeenLastCalledWith({ type: "remove", id: ID(1) });
    picker.update(data());
    expect($(".picker-menu")).toBeNull();
    $<HTMLButtonElement>(`[data-key="more:${ID(2)}"]`).click();
    $<HTMLButtonElement>(`[data-key="more:${ID(2)}"]`).click();
    expect($(".picker-menu")).toBeNull();
  });

  it("makes, renames, moves and deletes categories", () => {
    const picker = make();
    picker.show("favourites");
    $<HTMLButtonElement>(".picker-manage").click();
    expect($(".picker-manage").textContent).toBe("Done");
    const names = $$(".picker-editor-row .picker-category-name") as HTMLInputElement[];
    names[0]!.value = "  Reacts ";
    names[0]!.dispatchEvent(new Event("change"));
    expect(handlers.onFavourites).toHaveBeenLastCalledWith({ type: "renameCategory", id: CAT, name: "Reacts" });
    handlers.onFavourites.mockClear();
    names[1]!.value = " ";
    names[1]!.dispatchEvent(new Event("change"));
    names[1]!.value = "Memes";
    names[1]!.dispatchEvent(new Event("change"));
    expect(handlers.onFavourites).not.toHaveBeenCalled();
    expect($<HTMLButtonElement>(`[data-key="up:${CAT}"]`).disabled).toBe(true);
    expect($<HTMLButtonElement>(`[data-key="down:${CAT2}"]`).disabled).toBe(true);
    $<HTMLButtonElement>(`[data-key="down:${CAT}"]`).click();
    expect(handlers.onFavourites).toHaveBeenLastCalledWith({ type: "moveCategory", id: CAT, index: 1 });
    $<HTMLButtonElement>(`[data-key="up:${CAT2}"]`).click();
    expect(handlers.onFavourites).toHaveBeenLastCalledWith({ type: "moveCategory", id: CAT2, index: 0 });
    $<HTMLButtonElement>(`[data-key="delete:${CAT2}"]`).click();
    expect(handlers.onFavourites).toHaveBeenLastCalledWith({ type: "deleteCategory", id: CAT2 });
    const input = $<HTMLInputElement>('[data-key="new-category"]');
    const form = $<HTMLFormElement>(".picker-new-category");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    input.value = " Cats ";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(handlers.onFavourites).toHaveBeenLastCalledWith({ type: "createCategory", name: "Cats" });
    expect(input.value).toBe("");
    $<HTMLButtonElement>(".picker-manage").click();
    expect($(".picker-editor")).toBeNull();
  });

  it("shows errors, saving and why nothing can be sent", () => {
    const picker = make({ files: false, favourites: favourites({ error: "Too large", saving: ["https://x/a.gif"] }) });
    picker.show("favourites");
    expect($(".picker-error").textContent).toBe("Too large");
    expect($$(".picker-note").map((n) => n.textContent)).toEqual(["Saving…", "This conversation takes no files, so favourites cannot be sent here."]);
    expect($<HTMLButtonElement>(`[data-key="fav:${ID(1)}"]`).disabled).toBe(true);
    const none = make({ favourites: undefined });
    none.show("favourites");
    expect($(".picker-empty").textContent).toBe("No favourites yet. Star a GIF, sticker or picture in a message to keep it here.");
  });
});
