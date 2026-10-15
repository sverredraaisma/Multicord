// Simplified sliding sync (MSC4186): the request Multicord makes, and its
// response as the same MxSync classic /v3/sync gives (events.ts), so the
// adapter handles both alike. Each room is put into the shape of a classic
// sync's joined room and read by events.ts's parseRoom, with all its checks.
//
// Everything this sync needs to continue is in the token it returns: the
// connection's position, and where the to-device and sticky event streams
// got to. The adapter passes a token back only once it handled the sync, so
// to-device messages are acknowledged (and deleted by the server) only after
// the crypto library has them, as with classic sync's next_batch.

import type { MxRoomUpdate, MxSync } from "./api";
import { accountPacks, CALL_MEMBER_TYPE, eventId, isRecord, MAX_EVENTS, MAX_ROOMS, MAX_TOKEN, parseCryptoSync, parseDirects, parseRoom, ROOM_PACK_TYPE, roomId } from "./events";

/** What /versions lists (unstable_features) when the homeserver has simplified sliding sync. */
export const SLIDING_SYNC_FEATURE = "org.matrix.simplified_msc3575";
export const SLIDING_SYNC_PATH = "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync";
/** Sticky events over sliding sync (MSC4480, named after MSC4354): call memberships. */
export const STICKY_EXTENSION = "org.matrix.msc4354.sticky_events";
/** Events per room in a sync: enough to show the latest messages, few enough for a fast start. */
export const SLIDING_TIMELINE_LIMIT = 10;
/** Rooms per list in the first response, which the rail shows first; the next asks for all. */
export const FIRST_WINDOW = 50;
/** Rooms per list after that: with both lists, as many rooms as classic sync's are read. */
export const FULL_WINDOW = MAX_ROOMS / 2;
/** Keeps Multicord's connection apart from another client's on the same device (a copied access token). */
export const CONNECTION_ID = "multicord";
/** To-device messages and sticky events per response, as matrix-js-sdk asks; the rest come with the next. */
export const EXTENSION_LIMIT = 100;
/** Global account data events looked through for m.direct and image packs (sliding sync cannot narrow them by type). */
const MAX_ACCOUNT_DATA = 1000;

/**
 * The state each room comes with: what names, pictures and sorts it, its
 * encryption, space structure and call memberships. DMs come with all their
 * members (they have few), for the other person's name and picture; other
 * rooms with the senders of their events, and our own membership.
 */
const ROOM_STATE = [
  ["m.room.name", ""],
  ["m.room.canonical_alias", ""],
  ["m.room.avatar", ""],
  ["m.room.encryption", ""],
  ["m.room.history_visibility", ""],
  ["m.room.create", ""],
  ["m.space.child", "*"],
  [CALL_MEMBER_TYPE, "*"],
  // Image packs: the room's emoji and stickers, and those of rooms the user enabled everywhere.
  [ROOM_PACK_TYPE, "*"],
];
const DM_MEMBERS = [["m.room.member", "*"]];
const LAZY_MEMBERS = [
  ["m.room.member", "$LAZY"],
  ["m.room.member", "$ME"],
];

/** Where a sliding sync connection is: its position, and the to-device and sticky event streams' tokens. */
export interface SlidingPosition {
  pos?: string;
  toDevice?: string;
  sticky?: string;
}

const TOKEN_TAG = "mc-sss";
const token = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= MAX_TOKEN;

/** A position as one opaque token, for the adapter to pass back. */
export function slidingToken(position: SlidingPosition & { pos: string }): string {
  return JSON.stringify([TOKEN_TAG, position.pos, position.toDevice ?? null, position.sticky ?? null]);
}

/** The position in a token slidingToken made; undefined for anything else. */
export function parseSlidingToken(value: string): SlidingPosition | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== TOKEN_TAG || !token(parts[1])) return undefined;
  const position: SlidingPosition = { pos: parts[1] };
  if (token(parts[2])) position.toDevice = parts[2];
  if (token(parts[3])) position.sticky = parts[3];
  return position;
}

export interface SlidingRequestOptions {
  /** Ask for to-device messages and key changes: only for a device of our own (see MxSession.ownDevice). */
  encryption: boolean;
  /** Ask for sticky events: the homeserver has them (MSC4354). */
  sticky: boolean;
}

