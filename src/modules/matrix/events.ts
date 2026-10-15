// Turns the homeserver's JSON into the plain data of api.ts. Everything from
// the network is untrusted: ids, names and bodies are checked for type and
// length, and whatever does not fit is dropped rather than passed on.

import type {
  MxCallMember,
  MxContent,
  MxCryptoSync,
  MxEncryptedFile,
  MxEmote,
  MxEncryption,
  MxEvent,
  MxMedia,
  MxMediaKind,
  MxMediaSource,
  MxMember,
  MxPack,
  MxPackImage,
  MxPackRef,
  MxPoll,
  MxRich,
  MxPage,
  MxRoomState,
  MxRoomUpdate,
  MxRtcTransport,
  MxSpaceChild,
  MxSpaceRoom,
  MxInvite,
  MxSync,
} from "./api";
import { parseHtml } from "./format";
import { sha256 } from "./sha256";

/** Room ids are used in rail keys (at most 200 characters with the instance prefix). */
export const MAX_ROOM_ID = 150;
const MAX_ID = 255;
export const MAX_NAME = 100;
/** Longest message text kept; Matrix allows 64 KiB events. */
export const MAX_BODY = 4000;
export const MAX_TOKEN = 4096;
export const MAX_ROOMS = 2000;
export const MAX_EVENTS = 1000;
const MAX_MENTIONS = 100;
const MAX_HEROES = 5;
/** People shown typing in a room at once. */
const MAX_TYPING = 20;
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

/** A display, room or file name: control characters removed, trimmed, cut to length. */
export function cleanName(value: unknown, max = MAX_NAME): string | undefined {
  if (typeof value !== "string") return undefined;
  // Bidirectional overrides too: a name must not reorder the text around it.
  const name = value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim();
  return name === "" ? undefined : name.slice(0, max);
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

/** Longest reaction key kept, as long as the view may send one back. */
export const MAX_REACTION_KEY = 64;

/** A reaction's key (usually an emoji) when it can be shown as it is: no control or reordering characters, nothing to trim. */
export function reactionKey(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_REACTION_KEY && cleanName(value, MAX_REACTION_KEY) === value ? value : undefined;
}

// --- Polls (MSC3381) --------------------------------------------------------------

/** A poll's event types, stable first: its start, a vote (response) and its end. */
export const POLL_TYPES = {
  start: ["m.poll.start", "org.matrix.msc3381.poll.start"],
  response: ["m.poll.response", "org.matrix.msc3381.poll.response"],
  end: ["m.poll.end", "org.matrix.msc3381.poll.end"],
} as const;
/** The unstable form of extensible events' text (MSC1767), as Element still sends polls. */
export const UNSTABLE_TEXT = "org.matrix.msc1767.text";
/** Answers read per poll; MSC3381 allows 20. */
export const MAX_POLL_ANSWERS = 20;
const MAX_POLL_TEXT = 300;

/** Text in either of MSC1767's forms: a plain string (unstable), or a list of representations, of which the plain one counts. */
function extensibleText(value: unknown): string | undefined {
  if (typeof value === "string") return cleanName(value, MAX_POLL_TEXT);
  const plain = list(value, 10).find((r) => isRecord(r) && (r.mimetype === undefined || r.mimetype === "text/plain"));
  return isRecord(plain) ? cleanName(plain.body, MAX_POLL_TEXT) : undefined;
}

/** The event a poll's vote or end refers to (an m.reference relation). */
function referenced(content: Record<string, unknown>): string | undefined {
  const relates = content["m.relates_to"];
  return isRecord(relates) && relates.rel_type === "m.reference" ? eventId(relates.event_id) : undefined;
}

/**
 * A poll start's content (m.poll, or MSC3381's unstable form): its question,
 * its answers with an id and text (each id once, at most MAX_POLL_ANSWERS),
 * how many one vote may choose, and whether votes show before it ends.
 * Undefined when it has no question or no answers.
 */
export function parsePoll(content: Record<string, unknown>, stable: boolean): MxPoll | undefined {
  const poll = content[stable ? "m.poll" : POLL_TYPES.start[1]];
  if (!isRecord(poll)) return undefined;
  const text = (value: unknown) => (isRecord(value) ? extensibleText(stable ? value["m.text"] : (value[UNSTABLE_TEXT] ?? value.body)) : undefined);
  const question = text(poll.question);
  const answers: MxPoll["answers"] = [];
  for (const raw of list(poll.answers, MAX_POLL_ANSWERS)) {
    const id = isRecord(raw) ? raw[stable ? "m.id" : "id"] : undefined;
    const answer = text(raw);
    if (idText(id) && answer && !answers.some((a) => a.id === id)) answers.push({ id, text: answer });
  }
  if (!question || answers.length === 0) return undefined;
  const max = poll.max_selections;
  return {
    question,
    answers,
    maxSelections: typeof max === "number" && Number.isSafeInteger(max) && max > 0 ? Math.min(max, answers.length) : 1,
    // Kinds it does not know are undisclosed, as MSC3381 says.
    disclosed: poll.kind === (stable ? "m.disclosed" : "org.matrix.msc3381.poll.disclosed"),
    stable,
  };
}

// --- Media ------------------------------------------------------------------------

const MAX_FILE_NAME = 255;
/** Largest width or height believed. */
const MAX_DIMENSION = 100_000;
/** A MIME type: no parameters, nothing that could end a data: URL's header. */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;
/** A 256-bit AES key as a JWK's k: unpadded base64url. */
const AES_KEY = /^[A-Za-z0-9_-]{43}$/;
/** 16 bytes of base64, padded or not. */
const IV = /^[A-Za-z0-9+/]{22}(==)?$/;
/** 32 bytes of base64, padded or not. */
const SHA256 = /^[A-Za-z0-9+/]{43}=?$/;
const DEFAULT_NAMES: Record<MxMediaKind, string> = { image: "Image", video: "Video", audio: "Audio", file: "File", sticker: "Sticker" };

/** A MIME type, lower-cased, when it is a plain type/subtype. */
export function mimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mime = value.trim().toLowerCase();
  return MIME.test(mime) ? mime : undefined;
}

