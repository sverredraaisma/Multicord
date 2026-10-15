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
  MAX_PINNED,
  MAX_ROOM_ID,
  MAX_SPACE_CHILDREN,
  mimeType,
  parseContent,
  parseEncryptedFile,
  parseMedia,
  parseCryptoSync,
  parseEncryption,
  parseEvent,
  parseMembers,
  parseJoinedMembers,
  parsePowerLevels,
  parsePresence,
  parseProfile,
  parseMutedRooms,
  PUSH_RULES_TYPE,
  parseMxc,
  parsePage,
  parseSync,
  MAX_REACTION_KEY,
  reactionKey,
  roomId,
  stripReplyFallback,
  userId,
  MAX_EMOTES,
  parseEmotes,
  parsePoll,
  parseHierarchy,
  parseInvite,
  MAX_HIERARCHY_ROOMS,
  MAX_POLL_ANSWERS,
  MAX_PACK_IMAGES,
  MAX_PACK_ROOMS,
  MAX_ROOM_PACKS,
  PACK_ROOMS_TYPE,
  parsePack,
  parsePackRooms,
  ROOM_PACK_TYPE,
  shortcode,
  USER_PACK_TYPE,
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
    expect(parseEvent(ev({ content: { msgtype: "m.text", body: "x", "m.mentions": {} } }))).not.toHaveProperty("mentionsRoom");
    expect(parseEvent(ev({ content: { msgtype: "m.text", body: "all", "m.mentions": { room: true } } }))).toMatchObject({ mentions: [], mentionsRoom: true });
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

  it("reads polls in both forms, and shows the fallback text of one that cannot be read", () => {
    const unstable = {
      "org.matrix.msc3381.poll.start": {
        question: { "org.matrix.msc1767.text": "Lunch?", body: "ignored" },
        kind: "org.matrix.msc3381.poll.disclosed",
        max_selections: 5,
        answers: [{ id: "p", "org.matrix.msc1767.text": "Pizza" }, { id: "s", "org.matrix.msc1767.text": "Soup" }, { id: "p", "org.matrix.msc1767.text": "Again" }, { id: "", "org.matrix.msc1767.text": "No id" }, { id: "x" }, "bad"],
      },
    };
    expect(parseEvent(ev({ type: "org.matrix.msc3381.poll.start", content: unstable }))).toEqual({
      kind: "message",
      id: "$e1",
      sender: "@ana:x.org",
      ts: 1000,
      content: { msgtype: "m.poll", text: "", media: "📊 Lunch?", poll: { question: "Lunch?", answers: [{ id: "p", text: "Pizza" }, { id: "s", text: "Soup" }], maxSelections: 2, disclosed: true, stable: false } },
    });
    const stable = {
      "m.poll": {
        question: { "m.text": [{ mimetype: "text/html", body: "<b>Q</b>" }, { body: "Q" }] },
        kind: "m.undisclosed",
        max_selections: 0,
        answers: [{ "m.id": "a", "m.text": [{ mimetype: "text/plain", body: "A" }] }],
      },
    };
    expect(parseEvent(ev({ type: "m.poll.start", content: stable }))).toMatchObject({ content: { poll: { question: "Q", answers: [{ id: "a", text: "A" }], maxSelections: 1, disclosed: false, stable: true } } });
    expect(parsePoll({ "org.matrix.msc3381.poll.start": { question: { body: "Plain body" }, answers: [{ id: "a", body: "A" }], kind: "other" } }, false)).toMatchObject({ question: "Plain body", disclosed: false });
    expect(parsePoll({ "m.poll": { question: "not text", answers: [{ "m.id": "a", "m.text": [{ body: "A" }] }] } }, true)).toBeUndefined();
    expect(parsePoll({ "m.poll": { question: { "m.text": "Q" }, answers: [] } }, true)).toBeUndefined();
    expect(parsePoll({}, true)).toBeUndefined();
    const many = Array.from({ length: MAX_POLL_ANSWERS + 5 }, (_, i) => ({ id: `a${i}`, "org.matrix.msc1767.text": `A${i}` }));
    expect(parsePoll({ "org.matrix.msc3381.poll.start": { question: { "org.matrix.msc1767.text": "Q" }, answers: many } }, false)!.answers).toHaveLength(MAX_POLL_ANSWERS);
    // Unreadable: the fallback, in any of its forms, or nothing.
    expect(parseEvent(ev({ type: "m.poll.start", content: { "m.text": [{ body: "Poll: Q" }] } }))).toMatchObject({ kind: "message", content: { msgtype: "m.text", text: "Poll: Q" } });
    expect(parseEvent(ev({ type: "org.matrix.msc3381.poll.start", content: { "org.matrix.msc1767.text": "Old poll" } }))).toMatchObject({ content: { text: "Old poll" } });
    expect(parseEvent(ev({ type: "m.poll.start", content: { "m.text": [{ mimetype: "text/html", body: "x" }] } }))).toBeUndefined();
    expect(parseEvent(ev({ type: "m.poll.start", content: {} }))).toBeUndefined();
  });

  it("reads thread replies, whose fallback reply is no reply, and thread roots' bundled summaries", () => {
    const relates = (extra: Record<string, unknown>) => parseEvent(ev({ content: { msgtype: "m.text", body: "in thread", "m.relates_to": { rel_type: "m.thread", event_id: "$root", "m.in_reply_to": { event_id: "$latest" }, ...extra } } }));
    const fallback = relates({ is_falling_back: true });
    expect(fallback).toMatchObject({ kind: "message", thread: "$root" });
    expect(fallback).not.toHaveProperty("replyTo");
    expect(relates({})).toMatchObject({ thread: "$root", replyTo: "$latest" });
    expect(parseEvent(ev({ content: { msgtype: "m.text", body: "x", "m.relates_to": { rel_type: "m.thread", event_id: "root" } } }))).not.toHaveProperty("thread");
    const root = (thread: unknown) => parseEvent(ev({ unsigned: { "m.relations": { "m.thread": thread } } }));
    expect(root({ count: 3, latest_event: { sender: "@bo:x.org" }, current_user_participated: true })).toMatchObject({ threadInfo: { count: 3, latest: "@bo:x.org" } });
    expect(root({ count: 2, latest_event: { sender: "bo" } })).toMatchObject({ threadInfo: { count: 2 } });
    expect(root({ count: 0 })).not.toHaveProperty("threadInfo");
    expect(root({ count: 4 })).toMatchObject({ threadInfo: { count: 4 } });
    expect(root("x")).not.toHaveProperty("threadInfo");
    expect(parseEvent(ev({ unsigned: { "m.relations": "x" } }))).not.toHaveProperty("threadInfo");
    // Encrypted replies are known by their readable relation.
    expect(parseEvent(ev({ type: "m.room.encrypted", content: { ciphertext: "…", "m.relates_to": { rel_type: "m.thread", event_id: "$root" } } }))).toMatchObject({ kind: "encrypted", thread: "$root" });
  });

  it("reads poll votes and ends, which refer to their poll", () => {
    const ref = { rel_type: "m.reference", event_id: "$poll" };
    expect(parseEvent(ev({ type: "m.poll.response", content: { "m.relates_to": ref, "m.selections": ["a", 5, "b"] } }))).toEqual({ kind: "pollResponse", id: "$e1", sender: "@ana:x.org", ts: 1000, target: "$poll", answers: ["a", "b"] });
    expect(parseEvent(ev({ type: "org.matrix.msc3381.poll.response", content: { "m.relates_to": ref, "org.matrix.msc3381.poll.response": { answers: ["c"] } } }))).toMatchObject({ answers: ["c"] });
    // Not a list: a vote for nothing, which withdraws one.
    expect(parseEvent(ev({ type: "org.matrix.msc3381.poll.response", content: { "m.relates_to": ref } }))).toMatchObject({ kind: "pollResponse", answers: [] });
    expect(parseEvent(ev({ type: "m.poll.response", content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$poll" } } }))).toBeUndefined();
    expect(parseEvent(ev({ type: "m.poll.response", content: {} }))).toBeUndefined();
    expect(parseEvent(ev({ type: "m.poll.end", content: { "m.relates_to": ref } }))).toEqual({ kind: "pollEnd", id: "$e1", sender: "@ana:x.org", ts: 1000, target: "$poll" });
    expect(parseEvent(ev({ type: "org.matrix.msc3381.poll.end", content: { "m.relates_to": { rel_type: "m.reference", event_id: "poll" } } }))).toBeUndefined();
    // Encrypted votes are known by their readable relation.
    expect(parseEvent(ev({ type: "m.room.encrypted", content: { ciphertext: "…", "m.relates_to": ref } }))).toMatchObject({ kind: "encrypted", references: "$poll" });
  });

  it("drops state events, unknown types and malformed events", () => {
    expect(parseEvent(ev({ state_key: "" }))).toBeUndefined();
    expect(parseEvent(ev({ type: "m.call.invite" }))).toBeUndefined();
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

  it("reads the pinned events: valid ids, each once, the newest kept", () => {
    const state = emptyState();
    applyState(state, st("m.room.pinned_events", { pinned: ["$a", "$b", "$a", 5, "nope", "$c"] }));
    expect(state.pinned).toEqual(["$a", "$b", "$c"]);
    applyState(state, st("m.room.pinned_events", { pinned: ["$x"] }, "odd"));
    expect(state.pinned).toEqual(["$a", "$b", "$c"]);
    applyState(state, st("m.room.pinned_events", {}));
    expect(state.pinned).toEqual([]);
    applyState(state, st("m.room.pinned_events", { pinned: Array.from({ length: MAX_PINNED + 5 }, (_, i) => `$e${i}`) }));
    expect(state.pinned).toHaveLength(MAX_PINNED);
    expect(state.pinned!.at(-1)).toBe(`$e${MAX_PINNED + 4}`);
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

describe("spaces", () => {
  it("marks a room a space only from its create event's type", () => {
    const space = emptyState();
    applyState(space, st("m.room.create", { type: "m.space", creator: "@ana:x.org" }));
    expect(space.space).toBe(true);
    const room = emptyState();
    applyState(room, st("m.room.create", { creator: "@ana:x.org" }));
    applyState(room, st("m.room.create", { type: "m.space" }, "x"));
    applyState(room, st("m.room.create", "junk"));
    expect(room).toEqual({ members: {} });
  });

  it("reads children: present while via names a server, with a valid order", () => {
    const state = emptyState();
    applyState(state, { ...st("m.space.child", { via: ["x.org"], order: "a1", suggested: true }, "!a:x.org"), origin_server_ts: 1_700_000_000_000 });
    applyState(state, st("m.space.child", { via: ["", 4, "y.org"], order: "x".repeat(51) }, "!b:x.org"));
    applyState(state, st("m.space.child", { via: ["x.org"], order: "café", suggested: "yes" }, "!c:x.org"));
    applyState(state, { ...st("m.space.child", { via: ["x.org"], order: 5 }, "!d:x.org"), origin_server_ts: -5 });
    applyState(state, st("m.space.child", { via: [] }, "!e:x.org"));
    applyState(state, st("m.space.child", { via: [""] }, "!f:x.org"));
    applyState(state, st("m.space.child", {}, "!g:x.org"));
    applyState(state, st("m.space.child", { via: ["x.org"] }, "not-a-room"));
    applyState(state, st("m.space.child", { via: ["x.org"] }, ""));
    expect([...state.children!]).toEqual([
      ["!a:x.org", { order: "a1", suggested: true, ts: 1_700_000_000_000, via: ["x.org"] }],
      ["!b:x.org", { suggested: false, ts: 1, via: ["y.org"] }],
      ["!c:x.org", { suggested: false, ts: 1, via: ["x.org"] }],
      ["!d:x.org", { suggested: false, ts: 0, via: ["x.org"] }],
      ["!e:x.org", null],
      ["!f:x.org", null],
      ["!g:x.org", null],
    ]);
  });

  it("keeps the first few servers a child is joined through, those that are server names", () => {
    const state = emptyState();
    applyState(state, st("m.space.child", { via: ["a.org", "bad server", "b.org:8448", "c.org", "d.org"] }, "!a:x.org"));
    applyState(state, st("m.space.child", { via: ["has space"] }, "!b:x.org"));
    expect(state.children!.get("!a:x.org")!.via).toEqual(["a.org", "b.org:8448"]);
    expect(state.children!.get("!b:x.org")).not.toHaveProperty("via");
  });

  it("reads a space's hierarchy: its rooms, with a name or alias where they have one", () => {
    expect(
      parseHierarchy({
        rooms: [
          { room_id: "!sp:x.org", room_type: "m.space", name: "Space" },
          { room_id: "!a:x.org", name: " Chat ", canonical_alias: "#chat:x.org" },
          { room_id: "!b:x.org", canonical_alias: "#b:x.org" },
          { room_id: "!c:x.org" },
          { room_id: "bad" },
          "junk",
        ],
      }),
    ).toEqual([
      { roomId: "!sp:x.org", space: true, name: "Space" },
      { roomId: "!a:x.org", space: false, name: "Chat" },
      { roomId: "!b:x.org", space: false, name: "#b:x.org" },
      { roomId: "!c:x.org", space: false },
    ]);
    expect(parseHierarchy(undefined)).toEqual([]);
    expect(parseHierarchy({ rooms: Array.from({ length: MAX_HIERARCHY_ROOMS + 5 }, (_, i) => ({ room_id: `!r${i}:x.org` })) })).toHaveLength(MAX_HIERARCHY_ROOMS);
  });

  it("reads invitations: the room's name, whether it is a space, and who invited, from the user's own invite", () => {
    const ME = "@me:x.org";
    const mine = (sender: string, content: Record<string, unknown>) => ({ type: "m.room.member", state_key: ME, sender, content });
    const events = [
      st("m.room.canonical_alias", { alias: "#plans:x.org" }),
      st("m.room.create", { type: "m.space" }),
      { ...st("m.room.member", { membership: "join", displayname: "Bo" }, "@bo:x.org") },
      { type: "m.room.member", state_key: "@cy:x.org", sender: "@cy:x.org", content: { membership: "invite" } },
      mine("@bo:x.org", { membership: "invite", is_direct: true }),
      { type: "m.room.member", state_key: ME, sender: "@bo:x.org", content: "junk" },
    ];
    expect(parseInvite("!r:x.org", events, ME)).toEqual({ roomId: "!r:x.org", name: "#plans:x.org", inviter: "@bo:x.org", inviterName: "Bo", direct: true, space: true });
    // Without the user, any invite counts; a name comes before the alias.
    expect(parseInvite("!r:x.org", [st("m.room.name", { name: "Plans" }), st("m.room.canonical_alias", { alias: "#p:x.org" }), mine("bad", { membership: "invite" })])).toEqual({ roomId: "!r:x.org", name: "Plans", direct: false, space: false });
    expect(parseInvite("!r:x.org", "junk", ME)).toEqual({ roomId: "!r:x.org", direct: false, space: false });
    expect(parseInvite("!r:x.org", [{ type: "m.room.member", state_key: ME, sender: "@cy:x.org", content: { membership: "invite" } }], ME)).toEqual({ roomId: "!r:x.org", inviter: "@cy:x.org", direct: false, space: false });
  });

  it("reads a sync's invitations", () => {
    const invite = { type: "m.room.member", state_key: "@me:x.org", sender: "@bo:x.org", content: { membership: "invite" } };
    const sync = parseSync({ next_batch: "s", rooms: { invite: { "!i:x.org": { invite_state: { events: [invite] } }, "!j:x.org": {}, "bad": {}, "!k:x.org": "x" } } }, "@me:x.org");
    expect(sync.invited).toEqual([
      { roomId: "!i:x.org", inviter: "@bo:x.org", direct: false, space: false },
      { roomId: "!j:x.org", direct: false, space: false },
    ]);
    expect(parseSync({ next_batch: "s" })).not.toHaveProperty("invited");
  });

  it("keeps at most MAX_SPACE_CHILDREN children, but still takes changes to those it has", () => {
    const state = emptyState();
    for (let i = 0; i <= MAX_SPACE_CHILDREN; i++) applyState(state, st("m.space.child", { via: ["x.org"] }, `!r${i}:x.org`));
    expect(state.children!.size).toBe(MAX_SPACE_CHILDREN);
    expect(state.children!.has(`!r${MAX_SPACE_CHILDREN}:x.org`)).toBe(false);
    applyState(state, st("m.space.child", {}, "!r0:x.org"));
    expect(state.children!.get("!r0:x.org")).toBeNull();
  });

  it("reads space structure from a sync's state and timeline alike", () => {
    const sync = parseSync({
      next_batch: "s1",
      rooms: {
        join: {
          "!sp:x.org": {
            state: { events: [st("m.room.create", { type: "m.space" }), st("m.space.child", { via: ["x.org"] }, "!a:x.org")] },
            timeline: { events: [{ ...st("m.space.child", { via: ["x.org"] }, "!b:x.org"), event_id: "$c" }] },
          },
        },
      },
    });
    const [space] = sync.joined;
    expect(space!.state.space).toBe(true);
    expect([...space!.state.children!.keys()]).toEqual(["!a:x.org", "!b:x.org"]);
    expect(space!.timeline).toEqual([]);
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

  it("reads who is typing from the last m.typing, keeping only user ids, at most 20", () => {
    const typing = (ephemeral: unknown) => parseSync({ next_batch: "s", rooms: { join: { "!a:x.org": { ephemeral } } } }).joined[0]!.typing;
    expect(typing({ events: [{ type: "m.typing", content: { user_ids: ["@old:x.org"] } }, { type: "m.receipt", content: {} }, { type: "m.typing", content: { user_ids: ["@bo:x.org", "bo", 3] } }] })).toEqual(["@bo:x.org"]);
    expect(typing({ events: [{ type: "m.typing", content: { user_ids: Array.from({ length: 30 }, (_, i) => `@u${i}:x.org`) } }] })).toHaveLength(20);
    expect(typing({ events: [{ type: "m.typing", content: {} }] })).toEqual([]);
    expect(typing({ events: [{ type: "m.typing", content: "x" }, "junk"] })).toBeUndefined();
    expect(typing({ events: [] })).toBeUndefined();
    expect(typing("x")).toBeUndefined();
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

  it("reads joined members, power levels, profiles and presence", () => {
    expect(parseJoinedMembers({ joined: { "@a:x": { display_name: " Ana ", avatar_url: "mxc://x/a" }, "@b:x": { display_name: 5, avatar_url: "https://x/b" }, "@c:x": null, bad: {} } })).toEqual([
      { id: "@a:x", name: "Ana", avatar: "mxc://x/a" },
      { id: "@b:x" },
      { id: "@c:x" },
    ]);
    expect(parseJoinedMembers({ joined: [] })).toEqual([]);
    expect(parseJoinedMembers(null)).toEqual([]);
    expect(parseProfile("@a:x", { displayname: "Ana", avatar_url: "mxc://x/a" })).toEqual({ id: "@a:x", name: "Ana", avatar: "mxc://x/a" });
    expect(parseProfile("@a:x", undefined)).toEqual({ id: "@a:x" });
    expect([...parsePowerLevels({ users: { "@a:x": 100, "@b:x": 50.5, bad: 100 } })]).toEqual([["@a:x", 100]]);
    expect(parsePowerLevels({ users: null }).size).toBe(0);
    expect(parsePowerLevels(undefined).size).toBe(0);
    expect(parsePresence({ presence: "unavailable", status_msg: " lunch " })).toEqual({ presence: "idle", status: "lunch" });
    expect(parsePresence({ presence: "online", status_msg: 5 })).toEqual({ presence: "online" });
    expect(parsePresence({ presence: "offline" })).toEqual({ presence: "offline" });
    expect(parsePresence({ presence: "constructor" })).toBeUndefined();
    expect(parsePresence("junk")).toBeUndefined();
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

describe("image packs (MSC2545)", () => {
  it("reads shortcodes with or without their colons", () => {
    expect(shortcode("blob")).toBe("blob");
    expect(shortcode(":blob_cat:")).toBe("blob_cat");
    expect(shortcode("k".repeat(64))).toBe("k".repeat(64));
    for (const bad of ["k".repeat(65), "", "::", "a b", "a:b", "<a>", "a‮b", "a\u0007b", 5, undefined]) expect(shortcode(bad)).toBeUndefined();
  });

  it("parses a pack's name, usage and pictures, dropping what does not fit", () => {
    const pack = parsePack({
      pack: { display_name: " Cats ", usage: ["emoticon"], avatar_url: "mxc://x.org/av" },
      images: {
        cat: { url: "mxc://x.org/cat", body: "A cat", info: { mimetype: "image/PNG", w: 64, h: 64, size: 1200 } },
        both: { url: "mxc://x.org/both", usage: ["sticker", "emoticon"], info: { w: 64, size: -1, mimetype: "nope" } },
        wave: { url: "mxc://x.org/wave", usage: ["sticker"], body: "" },
        odd: { url: "mxc://x.org/odd", usage: ["other"], info: "x" },
        "bad code": { url: "mxc://x.org/x" },
        ":colons:": { url: "mxc://x.org/x" },
        nourl: { url: "https://x.org/x" },
        notrecord: "mxc://x.org/x",
      },
    });
    expect(pack).toEqual({
      name: "Cats",
      images: [
        { shortcode: "cat", url: "mxc://x.org/cat", body: "A cat", info: { mimetype: "image/png", w: 64, h: 64, size: 1200 }, emoticon: true, sticker: false },
        { shortcode: "both", url: "mxc://x.org/both", info: {}, emoticon: true, sticker: true },
        { shortcode: "wave", url: "mxc://x.org/wave", info: {}, emoticon: false, sticker: true },
        { shortcode: "odd", url: "mxc://x.org/odd", info: {}, emoticon: true, sticker: false },
      ],
    });
    // Without a usage (or an empty one), pictures are both.
    expect(parsePack({ pack: { usage: [] }, images: { a: { url: "mxc://x.org/a" } } })).toEqual({ images: [{ shortcode: "a", url: "mxc://x.org/a", info: {}, emoticon: true, sticker: true }] });
    expect(parsePack({ pack: "x", images: [] })).toEqual({ images: [] });
    expect(parsePack({})).toEqual({ images: [] });
    const many = Object.fromEntries(Array.from({ length: MAX_PACK_IMAGES + 5 }, (_, i) => [`e${i}`, { url: `mxc://x.org/e${i}` }]));
    expect(parsePack({ images: many }).images).toHaveLength(MAX_PACK_IMAGES);
  });

  it("parses the room packs enabled everywhere", () => {
    expect(
      parsePackRooms({ rooms: { "!a:x.org": { "": {}, cats: {}, ["k".repeat(256)]: {} }, nope: { "": {} }, "!b:x.org": "x" } }),
    ).toEqual([
      { roomId: "!a:x.org", stateKey: "" },
      { roomId: "!a:x.org", stateKey: "cats" },
    ]);
    expect(parsePackRooms({ rooms: "x" })).toEqual([]);
    expect(parsePackRooms("x")).toEqual([]);
    const keys = Object.fromEntries(Array.from({ length: MAX_ROOM_PACKS + 5 }, (_, i) => [`k${i}`, {}]));
    const rooms = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`!r${i}:x.org`, keys]));
    expect(parsePackRooms({ rooms })).toHaveLength(MAX_PACK_ROOMS);
  });

  it("keeps a room's packs by state key, up to a limit", () => {
    const state = emptyState();
    applyState(state, st(ROOM_PACK_TYPE, { images: { a: { url: "mxc://x.org/a" } } }));
    applyState(state, st(ROOM_PACK_TYPE, "junk", "cleared"));
    applyState(state, st(ROOM_PACK_TYPE, {}, "k".repeat(256)));
    expect(state.packs).toEqual(
      new Map([
        ["", { images: [{ shortcode: "a", url: "mxc://x.org/a", info: {}, emoticon: true, sticker: true }] }],
        ["cleared", { images: [] }],
      ]),
    );
    for (let i = 0; i < MAX_ROOM_PACKS + 2; i++) applyState(state, st(ROOM_PACK_TYPE, {}, `p${i}`));
    expect(state.packs!.size).toBe(MAX_ROOM_PACKS);
    // A pack it has may still change.
    applyState(state, st(ROOM_PACK_TYPE, { pack: { display_name: "New" } }, ""));
    expect(state.packs!.get("")).toEqual({ name: "New", images: [] });
  });

  it("reads the user's pack and enabled rooms from a sync's account data", () => {
    const sync = parseSync({
      next_batch: "s",
      account_data: {
        events: ["junk", { type: USER_PACK_TYPE, content: { images: { me: { url: "mxc://x.org/me" } } } }, { type: PACK_ROOMS_TYPE, content: { rooms: { "!a:x.org": { "": {} } } } }],
      },
    });
    expect(sync.userPack).toEqual({ images: [{ shortcode: "me", url: "mxc://x.org/me", info: {}, emoticon: true, sticker: true }] });
    expect(sync.packRooms).toEqual([{ roomId: "!a:x.org", stateKey: "" }]);
    expect(parseSync({ next_batch: "s", account_data: { events: [{ type: USER_PACK_TYPE, content: "x" }] } }).userPack).toEqual({ images: [] });
    expect(parseSync({ next_batch: "s" })).not.toHaveProperty("userPack");
  });

  it("reads the rooms the user muted from their push rules", () => {
    const rule = (id: unknown, extra: Record<string, unknown> = {}) => ({ rule_id: id, conditions: [{ kind: "event_match", key: "room_id", pattern: id }], actions: [], ...extra });
    const sync = parseSync({
      next_batch: "s",
      account_data: {
        events: [
          {
            type: PUSH_RULES_TYPE,
            content: {
              global: {
                override: [
                  rule("!a:x.org"),
                  rule("!b:x.org", { actions: ["dont_notify"] }),
                  rule("!c:x.org", { enabled: false }),
                  rule("!d:x.org", { actions: ["notify"] }),
                  rule("!e:x.org", { conditions: [{ kind: "event_match", key: "room_id", pattern: "!other:x.org" }] }),
                  rule("!f:x.org", { conditions: [{ kind: "event_match", key: "room_id", pattern: "!f:x.org" }, { kind: "contains_display_name" }] }),
                  rule("!g:x.org", { conditions: ["junk"] }),
                  rule(".m.rule.master"),
                  "junk",
                ],
              },
            },
          },
        ],
      },
    });
    expect(sync.mutedRooms).toEqual(["!a:x.org", "!b:x.org"]);
    expect(parseMutedRooms(undefined)).toEqual([]);
    expect(parseMutedRooms({ global: "x" })).toEqual([]);
    expect(parseSync({ next_batch: "s" })).not.toHaveProperty("mutedRooms");
  });

  it("reads the custom emoji a message's formatted_body shows", () => {
    const html = (formatted_body: unknown, format: unknown = "org.matrix.custom.html") => parseEmotes({ format, formatted_body });
    expect(
      html(
        'hi <img data-mx-emoticon src="mxc://x.org/cat" alt=":cat:" title=":cat:" height="32" /> ' +
          "<IMG height=32 alt=':a&amp;b:' data-mx-emoticon='' src='mxc://x.org/ab'> " +
          '<img data-mx-emoticon src="mxc://x.org/cat2" title=":cat:"> ' +
          '<img src="mxc://x.org/plain" alt=":plain:"> ' +
          '<img data-mx-emoticon src="https://x.org/web" alt=":web:"> ' +
          '<img data-mx-emoticon src="mxc://x.org/bad" alt="a b"> ' +
          '<img data-mx-emoticon src="mxc://x.org/none"> ' +
          '<img data-mx-emoticonx src="mxc://x.org/other" alt=":other:">',
      ),
    ).toEqual([
      { shortcode: "cat", url: "mxc://x.org/cat" },
      { shortcode: "a&b", url: "mxc://x.org/ab" },
    ]);
    expect(html("<b>no emoji</b>")).toBeUndefined();
    expect(html('<img data-mx-emoticon src="mxc://x.org/cat" alt=":cat:">', "other")).toBeUndefined();
    expect(html(5)).toBeUndefined();
    const many = Array.from({ length: MAX_EMOTES + 3 }, (_, i) => `<img data-mx-emoticon src="mxc://x.org/e${i}" alt=":e${i}:">`).join("");
    expect(html(many)).toHaveLength(MAX_EMOTES);
    // Text messages carry them; media do not.
    expect(parseContent({ msgtype: "m.text", body: ":cat:", format: "org.matrix.custom.html", formatted_body: '<img data-mx-emoticon src="mxc://x.org/cat" alt=":cat:">' })).toEqual({
      msgtype: "m.text",
      text: ":cat:",
      emotes: [{ shortcode: "cat", url: "mxc://x.org/cat" }],
    });
    expect(parseContent({ msgtype: "m.text", body: "hi" })).toEqual({ msgtype: "m.text", text: "hi" });
  });

  it("reads a text message's formatting, when it has any", () => {
    expect(parseContent({ msgtype: "m.notice", body: "b", format: "org.matrix.custom.html", formatted_body: "<b>b</b>" })).toEqual({ msgtype: "m.notice", text: "b", html: [{ t: "b", c: [{ t: "text", text: "b" }] }] });
    expect(parseContent({ msgtype: "m.text", body: "b", format: "org.matrix.custom.html", formatted_body: "b" })).toEqual({ msgtype: "m.text", text: "b" });
    expect(parseContent({ msgtype: "m.text", body: "b", format: "other", formatted_body: "<b>b</b>" })).toEqual({ msgtype: "m.text", text: "b" });
    expect(parseContent({ msgtype: "m.text", body: "b", format: "org.matrix.custom.html", formatted_body: 5 })).toEqual({ msgtype: "m.text", text: "b" });
  });

  it("keeps the name of a custom emoji reaction", () => {
    const reaction = (key: string, content: Record<string, unknown>) =>
      parseEvent(ev({ type: "m.reaction", content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$msg", key }, ...content } }));
    expect(reaction("mxc://x.org/cat", { "com.beeper.reaction.shortcode": ":cat:" })).toMatchObject({ key: "mxc://x.org/cat", shortcode: "cat" });
    expect(reaction("mxc://x.org/cat", { shortcode: "cat" })).toMatchObject({ shortcode: "cat" });
    expect(reaction("mxc://x.org/cat", { shortcode: "a b" })).not.toHaveProperty("shortcode");
    // Only custom emoji have one.
    expect(reaction("👍", { shortcode: "thumbsup" })).not.toHaveProperty("shortcode");
  });
});
