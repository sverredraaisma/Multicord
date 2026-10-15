import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../../src/modules/matrix/sha256";
import {
  applyState,
  CALL_MEMBERSHIP_EXPIRY_MS,
  CALL_MEMBER_TYPE,
  liveKitServices,
  liveKitTransports,
  liveKitUrl,
  RTC_MEMBER_TYPE,
  rtcIdentity,
  MAX_CALL_MEMBERS,
  parseCallMember,
  serviceUrl,
  cleanName,
  emptyState,
  eventId,
  MAX_BODY,
  MAX_EVENT_JSON,
  MAX_NAME,
  MAX_ROOM_ID,
  mimeType,
  parseContent,
  parseEncryptedFile,
  parseMedia,
  parseCryptoSync,
  parseEncryption,
  parseEvent,
  parseMembers,
  parseMxc,
  parsePage,
  parseSync,
  MAX_REACTION_KEY,
  reactionKey,
  roomId,
  stripReplyFallback,
  userId,
} from "../../../src/modules/matrix/events";

const ev = (extra: Record<string, unknown> = {}) => ({
  event_id: "$e1",
  sender: "@ana:x.org",
  origin_server_ts: 1000,
  type: "m.room.message",
  content: { msgtype: "m.text", body: "hi" },
  ...extra,
});
const st = (type: string, content: unknown, stateKey = "") => ({ type, state_key: stateKey, content, event_id: "$s", sender: "@ana:x.org", origin_server_ts: 1 });

describe("ids and names", () => {
  it("accepts only well-formed, bounded ids", () => {
    expect(roomId("!r:x.org")).toBe("!r:x.org");
    expect(roomId("!")).toBeUndefined();
    expect(roomId(`!${"a".repeat(MAX_ROOM_ID)}`)).toBeUndefined();
    expect(roomId("$r")).toBeUndefined();
    expect(roomId(5)).toBeUndefined();
    expect(eventId("$e")).toBe("$e");
    expect(eventId("!e")).toBeUndefined();
    expect(userId("@ana:x.org")).toBe("@ana:x.org");
    expect(userId("@ana")).toBeUndefined();
    expect(userId(undefined)).toBeUndefined();
  });

  it("parses mxc URIs and rejects anything else", () => {
    expect(parseMxc("mxc://x.org/abc_1-2")).toEqual({ server: "x.org", media: "abc_1-2" });
    expect(parseMxc("mxc://[::1]:8448/abc")).toEqual({ server: "[::1]:8448", media: "abc" });
    expect(parseMxc("mxc://x.org/../etc")).toBeUndefined();
    expect(parseMxc("https://x.org/abc")).toBeUndefined();
    expect(parseMxc(1)).toBeUndefined();
  });

  it("cleans names of control and direction characters and cuts them", () => {
    expect(cleanName(" A\u0007na‮ ")).toBe("Ana");
    expect(cleanName("\u0000 ")).toBeUndefined();
    expect(cleanName(3)).toBeUndefined();
    expect(cleanName("x".repeat(500))).toHaveLength(MAX_NAME);
  });
});

describe("message content", () => {
  it("strips reply fallbacks", () => {
    expect(stripReplyFallback("> <@a:x> hi\n> there\n\nanswer")).toBe("answer");
    expect(stripReplyFallback("> quote only")).toBe("");
    expect(stripReplyFallback("> q\nno blank")).toBe("no blank");
    expect(stripReplyFallback("plain")).toBe("plain");
  });

  it("labels media and keeps captions", () => {
    expect(parseContent({ msgtype: "m.image", body: "cat.png" })).toMatchObject({ msgtype: "m.image", text: "", media: "📷 Image" });
    expect(parseContent({ msgtype: "m.image", body: "look", filename: "cat.png" })).toMatchObject({ msgtype: "m.image", text: "look", media: "📷 Image" });
    expect(parseContent({ msgtype: "m.image", body: "cat.png", filename: "cat.png" })!.text).toBe("");
    expect(parseContent({ msgtype: "m.video", body: "v" })!.media).toBe("🎥 Video");
    expect(parseContent({ msgtype: "m.audio", body: "a" })!.media).toBe("🎵 Audio");
    expect(parseContent({ msgtype: "m.audio", body: "a", "org.matrix.msc3245.voice": {} })!.media).toBe("🎤 Voice message");
    expect(parseContent({ msgtype: "m.file", body: "report.pdf" })!.media).toBe("📎 report.pdf");
    expect(parseContent({ msgtype: "m.file", body: "see this", filename: "r.pdf" })).toMatchObject({ msgtype: "m.file", text: "see this", media: "📎 r.pdf" });
    expect(parseContent({ msgtype: "m.file", body: "" })!.media).toBe("📎 File");
    expect(parseContent({ msgtype: "m.location", body: "geo" })).toEqual({ msgtype: "m.location", text: "", media: "📍 Location" });
    expect(parseContent({ body: "s", url: "mxc://x/y" }, true)).toMatchObject({ msgtype: "m.sticker", text: "", media: "🙂 Sticker" });
  });

  it("falls back to the body for text and unknown types, cut to length", () => {
    expect(parseContent({ msgtype: "m.notice", body: "n" })).toEqual({ msgtype: "m.notice", text: "n" });
    expect(parseContent({ msgtype: "org.custom", body: "c" })).toEqual({ msgtype: "org.custom", text: "c" });
    expect(parseContent({ msgtype: "m.text", body: "x".repeat(MAX_BODY + 10) })!.text).toHaveLength(MAX_BODY + 1);
    expect(parseContent({ msgtype: "x".repeat(100), body: "b" })!.msgtype).toHaveLength(64);
  });

  it("needs a body, and a msgtype for messages", () => {
    expect(parseContent({ msgtype: "m.text" })).toBeUndefined();
    expect(parseContent({ body: "b" })).toBeUndefined();
    expect(parseContent({}, true)).toBeUndefined();
  });
});

