// Turns the homeserver's JSON into the plain data of api.ts. Everything from
// the network is untrusted: ids, names and bodies are checked for type and
// length, and whatever does not fit is dropped rather than passed on.

import type { MxCallMember, MxContent, MxCryptoSync, MxEncryption, MxEvent, MxMember, MxPage, MxRoomState, MxRoomUpdate, MxSync } from "./api";

/** Room ids are used in rail keys (at most 200 characters with the instance prefix). */
export const MAX_ROOM_ID = 150;
const MAX_ID = 255;
export const MAX_NAME = 100;
/** Longest message text kept; Matrix allows 64 KiB events. */
export const MAX_BODY = 4000;
const MAX_TOKEN = 4096;
const MAX_ROOMS = 2000;
const MAX_EVENTS = 1000;
const MAX_MENTIONS = 100;
const MAX_HEROES = 5;
const MAX_COUNT = 1_000_000;
/** Matrix events are at most 64 KiB; a larger one is not passed to the crypto library. */
export const MAX_EVENT_JSON = 65_536;
const MAX_TO_DEVICE = 1000;
/** Users in a device list change, and members of a room taken for key sharing. */
const MAX_USERS = 20_000;
const MAX_SESSION_ID = 128;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const bounded = (value: unknown, prefix: string, max: number): string | undefined =>
  typeof value === "string" && value.length > 1 && value.length <= max && value.startsWith(prefix) ? value : undefined;

export const roomId = (value: unknown): string | undefined => bounded(value, "!", MAX_ROOM_ID);
export const eventId = (value: unknown): string | undefined => bounded(value, "$", MAX_ID);
export const userId = (value: unknown): string | undefined => {
  const id = bounded(value, "@", MAX_ID);
  return id?.includes(":") ? id : undefined;
};

const MXC = /^mxc:\/\/([A-Za-z0-9.:[\]-]{1,255})\/([A-Za-z0-9_-]{1,255})$/;

/** An mxc:// URI's server name and media id, when it is well formed. */
export function parseMxc(value: unknown): { server: string; media: string } | undefined {
  const match = typeof value === "string" ? MXC.exec(value) : null;
  return match ? { server: match[1]!, media: match[2]! } : undefined;
}

/** A display name or room name: control characters removed, trimmed, cut to length. */
export function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Bidirectional overrides too: a name must not reorder the text around it.
  const name = value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim();
  return name === "" ? undefined : name.slice(0, MAX_NAME);
}

const count = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, MAX_COUNT) : 0);
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const clip = (text: string): string => (text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text);

/**
 * Removes a reply's quoted fallback ("> <@ana:x> original" lines and the
 * blank line after them); the reply preview shows the original instead.
 */
export function stripReplyFallback(body: string): string {
  const lines = body.split("\n");
  let start = 0;
  while (start < lines.length && lines[start]!.startsWith(">")) start++;
  if (start === 0) return body;
  if (lines[start] === "") start++;
  return lines.slice(start).join("\n");
}

/** Text and media label of an m.room.message (or m.sticker) content; undefined when it has no body. */
export function parseContent(content: Record<string, unknown>, sticker = false): MxContent | undefined {
  if (typeof content.body !== "string") return undefined;
  if (sticker) return { msgtype: "m.sticker", text: "", media: "🙂 Sticker" };
  if (typeof content.msgtype !== "string") return undefined;
  const msgtype = content.msgtype.slice(0, 64);
  const body = clip(content.body);
  // With a separate filename, the body of a media message is its caption.
  const filename = typeof content.filename === "string" ? clip(content.filename) : undefined;
  const caption = filename !== undefined && filename !== body ? body : "";
  switch (msgtype) {
    case "m.image":
      return { msgtype, text: caption, media: "📷 Image" };
    case "m.video":
      return { msgtype, text: caption, media: "🎥 Video" };
    case "m.audio":
      return { msgtype, text: caption, media: content["org.matrix.msc3245.voice"] !== undefined ? "🎤 Voice message" : "🎵 Audio" };
    case "m.file":
      return { msgtype, text: caption, media: `📎 ${(filename ?? body) || "File"}` };
    case "m.location":
      return { msgtype, text: "", media: "📍 Location" };
    default:
      // m.text, m.notice, m.emote, and unknown types, which fall back to their body.
      return { msgtype, text: body };
  }
}

function mentionsOf(content: Record<string, unknown>): string[] | undefined {
  const mentions = content["m.mentions"];
  if (!isRecord(mentions)) return undefined;
  return list(mentions.user_ids, MAX_MENTIONS).flatMap((id) => userId(id) ?? []);
}