const size = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const dimension = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION ? value : undefined);

/**
 * An EncryptedFile, when well formed; a short reason when it is one we must
 * not use (another version, or a key that is not AES-CTR 256 for decrypting);
 * undefined when there is none.
 */
export function parseEncryptedFile(value: unknown): MxEncryptedFile | string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.v !== "v2") return "its encryption version is not supported";
  const key = isRecord(value.key) ? value.key : {};
  const ops = Array.isArray(key.key_ops) ? key.key_ops : [];
  if (key.kty !== "oct" || key.alg !== "A256CTR" || typeof key.k !== "string" || !AES_KEY.test(key.k) || !ops.includes("decrypt")) return "its encryption key is not usable";
  const hashes = isRecord(value.hashes) ? value.hashes : {};
  if (typeof value.iv !== "string" || !IV.test(value.iv) || typeof hashes.sha256 !== "string" || !SHA256.test(hashes.sha256)) return "its encryption details are not usable";
  if (!parseMxc(value.url)) return "its address is not valid";
  return { url: value.url as string, key: key.k, iv: value.iv, sha256: hashes.sha256 };
}

/** Where a file or thumbnail is (an encrypted file first), with its type and size; or why it cannot be fetched. */
function mediaSource(url: unknown, file: unknown, info: Record<string, unknown>): MxMediaSource | string {
  const source: MxMediaSource = {};
  const encrypted = parseEncryptedFile(file);
  if (typeof encrypted === "string") return encrypted;
  if (encrypted) source.file = encrypted;
  else if (parseMxc(url)) source.url = url as string;
  else return "its address is not valid";
  const mime = mimeType(info.mimetype);
  if (mime) source.mime = mime;
  const bytes = size(info.size);
  if (bytes !== undefined) source.size = bytes;
  return source;
}

/** The media of an m.image, m.video, m.audio, m.file or m.sticker content. */
export function parseMedia(content: Record<string, unknown>, kind: MxMediaKind): MxMedia {
  const info = isRecord(content.info) ? content.info : {};
  const name = cleanName(content.filename, MAX_FILE_NAME) ?? cleanName(content.body, MAX_FILE_NAME) ?? DEFAULT_NAMES[kind];
  const source = mediaSource(content.url, content.file, info);
  const media: MxMedia = typeof source === "string" ? { kind, name, problem: source } : { kind, name, ...source };
  const width = dimension(info.w);
  const height = dimension(info.h);
  const duration = size(info.duration);
  if (width && height) {
    media.width = width;
    media.height = height;
  }
  if (duration !== undefined) media.durationMs = duration;
  // Bridges (mautrix) send GIFs as looping videos.
  if (kind === "video" && (info["fi.mau.loop"] === true || info["fi.mau.gif"] === true)) media.loop = true;
  const thumbnail = mediaSource(info.thumbnail_url, info.thumbnail_file, isRecord(info.thumbnail_info) ? info.thumbnail_info : {});
  if (typeof thumbnail !== "string") media.thumbnail = thumbnail;
  return media;
}

