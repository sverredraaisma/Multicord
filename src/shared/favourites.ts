// Favourite GIFs, stickers and pictures: kept by the shell, never by a
// module. Native chat views (Multicord's own pages) read and change them
// through FAVOURITES_IPC; engines never see this channel, the store or its
// files. Everything a view sends is checked here before the main process
// uses it.

export const FAVOURITES_IPC = {
  /** Main -> native views: the favourites and their categories (FavouritesState). */
  state: "favourites:state",
  /** Native views -> main: a FavouritesAction. */
  action: "favourites:action",
} as const;

/** Cached favourites are served to native views as multicord-media://media/<id>, and nowhere else. */
export const MEDIA_SCHEME = "multicord-media";
export const MEDIA_HOST = "media";

export const MAX_FAVOURITES = 2000;
export const MAX_CATEGORIES = 100;
/** Largest file kept as a favourite or sent as a picture in place of a sticker. */
export const MAX_FAVOURITE_BYTES = 20 * 1024 * 1024;
export const MAX_FAVOURITE_NAME = 100;
export const MAX_CATEGORY_NAME = 40;
/** Longest https URL a view may hand in. */
export const MAX_MEDIA_URL = 2048;
/** Longest data: URL a view may hand in: MAX_FAVOURITE_BYTES in base64, plus its header. */
export const MAX_DATA_URL = Math.ceil(MAX_FAVOURITE_BYTES / 3) * 4 + 100;

/** What a favourite is, which decides the picker tab it shows in. */
export type FavouriteKind = "gif" | "sticker" | "image";
export const FAVOURITE_KINDS = ["gif", "sticker", "image"] as const satisfies readonly FavouriteKind[];

/** Raster pictures and the two video formats every platform plays; never SVG or anything that can run script. */
export type MediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "video/mp4" | "video/webm";

/** Where a favourite was saved from, shown with it. */
export interface FavouriteSource {
  /** The module's name, e.g. "Fluxer". */
  platform: string;
  /** The module's "#rrggbb" colour, for its badge. */
  color: string;
  /** Its short label, e.g. "FX". */
  label: string;
  /** The server, sticker pack or chat it came from, when the view knew it. */
  place?: string;
}

export interface FavouriteCategory {
  id: string;
  name: string;
}

export interface Favourite {
  /** The SHA-256 of its bytes, hex: the same file saved twice is one favourite. */
  id: string;
  kind: FavouriteKind;
  name: string;
  /** Its sniffed type, never what a server claimed. */
  mime: MediaType;
  animated: boolean;
  size: number;
  /** Category ids, in no particular order. */
  categories: string[];
  source: FavouriteSource;
  addedAt: number;
  /** The https address it was saved from: it can be downloaded again after the cache was cleared. */
  origin?: string;
  /** Its file is on disk now. */
  cached: boolean;
}

/** What a native view gets. */
export interface FavouritesState {
  /** In the order the user gave them. */
  categories: FavouriteCategory[];
  /** Newest first. */
  items: Favourite[];
  /** The module of the view this is sent to, for badges on its own emoji and stickers. */
  module: { name: string; label: string; color: string };
  /** Addresses being saved right now, so the view can show progress. */
  saving: string[];
  /** The last thing that could not be done, e.g. a file too large. */
  error?: string;
}

/** What Settings shows. */
export interface FavouritesSummary {
  categories: { id: string; name: string; count: number }[];
  items: number;
  /** Bytes of cached files on disk. */
  cacheBytes: number;
  /** Favourites the cache cannot drop, as nothing could download them again (media a module loaded itself). */
  pinned: number;
}

/** Where media comes from: an https address or bytes the view already has (a data: URL). */
export type MediaUrl = string;

export type FavouritesAction =
  /** Keep this picture, GIF or sticker. */
  | { type: "add"; url: MediaUrl; kind: FavouriteKind; name: string; place?: string }
  | { type: "remove"; id: string }
  | { type: "createCategory"; name: string; /** Put this favourite in it at once. */ assign?: string }
  | { type: "renameCategory"; id: string; name: string }
  | { type: "deleteCategory"; id: string }
  /** Moves a category to a new place in the order. */
  | { type: "moveCategory"; id: string; index: number }
  /** Puts a favourite in a category, or takes it out. */
  | { type: "assign"; id: string; category: string; on: boolean }
  /** Sends a favourite into the open conversation, as a file through the module's own upload. */
  | { type: "send"; id: string; replyTo?: string }
  /** Sends media the view shows (a sticker that cannot go natively) as a file, the same way. */
  | { type: "sendMedia"; url: MediaUrl; name: string; replyTo?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;

export const isFavouriteId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const isCategoryId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
/** A message id as NativeAction takes it: a snowflake or a ULID. */
const isMessageId = (value: unknown): boolean => typeof value === "string" && /^(\d{1,20}|[0-9A-HJKMNP-TV-Z]{26})$/.test(value);

/** An https address or a base64 data: URL of an image or video, within the length caps. */
export function isMediaUrl(value: unknown): value is MediaUrl {
  if (typeof value !== "string") return false;
  if (value.startsWith("https://")) return value.length <= MAX_MEDIA_URL;
  return value.length <= MAX_DATA_URL && /^data:(image|video)\/[a-z0-9.+-]{1,40};base64,[A-Za-z0-9+/]+={0,2}$/.test(value.slice(0, 200)) && /^[A-Za-z0-9+/]*={0,2}$/.test(value.slice(value.indexOf(",") + 1));
}

export function isFavouritesAction(value: unknown): value is FavouritesAction {
  if (!isRecord(value)) return false;
  const reply = value.replyTo === undefined || isMessageId(value.replyTo);
  switch (value.type) {
    case "add":
      return isMediaUrl(value.url) && (FAVOURITE_KINDS as readonly unknown[]).includes(value.kind) && isText(value.name, MAX_FAVOURITE_NAME) && (value.place === undefined || isText(value.place, MAX_FAVOURITE_NAME));
    case "remove":
      return isFavouriteId(value.id);
    case "createCategory":
      return isText(value.name, MAX_CATEGORY_NAME) && (value.assign === undefined || isFavouriteId(value.assign));
    case "renameCategory":
      return isCategoryId(value.id) && isText(value.name, MAX_CATEGORY_NAME);
    case "deleteCategory":
      return isCategoryId(value.id);
    case "moveCategory":
      return isCategoryId(value.id) && typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0 && value.index < MAX_CATEGORIES;
    case "assign":
      return isFavouriteId(value.id) && isCategoryId(value.category) && typeof value.on === "boolean";
    case "send":
      return isFavouriteId(value.id) && reply;
    case "sendMedia":
      return isMediaUrl(value.url) && isText(value.name, MAX_FAVOURITE_NAME) && reply;
    default:
      return false;
  }
}

/** The address a native view loads a cached favourite from. */
export function mediaUrl(id: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${id}`;
}

const EXTENSIONS: Record<MediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** A file name for an upload: the name cut to letters, digits and a few marks, with the type's extension. */
export function uploadName(name: string, mime: MediaType): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "_").slice(0, 60) || "media";
  return `${base}.${EXTENSIONS[mime]}`;
}