/** A timeline event, or undefined for state events and types not shown. */
export function parseEvent(raw: unknown): MxEvent | undefined {
  if (!isRecord(raw) || raw.state_key !== undefined) return undefined;
  const id = eventId(raw.event_id);
  const sender = userId(raw.sender);
  const ts = raw.origin_server_ts;
  if (!id || !sender || typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) return undefined;
  const base = { id, sender, ts };
  const content = isRecord(raw.content) ? raw.content : {};
  if (isRecord(raw.unsigned) && raw.unsigned.redacted_because !== undefined) return { kind: "redacted", ...base };
  switch (raw.type) {
    case "m.room.encrypted": {
      const event: MxEvent = { kind: "encrypted", ...base };
      const json = JSON.stringify(raw);
      if (json.length <= MAX_EVENT_JSON) event.raw = json;
      if (typeof content.session_id === "string" && content.session_id !== "" && content.session_id.length <= MAX_SESSION_ID) event.sessionId = content.session_id;
      // Relations stay readable on encrypted events, so an edit is known as one before it is decrypted.
      const relates = isRecord(content["m.relates_to"]) ? content["m.relates_to"] : {};
      const replaces = relates.rel_type === "m.replace" ? eventId(relates.event_id) : undefined;
      if (replaces) event.replaces = replaces;
      return event;
    }
    case "m.room.redaction": {
      // Room version 11 moved `redacts` into the content.
      const redacts = eventId(content.redacts) ?? eventId(raw.redacts);
      return redacts ? { kind: "redaction", ...base, redacts } : undefined;
    }
    case "m.room.message":
    case "m.sticker": {
      const sticker = raw.type === "m.sticker";
      const relates = isRecord(content["m.relates_to"]) ? content["m.relates_to"] : {};
      if (relates.rel_type === "m.replace") {
        const target = eventId(relates.event_id);
        const fresh = isRecord(content["m.new_content"]) ? content["m.new_content"] : undefined;
        const parsed = fresh && parseContent(fresh, sticker);
        if (!target || !parsed) return undefined;
        return { kind: "message", ...base, content: parsed, mentions: mentionsOf(fresh), replaces: target };
      }
      const parsed = parseContent(content, sticker);
      // A message without a body has had its content removed.
      if (!parsed) return { kind: "redacted", ...base };
      const event: MxEvent = { kind: "message", ...base, content: parsed, mentions: mentionsOf(content) };
      const replyTo = isRecord(relates["m.in_reply_to"]) ? eventId(relates["m.in_reply_to"].event_id) : undefined;
      if (replyTo) {
        event.replyTo = replyTo;
        parsed.text = stripReplyFallback(parsed.text);
      }
      return event;
    }
    default:
      return undefined;
  }
}

export const emptyState = (): MxRoomState => ({ members: {} });

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);

/** An m.room.encryption content; an algorithm we cannot name stays "", which nothing encrypts with. */
export function parseEncryption(content: Record<string, unknown>): MxEncryption {
  const encryption: MxEncryption = { algorithm: typeof content.algorithm === "string" && content.algorithm.length <= 64 ? content.algorithm : "" };
  const rotationMs = positive(content.rotation_period_ms);
  const rotationMsgs = positive(content.rotation_period_msgs);
  if (rotationMs) encryption.rotationMs = rotationMs;
  if (rotationMsgs) encryption.rotationMsgs = rotationMsgs;
  return encryption;
}

/**
 * Applies a state event to `state`. A cleared name, alias or avatar becomes
 * "". Any m.room.encryption event marks the room encrypted, even a
 * malformed one: it is never safe to assume less.
 */
export function applyState(state: MxRoomState, raw: unknown): void {
  if (!isRecord(raw) || typeof raw.state_key !== "string") return;
  const content = isRecord(raw.content) ? raw.content : {};
  const global = raw.state_key === "";
  switch (raw.type) {
    case "m.room.encryption":
      state.encrypted = true;
      if (global) state.encryption = parseEncryption(content);
      return;
    case "m.room.history_visibility":
      if (global && typeof content.history_visibility === "string") state.history = content.history_visibility.slice(0, 32);
      return;
    case "m.room.name":
      if (global) state.name = cleanName(content.name) ?? "";
      return;
    case "m.room.canonical_alias":
      if (global) state.alias = cleanName(content.alias) ?? "";
      return;
    case "m.room.avatar":
      if (global) state.avatar = parseMxc(content.url) ? (content.url as string) : "";
      return;
    case "m.room.member": {
      const user = userId(raw.state_key);
      if (!user) return;
      const member: MxMember = { membership: typeof content.membership === "string" ? content.membership.slice(0, 32) : "leave" };
      const name = cleanName(content.displayname);
      if (name) member.name = name;
      if (parseMxc(content.avatar_url)) member.avatar = content.avatar_url as string;
      state.members[user] = member;
      return;
    }
  }
}

// --- Calls (MatrixRTC) ------------------------------------------------------------