/** Text and media label of an m.room.message (or m.sticker) content; undefined when it has no body. */
export function parseContent(content: Record<string, unknown>, sticker = false): MxContent | undefined {
  if (typeof content.body !== "string") return undefined;
  if (sticker) return { msgtype: "m.sticker", text: "", media: "🙂 Sticker", attachment: parseMedia(content, "sticker") };
  if (typeof content.msgtype !== "string") return undefined;
  const msgtype = content.msgtype.slice(0, 64);
  const body = clip(content.body);
  // With a separate filename, the body of a media message is its caption (MSC2530).
  const filename = typeof content.filename === "string" ? clip(content.filename) : undefined;
  const caption = filename !== undefined && filename !== body ? body : "";
  switch (msgtype) {
    case "m.image":
      return { msgtype, text: caption, media: "📷 Image", attachment: parseMedia(content, "image") };
    case "m.video":
      return { msgtype, text: caption, media: "🎥 Video", attachment: parseMedia(content, "video") };
    case "m.audio":
      return { msgtype, text: caption, media: content["org.matrix.msc3245.voice"] !== undefined ? "🎤 Voice message" : "🎵 Audio", attachment: parseMedia(content, "audio") };
    case "m.file":
      return { msgtype, text: caption, media: `📎 ${(filename ?? body) || "File"}`, attachment: parseMedia(content, "file") };
    case "m.location":
      return { msgtype, text: "", media: "📍 Location" };
    default: {
      // m.text, m.notice, m.emote, and unknown types, which fall back to their body.
      const parsed: MxContent = { msgtype, text: body };
      const emotes = parseEmotes(content);
      if (emotes) parsed.emotes = emotes;
      const html = parseFormatting(content);
      if (html) parsed.html = html;
      return parsed;
    }
  }
}

/** A text message's formatting, from its formatted_body (format.ts); undefined without any beyond plain text. */
export function parseFormatting(content: Record<string, unknown>): MxRich | undefined {
  return content.format === "org.matrix.custom.html" && typeof content.formatted_body === "string" ? parseHtml(content.formatted_body) : undefined;
}

/** A thread root's summary, from the homeserver's bundled aggregation (unsigned m.relations m.thread); undefined without replies. */
function threadSummary(unsigned: unknown): { count: number; latest?: string } | undefined {
  const relations = isRecord(unsigned) && isRecord(unsigned["m.relations"]) ? unsigned["m.relations"] : {};
  const thread = isRecord(relations["m.thread"]) ? relations["m.thread"] : {};
  const replies = count(thread.count);
  if (replies === 0) return undefined;
  const latest = isRecord(thread.latest_event) ? userId(thread.latest_event.sender) : undefined;
  return latest ? { count: replies, latest } : { count: replies };
}

/** Whom a message says it mentions (m.mentions): users, and the whole room; nothing when it does not say. */
function mentionsOf(content: Record<string, unknown>): { mentions?: string[]; mentionsRoom?: true } {
  const mentions = content["m.mentions"];
  if (!isRecord(mentions)) return {};
  const users = list(mentions.user_ids, MAX_MENTIONS).flatMap((id) => userId(id) ?? []);
  return mentions.room === true ? { mentions: users, mentionsRoom: true } : { mentions: users };
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
    case RTC_MEMBER_TYPE:
      return parseRtcMember(raw, content, base);
    case "m.room.encrypted": {
      const event: MxEvent = { kind: "encrypted", ...base };
      const json = JSON.stringify(raw);
      if (json.length <= MAX_EVENT_JSON) event.raw = json;
      if (typeof content.session_id === "string" && content.session_id !== "" && content.session_id.length <= MAX_SESSION_ID) event.sessionId = content.session_id;
      // Relations stay readable on encrypted events, so an edit or a reaction is known as one before it is decrypted.
      const relates = isRecord(content["m.relates_to"]) ? content["m.relates_to"] : {};
      const target = eventId(relates.event_id);
      if (target && relates.rel_type === "m.replace") event.replaces = target;
      if (target && relates.rel_type === "m.annotation") event.annotates = target;
      if (target && relates.rel_type === "m.reference") event.references = target;
      if (target && relates.rel_type === "m.thread") event.thread = target;
      return event;
    }
    case POLL_TYPES.start[0]:
    case POLL_TYPES.start[1]: {
      const poll = parsePoll(content, raw.type === POLL_TYPES.start[0]);
      if (poll) return { kind: "message", ...base, content: { msgtype: "m.poll", text: "", media: `📊 ${poll.question}`, poll } };
      // A poll that cannot be read shows its fallback text, where it has one.
      const fallback = extensibleText(content["m.text"]) ?? extensibleText(content[UNSTABLE_TEXT]) ?? cleanName(content.body, MAX_POLL_TEXT);
      return fallback ? { kind: "message", ...base, content: { msgtype: "m.text", text: fallback } } : undefined;
    }
    case POLL_TYPES.response[0]:
    case POLL_TYPES.response[1]: {
      const target = referenced(content);
      const unstable = content[POLL_TYPES.response[1]];
      const answers = raw.type === POLL_TYPES.response[0] ? content["m.selections"] : isRecord(unstable) ? unstable.answers : undefined;
      // A vote naming no answers (or not as a list) withdraws the sender's vote.
      return target ? { kind: "pollResponse", ...base, target, answers: list(answers, MAX_POLL_ANSWERS).filter(idText) } : undefined;
    }
    case POLL_TYPES.end[0]:
    case POLL_TYPES.end[1]: {
      const target = referenced(content);
      return target ? { kind: "pollEnd", ...base, target } : undefined;
    }
    case "m.reaction": {
      const relates = isRecord(content["m.relates_to"]) ? content["m.relates_to"] : {};
      const target = eventId(relates.event_id);
      const key = reactionKey(relates.key);
      if (relates.rel_type !== "m.annotation" || !target || !key) return undefined;
      const reaction: MxEvent = { kind: "reaction", ...base, target, key };
      // A custom emoji's name, as Beeper and Cinny send it (":name:").
      const named = shortcode(content["com.beeper.reaction.shortcode"] ?? content.shortcode);
      if (named && parseMxc(key)) reaction.shortcode = named;
      return reaction;
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
        return { kind: "message", ...base, content: parsed, ...mentionsOf(fresh), replaces: target };
      }
      const parsed = parseContent(content, sticker);
      // A message without a body has had its content removed.
      if (!parsed) return { kind: "redacted", ...base };
      const event: MxEvent = { kind: "message", ...base, content: parsed, ...mentionsOf(content) };
      const thread = relates.rel_type === "m.thread" ? eventId(relates.event_id) : undefined;
      if (thread) event.thread = thread;
      const replyTo = isRecord(relates["m.in_reply_to"]) ? eventId(relates["m.in_reply_to"].event_id) : undefined;
      // In a thread, a reply marked is_falling_back only points clients without threads at the latest message: no reply.
      if (replyTo && !(thread && relates.is_falling_back === true)) {
        event.replyTo = replyTo;
        parsed.text = stripReplyFallback(parsed.text);
      }
      const summary = threadSummary(raw.unsigned);
      if (summary) event.threadInfo = summary;
      return event;
    }
    default:
      return undefined;
  }
}