describe("timeline events", () => {
  it("parses messages with their mentions and replies", () => {
    expect(parseEvent(ev())).toEqual({ kind: "message", id: "$e1", sender: "@ana:x.org", ts: 1000, content: { msgtype: "m.text", text: "hi" }, mentions: undefined });
    const reply = parseEvent(
      ev({
        content: {
          msgtype: "m.text",
          body: "> <@bo:x.org> q\n\nanswer",
          "m.relates_to": { "m.in_reply_to": { event_id: "$q" } },
          "m.mentions": { user_ids: ["@bo:x.org", "bad", 3] },
        },
      }),
    );
    expect(reply).toMatchObject({ kind: "message", replyTo: "$q", mentions: ["@bo:x.org"], content: { text: "answer" } });
    expect(parseEvent(ev({ content: { msgtype: "m.text", body: "> not a reply", "m.mentions": {} } }))).toMatchObject({ content: { text: "> not a reply" }, mentions: [] });
    expect(parseEvent(ev({ content: { msgtype: "m.text", body: "x", "m.relates_to": { "m.in_reply_to": { event_id: 5 } } } }))!).not.toHaveProperty("replyTo");
    expect(parseEvent(ev({ type: "m.sticker", content: { body: "s" } }))).toMatchObject({ kind: "message", content: { media: "🙂 Sticker" } });
  });

  it("parses edits with their new content", () => {
    const edit = parseEvent(
      ev({ content: { msgtype: "m.text", body: "* new", "m.new_content": { msgtype: "m.text", body: "new", "m.mentions": { user_ids: ["@me:x.org"] } }, "m.relates_to": { rel_type: "m.replace", event_id: "$orig" } } }),
    );
    expect(edit).toMatchObject({ kind: "message", replaces: "$orig", content: { text: "new" }, mentions: ["@me:x.org"] });
    expect(parseEvent(ev({ content: { body: "* x", "m.relates_to": { rel_type: "m.replace", event_id: "$o" } } }))).toBeUndefined();
    expect(parseEvent(ev({ content: { body: "* x", "m.new_content": { msgtype: "m.text", body: "x" }, "m.relates_to": { rel_type: "m.replace", event_id: 1 } } }))).toBeUndefined();
    expect(parseEvent(ev({ content: { body: "* x", "m.new_content": { msgtype: "m.text" }, "m.relates_to": { rel_type: "m.replace", event_id: "$o" } } }))).toBeUndefined();
  });

  it("parses encrypted events, redactions and redacted events", () => {
    const encrypted = ev({ type: "m.room.encrypted", content: { ciphertext: "…" } });
    expect(parseEvent(encrypted)).toEqual({ kind: "encrypted", id: "$e1", sender: "@ana:x.org", ts: 1000, raw: JSON.stringify(encrypted) });
    expect(parseEvent(ev({ type: "m.room.redaction", redacts: "$old", content: {} }))).toMatchObject({ kind: "redaction", redacts: "$old" });
    expect(parseEvent(ev({ type: "m.room.redaction", content: { redacts: "$v11" } }))).toMatchObject({ kind: "redaction", redacts: "$v11" });
    expect(parseEvent(ev({ type: "m.room.redaction", content: {} }))).toBeUndefined();
    expect(parseEvent(ev({ unsigned: { redacted_because: {} }, content: {} }))).toMatchObject({ kind: "redacted", id: "$e1" });
    expect(parseEvent(ev({ content: {} }))).toMatchObject({ kind: "redacted" });
    expect(parseEvent(ev({ content: "nope" }))).toMatchObject({ kind: "redacted" });
    expect(parseEvent(ev({ unsigned: "x" }))).toMatchObject({ kind: "message" });
  });

  it("parses reactions, keeping only keys that can be shown as they are", () => {
    const reaction = (relates: unknown, extra: Record<string, unknown> = {}) => parseEvent(ev({ type: "m.reaction", content: { "m.relates_to": relates }, ...extra }));
    expect(reaction({ rel_type: "m.annotation", event_id: "$msg", key: "👍" })).toEqual({ kind: "reaction", id: "$e1", sender: "@ana:x.org", ts: 1000, target: "$msg", key: "👍" });
    expect(reaction({ rel_type: "m.annotation", event_id: "$msg", key: "k".repeat(MAX_REACTION_KEY) })).toMatchObject({ key: "k".repeat(MAX_REACTION_KEY) });
    for (const key of ["k".repeat(MAX_REACTION_KEY + 1), "", " 👍", "a‮b", "a\nb", 1, undefined]) {
      expect(reaction({ rel_type: "m.annotation", event_id: "$msg", key })).toBeUndefined();
    }
    expect(reaction({ rel_type: "m.replace", event_id: "$msg", key: "👍" })).toBeUndefined();
    expect(reaction({ rel_type: "m.annotation", event_id: "msg", key: "👍" })).toBeUndefined();
    expect(reaction("nope")).toBeUndefined();
    expect(parseEvent(ev({ type: "m.reaction", content: {} }))).toBeUndefined();
    // A redacted reaction is a redacted event: whatever it reacted to loses it.
    expect(reaction({}, { unsigned: { redacted_because: {} } })).toMatchObject({ kind: "redacted", id: "$e1" });
    expect(reactionKey("🎉")).toBe("🎉");
    expect(reactionKey("🎉 ")).toBeUndefined();
  });

  it("knows encrypted reactions by their readable relation", () => {
    const encrypted = (relates: unknown) => parseEvent(ev({ type: "m.room.encrypted", content: { ciphertext: "…", "m.relates_to": relates } }));
    expect(encrypted({ rel_type: "m.annotation", event_id: "$msg", key: "👍" })).toMatchObject({ kind: "encrypted", annotates: "$msg" });
    expect(encrypted({ rel_type: "m.annotation", event_id: "msg" })).not.toHaveProperty("annotates");
    expect(encrypted({ rel_type: "m.annotation", event_id: "$msg" })).not.toHaveProperty("replaces");
  });

  it("drops state events, unknown types and malformed events", () => {
    expect(parseEvent(ev({ state_key: "" }))).toBeUndefined();
    expect(parseEvent(ev({ type: "m.poll.start" }))).toBeUndefined();
    expect(parseEvent(ev({ event_id: "e1" }))).toBeUndefined();
    expect(parseEvent(ev({ sender: "ana" }))).toBeUndefined();
    expect(parseEvent(ev({ origin_server_ts: "1" }))).toBeUndefined();
    expect(parseEvent(ev({ origin_server_ts: -1 }))).toBeUndefined();
    expect(parseEvent(ev({ origin_server_ts: Infinity }))).toBeUndefined();
    expect(parseEvent(null)).toBeUndefined();
    expect(parseEvent([])).toBeUndefined();
  });
});