/** The call membership state event Element Call sends, one per device (MSC3401/MSC4143). */
export const CALL_MEMBER_TYPE = "org.matrix.msc3401.call.member";
/** A membership counts this long after it started unless its device renews it, as Element Call's default. */
export const CALL_MEMBERSHIP_EXPIRY_MS = 4 * 3600 * 1000;
/** Longest lifetime a membership may claim; calls renew long before this. */
const MAX_CALL_EXPIRES_MS = 7 * 24 * 3600 * 1000;
const MAX_STATE_KEY = 600;
const MAX_SERVICE_URL = 2048;
const MAX_FOCI = 10;
/** Calls with more devices than this show only the first ones. */
export const MAX_CALL_MEMBERS = 100;

/** A LiveKit service URL: https, no credentials, query or fragment, no trailing slash (paths are appended to it). */
export function serviceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SERVICE_URL) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** The LiveKit services in a list of MatrixRTC transports (foci), in order, without repeats. */
export function liveKitServices(value: unknown): string[] {
  const urls = list(value, MAX_FOCI).flatMap((focus) => (isRecord(focus) && focus.type === "livekit" ? (serviceUrl(focus.livekit_service_url) ?? []) : []));
  return [...new Set(urls)];
}

const timestamp = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * A call membership state event: its state key, and the membership, or null
 * when the device left (empty content) or the event is not a membership of
 * the room's call (another application, a breakout call, a malformed or the
 * deprecated "memberships" form). Undefined when it is no such event.
 */
export function parseCallMember(raw: unknown): { stateKey: string; member: MxCallMember | null } | undefined {
  if (!isRecord(raw) || raw.type !== CALL_MEMBER_TYPE || typeof raw.state_key !== "string" || raw.state_key.length > MAX_STATE_KEY) return undefined;
  const stateKey = raw.state_key;
  const user = userId(raw.sender);
  const ts = timestamp(raw.origin_server_ts);
  const content = isRecord(raw.content) ? raw.content : {};
  const { device_id: deviceId, focus_active: active, created_ts: created, expires } = content;
  const valid =
    user !== undefined &&
    ts !== undefined &&
    content.application === "m.call" &&
    content.call_id === "" &&
    (content.scope === undefined || content.scope === "m.room") &&
    typeof deviceId === "string" &&
    deviceId !== "" &&
    deviceId.length <= MAX_ID &&
    isRecord(active) &&
    typeof active.type === "string" &&
    (created === undefined || timestamp(created) !== undefined) &&
    (expires === undefined || (typeof expires === "number" && Number.isFinite(expires) && expires > 0));
  if (!valid) return { stateKey, member: null };
  const createdTs = (created as number | undefined) ?? ts;
  const member: MxCallMember = { user, deviceId, createdTs, expiresAt: createdTs + Math.min((expires as number | undefined) ?? CALL_MEMBERSHIP_EXPIRY_MS, MAX_CALL_EXPIRES_MS) };
  const [focus] = liveKitServices(content.foci_preferred);
  if (focus) member.focus = focus;
  const intent = content["m.call.intent"];
  if (typeof intent === "string" && intent !== "" && intent.length <= 32) member.intent = intent;
  return { stateKey, member };
}

function parseRoom(id: string, raw: Record<string, unknown>): MxRoomUpdate {
  const state = emptyState();
  // A Map: state keys are the sender's to choose, "__proto__" included.
  const calls = new Map<string, MxCallMember | null>();
  const call = (event: unknown): void => {
    const parsed = parseCallMember(event);
    if (parsed && (calls.has(parsed.stateKey) || calls.size < MAX_CALL_MEMBERS * 2)) calls.set(parsed.stateKey, parsed.member);
  };
  for (const event of list(isRecord(raw.state) ? raw.state.events : undefined, MAX_EVENTS)) {
    applyState(state, event);
    call(event);
  }
  const timelineRaw = isRecord(raw.timeline) ? raw.timeline : {};
  const timeline: MxEvent[] = [];
  for (const event of list(timelineRaw.events, MAX_EVENTS)) {
    // State changes can arrive in the timeline too; they apply in order.
    applyState(state, event);
    call(event);
    const parsed = parseEvent(event);
    if (parsed) timeline.push(parsed);
  }
  const update: MxRoomUpdate = { roomId: id, state, timeline, limited: timelineRaw.limited === true };
  if (calls.size) update.calls = calls;
  if (typeof timelineRaw.prev_batch === "string" && timelineRaw.prev_batch.length <= MAX_TOKEN) update.prevBatch = timelineRaw.prev_batch;
  if (isRecord(raw.unread_notifications)) {
    update.unread = { notifications: count(raw.unread_notifications.notification_count), highlights: count(raw.unread_notifications.highlight_count) };
  }
  if (isRecord(raw.summary) && Array.isArray(raw.summary["m.heroes"])) {
    update.heroes = list(raw.summary["m.heroes"], MAX_HEROES).flatMap((u) => userId(u) ?? []);
  }
  return update;
}

