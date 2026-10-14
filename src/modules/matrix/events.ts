// Turns the homeserver's JSON into the plain data of api.ts. Everything from
// the network is untrusted: ids, names and bodies are checked for type and
// length, and whatever does not fit is dropped rather than passed on.

import type { MxContent, MxEvent, MxMember, MxPage, MxRoomState, MxRoomUpdate, MxSync } from "./api";

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
    case "m.room.encrypted":
      return { kind: "encrypted", ...base };
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

function parseRoom(id: string, raw: Record<string, unknown>): MxRoomUpdate {
  const state = emptyState();
  for (const event of list(isRecord(raw.state) ? raw.state.events : undefined, MAX_EVENTS)) applyState(state, event);
  const timelineRaw = isRecord(raw.timeline) ? raw.timeline : {};
  const timeline: MxEvent[] = [];
  for (const event of list(timelineRaw.events, MAX_EVENTS)) {
    // State changes can arrive in the timeline too; they apply in order.
    applyState(state, event);
    const parsed = parseEvent(event);
    if (parsed) timeline.push(parsed);
  }
  const update: MxRoomUpdate = { roomId: id, state, timeline, limited: timelineRaw.limited === true };
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
  return sync;
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