describe("room state", () => {
  it("applies names, aliases, avatars and members", () => {
    const state = emptyState();
    applyState(state, st("m.room.name", { name: " Lounge " }));
    applyState(state, st("m.room.canonical_alias", { alias: "#lounge:x.org" }));
    applyState(state, st("m.room.avatar", { url: "mxc://x.org/av" }));
    applyState(state, st("m.room.member", { membership: "join", displayname: "Ana", avatar_url: "mxc://x.org/a" }, "@ana:x.org"));
    applyState(state, st("m.room.member", { displayname: 5, avatar_url: "http://evil" }, "@bo:x.org"));
    applyState(state, st("m.room.member", { membership: "join" }, "not-a-user"));
    expect(state).toEqual({
      name: "Lounge",
      alias: "#lounge:x.org",
      avatar: "mxc://x.org/av",
      members: { "@ana:x.org": { membership: "join", name: "Ana", avatar: "mxc://x.org/a" }, "@bo:x.org": { membership: "leave" } },
    });
  });

  it("records cleared values as empty and ignores non-room state keys", () => {
    const state = emptyState();
    applyState(state, st("m.room.name", {}));
    applyState(state, st("m.room.canonical_alias", { alias: 1 }));
    applyState(state, st("m.room.avatar", { url: "bad" }));
    applyState(state, st("m.room.name", { name: "Other" }, "x"));
    applyState(state, st("m.room.canonical_alias", { alias: "#a:x" }, "x"));
    applyState(state, st("m.room.avatar", { url: "mxc://x/y" }, "x"));
    applyState(state, st("m.room.topic", { topic: "t" }));
    applyState(state, { type: "m.room.name", content: { name: "no state key" } });
    applyState(state, "junk");
    expect(state).toEqual({ name: "", alias: "", avatar: "", members: {} });
  });

  it("treats any encryption event as encrypted, even a malformed one", () => {
    const state = emptyState();
    applyState(state, st("m.room.encryption", "garbage", "odd"));
    expect(state.encrypted).toBe(true);
    const other = emptyState();
    applyState(other, { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } });
    expect(other.encrypted).toBe(true);
  });
});

describe("sync responses", () => {
  it("parses joined and left rooms, DMs, unread counts and heroes", () => {
    const sync = parseSync({
      next_batch: "s2",
      account_data: { events: [{ type: "other" }, { type: "m.direct", content: { "@bo:x.org": ["!dm:x.org", "bad", 4], "bad": ["!r:x"], "@cy:x.org": ["nope"] } }] },
      rooms: {
        join: {
          "!dm:x.org": {
            state: { events: [st("m.room.member", { membership: "join", displayname: "Bo" }, "@bo:x.org")] },
            timeline: { events: [ev(), st("m.room.name", { name: "Chat" }), { junk: true }], limited: true, prev_batch: "p1" },
            unread_notifications: { notification_count: 3, highlight_count: -1 },
            summary: { "m.heroes": ["@bo:x.org", "bad"] },
          },
          "bad-id": {},
          "!x:x.org": "not a room",
          "!plain:x.org": { timeline: { prev_batch: "x".repeat(5000) }, unread_notifications: {}, summary: {} },
        },
        leave: { "!gone:x.org": {}, "junk": {} },
      },
    });
    expect(sync.nextBatch).toBe("s2");
    expect(sync.directs).toEqual({ "@bo:x.org": ["!dm:x.org"] });
    expect(sync.left).toEqual(["!gone:x.org"]);
    expect(sync.joined).toHaveLength(2);
    const [dm, plain] = sync.joined;
    expect(dm).toMatchObject({
      roomId: "!dm:x.org",
      limited: true,
      prevBatch: "p1",
      unread: { notifications: 3, highlights: 0 },
      heroes: ["@bo:x.org"],
      state: { name: "Chat", members: { "@bo:x.org": { name: "Bo" } } },
    });
    expect(dm!.timeline.map((e) => e.id)).toEqual(["$e1"]);
    expect(plain).toEqual({ roomId: "!plain:x.org", state: { members: {} }, timeline: [], limited: false, unread: { notifications: 0, highlights: 0 } });
  });

  it("caps unread counts", () => {
    const sync = parseSync({ next_batch: "s", rooms: { join: { "!a:x": { unread_notifications: { notification_count: 1e12, highlight_count: 1.5 } } } } });
    expect(sync.joined[0]!.unread).toEqual({ notifications: 1_000_000, highlights: 0 });
  });

  it("leaves out DMs when account data has none, and handles a bare response", () => {
    expect(parseSync({ next_batch: "s", account_data: { events: [] }, rooms: { join: [], leave: "x" } })).toEqual({
      nextBatch: "s",
      joined: [],
      left: [],
      crypto: { toDevice: "[]", changed: [], left: [], oneTimeKeys: {} },
    });
    expect(parseSync({ next_batch: "s", account_data: { events: [{ type: "m.direct", content: "junk" }] } }).directs).toEqual({});
  });

  it("rejects responses without a usable next_batch", () => {
    expect(() => parseSync({})).toThrow("unreadable sync");
    expect(() => parseSync({ next_batch: "" })).toThrow();
    expect(() => parseSync({ next_batch: "x".repeat(5000) })).toThrow();
    expect(() => parseSync([])).toThrow();
  });
});

