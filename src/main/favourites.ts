// The shell's favourites: an index (favourites.json) and one file per
// favourite, named by the SHA-256 of its bytes, in the user data folder.
// Only the shell reads them; native views see them as
// multicord-media://media/<id>, served from here.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Emitter } from "../shared/emitter";
import {
  FAVOURITE_KINDS,
  isCategoryId,
  isFavouriteId,
  MAX_CATEGORIES,
  MAX_CATEGORY_NAME,
  MAX_FAVOURITE_BYTES,
  MAX_FAVOURITE_NAME,
  MAX_FAVOURITES,
  MAX_MEDIA_URL,
  MEDIA_HOST,
  MEDIA_SCHEME,
  uploadName,
  type Favourite,
  type FavouriteCategory,
  type FavouriteKind,
  type FavouriteSource,
  type FavouritesAction,
  type FavouritesState,
  type FavouritesSummary,
  type MediaType,
} from "../shared/favourites";
import { checkUrl, readCapped, type UrlPolicy } from "./netPolicy";

const ascii = (bytes: Uint8Array, start: number, length: number): string => String.fromCharCode(...bytes.subarray(start, start + length));
const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean => prefix.every((b, i) => bytes[at + i] === b);

/** Whether a PNG has an animation control chunk before its image data (APNG). */
function apng(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = ascii(bytes, at + 4, 4);
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    at += 12 + length;
  }
  return false;
}

const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash", "mmp4"]);

/**
 * What a file really is, from its first bytes; undefined for anything that
 * is not a raster picture or an MP4 or WebM video. SVG never passes: it can
 * carry script.
 */
export function sniffMedia(bytes: Uint8Array): { mime: MediaType; animated: boolean } | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", animated: apng(bytes) };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", animated: false };
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") {
    // Animated GIFs carry a looping extension; a still one is a picture.
    const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString("latin1");
    return { mime: "image/gif", animated: text.includes("NETSCAPE2.0") || text.includes("ANIMEXTS1.0") };
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    // VP8X's flags say whether it is animated.
    return { mime: "image/webp", animated: ascii(bytes, 12, 4) === "VP8X" && ((bytes[20] ?? 0) & 0x02) !== 0 };
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", animated: brand === "avis" };
    if (MP4_BRANDS.has(brand)) return { mime: "video/mp4", animated: true };
    return undefined;
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) && ascii(bytes, 0, 64).includes("webm")) return { mime: "video/webm", animated: true };
  return undefined;
}

/** The bytes of a base64 data: URL; undefined when it is not one or is too large. */
export function dataUrlBytes(url: string): Uint8Array | undefined {
  const match = /^data:[a-z]+\/[a-z0-9.+-]+;base64,/.exec(url);
  if (!match) return undefined;
  const base64 = url.slice(match[0].length);
  if (base64.length > (MAX_FAVOURITE_BYTES / 3) * 4 + 4) return undefined;
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export type MediaFetch = (url: string, init: { method: "GET"; redirect: "follow"; credentials: "omit" }) => Promise<Response>;

/** Content types a server may name for what is saved; the bytes are sniffed afterwards either way. */
function acceptableType(header: string | null): boolean {
  const type = (header ?? "").split(";")[0]!.trim().toLowerCase();
  return (type.startsWith("image/") && !type.includes("svg")) || type === "video/mp4" || type === "video/webm";
}

/**
 * Downloads media for the favourites: https only, within the policy (public
 * hosts, and the module's own hosts where it has them), checked again after
 * redirects, of a picture or video type, and at most MAX_FAVOURITE_BYTES.
 * The fetch must keep no cookies; the caller polices each redirect's address.
 */
export async function downloadMedia(fetchImpl: MediaFetch, url: string, policy: UrlPolicy): Promise<Uint8Array> {
  const problem = checkUrl(url, policy);
  if (problem) throw new Error(`Not downloaded: ${problem}`);
  const response = await fetchImpl(url, { method: "GET", redirect: "follow", credentials: "omit" });
  const finalProblem = response.url ? checkUrl(response.url, policy) : undefined;
  const fail = async (message: string): Promise<never> => {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing more to read either way.
    }
    throw new Error(message);
  };
  if (finalProblem) return fail(`Not downloaded: ${finalProblem}`);
  if (!response.ok) return fail(`The server answered ${response.status}`);
  if (!acceptableType(response.headers.get("content-type"))) return fail("That is not a picture or a video");
  if (Number(response.headers.get("content-length") ?? 0) > MAX_FAVOURITE_BYTES) return fail(tooLarge);
  try {
    return await readCapped(response, MAX_FAVOURITE_BYTES);
  } catch {
    throw new Error(tooLarge);
  }
}

