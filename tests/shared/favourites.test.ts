import { describe, expect, it, vi } from "vitest";
import { createNativeApi } from "../../src/preload/native";
import { FAVOURITES_IPC, isFavouritesAction, isMediaUrl, MAX_CATEGORIES, MAX_DATA_URL, MAX_MEDIA_URL, mediaUrl, uploadName } from "../../src/shared/favourites";
import { isNativeAction } from "../../src/shared/native";

const ID = "a".repeat(64);
const CAT = "0123456789abcdef";

describe("isMediaUrl", () => {
  it("takes https addresses and base64 picture or video data", () => {
    expect(isMediaUrl("https://cdn.example/a.gif")).toBe(true);
    expect(isMediaUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isMediaUrl("data:video/webm;base64,GkXfow==")).toBe(true);
  });

  it("refuses other schemes, other types, broken data and anything too long", () => {
    for (const url of [
      5,
      "http://cdn.example/a.gif",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html;base64,PGI+",
      "data:image/svg+xml,<svg/>",
      "data:image/png;base64,***",
      "data:image/png;base64,AAAA" + "!",
      "https://x/" + "a".repeat(MAX_MEDIA_URL),
      "data:image/png;base64," + "A".repeat(MAX_DATA_URL),
    ]) {
      expect(isMediaUrl(url)).toBe(false);
    }
  });
});

describe("isFavouritesAction", () => {
  it("accepts well-formed actions", () => {
    for (const action of [
      { type: "add", url: "https://cdn.example/a.gif", kind: "gif", name: "Dance" },
      { type: "add", url: "https://cdn.example/a.webp", kind: "sticker", name: "Wave", place: "Cats pack" },
      { type: "remove", id: ID },
      { type: "createCategory", name: "Reactions" },
      { type: "createCategory", name: "Reactions", assign: ID },
      { type: "renameCategory", id: CAT, name: "Memes" },
      { type: "deleteCategory", id: CAT },
      { type: "moveCategory", id: CAT, index: 0 },
      { type: "assign", id: ID, category: CAT, on: true },
      { type: "send", id: ID },
      { type: "send", id: ID, replyTo: "123" },
      { type: "sendMedia", url: "data:image/png;base64,iVBORw0KGgo=", name: "Wave", replyTo: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    ]) {
      expect(isFavouritesAction(action)).toBe(true);
    }
  });

  it("refuses malformed actions", () => {
    for (const action of [
      null,
      [],
      { type: "nope" },
      { type: "add", url: "http://x/a.gif", kind: "gif", name: "a" },
      { type: "add", url: "https://x/a.gif", kind: "emoji", name: "a" },
      { type: "add", url: "https://x/a.gif", kind: "gif", name: " " },
      { type: "add", url: "https://x/a.gif", kind: "gif", name: "a", place: "x".repeat(101) },
      { type: "remove", id: "../x" },
      { type: "createCategory", name: "x".repeat(41) },
      { type: "createCategory", name: "a", assign: "b" },
      { type: "renameCategory", id: "zz", name: "a" },
      { type: "deleteCategory", id: ID },
      { type: "moveCategory", id: CAT, index: MAX_CATEGORIES },
      { type: "moveCategory", id: CAT, index: -1 },
      { type: "moveCategory", id: CAT, index: 1.5 },
      { type: "moveCategory", id: CAT },
      { type: "assign", id: ID, category: CAT },
      { type: "send", id: ID, replyTo: "x" },
      { type: "sendMedia", url: "https://x/a", name: "" },
    ]) {
      expect(isFavouritesAction(action)).toBe(false);
    }
  });

  it("never lets a view send a file into the engine itself", () => {
    expect(isNativeAction({ type: "sendFile", file: { handle: "h", name: "a.png", size: 1, type: "image/png" } })).toBe(false);
  });
});

describe("helpers", () => {
  it("names the media address and upload files", () => {
    expect(mediaUrl(ID)).toBe(`multicord-media://media/${ID}`);
    expect(uploadName("Happy cat.gif", "image/gif")).toBe("Happy_cat.gif");
    expect(uploadName("../../evil<script>", "video/webm")).toBe("evilscript.webm");
    expect(uploadName("???", "image/png")).toBe("media.png");
    expect(uploadName("x".repeat(100), "image/jpeg")).toBe(`${"x".repeat(60)}.jpg`);
    expect(uploadName("a", "image/webp")).toBe("a.webp");
    expect(uploadName("a", "image/avif")).toBe("a.avif");
    expect(uploadName("a", "video/mp4")).toBe("a.mp4");
  });

  it("relays favourites between the native view and the shell", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc = { send: vi.fn(), on: (c: string, l: (e: unknown, p: unknown) => void) => void listeners.set(c, l) };
    const api = createNativeApi(ipc);
    const onFavourites = vi.fn();
    api.onFavourites(onFavourites);
    listeners.get(FAVOURITES_IPC.state)!(null, { items: [] });
    expect(onFavourites).toHaveBeenCalledWith({ items: [] });
    api.favourites({ type: "remove", id: ID });
    expect(ipc.send).toHaveBeenCalledWith(FAVOURITES_IPC.action, { type: "remove", id: ID });
  });
});