/** The m.direct account data: user id -> their DM room ids. */
function parseDirects(content: unknown): Record<string, string[]> {
  const directs: Record<string, string[]> = {};
  if (!isRecord(content)) return directs;
  for (const [user, rooms] of Object.entries(content).slice(0, MAX_ROOMS)) {
    if (!userId(user)) continue;
    const ids = list(rooms, MAX_ROOMS).flatMap((r) => roomId(r) ?? []);
    if (ids.length) directs[user] = ids;
  }
  return directs;
}

export function parseSync(raw: unknown): MxSync {
  if (!isRecord(raw) || typeof raw.next_batch !== "string" || raw.next_batch === "" || raw.next_batch.length > MAX_TOKEN) {
    throw new Error("The homeserver sent an unreadable sync response");
  }
  const sync: MxSync = { nextBatch: raw.next_batch, joined: [], left: [] };
  const direct = list(isRecord(raw.account_data) ? raw.account_data.events : undefined, 100).find((e) => isRecord(e) && e.type === "m.direct");
  if (isRecord(direct)) sync.directs = parseDirects(direct.content);
  const rooms = isRecord(raw.rooms) ? raw.rooms : {};
  const join = isRecord(rooms.join) ? rooms.join : {};
  for (const [id, room] of Object.entries(join).slice(0, MAX_ROOMS)) {
    if (roomId(id) && isRecord(room)) sync.joined.push(parseRoom(id, room));
  }
  const leave = isRecord(rooms.leave) ? rooms.leave : {};
  sync.left = Object.keys(leave).slice(0, MAX_ROOMS).filter((id) => roomId(id));
  sync.crypto = parseCryptoSync(raw);
  return sync;
}

const users = (value: unknown): string[] => list(value, MAX_USERS).flatMap((u) => userId(u) ?? []);

/**
 * The encryption parts of a sync. To-device events are only checked for
 * their outline (the crypto library parses them itself) and dropped when
 * oversized; key counts must be counts.
 */
export function parseCryptoSync(raw: Record<string, unknown>): MxCryptoSync {
  const toDevice = list(isRecord(raw.to_device) ? raw.to_device.events : undefined, MAX_TO_DEVICE).filter(
    (event) =>
      isRecord(event) &&
      typeof event.type === "string" &&
      event.type.length <= 255 &&
      userId(event.sender) !== undefined &&
      isRecord(event.content) &&
      JSON.stringify(event).length <= MAX_EVENT_JSON,
  );
  const lists = isRecord(raw.device_lists) ? raw.device_lists : {};
  const oneTimeKeys: Record<string, number> = {};
  const counts = isRecord(raw.device_one_time_keys_count) ? raw.device_one_time_keys_count : {};
  for (const [algorithm, value] of Object.entries(counts).slice(0, 20)) {
    if (algorithm.length <= 64 && typeof value === "number" && Number.isInteger(value) && value >= 0) oneTimeKeys[algorithm] = Math.min(value, MAX_COUNT);
  }
  const crypto: MxCryptoSync = { toDevice: JSON.stringify(toDevice), changed: users(lists.changed), left: users(lists.left), oneTimeKeys };
  const fallback = raw.device_unused_fallback_key_types ?? raw["org.matrix.msc2732.device_unused_fallback_key_types"];
  if (Array.isArray(fallback)) crypto.fallbackKeys = list(fallback, 20).filter((t): t is string => typeof t === "string" && t.length <= 64);
  return crypto;
}

/** The joined and invited members in a /members response. */
export function parseMembers(raw: unknown): string[] {
  const members = new Set<string>();
  for (const event of list(isRecord(raw) ? raw.chunk : undefined, MAX_USERS)) {
    if (!isRecord(event) || event.type !== "m.room.member" || !isRecord(event.content)) continue;
    const user = userId(event.state_key);
    if (user && (event.content.membership === "join" || event.content.membership === "invite")) members.add(user);
  }
  return [...members];
}

/** A /messages page (dir=b): Matrix sends it newest first. */
export function parsePage(raw: unknown): MxPage {
  if (!isRecord(raw)) throw new Error("The homeserver sent an unreadable history page");
  const state = emptyState();
  for (const event of list(raw.state, MAX_EVENTS)) applyState(state, event);
  const events: MxEvent[] = [];
  for (const event of list(raw.chunk, MAX_EVENTS).reverse()) {
    applyState(state, event);
    const parsed = parseEvent(event);
    if (parsed) events.push(parsed);
  }
  const page: MxPage = { events, state };
  if (typeof raw.end === "string" && raw.end !== "" && raw.end.length <= MAX_TOKEN) page.end = raw.end;
  return page;
}