export const emptyState = (): MxRoomState => ({ members: {} });

/** Pinned events kept per room: the newest. */
export const MAX_PINNED = 100;

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

/** Rooms kept per space; a space listing more shows the first ones. */
export const MAX_SPACE_CHILDREN = 500;
const SPACE_ORDER = /^[\x20-\x7e]{1,50}$/;

/**
 * An m.space.child content: the child is there while `via` names a server
 * to join it through, else it was removed (null). An order that breaks the
 * spec's rules is ignored, as the spec says.
 */
export function spaceChild(content: Record<string, unknown>, ts: unknown): MxSpaceChild | null {
  const via = content.via;
  if (!Array.isArray(via) || !via.some((server) => typeof server === "string" && server !== "")) return null;
  const child: MxSpaceChild = { suggested: content.suggested === true, ts: typeof ts === "number" && Number.isSafeInteger(ts) && ts >= 0 ? ts : 0 };
  if (typeof content.order === "string" && SPACE_ORDER.test(content.order)) child.order = content.order;
  const servers = list(via, MAX_VIA).filter(serverName);
  if (servers.length) child.via = servers;
  return child;
}

/** Servers kept to join a room through. */
export const MAX_VIA = 3;
/** A server name as Matrix writes them (a host, perhaps with a port). */
export const serverName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9.:[\]-]{1,255}$/.test(value);

/**
 * An invitation from its stripped state (invite_state): the room's name (or
 * alias), whether it is a space, and who invited the user, by the invite
 * membership event of `me` (any invite membership without it).
 */
export function parseInvite(id: string, events: unknown, me?: string): MxInvite {
  const invite: MxInvite = { roomId: id, direct: false, space: false };
  const state = emptyState();
  let inviter: string | undefined;
  for (const event of list(events, MAX_EVENTS)) {
    applyState(state, event);
    if (!isRecord(event) || event.type !== "m.room.member" || (me !== undefined && event.state_key !== me)) continue;
    const content = isRecord(event.content) ? event.content : {};
    if (content.membership !== "invite") continue;
    inviter = userId(event.sender);
    invite.direct = content.is_direct === true;
  }
  const name = state.name || state.alias;
  if (name) invite.name = name;
  if (state.space) invite.space = true;
  if (inviter) {
    invite.inviter = inviter;
    const named = state.members[inviter]?.name;
    if (named) invite.inviterName = named;
  }
  return invite;
}

/** Rooms read from a space's hierarchy. */
export const MAX_HIERARCHY_ROOMS = 100;