/**
 * The request body. Two lists, DMs and other rooms, newest first, without
 * invites (which Multicord does not show). A new connection asks for the
 * first rooms of each, then for all; sticky events from then on, when every
 * room they can be for has been sent.
 */
export function slidingRequest(position: SlidingPosition, options: SlidingRequestOptions): Record<string, unknown> {
  const end = (position.pos ? FULL_WINDOW : FIRST_WINDOW) - 1;
  const list = (dm: boolean) => ({
    ranges: [[0, end]],
    timeline_limit: SLIDING_TIMELINE_LIMIT,
    required_state: [...ROOM_STATE, ...(dm ? DM_MEMBERS : LAZY_MEMBERS)],
    filters: { is_dm: dm, is_invite: false },
  });
  // Global account data only (the DM list, image packs); room account data is not used.
  // Receipts for our own read receipts: unread counts are left to the client.
  const extensions: Record<string, unknown> = { account_data: { enabled: true, lists: [], rooms: [] }, typing: { enabled: true }, receipts: { enabled: true } };
  if (options.encryption) {
    extensions.e2ee = { enabled: true };
    extensions.to_device = { enabled: true, limit: EXTENSION_LIMIT, ...(position.toDevice ? { since: position.toDevice } : {}) };
  }
  if (options.sticky && position.pos) extensions[STICKY_EXTENSION] = { enabled: true, limit: EXTENSION_LIMIT, ...(position.sticky ? { since: position.sticky } : {}) };
  return { conn_id: CONNECTION_ID, lists: { dms: list(true), rooms: list(false) }, extensions };
}

export interface SlidingContext {
  userId: string;
  /** Joined rooms this connection has sent, so extension data for any other room is dropped; kept up to date here. */
  known: Set<string>;
  /** to-device messages and key changes were asked for. */
  encryption: boolean;
}

const events = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, MAX_EVENTS) : []);

/** Our latest membership among these events, if they have one. */
function ownMembership(list: unknown[], userId: string): string | undefined {
  let membership: string | undefined;
  for (const event of list) {
    if (isRecord(event) && event.type === "m.room.member" && event.state_key === userId && isRecord(event.content) && typeof event.content.membership === "string") {
      membership = event.content.membership;
    }
  }
  return membership;
}

/**
 * Our latest read receipt in an m.receipt event (public or private, not in
 * a thread), by when we read; undefined when it has none of ours.
 */
function ownRead(receipt: unknown, userId: string): { id: string; ts: number } | undefined {
  if (!isRecord(receipt) || receipt.type !== "m.receipt" || !isRecord(receipt.content)) return undefined;
  let latest: { id: string; ts: number } | undefined;
  for (const [id, kinds] of Object.entries(receipt.content).slice(0, MAX_EVENTS)) {
    if (!eventId(id) || !isRecord(kinds)) continue;
    for (const kind of ["m.read", "m.read.private"]) {
      const users = kinds[kind];
      // User ids start with "@": no key of Object.prototype.
      const mine = isRecord(users) ? users[userId] : undefined;
      if (!isRecord(mine) || (mine.thread_id !== undefined && mine.thread_id !== "main")) continue;
      const ts = typeof mine.ts === "number" && Number.isSafeInteger(mine.ts) && mine.ts > 0 ? mine.ts : 0;
      if (!latest || ts >= latest.ts) latest = { id, ts };
    }
  }
  return latest;
}

/** An extension's per-room data (typing, receipts, sticky events), by valid room id. */
function byRoom(extension: unknown): Map<string, unknown> {
  const rooms = isRecord(extension) && isRecord(extension.rooms) ? extension.rooms : {};
  return new Map(Object.entries(rooms).slice(0, MAX_ROOMS).filter(([id]) => roomId(id)));
}

/**
 * A sliding sync response as an MxSync, whose token continues after it.
 * `position` is what the request was sent with. Rooms we left come as
 * `left`; invites and knocks are skipped. Rooms are `initial` when the
 * connection sends them in full (all of them, on a new connection), with
 * `limited` set, as what they bring may not join up with what was known.
 */