describe("history pages", () => {
  it("returns events oldest first with their state and the next token", () => {
    const page = parsePage({
      chunk: [ev({ event_id: "$new", origin_server_ts: 3 }), st("m.room.member", { membership: "join", displayname: "Cy" }, "@cy:x.org"), ev({ event_id: "$old", origin_server_ts: 1 })],
      state: [st("m.room.member", { membership: "join", displayname: "Ana" }, "@ana:x.org")],
      end: "t2",
    });
    expect(page.events.map((e) => e.id)).toEqual(["$old", "$new"]);
    expect(Object.keys(page.state.members)).toEqual(["@ana:x.org", "@cy:x.org"]);
    expect(page.end).toBe("t2");
  });

  it("has no token at the start of the room", () => {
    expect(parsePage({ chunk: [] })).toEqual({ events: [], state: { members: {} } });
    expect(parsePage({ end: "" }).end).toBeUndefined();
    expect(() => parsePage("x")).toThrow("unreadable history");
  });
});

describe("encryption", () => {
  it("keeps encrypted events whole for decrypting, with their session and edit target", () => {
    const edit = ev({ type: "m.room.encrypted", content: { session_id: "S1", "m.relates_to": { rel_type: "m.replace", event_id: "$orig" } } });
    expect(parseEvent(edit)).toEqual({ kind: "encrypted", id: "$e1", sender: "@ana:x.org", ts: 1000, raw: JSON.stringify(edit), sessionId: "S1", replaces: "$orig" });
    const reply = parseEvent(ev({ type: "m.room.encrypted", content: { session_id: "", "m.relates_to": { "m.in_reply_to": { event_id: "$x" } } } }));
    expect(reply).not.toHaveProperty("sessionId");
    expect(reply).not.toHaveProperty("replaces");
    expect(parseEvent(ev({ type: "m.room.encrypted", content: { session_id: "x".repeat(129), "m.relates_to": { rel_type: "m.replace", event_id: "bad" } } }))).toEqual({
      kind: "encrypted",
      id: "$e1",
      sender: "@ana:x.org",
      ts: 1000,
      raw: expect.any(String),
    });
    // Larger than any genuine event: not handed to the crypto library.
    const huge = parseEvent(ev({ type: "m.room.encrypted", content: { ciphertext: "x".repeat(MAX_EVENT_JSON) } }));
    expect(huge).toEqual({ kind: "encrypted", id: "$e1", sender: "@ana:x.org", ts: 1000 });
  });

  it("reads the room's encryption settings and history visibility", () => {
    const state = emptyState();
    applyState(state, st("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2", rotation_period_ms: 3600000, rotation_period_msgs: 50 }));
    applyState(state, st("m.room.history_visibility", { history_visibility: "joined" }));
    expect(state).toMatchObject({ encrypted: true, encryption: { algorithm: "m.megolm.v1.aes-sha2", rotationMs: 3600000, rotationMsgs: 50 }, history: "joined" });
    const odd = emptyState();
    applyState(odd, st("m.room.encryption", { algorithm: 5, rotation_period_ms: -1, rotation_period_msgs: 1.5 }, "x"));
    applyState(odd, st("m.room.history_visibility", { history_visibility: 1 }));
    applyState(odd, st("m.room.history_visibility", { history_visibility: "shared" }, "x"));
    // Encrypted all the same, but with no settings to encrypt by.
    expect(odd).toEqual({ encrypted: true, members: {} });
    expect(parseEncryption({ algorithm: "x".repeat(65), rotation_period_ms: 0 })).toEqual({ algorithm: "" });
  });

  it("reads the encryption parts of a sync, checking their outline", () => {
    const toDevice = { type: "m.room.encrypted", sender: "@bo:x.org", content: { ciphertext: {} } };
    const crypto = parseCryptoSync({
      to_device: {
        events: [toDevice, { type: "x", sender: "bo", content: {} }, { type: 5, sender: "@bo:x.org", content: {} }, { type: "x", sender: "@bo:x.org" }, { type: "x".repeat(256), sender: "@bo:x.org", content: {} }, { type: "big", sender: "@bo:x.org", content: { x: "y".repeat(MAX_EVENT_JSON) } }, "junk"],
      },
      device_lists: { changed: ["@a:x.org", "bad", 5], left: ["@b:x.org"] },
      device_one_time_keys_count: { signed_curve25519: 12, odd: -1, frac: 1.5, ["x".repeat(65)]: 1, big: 1e9 },
      device_unused_fallback_key_types: ["signed_curve25519", 5],
    });
    expect(crypto).toEqual({ toDevice: JSON.stringify([toDevice]), changed: ["@a:x.org"], left: ["@b:x.org"], oneTimeKeys: { signed_curve25519: 12, big: 1_000_000 }, fallbackKeys: ["signed_curve25519"] });
    expect(parseCryptoSync({ "org.matrix.msc2732.device_unused_fallback_key_types": [] }).fallbackKeys).toEqual([]);
    expect(parseCryptoSync({ device_lists: "x", to_device: "x" })).toEqual({ toDevice: "[]", changed: [], left: [], oneTimeKeys: {} });
    expect(parseSync({ next_batch: "s", device_one_time_keys_count: { signed_curve25519: 3 } }).crypto?.oneTimeKeys).toEqual({ signed_curve25519: 3 });
  });

  it("lists joined and invited members", () => {
    const member = (user: unknown, membership: unknown) => ({ type: "m.room.member", state_key: user, content: { membership } });
    expect(
      parseMembers({
        chunk: [member("@a:x.org", "join"), member("@b:x.org", "invite"), member("@c:x.org", "leave"), member("@a:x.org", "join"), member("bad", "join"), { type: "m.room.name", state_key: "@d:x.org", content: { membership: "join" } }, { type: "m.room.member", state_key: "@e:x.org" }, "junk"],
      }),
    ).toEqual(["@a:x.org", "@b:x.org"]);
    expect(parseMembers(null)).toEqual([]);
  });
});

describe("rooms without counts", () => {
  it("leaves unread counts out when the server sends none", () => {
    const sync = parseSync({ next_batch: "s", rooms: { join: { "!r:x.org": { timeline: { events: [] } } } } });
    expect(sync.joined[0]).not.toHaveProperty("unread");
  });
});