/** A /hierarchy response: the rooms it describes, with a name (else alias) where they have one. */
export function parseHierarchy(raw: unknown): MxSpaceRoom[] {
  const rooms = isRecord(raw) ? raw.rooms : undefined;
  return list(rooms, MAX_HIERARCHY_ROOMS).flatMap((room) => {
    const id = isRecord(room) ? roomId(room.room_id) : undefined;
    if (!id) return [];
    const info = room as Record<string, unknown>;
    const found: MxSpaceRoom = { roomId: id, space: info.room_type === "m.space" };
    const name = cleanName(info.name) ?? cleanName(info.canonical_alias);
    if (name) found.name = name;
    return [found];
  });
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
    case "m.room.create":
      if (global && content.type === "m.space") state.space = true;
      return;
    case "m.room.pinned_events":
      // The newest pins, each once.
      if (global) state.pinned = [...new Set((Array.isArray(content.pinned) ? content.pinned : []).flatMap((id) => eventId(id) ?? []))].slice(-MAX_PINNED);
      return;
    case ROOM_PACK_TYPE: {
      if (raw.state_key.length > MAX_ID) return;
      const packs = (state.packs ??= new Map());
      if (!packs.has(raw.state_key) && packs.size >= MAX_ROOM_PACKS) return;
      packs.set(raw.state_key, parsePack(content));
      return;
    }
    case "m.space.child": {
      const child = roomId(raw.state_key);
      if (!child) return;
      const children = (state.children ??= new Map());
      if (!children.has(child) && children.size >= MAX_SPACE_CHILDREN) return;
      children.set(child, spaceChild(content, raw.origin_server_ts));
      return;
    }
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

// --- Image packs (MSC2545) --------------------------------------------------------

/** A room's image packs, one per state key (the unstable names Element, Cinny and FluffyChat use). */
export const ROOM_PACK_TYPE = "im.ponies.room_emotes";
/** The user's own pack, in account data. */
export const USER_PACK_TYPE = "im.ponies.user_emotes";
/** Room packs the user enabled in every room, in account data: { rooms: { roomId: { stateKey: {} } } }. */
export const PACK_ROOMS_TYPE = "im.ponies.emote_rooms";
/** Pictures read per pack. */
export const MAX_PACK_IMAGES = 500;
/** Packs kept per room. */
export const MAX_ROOM_PACKS = 20;
/** Room packs enabled everywhere that are read. */
export const MAX_PACK_ROOMS = 50;
const SHORTCODE = /^[^\s:<>]{1,64}$/;

/** A pack picture's shortcode, with or without its colons, when usable: no spaces, colons, angle brackets or control characters. */
export function shortcode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.replace(/^:(.*):$/, "$1");
  return SHORTCODE.test(code) && cleanName(code, 64) === code ? code : undefined;
}

/** Custom emoji read per message. */
export const MAX_EMOTES = 50;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" };

/** An HTML attribute's value in a tag, entities decoded; undefined when the tag has none. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? (match[1] ?? match[2]!).replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_m, entity: string) => ENTITIES[entity]!) : undefined;
}

/**
 * The custom emoji in a message's formatted_body: <img data-mx-emoticon>
 * tags with an mxc:// picture, named by their title (else alt) as
 * ":shortcode:"; each shortcode once, at most MAX_EMOTES. Undefined without any.
 */
export function parseEmotes(content: Record<string, unknown>): MxEmote[] | undefined {
  const html = content.format === "org.matrix.custom.html" && typeof content.formatted_body === "string" ? content.formatted_body.slice(0, MAX_EVENT_JSON) : "";
  const emotes = new Map<string, string>();
  for (const [tag] of html.matchAll(/<img\s[^>]*>/gi)) {
    if (emotes.size >= MAX_EMOTES) break;
    const url = attribute(tag, "src");
    const code = shortcode(attribute(tag, "title") ?? attribute(tag, "alt"));
    if (/\sdata-mx-emoticon[\s=/>]/i.test(tag) && parseMxc(url) && code && !emotes.has(code)) emotes.set(code, url!);
  }
  return emotes.size ? [...emotes].map(([code, url]) => ({ shortcode: code, url })) : undefined;
}

/** What a pack or picture is for (its usage); undefined when it does not say, which means both. */
function packUsage(value: unknown): { emoticon: boolean; sticker: boolean } | undefined {
  const usage = list(value, 10);
  const emoticon = usage.includes("emoticon");
  const sticker = usage.includes("sticker");
  return emoticon || sticker ? { emoticon, sticker } : undefined;
}

/** An image pack's content: its name, and its pictures with a usable shortcode and mxc:// address, at most MAX_PACK_IMAGES. */
export function parsePack(content: Record<string, unknown>): MxPack {
  const meta = isRecord(content.pack) ? content.pack : {};
  const usage = packUsage(meta.usage) ?? { emoticon: true, sticker: true };
  const pack: MxPack = { images: [] };
  const name = cleanName(meta.display_name);
  if (name) pack.name = name;
  const images = isRecord(content.images) ? content.images : {};
  for (const [code, raw] of Object.entries(images).slice(0, MAX_PACK_IMAGES)) {
    if (shortcode(code) !== code || !isRecord(raw) || !parseMxc(raw.url)) continue;
    const info = isRecord(raw.info) ? raw.info : {};
    const kept: Record<string, unknown> = {};
    const mime = mimeType(info.mimetype);
    if (mime) kept.mimetype = mime;
    const width = dimension(info.w);
    const height = dimension(info.h);
    if (width && height) Object.assign(kept, { w: width, h: height });
    const bytes = size(info.size);
    if (bytes !== undefined) kept.size = bytes;
    const image: MxPackImage = { shortcode: code, url: raw.url as string, info: kept, ...(packUsage(raw.usage) ?? usage) };
    const body = cleanName(raw.body);
    if (body) image.body = body;
    pack.images.push(image);
  }
  return pack;
}