export function parseSlidingSync(raw: unknown, position: SlidingPosition, context: SlidingContext): MxSync {
  if (!isRecord(raw) || !token(raw.pos)) throw new Error("The homeserver sent an unreadable sync response");
  const fresh = position.pos === undefined;
  if (fresh) context.known.clear();
  const extensions = isRecord(raw.extensions) ? raw.extensions : {};
  const typing = byRoom(extensions.typing);
  const sticky = byRoom(extensions[STICKY_EXTENSION]);
  const receipts = byRoom(extensions.receipts);
  const ephemeral = (id: string) => (typing.has(id) ? { events: [typing.get(id)] } : undefined);
  /** The room as parseRoom reads it, with what the extensions say about it; and our read receipt. */
  const update = (id: string, classic: Record<string, unknown>): MxRoomUpdate => {
    const parsed = parseRoom(id, { ...classic, ephemeral: ephemeral(id), msc4354_sticky: sticky.get(id) });
    const read = ownRead(receipts.get(id), context.userId);
    if (read) parsed.read = read;
    return parsed;
  };
  // Synapse sends every room's unread counts as zero: the adapter counts them.
  const sync: MxSync = { nextBatch: "", joined: [], left: [], countUnread: true };
  const seen = new Set<string>();

  const rooms = isRecord(raw.rooms) ? raw.rooms : {};
  for (const [id, room] of Object.entries(rooms).slice(0, MAX_ROOMS)) {
    if (!roomId(id) || !isRecord(room) || room.invite_state !== undefined || room.knock_state !== undefined) continue;
    const required = events(room.required_state);
    const timeline = events(room.timeline);
    // The required state is the room's state now; the timeline says what changed on the way.
    const membership = ownMembership(required, context.userId) ?? ownMembership(timeline, context.userId);
    if (membership === "leave" || membership === "ban") {
      sync.left.push(id);
      context.known.delete(id);
      continue;
    }
    if (membership !== undefined && membership !== "join") continue;
    seen.add(id);
    const initial = fresh || room.initial === true;
    const classic: Record<string, unknown> = {
      state: { events: required },
      timeline: { events: timeline, limited: initial || room.limited === true, prev_batch: room.prev_batch },
    };
    if (Array.isArray(room.heroes)) classic.summary = { "m.heroes": room.heroes.map((hero) => (isRecord(hero) ? hero.user_id : undefined)) };
    const joined = update(id, classic);
    if (initial) joined.initial = true;
    sync.joined.push(joined);
    context.known.add(id);
  }
  // Typing, receipts and sticky events for rooms the response did not otherwise carry, if they were sent before.
  for (const id of new Set([...typing.keys(), ...receipts.keys(), ...sticky.keys()])) {
    if (!seen.has(id) && context.known.has(id)) sync.joined.push(update(id, {}));
  }

  const accountData = isRecord(extensions.account_data) ? extensions.account_data : {};
  const global = Array.isArray(accountData.global) ? accountData.global.slice(0, MAX_ACCOUNT_DATA) : [];
  const direct = global.find((e) => isRecord(e) && e.type === "m.direct");
  if (isRecord(direct)) sync.directs = parseDirects(direct.content);
  accountPacks(global, sync);

  const next: SlidingPosition & { pos: string } = { pos: raw.pos };
  if (context.encryption) {
    const toDevice = isRecord(extensions.to_device) ? extensions.to_device : {};
    const e2ee = isRecord(extensions.e2ee) ? extensions.e2ee : {};
    const crypto = parseCryptoSync({ ...e2ee, to_device: { events: toDevice.events } });
    crypto.sliding = true;
    // A new connection says nothing of device lists changed before it.
    if (fresh) crypto.stale = true;
    sync.crypto = crypto;
    if (token(toDevice.next_batch)) next.toDevice = toDevice.next_batch;
  }
  next.toDevice ??= position.toDevice;
  const stickyExtension = extensions[STICKY_EXTENSION];
  // Sent only when it changed.
  next.sticky = isRecord(stickyExtension) && token(stickyExtension.next_batch) ? stickyExtension.next_batch : position.sticky;
  sync.nextBatch = slidingToken(next);
  return sync;
}