describe("call memberships", () => {
  const member = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: CALL_MEMBER_TYPE,
    state_key: "_@ana:x.org_ANADEV_m.call",
    sender: "@ana:x.org",
    origin_server_ts: 5000,
    event_id: "$m1",
    content,
    ...extra,
  });
  const joined = {
    application: "m.call",
    call_id: "",
    scope: "m.room",
    device_id: "ANADEV",
    expires: 3600_000,
    focus_active: { type: "livekit", focus_selection: "multi_sfu" },
    foci_preferred: [{ type: "other" }, { type: "livekit", livekit_service_url: "https://jwt.call.x.org/" }],
    "m.call.intent": "video",
  };

  it("reads a device's membership: its sender, device, times and call service", () => {
    expect(parseCallMember(member(joined))).toEqual({
      stateKey: "_@ana:x.org_ANADEV_m.call",
      member: { user: "@ana:x.org", deviceId: "ANADEV", createdTs: 5000, expiresAt: 3605_000, focus: "https://jwt.call.x.org", intent: "video", identities: ["@ana:x.org:ANADEV"] },
    });
    // A renewal keeps the start time; without `expires` Element Call's four hours apply, and at most a week.
    const renewed = parseCallMember(member({ ...joined, created_ts: 1000, expires: undefined, foci_preferred: undefined, "m.call.intent": "" }))!.member!;
    expect(renewed).toEqual({ user: "@ana:x.org", deviceId: "ANADEV", createdTs: 1000, expiresAt: 1000 + CALL_MEMBERSHIP_EXPIRY_MS, identities: ["@ana:x.org:ANADEV"] });
    expect(parseCallMember(member({ ...joined, expires: 1e12 }))!.member!.expiresAt).toBe(5000 + 7 * 24 * 3600_000);
  });

  it("counts left, malformed and other calls as no membership", () => {
    const none = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => expect(parseCallMember(member(content, extra))).toEqual({ stateKey: "_@ana:x.org_ANADEV_m.call", member: null });
    none({});
    none({ memberships: [] }); // the deprecated form
    none({ ...joined, application: "m.other" });
    none({ ...joined, call_id: "breakout" });
    none({ ...joined, scope: "m.user" });
    none({ ...joined, device_id: "" });
    none({ ...joined, device_id: "x".repeat(256) });
    none({ ...joined, focus_active: undefined });
    none({ ...joined, focus_active: { type: 1 } });
    none({ ...joined, created_ts: -1 });
    none({ ...joined, expires: 0 });
    none({ ...joined, expires: Number.POSITIVE_INFINITY });
    none(joined, { sender: "ana" });
    none(joined, { origin_server_ts: "late" });
    none(joined, { content: "nope" });
  });

  it("ignores other events", () => {
    expect(parseCallMember(member(joined, { type: "m.room.member" }))).toBeUndefined();
    expect(parseCallMember(member(joined, { state_key: undefined }))).toBeUndefined();
    expect(parseCallMember(member(joined, { state_key: "k".repeat(601) }))).toBeUndefined();
    expect(parseCallMember("x")).toBeUndefined();
  });

  it("checks call service URLs", () => {
    expect(serviceUrl("https://jwt.x.org/livekit/jwt//")).toBe("https://jwt.x.org/livekit/jwt");
    for (const bad of ["http://jwt.x.org", "https://u:p@jwt.x.org", "https://jwt.x.org/?a=1", "https://jwt.x.org/#a", "nope", 5, `https://x.org/${"a".repeat(2048)}`]) expect(serviceUrl(bad)).toBeUndefined();
    expect(liveKitServices([{ type: "livekit", livekit_service_url: "https://a.x.org" }, { type: "livekit", livekit_service_url: "https://a.x.org/" }, { type: "livekit" }, null, { type: "livekit", livekit_service_url: "https://b.x.org" }])).toEqual([
      "https://a.x.org",
      "https://b.x.org",
    ]);
    expect(liveKitServices("x")).toEqual([]);
  });

  it("collects membership changes from a sync's state and timeline, the last one per state key winning", () => {
    const sync = parseSync({
      next_batch: "n",
      rooms: {
        join: {
          "!r:x.org": {
            state: { events: [member(joined), member(joined, { state_key: "__proto__", sender: "@bo:x.org" })] },
            timeline: { events: [member({}), ev()] },
          },
          "!quiet:x.org": { timeline: { events: [ev()] } },
        },
      },
    });
    const [room, quiet] = sync.joined;
    expect(room!.calls).toEqual(new Map([["_@ana:x.org_ANADEV_m.call", null], ["__proto__", expect.objectContaining({ user: "@bo:x.org" })]]));
    expect(room!.timeline).toHaveLength(1);
    expect(quiet!.calls).toBeUndefined();
  });

  it("keeps a bounded number of state keys per room", () => {
    const events = Array.from({ length: MAX_CALL_MEMBERS * 2 + 5 }, (_, i) => member(joined, { state_key: `k${i}` }));
    const sync = parseSync({ next_batch: "n", rooms: { join: { "!r:x.org": { state: { events }, timeline: { events: [member({}, { state_key: "k0" })] } } } } });
    const calls = sync.joined[0]!.calls!;
    expect(calls.size).toBe(MAX_CALL_MEMBERS * 2);
    // Known keys still update.
    expect(calls.get("k0")).toBeNull();
  });
});