/** The room packs in im.ponies.emote_rooms, at most MAX_PACK_ROOMS. */
export function parsePackRooms(content: unknown): MxPackRef[] {
  const rooms = isRecord(content) && isRecord(content.rooms) ? content.rooms : {};
  const refs: MxPackRef[] = [];
  for (const [id, keys] of Object.entries(rooms).slice(0, MAX_PACK_ROOMS)) {
    if (!roomId(id) || !isRecord(keys)) continue;
    for (const stateKey of Object.keys(keys).slice(0, MAX_ROOM_PACKS)) if (stateKey.length <= MAX_ID) refs.push({ roomId: id, stateKey });
  }
  return refs.slice(0, MAX_PACK_ROOMS);
}

/** The push rules account data, which says (among much else) which rooms are muted. */
export const PUSH_RULES_TYPE = "m.push_rules";

/**
 * The rooms the user muted, from their push rules: an enabled override rule
 * named after the room that matches only its events and does not notify, as
 * Element (and Multicord) make them.
 */
export function parseMutedRooms(content: unknown): string[] {
  const global = isRecord(content) && isRecord(content.global) ? content.global : {};
  const muted: string[] = [];
  for (const rule of list(global.override, MAX_ROOMS)) {
    const id = isRecord(rule) && rule.enabled !== false ? roomId(rule.rule_id) : undefined;
    if (!id) continue;
    const [condition, ...more] = list((rule as Record<string, unknown>).conditions, 2);
    const onlyRoom = more.length === 0 && isRecord(condition) && condition.kind === "event_match" && condition.key === "room_id" && condition.pattern === id;
    if (onlyRoom && list((rule as Record<string, unknown>).actions, 2).every((a) => a === "dont_notify")) muted.push(id);
  }
  return muted;
}

/** The user's pack, enabled room packs and muted rooms among a sync's global account data. */
export function globalAccountData(events: unknown[], sync: MxSync): void {
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === USER_PACK_TYPE) sync.userPack = parsePack(isRecord(event.content) ? event.content : {});
    else if (event.type === PACK_ROOMS_TYPE) sync.packRooms = parsePackRooms(event.content);
    else if (event.type === PUSH_RULES_TYPE) sync.mutedRooms = parseMutedRooms(event.content);
  }
}

// --- Calls (MatrixRTC) ------------------------------------------------------------

/** The call membership state event Element Call sends, one per device (MSC3401/MSC4143). */
export const CALL_MEMBER_TYPE = "org.matrix.msc3401.call.member";
/** The newer call membership: a sticky room event per member (MSC4143 with MSC4354 sticky events). */
export const RTC_MEMBER_TYPE = "org.matrix.msc4143.rtc.member";
/** The room's call, as MatrixRTC names it (MSC4143): its memberships' slot, the ring's, and the state key of the slot event. */
export const SLOT_ID = "m.call#ROOM";
/** Sticky events stay sticky at most this long (MSC4354); Element sends its memberships for this long. */
export const MAX_STICKY_MS = 3_600_000;
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

/** A LiveKit server's address: wss (or https, which LiveKit turns into wss), no credentials. */
export function liveKitUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SERVICE_URL) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "wss:" || url.protocol === "https:") && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The LiveKit transports in a list (MSC4195): a service (livekit_service_url),
 * a LiveKit server (url), or both; in order, without repeats, and without
 * parts we may not use (plain http or ws, credentials).
 */
export function liveKitTransports(value: unknown): MxRtcTransport[] {
  const seen = new Set<string>();
  const transports: MxRtcTransport[] = [];
  for (const raw of list(value, MAX_FOCI)) {
    if (!isRecord(raw) || raw.type !== "livekit") continue;
    const transport: MxRtcTransport = {};
    const service = serviceUrl(raw.livekit_service_url);
    // Kept as given: lk-jwt-service compares it with its own address, character for character.
    const sfu = liveKitUrl(raw.url) ? (raw.url as string) : undefined;
    if (service) transport.service = service;
    if (sfu) transport.sfu = sfu;
    const id = JSON.stringify([service, sfu]);
    if ((service || sfu) && !seen.has(id)) {
      seen.add(id);
      transports.push(transport);
    }
  }
  return transports;
}

/** A device's participant identity on LiveKit for the older memberships and service transports, as lk-jwt-service's /sfu/get names it. */
export function liveKitIdentity(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

/**
 * A member's identity on LiveKit for transports with a LiveKit server
 * (MSC4195): the unpadded base64 SHA-256 of the JSON array [user, member id],
 * as the homeserver's get_token and matrix-js-sdk compute it.
 */
export function rtcIdentity(userId: string, memberId: string): string {
  const digest = sha256(new TextEncoder().encode(JSON.stringify([userId, memberId])));
  return btoa(String.fromCharCode(...digest)).replace(/=+$/, "");
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
  const member: MxCallMember = {
    user,
    deviceId,
    createdTs,
    expiresAt: createdTs + Math.min((expires as number | undefined) ?? CALL_MEMBERSHIP_EXPIRY_MS, MAX_CALL_EXPIRES_MS),
    identities: [liveKitIdentity(user, deviceId)],
  };
  const [focus] = liveKitServices(content.foci_preferred);
  if (focus) member.focus = focus;
  const intent = callIntent(content["m.call.intent"]);
  if (intent) member.intent = intent;
  return { stateKey, member };
}

const callIntent = (value: unknown): string | undefined => (typeof value === "string" && value !== "" && value.length <= 32 ? value : undefined);
const idText = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= MAX_ID;
const strings = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * When a sticky event stops being sticky: the server's remaining time when it
 * says (immune to clock skew), else the event's own time (never from the
 * future) plus its duration, at most an hour. Undefined for events that are
 * not sticky.
 */
