import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataUrlBytes, downloadMedia, FavouritesStore, sniffMedia, type FavouritesContext, type MediaFetch } from "../../src/main/favourites";
import { MAX_CATEGORIES, MAX_FAVOURITE_BYTES, MAX_FAVOURITES, mediaUrl } from "../../src/shared/favourites";

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, length = 0) => [...u32(length), ...[...type].map((c) => c.charCodeAt(0)), ...new Array(length + 4).fill(0)];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG = bytes(PNG_SIG, chunk("IHDR", 13), chunk("IDAT", 2), chunk("IEND"));
const APNG = bytes(PNG_SIG, chunk("IHDR", 13), chunk("acTL", 8), chunk("IDAT", 2));
const GIF = bytes("GIF89a", [0, 0, 0, 0], "NETSCAPE2.0");
const STILL_GIF = bytes("GIF87a", [1, 2, 3]);
const webp = (flags: number, kind = "VP8X") => bytes("RIFF", [0, 0, 0, 0], "WEBP", kind, [0, 0, 0, 0, flags, 0, 0, 0]);
const ftyp = (brand: string) => bytes([0, 0, 0, 24], "ftyp", brand, [0, 0, 0, 0]);
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84], "webm");
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const dataUrl = (data: Uint8Array, mime = "image/png") => `data:${mime};base64,${Buffer.from(data).toString("base64")}`;