describe("sticky call memberships (m.rtc.member)", () => {
  const NOW = 10_000_000;
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());
  const HASHED = "5OWO3FyHTtPBGuwDVlk4J4WzqWJeqXInzEtSSYWiu5k"; // sha256(["@ana:x.org","uuid-a"]), as lk-jwt-service and matrix-js-sdk make it
  const joined = {
    slot_id: "m.call#ROOM",
    application: { type: "m.call", "m.call.intent": "video" },
    member: { user_id: "@ana:x.org", device_id: "ANADEV", id: "uuid-a" },
    transports: { published: [{ type: "livekit", livekit_service_url: "https://jwt.x.org/", url: "wss://sfu.x.org" }], can_subscribe: ["livekit"] },
    versions: [],
    msc4354_sticky_key: "uuid-a",
  };
  const rtc = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: RTC_MEMBER_TYPE,
    sender: "@ana:x.org",
    origin_server_ts: NOW - 1000,
    event_id: "$r1",
    msc4354_sticky: { duration_ms: 3_600_000 },
    content,
    ...extra,
  });

  it("reads a member's sticky membership: its device, member id, transports and LiveKit identities", () => {
    expect(parseEvent(rtc(joined))).toEqual({
      kind: "rtc",
      id: "$r1",
      sender: "@ana:x.org",
      ts: NOW - 1000,
      key: "@ana:x.org|uuid-a",
      expiresAt: NOW - 1000 + 3_600_000,
      member: {
        user: "@ana:x.org",
        deviceId: "ANADEV",
        memberId: "uuid-a",
        createdTs: NOW - 1000,
        expiresAt: NOW - 1000 + 3_600_000,
        focus: "https://jwt.x.org",
        sfu: "wss://sfu.x.org",
        intent: "video",
        identities: [HASHED, "@ana:x.org:ANADEV"],
      },
    });
    expect(rtcIdentity("@ana:x.org", "uuid-a")).toBe(HASHED);
  });

  it("takes the identities matrix-js-sdk takes for each kind of transport", () => {
    const only = (published: unknown[]) => (parseEvent(rtc({ ...joined, transports: { published, can_subscribe: [] } })) as { member: { identities: string[]; focus?: string; sfu?: string } }).member;
    expect(only([{ type: "livekit", livekit_service_url: "https://jwt.x.org" }])).toMatchObject({ identities: ["@ana:x.org:ANADEV"], focus: "https://jwt.x.org" });
    expect(only([{ type: "livekit", url: "wss://sfu.x.org" }])).toMatchObject({ identities: [HASHED], sfu: "wss://sfu.x.org" });
    // A LiveKit server we may not reach (plain ws) still names the identity, but is no transport for us.
    const plain = only([{ type: "livekit", url: "ws://sfu.x.org" }]);
    expect(plain.identities).toEqual([HASHED]);
    expect(plain.sfu).toBeUndefined();
    expect(only([{ type: "other" }]).identities).toEqual([]);
    expect(parseEvent(rtc({ ...joined, application: { type: "m.call" } }))).not.toHaveProperty("member.intent");
    // Each from its first transport that has one.
    expect(only([{ type: "livekit", livekit_service_url: "https://a.x.org" }, { type: "livekit", url: "wss://b.x.org" }])).toMatchObject({ focus: "https://a.x.org", sfu: "wss://b.x.org" });
  });

  it("counts from the server's remaining sticky time, else from the event's time, never from the future, for an hour at most", () => {
    const expiry = (extra: Record<string, unknown>) => (parseEvent(rtc(joined, extra)) as { expiresAt: number }).expiresAt;
    expect(expiry({ unsigned: { msc4354_sticky_duration_ttl_ms: 5000 } })).toBe(NOW + 5000);
    expect(expiry({ unsigned: { msc4354_sticky_duration_ttl_ms: 1e12 } })).toBe(NOW + 3_600_000);
    expect(expiry({ unsigned: { msc4354_sticky_duration_ttl_ms: -1 } })).toBe(NOW - 1000 + 3_600_000);
    expect(expiry({ origin_server_ts: NOW + 50_000 })).toBe(NOW + 3_600_000);
    expect(expiry({ msc4354_sticky: { duration_ms: 1e12 } })).toBe(NOW - 1000 + 3_600_000);
    expect(expiry({ msc4354_sticky: { duration_ms: 60_000 } })).toBe(NOW - 1000 + 60_000);
  });

  it("reads a left member, another slot or a malformed membership as no membership of the call", () => {
    const none = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => expect(parseEvent(rtc(content, extra))).toMatchObject({ kind: "rtc", key: "@ana:x.org|uuid-a", member: null });
    none({ slot_id: "m.call#ROOM", msc4354_sticky_key: "uuid-a" });
    none({ ...joined, slot_id: "m.call#breakout" });
    none({ ...joined, application: { type: "m.other" } });
    none({ ...joined, application: "m.call" });
    none({ ...joined, member: { ...joined.member, user_id: "@bo:x.org" } });
    none({ ...joined, member: { ...joined.member, device_id: "" } });
    none({ ...joined, member: { ...joined.member, id: "x".repeat(256) } });
    none({ ...joined, member: "ana" });
    none({ ...joined, transports: { published: "x", can_subscribe: [] } });
    none({ ...joined, transports: { published: [{ url: "wss://sfu.x.org" }], can_subscribe: [] } });
    none({ ...joined, transports: { published: [null], can_subscribe: [] } });
    none({ ...joined, transports: { published: [], can_subscribe: [5] } });
    none({ ...joined, transports: "x" });
    none({ ...joined, versions: undefined });
    none({ ...joined, versions: [1] });
  });

  it("ignores events that are not sticky or have no usable sticky key", () => {
    expect(parseEvent(rtc(joined, { msc4354_sticky: undefined }))).toBeUndefined();
    expect(parseEvent(rtc(joined, { msc4354_sticky: { duration_ms: 0 } }))).toBeUndefined();
    expect(parseEvent(rtc({ ...joined, msc4354_sticky_key: undefined }))).toBeUndefined();
    expect(parseEvent(rtc({ ...joined, msc4354_sticky_key: "" }))).toBeUndefined();
    expect(parseEvent(rtc({ ...joined, msc4354_sticky_key: "k".repeat(256) }))).toBeUndefined();
    expect(parseEvent(rtc({ ...joined, sticky_key: "other" }))).toBeUndefined();
    // The stable field alone, or both agreeing, will do.
    expect(parseEvent(rtc({ ...joined, msc4354_sticky_key: undefined, sticky_key: "uuid-a" }))).toMatchObject({ key: "@ana:x.org|uuid-a" });
    expect(parseEvent(rtc({ ...joined, sticky_key: "uuid-a" }))).toMatchObject({ key: "@ana:x.org|uuid-a" });
    // State events of the type are not memberships.
    expect(parseEvent(rtc(joined, { state_key: "" }))).toBeUndefined();
    expect(parseEvent(rtc(joined, { unsigned: { redacted_because: {} } }))).toMatchObject({ kind: "redacted" });
  });

  it("collects sticky events from the timeline and from beside it, once each", () => {
    const encrypted = ev({ type: "m.room.encrypted", event_id: "$enc", content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x", session_id: "S" }, msc4354_sticky: { duration_ms: 1000 } });
    const sync = parseSync({
      next_batch: "n",
      rooms: {
        join: {
          "!r:x.org": {
            timeline: { events: [rtc(joined), ev()] },
            msc4354_sticky: { events: [rtc(joined), rtc(joined, { event_id: "$r2", sender: "@bo:x.org", content: { ...joined, member: { ...joined.member, user_id: "@bo:x.org" } } }), encrypted, ev({ event_id: "$ring" }), "x"] },
          },
          "!quiet:x.org": { timeline: { events: [] }, msc4354_sticky: { events: [ev()] } },
        },
      },
    });
    const [r, quiet] = sync.joined;
    expect(r!.timeline.map((e) => [e.kind, e.id])).toEqual([
      ["rtc", "$r1"],
      ["message", "$e1"],
    ]);
    expect(r!.sticky!.map((e) => [e.kind, e.id])).toEqual([
      ["rtc", "$r2"],
      ["encrypted", "$enc"],
    ]);
    expect(quiet!.sticky).toBeUndefined();
  });

  it("checks LiveKit transports as the homeserver names them", () => {
    expect(
      liveKitTransports([
        { type: "livekit", livekit_service_url: "https://jwt.x.org/", url: "wss://sfu.x.org" },
        { type: "livekit", livekit_service_url: "https://jwt.x.org", url: "wss://sfu.x.org" },
        { type: "livekit", url: "ws://plain.x.org", livekit_service_url: "http://plain.x.org" },
        { type: "livekit", url: "https://sfu2.x.org" },
        { type: "other", url: "wss://x.org" },
        "x",
      ]),
    ).toEqual([{ service: "https://jwt.x.org", sfu: "wss://sfu.x.org" }, { sfu: "https://sfu2.x.org" }]);
    expect(liveKitTransports(undefined)).toEqual([]);
    expect(liveKitUrl("wss://u:p@sfu.x.org")).toBeUndefined();
    expect(liveKitUrl("not a url")).toBeUndefined();
  });

  it("hashes with SHA-256", () => {
    const hex = (data: Uint8Array) => [...sha256(data)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(new Uint8Array(1000).fill(97))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });
});

describe("media", () => {
  const KEY = { kty: "oct", alg: "A256CTR", k: "a".repeat(43), key_ops: ["encrypt", "decrypt"], ext: true };
  const FILE = { v: "v2", url: "mxc://x.org/enc", key: KEY, iv: "b".repeat(22), hashes: { sha256: "c".repeat(43) } };
  const SOURCE = { url: "mxc://x.org/enc", key: "a".repeat(43), iv: "b".repeat(22), sha256: "c".repeat(43) };

  it("reads MIME types without parameters", () => {
    expect(mimeType("image/PNG")).toBe("image/png");
    expect(mimeType(" image/svg+xml ")).toBe("image/svg+xml");
    expect(mimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    for (const bad of ["image/png;base64", "text/html,<b>", "image", "/png", "image/", "a b/c", "x".repeat(70) + "/y", 5, undefined]) expect(mimeType(bad)).toBeUndefined();
  });

  it("describes plain media", () => {
    const content = { msgtype: "m.image", body: "look", filename: "cat.gif", url: "mxc://x.org/cat", info: { mimetype: "image/gif", size: 1234, w: 640, h: 480 } };
    expect(parseContent(content)).toEqual({
      msgtype: "m.image",
      text: "look",
      media: "📷 Image",
      attachment: { kind: "image", name: "cat.gif", url: "mxc://x.org/cat", mime: "image/gif", size: 1234, width: 640, height: 480 },
    });
    expect(parseContent({ msgtype: "m.video", body: "clip.mp4", url: "mxc://x.org/v", info: { duration: 5000 } })!.attachment).toEqual({ kind: "video", name: "clip.mp4", url: "mxc://x.org/v", durationMs: 5000 });
    expect(parseContent({ msgtype: "m.audio", body: "a.ogg", url: "mxc://x.org/a" })!.attachment!.kind).toBe("audio");
    expect(parseContent({ msgtype: "m.file", body: "r.pdf", url: "mxc://x.org/f" })!.attachment!.kind).toBe("file");
    expect(parseContent({ body: "Happy cat", url: "mxc://x.org/s", info: { mimetype: "image/png", w: 256, h: 256 } }, true)!.attachment).toEqual({
      kind: "sticker",
      name: "Happy cat",
      url: "mxc://x.org/s",
      mime: "image/png",
      width: 256,
      height: 256,
    });
  });

  it("names media by file name, else body, else kind", () => {
    expect(parseMedia({ body: "", url: "mxc://x.org/a" }, "image").name).toBe("Image");
    expect(parseMedia({ body: "‮evil\u0000.png", url: "mxc://x.org/a" }, "file").name).toBe("evil.png");
    expect(parseMedia({ body: "b", filename: "x".repeat(300), url: "mxc://x.org/a" }, "file").name).toHaveLength(255);
    expect(parseMedia({ url: "mxc://x.org/a" }, "sticker").name).toBe("Sticker");
  });

  it("drops info that does not fit", () => {
    const media = parseMedia({ body: "a", url: "mxc://x.org/a", info: { mimetype: "text/html;x", size: -1, w: 0, h: 10, duration: 1.5 } }, "image");
    expect(media).toEqual({ kind: "image", name: "a", url: "mxc://x.org/a" });
    // Both sides or none: a picture of one known side cannot be laid out.
    expect(parseMedia({ body: "a", url: "mxc://x.org/a", info: { w: 10, h: 100_001 } }, "image").width).toBeUndefined();
    expect(parseMedia({ body: "a", url: "mxc://x.org/a", info: "nope" }, "image")).toEqual({ kind: "image", name: "a", url: "mxc://x.org/a" });
  });

  it("marks bridged GIFs as looping videos", () => {
    expect(parseMedia({ body: "g", url: "mxc://x.org/g", info: { "fi.mau.loop": true } }, "video").loop).toBe(true);
    expect(parseMedia({ body: "g", url: "mxc://x.org/g", info: { "fi.mau.gif": true } }, "video").loop).toBe(true);
    expect(parseMedia({ body: "g", url: "mxc://x.org/g", info: { "fi.mau.loop": true } }, "image").loop).toBeUndefined();
    expect(parseMedia({ body: "g", url: "mxc://x.org/g", info: { "fi.mau.loop": "yes" } }, "video").loop).toBeUndefined();
  });

  it("checks mxc URIs strictly", () => {
    for (const url of ["mxc://x.org/../admin", "mxc://x.org/a/b", "https://x.org/a", "mxc://x.org/", "mxc:///a", "mxc://x.org/a?b", 5, undefined]) {
      expect(parseMedia({ body: "a", url }, "image")).toEqual({ kind: "image", name: "a", problem: "its address is not valid" });
    }
  });

  it("reads encrypted files", () => {
    expect(parseEncryptedFile(FILE)).toEqual(SOURCE);
    expect(parseEncryptedFile({ ...FILE, iv: `${"b".repeat(22)}==`, hashes: { sha256: `${"c".repeat(43)}=` } })).toMatchObject({ iv: `${"b".repeat(22)}==` });
    expect(parseEncryptedFile(undefined)).toBeUndefined();
    expect(parseEncryptedFile("file")).toBeUndefined();
    const media = parseMedia({ body: "secret.png", file: FILE, info: { mimetype: "image/png", size: 9 } }, "image");
    expect(media).toEqual({ kind: "image", name: "secret.png", file: SOURCE, mime: "image/png", size: 9 });
    // An encrypted file wins over a plain URL beside it.
    expect(parseMedia({ body: "s", url: "mxc://x.org/plain", file: FILE }, "image")).toEqual({ kind: "image", name: "s", file: SOURCE });
  });

  it.each([
    ["version 1", { ...FILE, v: "v1" }, "its encryption version is not supported"],
    ["no version", { ...FILE, v: undefined }, "its encryption version is not supported"],
    ["another key type", { ...FILE, key: { ...KEY, kty: "RSA" } }, "its encryption key is not usable"],
    ["another algorithm", { ...FILE, key: { ...KEY, alg: "A128CTR" } }, "its encryption key is not usable"],
    ["a short key", { ...FILE, key: { ...KEY, k: "a".repeat(22) } }, "its encryption key is not usable"],
    ["a key that is not base64url", { ...FILE, key: { ...KEY, k: `${"a".repeat(42)}+` } }, "its encryption key is not usable"],
    ["a key not for decrypting", { ...FILE, key: { ...KEY, key_ops: ["encrypt"] } }, "its encryption key is not usable"],
    ["no key operations", { ...FILE, key: { ...KEY, key_ops: "decrypt" } }, "its encryption key is not usable"],
    ["no key", { ...FILE, key: undefined }, "its encryption key is not usable"],
    ["a short counter block", { ...FILE, iv: "b".repeat(16) }, "its encryption details are not usable"],
    ["no counter block", { ...FILE, iv: 5 }, "its encryption details are not usable"],
    ["a malformed hash", { ...FILE, hashes: { sha256: "c".repeat(44) } }, "its encryption details are not usable"],
    ["no hashes", { ...FILE, hashes: undefined }, "its encryption details are not usable"],
    ["a malformed address", { ...FILE, url: "mxc://x.org/../a" }, "its address is not valid"],
  ])("refuses an encrypted file with %s", (_name, file, problem) => {
    expect(parseEncryptedFile(file)).toBe(problem);
    expect(parseMedia({ body: "a", file, url: "mxc://x.org/plain" }, "image")).toEqual({ kind: "image", name: "a", problem });
  });

  it("reads thumbnails, plain or encrypted", () => {
    const plain = parseMedia({ body: "a", url: "mxc://x.org/a", info: { thumbnail_url: "mxc://x.org/t", thumbnail_info: { mimetype: "image/jpeg", size: 100, w: 1, h: 1 } } }, "image");
    expect(plain.thumbnail).toEqual({ url: "mxc://x.org/t", mime: "image/jpeg", size: 100 });
    expect(parseMedia({ body: "a", file: FILE, info: { thumbnail_file: FILE } }, "video").thumbnail).toEqual({ file: SOURCE });
    expect(parseMedia({ body: "a", url: "mxc://x.org/a", info: { thumbnail_url: "mxc://x.org/../t" } }, "image").thumbnail).toBeUndefined();
    expect(parseMedia({ body: "a", url: "mxc://x.org/a", info: { thumbnail_file: { ...FILE, v: "v1" } } }, "image").thumbnail).toBeUndefined();
  });

  it("parses media in m.sticker events, edits and replies", () => {
    expect(parseEvent(ev({ type: "m.sticker", content: { body: "wave", url: "mxc://x.org/s" } }))).toMatchObject({
      kind: "message",
      content: { msgtype: "m.sticker", attachment: { kind: "sticker", name: "wave", url: "mxc://x.org/s" } },
    });
    const edit = parseEvent(
      ev({
        content: {
          msgtype: "m.image",
          body: "* new caption",
          "m.new_content": { msgtype: "m.image", body: "new caption", filename: "cat.png", url: "mxc://x.org/cat" },
          "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
        },
      }),
    );
    expect(edit).toMatchObject({ replaces: "$orig", content: { text: "new caption", attachment: { name: "cat.png", url: "mxc://x.org/cat" } } });
    const reply = parseEvent(
      ev({ content: { msgtype: "m.image", body: "> <@a:x> hi\n\nthis", filename: "c.png", url: "mxc://x.org/c", "m.relates_to": { "m.in_reply_to": { event_id: "$q" } } } }),
    );
    expect(reply).toMatchObject({ replyTo: "$q", content: { text: "this", attachment: { name: "c.png" } } });
  });
});