function stickyExpiry(raw: Record<string, unknown>, ts: number, now: number): number | undefined {
  const sticky = isRecord(raw.msc4354_sticky) ? raw.msc4354_sticky : {};
  const duration = positive(sticky.duration_ms);
  if (duration === undefined) return undefined;
  const capped = Math.min(duration, MAX_STICKY_MS);
  const ttl = isRecord(raw.unsigned) ? positive(raw.unsigned.msc4354_sticky_duration_ttl_ms) : undefined;
  return ttl !== undefined ? now + Math.min(ttl, capped) : Math.min(now, ts) + capped;
}

/**
 * An m.rtc.member event, as matrix-js-sdk reads it: sticky, with a sticky key
 * that later events of its sender replace. Its membership is null when the
 * device left (the content keeps only the slot and key) or the event is no
 * well-formed membership of the room's call, or one for another member.
 */
function parseRtcMember(raw: Record<string, unknown>, content: Record<string, unknown>, base: { id: string; sender: string; ts: number }): MxEvent | undefined {
  const expiresAt = stickyExpiry(raw, base.ts, Date.now());
  const { msc4354_sticky_key: unstableKey, sticky_key: stableKey } = content;
  const key = unstableKey ?? stableKey;
  if (expiresAt === undefined || !idText(key) || (unstableKey !== undefined && stableKey !== undefined && unstableKey !== stableKey)) return undefined;
  const rtc = { kind: "rtc" as const, ...base, key: `${base.sender}|${key}`, expiresAt };
  const member = isRecord(content.member) ? content.member : {};
  const application = isRecord(content.application) ? content.application : {};
  const transports = isRecord(content.transports) ? content.transports : {};
  // Without a list, one entry that fails the check below.
  const published: unknown[] = Array.isArray(transports.published) ? transports.published : [{}];
  const { device_id: deviceId, id: memberId } = member;
  if (
    content.slot_id !== SLOT_ID ||
    application.type !== "m.call" ||
    // Nobody may announce someone else (matrix-js-sdk's rule too).
    member.user_id !== base.sender ||
    !idText(deviceId) ||
    !idText(memberId) ||
    !published.every((t) => isRecord(t) && typeof t.type === "string") ||
    !strings(transports.can_subscribe) ||
    !strings(content.versions)
  ) {
    return { ...rtc, member: null };
  }
  const livekit = published.filter((t): t is Record<string, unknown> => isRecord(t) && t.type === "livekit");
  // Media keys go under the identities the device has on its transports: hashed for LiveKit servers, user:device for services.
  const identities: string[] = [];
  if (livekit.some((t) => typeof t.url === "string")) identities.push(rtcIdentity(base.sender, memberId));
  if (livekit.some((t) => typeof t.livekit_service_url === "string")) identities.push(liveKitIdentity(base.sender, deviceId));
  const call: MxCallMember = { user: base.sender, deviceId, createdTs: base.ts, expiresAt, identities, memberId };
  const usable = liveKitTransports(livekit);
  const focus = usable.find((t) => t.service)?.service;
  const sfu = usable.find((t) => t.sfu)?.sfu;
  if (focus) call.focus = focus;
  if (sfu) call.sfu = sfu;
  const intent = callIntent(application["m.call.intent"]);
  if (intent) call.intent = intent;
  return { ...rtc, member: call };
}

export function parseRoom(id: string, raw: Record<string, unknown>): MxRoomUpdate {
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
  // Sticky events the timeline did not carry (MSC4354). Only memberships matter here, and encrypted events that may be some.
  const sticky: MxEvent[] = [];
  const inTimeline = new Set(timeline.map((e) => e.id));
  for (const event of list(isRecord(raw.msc4354_sticky) ? raw.msc4354_sticky.events : undefined, MAX_EVENTS)) {
    const parsed = parseEvent(event);
    if ((parsed?.kind === "rtc" || parsed?.kind === "encrypted") && !inTimeline.has(parsed.id)) sticky.push(parsed);
  }
  if (sticky.length) update.sticky = sticky;
  if (typeof timelineRaw.prev_batch === "string" && timelineRaw.prev_batch.length <= MAX_TOKEN) update.prevBatch = timelineRaw.prev_batch;
  if (isRecord(raw.unread_notifications)) {
    update.unread = { notifications: count(raw.unread_notifications.notification_count), highlights: count(raw.unread_notifications.highlight_count) };
  }
  if (isRecord(raw.summary) && Array.isArray(raw.summary["m.heroes"])) {
    update.heroes = list(raw.summary["m.heroes"], MAX_HEROES).flatMap((u) => userId(u) ?? []);
  }
  // Each m.typing names everyone typing now; the last one counts.
  const typing = list(isRecord(raw.ephemeral) ? raw.ephemeral.events : undefined, MAX_EVENTS)
    .filter((e): e is Record<string, unknown> => isRecord(e) && e.type === "m.typing" && isRecord(e.content))
    .at(-1);
  if (typing) update.typing = list((typing.content as Record<string, unknown>).user_ids, MAX_TYPING).flatMap((u) => userId(u) ?? []);
  return update;
}