describe("sniffMedia", () => {
  it("knows pictures and videos by their bytes, and whether they move", () => {
    expect(sniffMedia(PNG)).toEqual({ mime: "image/png", animated: false });
    expect(sniffMedia(APNG)).toEqual({ mime: "image/png", animated: true });
    expect(sniffMedia(bytes(PNG_SIG, [0, 0]))).toEqual({ mime: "image/png", animated: false });
    expect(sniffMedia(bytes([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ mime: "image/jpeg", animated: false });
    expect(sniffMedia(GIF)).toEqual({ mime: "image/gif", animated: true });
    expect(sniffMedia(bytes("GIF89a", "ANIMEXTS1.0"))).toEqual({ mime: "image/gif", animated: true });
    expect(sniffMedia(STILL_GIF)).toEqual({ mime: "image/gif", animated: false });
    expect(sniffMedia(webp(0x02))).toEqual({ mime: "image/webp", animated: true });
    expect(sniffMedia(webp(0x10))).toEqual({ mime: "image/webp", animated: false });
    expect(sniffMedia(webp(0x02, "VP8 "))).toEqual({ mime: "image/webp", animated: false });
    expect(sniffMedia(bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X"))).toEqual({ mime: "image/webp", animated: false });
    expect(sniffMedia(ftyp("avif"))).toEqual({ mime: "image/avif", animated: false });
    expect(sniffMedia(ftyp("avis"))).toEqual({ mime: "image/avif", animated: true });
    expect(sniffMedia(ftyp("isom"))).toEqual({ mime: "video/mp4", animated: true });
    expect(sniffMedia(WEBM)).toEqual({ mime: "video/webm", animated: true });
  });

  it("refuses everything else, SVG and unknown containers included", () => {
    expect(sniffMedia(bytes("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).toBeUndefined();
    expect(sniffMedia(bytes("<!doctype html>"))).toBeUndefined();
    expect(sniffMedia(ftyp("heic"))).toBeUndefined();
    expect(sniffMedia(bytes([0x1a, 0x45, 0xdf, 0xa3], "matroska"))).toBeUndefined();
    expect(sniffMedia(new Uint8Array(0))).toBeUndefined();
  });
});

describe("dataUrlBytes", () => {
  it("decodes base64 data URLs within the cap", () => {
    expect(dataUrlBytes(dataUrl(PNG))).toEqual(PNG);
    expect(dataUrlBytes("data:image/png,raw")).toBeUndefined();
    expect(dataUrlBytes(`data:image/png;base64,${"A".repeat((MAX_FAVOURITE_BYTES / 3) * 4 + 8)}`)).toBeUndefined();
  });
});

const response = (body: Uint8Array | null, init: { status?: number; type?: string | null; length?: number; url?: string } = {}) => {
  const headers = new Headers();
  if (init.type !== null) headers.set("content-type", init.type ?? "image/png");
  if (init.length !== undefined) headers.set("content-length", String(init.length));
  const r = new Response(body ? new Uint8Array(body) : null, { status: init.status ?? 200, headers });
  Object.defineProperty(r, "url", { value: init.url ?? "" });
  return r;
};

describe("downloadMedia", () => {
  const policy = { schemes: ["https:"], hosts: ["cdn.example"] };

  it("downloads pictures from allowed hosts without cookies", async () => {
    const fetchImpl = vi.fn<MediaFetch>(async () => response(PNG, { url: "https://cdn.example/a.png" }));
    expect(await downloadMedia(fetchImpl, "https://cdn.example/a.png", policy)).toEqual(PNG);
    expect(fetchImpl).toHaveBeenCalledWith("https://cdn.example/a.png", { method: "GET", redirect: "follow", credentials: "omit" });
    expect(await downloadMedia(async () => response(WEBM, { type: "video/webm; codecs=vp9" }), "https://cdn.example/a", policy)).toEqual(WEBM);
    expect(await downloadMedia(async () => response(WEBM, { type: "video/mp4" }), "https://cdn.example/a", policy)).toEqual(WEBM);
  });

  it("refuses other hosts, redirects away, errors, other types and large bodies", async () => {
    const ok = async () => response(PNG);
    await expect(downloadMedia(ok, "https://evil.example/a.png", policy)).rejects.toThrow("not one of this module's hosts");
    await expect(downloadMedia(ok, "https://127.0.0.1/a.png", { schemes: ["https:"] })).rejects.toThrow("local or private");
    await expect(downloadMedia(async () => response(PNG, { url: "https://evil.example/x" }), "https://cdn.example/a", policy)).rejects.toThrow("not one of");
    await expect(downloadMedia(async () => response(null, { status: 404 }), "https://cdn.example/a", policy)).rejects.toThrow("answered 404");
    await expect(downloadMedia(async () => response(PNG, { type: "image/svg+xml" }), "https://cdn.example/a", policy)).rejects.toThrow("not a picture");
    await expect(downloadMedia(async () => response(PNG, { type: "text/html" }), "https://cdn.example/a", policy)).rejects.toThrow("not a picture");
    await expect(downloadMedia(async () => response(PNG, { type: null }), "https://cdn.example/a", policy)).rejects.toThrow("not a picture");
    await expect(downloadMedia(async () => response(PNG, { length: MAX_FAVOURITE_BYTES + 1 }), "https://cdn.example/a", policy)).rejects.toThrow("Larger than the 20 MB");
    await expect(downloadMedia(async () => response(new Uint8Array(MAX_FAVOURITE_BYTES + 1)), "https://cdn.example/a", policy)).rejects.toThrow("Larger than the 20 MB");
  });
});

describe("FavouritesStore", () => {
  let dir: string;
  let download: ReturnType<typeof vi.fn<(url: string, hosts: readonly string[] | undefined) => Promise<Uint8Array>>>;
  let share: ReturnType<typeof vi.fn<FavouritesContext["share"]>>;
  let context: FavouritesContext;
  const module = { name: "Fluxer", label: "FX", color: "#4641d9" };
  const store = () => new FavouritesStore(dir, { download, now: () => 1000 });
  const filesDir = () => path.join(dir, "files");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicord-fav-"));
    download = vi.fn(async () => GIF);
    share = vi.fn();
    context = { source: { platform: "Fluxer", label: "FX", color: "#4641d9" }, hosts: ["cdn.example"], share };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("saves a GIF once, by its hash, with where it came from", async () => {
    const favourites = store();
    const changed = vi.fn();
    favourites.changed.on(changed);
    await favourites.handle({ type: "add", url: "https://cdn.example/dance.gif", kind: "gif", name: "Dance", place: "Cats" }, context);
    expect(download).toHaveBeenCalledWith("https://cdn.example/dance.gif", ["cdn.example"]);
    const id = hash(GIF);
    expect(fs.readFileSync(path.join(filesDir(), id))).toEqual(Buffer.from(GIF));
    const state = favourites.state(module);
    expect(state).toEqual({
      categories: [],
      items: [
        {
          id,
          kind: "gif",
          name: "Dance",
          mime: "image/gif",
          animated: true,
          size: GIF.length,
          categories: [],
          source: { platform: "Fluxer", label: "FX", color: "#4641d9", place: "Cats" },
          addedAt: 1000,
          origin: "https://cdn.example/dance.gif",
          cached: true,
        },
      ],
      module,
      saving: [],
    });
    // Saving shows while the download runs, then the result.
    expect(changed).toHaveBeenCalledTimes(2);
    // The same bytes again stay one favourite.
    await favourites.handle({ type: "add", url: dataUrl(GIF, "image/gif"), kind: "gif", name: "Again" }, context);
    expect(favourites.state(module).items).toHaveLength(1);
    // And survive a restart.
    expect(store().state(module).items[0]!.name).toBe("Dance");
  });

  it("keeps the kind honest: a still picture is no GIF, a sticker stays a sticker", async () => {
    const favourites = store();
    await favourites.handle({ type: "add", url: dataUrl(PNG), kind: "gif", name: "Still" }, context);
    await favourites.handle({ type: "add", url: dataUrl(webp(0x02), "image/webp"), kind: "image", name: "Moving" }, context);
    await favourites.handle({ type: "add", url: dataUrl(STILL_GIF, "image/gif"), kind: "sticker", name: "Sticker" }, context);
    const items = favourites.state(module).items;
    expect(items.map((i) => [i.name, i.kind, i.origin])).toEqual([
      ["Sticker", "sticker", undefined],
      ["Moving", "gif", undefined],
      ["Still", "image", undefined],
    ]);
  });

  it("reports what could not be saved", async () => {
    const favourites = store();
    download.mockRejectedValueOnce(new Error("The server answered 404"));
    await favourites.handle({ type: "add", url: "https://cdn.example/x.gif", kind: "gif", name: "X" }, context);
    expect(favourites.state(module).error).toBe("The server answered 404");
    download.mockResolvedValueOnce(bytes("<svg/>"));
    await favourites.handle({ type: "add", url: "https://cdn.example/x.svg", kind: "image", name: "X" }, context);
    expect(favourites.state(module).error).toMatch(/^Only pictures/);
    download.mockResolvedValueOnce(new Uint8Array(MAX_FAVOURITE_BYTES + 1));
    await favourites.handle({ type: "add", url: "https://cdn.example/big.gif", kind: "gif", name: "X" }, context);
    expect(favourites.state(module).error).toMatch(/^Larger than/);
    await favourites.handle({ type: "add", url: `data:image/png;base64,${"A".repeat((MAX_FAVOURITE_BYTES / 3) * 4 + 8)}`, kind: "gif", name: "X" }, context);
    expect(favourites.state(module).error).toMatch(/^Larger than/);
    // The next action clears it.
    await favourites.handle({ type: "remove", id: "f".repeat(64) }, context);
    expect(favourites.state(module).error).toBeUndefined();
    expect(favourites.state(module).items).toEqual([]);
  });

  it("ignores a second save of the same address while the first runs", async () => {
    const favourites = store();
    let finish!: (data: Uint8Array) => void;
    download.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const first = favourites.handle({ type: "add", url: "https://cdn.example/a.gif", kind: "gif", name: "A" }, context);
    expect(favourites.state(module).saving).toEqual(["https://cdn.example/a.gif"]);
    await favourites.handle({ type: "add", url: "https://cdn.example/a.gif", kind: "gif", name: "A" }, context);
    expect(download).toHaveBeenCalledTimes(1);
    finish(GIF);
    await first;
    expect(favourites.state(module).saving).toEqual([]);
  });

  it("caps how many favourites there are", async () => {
    const id = (n: number) => n.toString(16).padStart(64, "0");
    const items = Array.from({ length: MAX_FAVOURITES + 5 }, (_, n) => ({ id: id(n), kind: "gif", name: "g", mime: "image/gif", size: 1, source: { platform: "P", label: "P", color: "#000000" } }));
    fs.writeFileSync(path.join(dir, "favourites.json"), JSON.stringify({ items }));
    const favourites = store();
    expect(favourites.state(module).items).toHaveLength(MAX_FAVOURITES);
    await favourites.handle({ type: "add", url: dataUrl(PNG), kind: "image", name: "One more" }, context);
    expect(favourites.state(module).error).toMatch(/^At most 2000 favourites/);
    expect(fs.existsSync(path.join(filesDir(), hash(PNG)))).toBe(false);
  });

  it("dates favourites by the clock without one given", async () => {
    vi.spyOn(Date, "now").mockReturnValue(55);
    const favourites = new FavouritesStore(dir, { download });
    await favourites.handle({ type: "add", url: dataUrl(PNG), kind: "image", name: "P" }, context);
    expect(favourites.state(module).items[0]!.addedAt).toBe(55);
  });

  it("removes a favourite and its file", async () => {
    const favourites = store();
    await favourites.handle({ type: "add", url: dataUrl(PNG), kind: "image", name: "P" }, context);
    await favourites.handle({ type: "remove", id: hash(PNG) }, context);
    expect(favourites.state(module).items).toEqual([]);
    expect(fs.existsSync(path.join(filesDir(), hash(PNG)))).toBe(false);
  });

  it("manages categories and what is in them", async () => {
    const favourites = store();
    await favourites.handle({ type: "add", url: dataUrl(PNG), kind: "image", name: "P" }, context);
    const id = hash(PNG);
    await favourites.handle({ type: "createCategory", name: " Reactions ", assign: id }, context);
    await favourites.handle({ type: "createCategory", name: "Memes" }, context);
    await favourites.handle({ type: "createCategory", name: "Unused", assign: "e".repeat(64) }, context);
    const [reactions, memes, unused] = favourites.state(module).categories;
    expect([reactions!.name, memes!.name, unused!.name]).toEqual(["Reactions", "Memes", "Unused"]);
    expect(favourites.state(module).items[0]!.categories).toEqual([reactions!.id]);

    await favourites.handle({ type: "assign", id, category: memes!.id, on: true }, context);
    await favourites.handle({ type: "assign", id, category: memes!.id, on: true }, context);
    expect(favourites.state(module).items[0]!.categories).toEqual([reactions!.id, memes!.id]);
    await favourites.handle({ type: "assign", id, category: reactions!.id, on: false }, context);
    await favourites.handle({ type: "assign", id: "e".repeat(64), category: memes!.id, on: true }, context);
    await favourites.handle({ type: "assign", id, category: "0".repeat(16), on: true }, context);
    expect(favourites.state(module).items[0]!.categories).toEqual([memes!.id]);

    await favourites.handle({ type: "renameCategory", id: memes!.id, name: "Funny" }, context);
    await favourites.handle({ type: "renameCategory", id: "0".repeat(16), name: "Ghost" }, context);
    await favourites.handle({ type: "moveCategory", id: unused!.id, index: 0 }, context);
    await favourites.handle({ type: "moveCategory", id: reactions!.id, index: 50 }, context);
    await favourites.handle({ type: "moveCategory", id: "0".repeat(16), index: 0 }, context);
    expect(favourites.state(module).categories.map((c) => c.name)).toEqual(["Unused", "Funny", "Reactions"]);
    expect(favourites.summary()).toEqual({
      categories: [
        { id: unused!.id, name: "Unused", count: 0 },
        { id: memes!.id, name: "Funny", count: 1 },
        { id: reactions!.id, name: "Reactions", count: 0 },
      ],
      items: 1,
      cacheBytes: PNG.length,
      pinned: 1,
    });

    // Deleting a category keeps its favourites.
    await favourites.handle({ type: "deleteCategory", id: memes!.id }, context);
    expect(favourites.state(module).items[0]!.categories).toEqual([]);
    expect(store().state(module).categories.map((c) => c.name)).toEqual(["Unused", "Reactions"]);
  });

  it("caps the categories", async () => {
    const categories = Array.from({ length: MAX_CATEGORIES + 3 }, (_, n) => ({ id: n.toString(16).padStart(16, "0"), name: `c${n}` }));
    fs.writeFileSync(path.join(dir, "favourites.json"), JSON.stringify({ categories }));
    const favourites = store();
    expect(favourites.state(module).categories).toHaveLength(MAX_CATEGORIES);
    await favourites.handle({ type: "createCategory", name: "More" }, context);
    expect(favourites.state(module).error).toBe(`At most ${MAX_CATEGORIES} categories.`);
  });

  it("trusts nothing in the index file", () => {
    const id = hash(PNG);
    const cat = "0123456789abcdef";
    const good = { id, kind: "image", name: "P", mime: "image/png", animated: true, size: 5, categories: [cat, "gone", cat, 4], source: { platform: "Fluxer", label: "FX", color: "#4641d9", place: "Here" }, addedAt: 7, origin: "https://cdn.example/p.png" };
    fs.writeFileSync(
      path.join(dir, "favourites.json"),
      JSON.stringify({
        categories: [{ id: cat, name: "A" }, { id: cat, name: "Twice" }, { id: "bad", name: "B" }, { id: "fedcba9876543210" }, null],
        items: [
          good,
          { ...good, name: "Twice" },
          { ...good, id: "b".repeat(64), mime: "image/svg+xml" },
          { ...good, id: "c".repeat(64), kind: "emoji" },
          { ...good, id: "a".repeat(64), source: "Fluxer" },
          { ...good, id: "d".repeat(64), source: { platform: "X", label: "X", color: "red" } },
          { ...good, id: "e".repeat(64), size: -1, addedAt: "soon", origin: "http://x/a", animated: "yes", categories: "all", source: { platform: "X", label: "X", color: "#000000", place: 5 } },
          "junk",
        ],
      }),
    );
    const items = store().state(module).items;
    expect(items.map((i) => i.id)).toEqual([id, "e".repeat(64)]);
    expect(items[0]).toMatchObject({ categories: [cat], source: { place: "Here" }, origin: "https://cdn.example/p.png", cached: false });
    expect(items[1]).toMatchObject({ size: 0, addedAt: 0, animated: false, categories: [] });
    expect(items[1]!.origin).toBeUndefined();
    expect(items[1]!.source.place).toBeUndefined();

    fs.writeFileSync(path.join(dir, "favourites.json"), "[1]");
    expect(store().state(module).items).toEqual([]);
    fs.writeFileSync(path.join(dir, "favourites.json"), "{");
    expect(store().state(module).items).toEqual([]);
    fs.writeFileSync(path.join(dir, "favourites.json"), "{}");
    expect(store().state(module).categories).toEqual([]);
  });

  it("sends a favourite through the module's upload, fetching it again if it was evicted", async () => {
    const favourites = store();
    await favourites.handle({ type: "add", url: "https://cdn.example/dance.gif", kind: "gif", name: "Dance party" }, context);
    const id = hash(GIF);
    await favourites.handle({ type: "send", id, replyTo: "42" }, context);
    expect(share).toHaveBeenCalledWith({ path: path.join(filesDir(), id), size: GIF.length, mime: "image/gif", name: "Dance_party.gif" }, "42");

    favourites.clearCache();
    expect(favourites.state(module).items[0]!.cached).toBe(false);
    expect(favourites.cacheBytes()).toBe(0);
    await favourites.handle({ type: "send", id }, context);
    expect(download).toHaveBeenLastCalledWith("https://cdn.example/dance.gif", undefined);
    expect(share).toHaveBeenCalledTimes(2);
    expect(favourites.state(module).items[0]!.cached).toBe(true);

    // What the address serves now must be the same file.
    favourites.clearCache();
    download.mockResolvedValueOnce(PNG);
    await favourites.handle({ type: "send", id }, context);
    expect(favourites.state(module).error).toBe("Dance party could not be loaded again.");
    download.mockRejectedValueOnce(new Error("offline"));
    await favourites.handle({ type: "send", id }, context);
    expect(favourites.state(module).error).toBe("Dance party could not be loaded again.");

    await favourites.handle({ type: "send", id: "e".repeat(64) }, context);
    expect(favourites.state(module).error).toBe("That favourite is gone.");
    expect(share).toHaveBeenCalledTimes(2);
  });

  it("keeps files nothing could download again when the cache is cleared", async () => {
    const favourites = store();
    await favourites.handle({ type: "add", url: dataUrl(PNG), kind: "image", name: "Own" }, context);
    favourites.clearCache();
    expect(favourites.state(module).items[0]!.cached).toBe(true);
    expect(favourites.summary().pinned).toBe(1);
  });

  it("sends media the view shows as a file, without keeping it", async () => {
    const favourites = store();
    await favourites.handle({ type: "sendMedia", url: dataUrl(webp(0x02), "image/webp"), name: "Wave" }, context);
    const file = share.mock.calls[0]![0];
    expect(file).toMatchObject({ mime: "image/webp", name: "Wave.webp", size: 24 });
    expect(path.dirname(file.path)).toBe(path.join(dir, "tmp"));
    expect(favourites.state(module).items).toEqual([]);
    // Gone at the next start.
    store();
    expect(fs.existsSync(file.path)).toBe(false);
    await favourites.handle({ type: "sendMedia", url: "https://cdn.example/s.gif", name: "S", replyTo: "9" }, context);
    expect(share.mock.calls[1]![1]).toBe("9");
  });

  it("serves cached favourites by id and nothing else", async () => {
    const favourites = store();
    await favourites.handle({ type: "add", url: "https://cdn.example/dance.gif", kind: "gif", name: "Dance" }, context);
    const id = hash(GIF);
    const served = await favourites.serve(mediaUrl(id));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/gif");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(GIF);

    for (const url of [`multicord-media://media/${"e".repeat(64)}`, `multicord-media://other/${id}`, `https://media/${id}`, "multicord-media://media/../favourites.json", "not a url"]) {
      expect((await favourites.serve(url)).status).toBe(404);
    }

    // An evicted file is fetched again once, however often it is asked for.
    favourites.clearCache();
    download.mockClear();
    const [a, b] = await Promise.all([favourites.serve(mediaUrl(id)), favourites.serve(mediaUrl(id))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("serves nothing for a favourite that cannot be had", async () => {
    const favourites = store();
    await favourites.handle({ type: "add", url: dataUrl(PNG), kind: "image", name: "Own" }, context);
    fs.rmSync(path.join(filesDir(), hash(PNG)));
    expect((await favourites.serve(mediaUrl(hash(PNG)))).status).toBe(404);
  });
});