const tooLarge = `Larger than the ${MAX_FAVOURITE_BYTES / 1024 / 1024} MB a favourite may be`;

/** A file ready to hand to a module as an upload. */
export interface MediaFile {
  path: string;
  size: number;
  mime: MediaType;
  /** A clean file name with the type's extension. */
  name: string;
}

/** What the store needs from the shell. */
export interface FavouritesDeps {
  /** Downloads within the policy; see downloadMedia. */
  download(url: string, hosts: readonly string[] | undefined): Promise<Uint8Array>;
  now?(): number;
}

/** Who is asking: the native view's module, the hosts it may reach, and how to give its engine a file. */
export interface FavouritesContext {
  source: Omit<FavouriteSource, "place">;
  hosts?: readonly string[];
  share(file: MediaFile, replyTo: string | undefined): void;
}

type Stored = Omit<Favourite, "cached">;

const MEDIA_TYPES = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4", "video/webm"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const shortText = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : undefined);

/** A favourite from the index file, which anything on disk could have changed: undefined unless it is whole. */
function storedItem(value: unknown, categories: ReadonlySet<string>): Stored | undefined {
  if (!isRecord(value) || !isFavouriteId(value.id) || !(FAVOURITE_KINDS as readonly unknown[]).includes(value.kind)) return undefined;
  const name = shortText(value.name, MAX_FAVOURITE_NAME);
  const source = isRecord(value.source) ? value.source : undefined;
  const platform = shortText(source?.platform, 64);
  const label = shortText(source?.label, 8);
  const color = typeof source?.color === "string" && /^#[0-9a-f]{6}$/i.test(source.color) ? source.color : undefined;
  if (!name || typeof value.mime !== "string" || !MEDIA_TYPES.has(value.mime) || !platform || !label || !color) return undefined;
  const item: Stored = {
    id: value.id,
    kind: value.kind as FavouriteKind,
    name,
    mime: value.mime as MediaType,
    animated: value.animated === true,
    size: typeof value.size === "number" && Number.isInteger(value.size) && value.size > 0 ? Math.min(value.size, MAX_FAVOURITE_BYTES) : 0,
    categories: Array.isArray(value.categories) ? [...new Set(value.categories.filter((c): c is string => typeof c === "string" && categories.has(c)))] : [],
    source: { platform, label, color },
    addedAt: typeof value.addedAt === "number" && Number.isFinite(value.addedAt) ? value.addedAt : 0,
  };
  const place = shortText(source?.place, MAX_FAVOURITE_NAME);
  if (place) item.source.place = place;
  if (typeof value.origin === "string" && value.origin.startsWith("https://") && value.origin.length <= MAX_MEDIA_URL) item.origin = value.origin;
  return item;
}

/**
 * Favourites and their categories. The index is rewritten whole on every
 * change (write and rename, so a crash leaves the old one); files are
 * written once, named by their hash, and served only by id.
 */
export class FavouritesStore {
  readonly changed = new Emitter<void>();
  private categories: FavouriteCategory[] = [];
  private items: Stored[] = [];
  private readonly saving = new Set<string>();
  private error: string | undefined;
  /** Downloads of evicted files in progress, so a file is fetched once however often it is shown. */
  private readonly refetching = new Map<string, Promise<boolean>>();

  constructor(
    private readonly dir: string,
    private readonly deps: FavouritesDeps,
  ) {
    this.load();
  }

  private get indexFile(): string {
    return path.join(this.dir, "favourites.json");
  }

  private get filesDir(): string {
    return path.join(this.dir, "files");
  }

  /** Files sent but not kept, for the engine to read; emptied at every start. */
  private get tmpDir(): string {
    return path.join(this.dir, "tmp");
  }

  private fileOf(id: string): string {
    return path.join(this.filesDir, id);
  }