/** The m.direct account data: user id -> their DM room ids. */
export function parseDirects(content: unknown): Record<string, string[]> {
  const directs: Record<string, string[]> = {};
  if (!isRecord(content)) return directs;
  for (const [user, rooms] of Object.entries(content).slice(0, MAX_ROOMS)) {
    if (!userId(user)) continue;
    const ids = list(rooms, MAX_ROOMS).flatMap((r) => roomId(r) ?? []);
    if (ids.length) directs[user] = ids;
  }
  return directs;
}

/** A classic sync; `me` (the user) finds who sent each invitation. */
export function parseSync(raw: unknown, me?: string): MxSync {
  if (!isRecord(raw) || typeof raw.next_batch !== "string" || raw.next_batch === "" || raw.next_batch.length > MAX_TOKEN) {
    throw new Error("The homeserver sent an unreadable sync response");
  }
  const sync: MxSync = { nextBatch: raw.next_batch, joined: [], left: [] };
  const accountData = list(isRecord(raw.account_data) ? raw.account_data.events : undefined, 100);
  const direct = accountData.find((e) => isRecord(e) && e.type === "m.direct");
  if (isRecord(direct)) sync.directs = parseDirects(direct.content);
  globalAccountData(accountData, sync);
  const rooms = isRecord(raw.rooms) ? raw.rooms : {};
  const join = isRecord(rooms.join) ? rooms.join : {};
  for (const [id, room] of Object.entries(join).slice(0, MAX_ROOMS)) {
    if (roomId(id) && isRecord(room)) sync.joined.push(parseRoom(id, room));
  }
  const leave = isRecord(rooms.leave) ? rooms.leave : {};
  sync.left = Object.keys(leave).slice(0, MAX_ROOMS).filter((id) => roomId(id));
  const invite = isRecord(rooms.invite) ? rooms.invite : {};
  const invited = Object.entries(invite)
    .slice(0, MAX_ROOMS)
    .flatMap(([id, room]) => (roomId(id) && isRecord(room) ? [parseInvite(id, isRecord(room.invite_state) ? room.invite_state.events : undefined, me)] : []));
  if (invited.length) sync.invited = invited;
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

/** Someone in a room's member list, or a profile: their user id, display name and picture (mxc://). */
export interface MxProfile {
  id: string;
  name?: string;
  avatar?: string;
}

function profileOf(id: string, name: unknown, avatar: unknown): MxProfile {
  const profile: MxProfile = { id };
  const shown = cleanName(name);
  if (shown) profile.name = shown;
  if (parseMxc(avatar)) profile.avatar = avatar as string;
  return profile;
}

/** The members in a /joined_members response, at most MAX_USERS. */
export function parseJoinedMembers(raw: unknown): MxProfile[] {
  const joined = isRecord(raw) && isRecord(raw.joined) ? raw.joined : {};
  return Object.entries(joined)
    .slice(0, MAX_USERS)
    .flatMap(([id, value]) => {
      const user = userId(id);
      const info = isRecord(value) ? value : {};
      return user ? [profileOf(user, info.display_name, info.avatar_url)] : [];
    });
}

/** A /profile response: the user's own display name and picture, outside any room. */
export function parseProfile(id: string, raw: unknown): MxProfile {
  const info = isRecord(raw) ? raw : {};
  return profileOf(id, info.displayname, info.avatar_url);
}

/** Users' power levels in an m.room.power_levels content; those not named have 0 (users_default is not read). */
export function parsePowerLevels(raw: unknown): Map<string, number> {
  const users = isRecord(raw) && isRecord(raw.users) ? raw.users : {};
  const levels = new Map<string, number>();
  for (const [id, level] of Object.entries(users).slice(0, MAX_USERS)) {
    const user = userId(id);
    if (user && Number.isInteger(level)) levels.set(user, level as number);
  }
  return levels;
}

const PRESENCE = new Map<unknown, "online" | "idle" | "offline">([["online", "online"], ["unavailable", "idle"], ["offline", "offline"]]);

/** A /presence/{user}/status response; undefined where the homeserver says nothing usable (many turn presence off). */
export function parsePresence(raw: unknown): { presence: "online" | "idle" | "offline"; status?: string } | undefined {
  const info = isRecord(raw) ? raw : {};
  const presence = PRESENCE.get(info.presence);
  if (!presence) return undefined;
  const status = cleanName(info.status_msg, 128);
  return status ? { presence, status } : { presence };
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