  private load(): void {
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.indexFile, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(raw)) return;
    const seen = new Set<string>();
    for (const value of Array.isArray(raw.categories) ? raw.categories : []) {
      const name = isRecord(value) ? shortText(value.name, MAX_CATEGORY_NAME) : undefined;
      if (!name || !isCategoryId(value.id) || seen.has(value.id) || this.categories.length >= MAX_CATEGORIES) continue;
      seen.add(value.id);
      this.categories.push({ id: value.id, name });
    }
    const ids = new Set<string>();
    for (const value of Array.isArray(raw.items) ? raw.items : []) {
      const item = storedItem(value, seen);
      if (!item || ids.has(item.id) || this.items.length >= MAX_FAVOURITES) continue;
      ids.add(item.id);
      this.items.push(item);
    }
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = `${this.indexFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, categories: this.categories, items: this.items }));
    fs.renameSync(temp, this.indexFile);
  }

  private cached(id: string): boolean {
    return fs.existsSync(this.fileOf(id));
  }

  /** What a native view of `module` gets. */
  state(module: FavouritesState["module"]): FavouritesState {
    const state: FavouritesState = {
      categories: this.categories.map((c) => ({ ...c })),
      items: this.items.map((item) => ({ ...item, categories: [...item.categories], source: { ...item.source }, cached: this.cached(item.id) })),
      module,
      saving: [...this.saving],
    };
    if (this.error) state.error = this.error;
    return state;
  }

  summary(): FavouritesSummary {
    return {
      categories: this.categories.map((c) => ({ ...c, count: this.items.filter((i) => i.categories.includes(c.id)).length })),
      items: this.items.length,
      cacheBytes: this.cacheBytes(),
      pinned: this.items.filter((i) => !i.origin).length,
    };
  }

  cacheBytes(): number {
    let total = 0;
    for (const item of this.items) {
      try {
        total += fs.statSync(this.fileOf(item.id)).size;
      } catch {
        // Not cached.
      }
    }
    return total;
  }

  /**
   * Drops cached files that can be downloaded again; favourites stay, and
   * their files come back the next time they are shown. Media only a module
   * could load (its own data: URLs) has no address to fetch again, so it stays.
   */
  clearCache(): void {
    for (const item of this.items) if (item.origin) fs.rmSync(this.fileOf(item.id), { force: true });
    this.changed.emit();
  }

  /** Carries out a view's action; a failure is kept in the state for the view to show. */
  async handle(action: FavouritesAction, context: FavouritesContext): Promise<void> {
    this.error = undefined;
    try {
      await this.run(action, context);
    } catch (error) {
      this.error = (error as Error).message;
    }
    this.changed.emit();
  }

  private async run(action: FavouritesAction, context: FavouritesContext): Promise<void> {
    switch (action.type) {
      case "add":
        return this.add(action, context);
      case "remove": {
        const before = this.items.length;
        this.items = this.items.filter((i) => i.id !== action.id);
        if (this.items.length === before) return;
        fs.rmSync(this.fileOf(action.id), { force: true });
        return this.save();
      }
      case "createCategory": {
        if (this.categories.length >= MAX_CATEGORIES) throw new Error(`At most ${MAX_CATEGORIES} categories.`);
        const id = randomBytes(8).toString("hex");
        this.categories.push({ id, name: action.name.trim() });
        const item = action.assign ? this.items.find((i) => i.id === action.assign) : undefined;
        if (item) item.categories.push(id);
        return this.save();
      }
      case "renameCategory": {
        const category = this.categories.find((c) => c.id === action.id);
        if (!category) return;
        category.name = action.name.trim();
        return this.save();
      }
      case "deleteCategory":
        // Its favourites stay, in their other categories.
        this.categories = this.categories.filter((c) => c.id !== action.id);
        for (const item of this.items) item.categories = item.categories.filter((c) => c !== action.id);
        return this.save();
      case "moveCategory": {
        const from = this.categories.findIndex((c) => c.id === action.id);
        if (from < 0) return;
        const [category] = this.categories.splice(from, 1);
        this.categories.splice(Math.min(action.index, this.categories.length), 0, category!);
        return this.save();
      }
      case "assign": {
        const item = this.items.find((i) => i.id === action.id);
        if (!item || !this.categories.some((c) => c.id === action.category)) return;
        item.categories = item.categories.filter((c) => c !== action.category);
        if (action.on) item.categories.push(action.category);
        return this.save();
      }
      case "send": {
        const item = this.items.find((i) => i.id === action.id);
        if (!item) throw new Error("That favourite is gone.");
        if (!(await this.ensureCached(item))) throw new Error(`${item.name} could not be loaded again.`);
        const file = this.fileOf(item.id);
        return context.share({ path: file, size: fs.statSync(file).size, mime: item.mime, name: uploadName(item.name, item.mime) }, action.replyTo);
      }
      case "sendMedia": {
        const { bytes, mime } = await this.fetchMedia(action.url, context.hosts);
        fs.mkdirSync(this.tmpDir, { recursive: true });
        const file = path.join(this.tmpDir, hashOf(bytes));
        fs.writeFileSync(file, bytes);
        return context.share({ path: file, size: bytes.length, mime, name: uploadName(action.name, mime) }, action.replyTo);
      }
    }
  }

  /** The bytes behind an https or data: URL, and what they really are. */
  private async fetchMedia(url: string, hosts: readonly string[] | undefined): Promise<{ bytes: Uint8Array; mime: MediaType; animated: boolean }> {
    const bytes = url.startsWith("data:") ? dataUrlBytes(url) : await this.deps.download(url, hosts);
    if (!bytes) throw new Error(tooLarge);
    if (bytes.length > MAX_FAVOURITE_BYTES) throw new Error(tooLarge);
    const sniffed = sniffMedia(bytes);
    if (!sniffed) throw new Error("Only pictures (PNG, JPEG, GIF, WebP, AVIF) and MP4 or WebM videos can be kept.");
    return { bytes, ...sniffed };
  }

  private async add(action: Extract<FavouritesAction, { type: "add" }>, context: FavouritesContext): Promise<void> {
    if (this.saving.has(action.url)) return;
    this.saving.add(action.url);
    this.changed.emit();
    try {
      const { bytes, mime, animated } = await this.fetchMedia(action.url, context.hosts);
      const id = hashOf(bytes);
      fs.mkdirSync(this.filesDir, { recursive: true });
      fs.writeFileSync(this.fileOf(id), bytes);
      const existing = this.items.find((i) => i.id === id);
      if (existing) return this.save();
      if (this.items.length >= MAX_FAVOURITES) {
        fs.rmSync(this.fileOf(id), { force: true });
        throw new Error(`At most ${MAX_FAVOURITES} favourites; remove some first.`);
      }
      // A still GIF is a picture; an animated picture is a GIF to the picker.
      const kind: FavouriteKind = action.kind === "sticker" ? "sticker" : animated ? "gif" : "image";
      const item: Stored = { id, kind, name: action.name.trim(), mime, animated, size: bytes.length, categories: [], source: { ...context.source }, addedAt: (this.deps.now ?? Date.now)() };
      if (action.place) item.source.place = action.place.trim();
      if (action.url.startsWith("https://")) item.origin = action.url;
      this.items.unshift(item);
      this.save();
    } finally {
      this.saving.delete(action.url);
    }
  }

  /** Downloads an evicted file again from where it was saved; false when it cannot be had. */
  private ensureCached(item: Stored): Promise<boolean> {
    if (this.cached(item.id)) return Promise.resolve(true);
    if (!item.origin) return Promise.resolve(false);
    let running = this.refetching.get(item.id);
    if (!running) {
      running = this.deps
        .download(item.origin, undefined)
        .then((bytes) => {
          // Only the same bytes: what the address serves now may have changed.
          if (hashOf(bytes) !== item.id) return false;
          fs.mkdirSync(this.filesDir, { recursive: true });
          fs.writeFileSync(this.fileOf(item.id), bytes);
          this.changed.emit();
          return true;
        })
        .catch(() => false)
        .finally(() => this.refetching.delete(item.id));
      this.refetching.set(item.id, running);
    }
    return running;
  }

  /**
   * Answers multicord-media://media/<id> for native views: a favourite's
   * file by its id, with its sniffed type, fetched again first if the cache
   * dropped it. Nothing else is reachable through it.
   */
  async serve(url: string): Promise<Response> {
    const headers = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "no-cache" };
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    const id = parsed?.pathname.slice(1);
    const item = parsed?.protocol === `${MEDIA_SCHEME}:` && parsed.host === MEDIA_HOST ? this.items.find((i) => i.id === id) : undefined;
    if (!item || !(await this.ensureCached(item))) return new Response("Not found", { status: 404, headers });
    const bytes = fs.readFileSync(this.fileOf(item.id));
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": item.mime, "Content-Length": String(bytes.length) } });
  }
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
