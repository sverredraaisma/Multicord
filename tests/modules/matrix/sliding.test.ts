import { describe, expect, it, vi } from "vitest";
import { MatrixError, type MxSession, type MxSyncMode } from "../../../src/modules/matrix/api";
import { createMatrixClient } from "../../../src/modules/matrix/client";
import { CALL_MEMBER_TYPE } from "../../../src/modules/matrix/events";
import {
  CONNECTION_ID,
  EXTENSION_LIMIT,
  FIRST_WINDOW,
  FULL_WINDOW,
  INVITE_WINDOW,
  parseSlidingSync,
  parseSlidingToken,
  SLIDING_SYNC_PATH,
  SLIDING_TIMELINE_LIMIT,
  slidingRequest,
  slidingToken,
  STICKY_EXTENSION,
  type SlidingContext,
} from "../../../src/modules/matrix/sliding";

const ME = "@me:x.org";
const BO = "@bo:x.org";
const BASE = "https://hs.x.org";
const SESSION: MxSession = { baseUrl: BASE, accessToken: "tok", userId: ME, deviceId: "D", ownDevice: true };

const member = (user: string, membership: string, extra: Record<string, unknown> = {}) => ({
  type: "m.room.member",
  state_key: user,
  sender: user,
  event_id: `$m-${user}-${membership}`,
  origin_server_ts: 1,
  content: { membership, ...extra },
});
const message = (id: string, sender: string, body: string, ts = 1000) => ({ type: "m.room.message", event_id: `$${id}`, sender, origin_server_ts: ts, content: { msgtype: "m.text", body } });
const context = (extra: Partial<SlidingContext> = {}): SlidingContext => ({ userId: ME, known: new Set(), encryption: true, ...extra });

describe("sliding sync tokens", () => {
  it("carry the position and the to-device and sticky event tokens", () => {
    const token = slidingToken({ pos: "p1", toDevice: "7", sticky: "sticky_3" });
    expect(parseSlidingToken(token)).toEqual({ pos: "p1", toDevice: "7", sticky: "sticky_3" });
    expect(parseSlidingToken(slidingToken({ pos: "p1" }))).toEqual({ pos: "p1" });
  });

  it.each([
    ["a classic token", "s72594_4483_1934"],
    ["JSON that is no list", '{"pos":"p"}'],
    ["a list of another length", '["mc-sss","p",null]'],
    ["another tag", '["other","p",null,null]'],
    ["no position", '["mc-sss","",null,null]'],
    ["an oversized position", JSON.stringify(["mc-sss", "p".repeat(5000), null, null])],
  ])("are not read from %s", (_name, value) => {
    expect(parseSlidingToken(value)).toBeUndefined();
  });

  it("drop stream tokens that are not ones", () => {
    expect(parseSlidingToken(JSON.stringify(["mc-sss", "p", 7, ""]))).toEqual({ pos: "p" });
  });
});

describe("sliding sync requests", () => {
  it("ask a new connection for the first rooms of DMs and other rooms, without invites, and for the device's keys", () => {
    const body = slidingRequest({}, { encryption: true, sticky: true }) as Record<string, any>;
    expect(body.conn_id).toBe(CONNECTION_ID);
    expect(Object.keys(body.lists)).toEqual(["dms", "rooms", "invites"]);
    // Invitations in a list of their own, with nothing but their stripped state and our membership.
    expect(body.lists.invites).toEqual({ ranges: [[0, INVITE_WINDOW - 1]], timeline_limit: 0, required_state: [["m.room.member", "$ME"]], filters: { is_invite: true } });
    const { dms, rooms } = body.lists;
    expect(dms.ranges).toEqual([[0, FIRST_WINDOW - 1]]);
    expect(dms.timeline_limit).toBe(SLIDING_TIMELINE_LIMIT);
    expect(dms.filters).toEqual({ is_dm: true, is_invite: false });
    expect(rooms.filters).toEqual({ is_dm: false, is_invite: false });
    // DMs with all their members (names, pictures); other rooms with the senders and our own.
    expect(dms.required_state).toContainEqual(["m.room.member", "*"]);
    expect(rooms.required_state).toContainEqual(["m.room.member", "$LAZY"]);
    expect(rooms.required_state).toContainEqual(["m.room.member", "$ME"]);
    expect(rooms.required_state).not.toContainEqual(["m.room.member", "*"]);
    for (const state of [
      ["m.room.name", ""],
      ["m.room.avatar", ""],
      ["m.room.canonical_alias", ""],
      ["m.room.encryption", ""],
      ["m.room.history_visibility", ""],
      ["m.room.create", ""],
      ["m.space.child", "*"],
      [CALL_MEMBER_TYPE, "*"],
      ["im.ponies.room_emotes", "*"],
      ["m.room.pinned_events", ""],
    ]) {
      expect(dms.required_state).toContainEqual(state);
      expect(rooms.required_state).toContainEqual(state);
    }
    expect(body.extensions).toEqual({
      account_data: { enabled: true, lists: [], rooms: [] },
      typing: { enabled: true },
      receipts: { enabled: true },
      e2ee: { enabled: true },
      to_device: { enabled: true, limit: EXTENSION_LIMIT },
    });
  });

  it("ask a running connection for all rooms, to-device messages after the last acknowledged, and sticky events", () => {
    const body = slidingRequest({ pos: "p", toDevice: "12", sticky: "sticky_4" }, { encryption: true, sticky: true }) as Record<string, any>;
    expect(body.lists.dms.ranges).toEqual([[0, FULL_WINDOW - 1]]);
    expect(body.lists.rooms.ranges).toEqual([[0, FULL_WINDOW - 1]]);
    expect(body.extensions.to_device).toEqual({ enabled: true, limit: EXTENSION_LIMIT, since: "12" });
    expect(body.extensions[STICKY_EXTENSION]).toEqual({ enabled: true, limit: EXTENSION_LIMIT, since: "sticky_4" });
    const first = slidingRequest({ pos: "p" }, { encryption: true, sticky: true }) as Record<string, any>;
    expect(first.extensions[STICKY_EXTENSION]).toEqual({ enabled: true, limit: EXTENSION_LIMIT });
  });

  it("leave out what the device or the server cannot use", () => {
    // Another client's device (a copied token): its to-device messages are that client's to take.
    const body = slidingRequest({ pos: "p", toDevice: "12" }, { encryption: false, sticky: false }) as Record<string, any>;
    expect(Object.keys(body.extensions)).toEqual(["account_data", "typing", "receipts"]);
  });
});

describe("sliding sync responses", () => {
  it("map rooms into the shape of classic sync's, with every check of events.ts", () => {
    const known = new Set<string>();
    const sync = parseSlidingSync(
      {
        pos: "p1",
        rooms: {
          "!dm:x.org": {
            initial: true,
            required_state: [member(BO, "join", { displayname: "Bo", avatar_url: "mxc://x.org/bo" }), member(ME, "join"), { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
            timeline: [message("d1", BO, "hello")],
            prev_batch: "t1",
            notification_count: 2,
            highlight_count: 1,
            heroes: [{ user_id: BO, displayname: "Bo" }, "junk", { user_id: "nobody" }],
          },
          "!space:x.org": {
            required_state: [
              { type: "m.room.create", state_key: "", content: { type: "m.space" } },
              { type: "m.space.child", state_key: "!child:x.org", origin_server_ts: 5, content: { via: ["x.org"] } },
              { type: CALL_MEMBER_TYPE, state_key: "_@bo:x.org_DEV", sender: BO, origin_server_ts: 9, content: {} },
            ],
            timeline: [],
            limited: false,
          },
          "bad id": { timeline: [] },
          "!notarecord:x.org": 5,
        },
      },
      {},
      context({ known }),
    );
    expect(sync.left).toEqual([]);
    expect(sync.joined.map((u) => u.roomId)).toEqual(["!dm:x.org", "!space:x.org"]);
    const [dm, space] = sync.joined;
    expect(dm).toMatchObject({
      initial: true,
      limited: true,
      prevBatch: "t1",
      heroes: [BO],
      state: { encrypted: true, members: { [BO]: { name: "Bo", avatar: "mxc://x.org/bo", membership: "join" }, [ME]: { membership: "join" } } },
    });
    expect(dm!.timeline.map((e) => e.id)).toEqual(["$d1"]);
    // Synapse sends zeros: the adapter counts unread events itself.
    expect(dm!.unread).toBeUndefined();
    expect(sync.countUnread).toBe(true);
    expect(space!.state.space).toBe(true);
    expect(space!.state.children!.get("!child:x.org")).toEqual({ suggested: false, ts: 5, via: ["x.org"] });
    expect(space!.calls!.get("_@bo:x.org_DEV")).toBeNull();
    // A new connection sends every room in full.
    expect(space).toMatchObject({ initial: true, limited: true });
    expect([...known]).toEqual(["!dm:x.org", "!space:x.org"]);
    expect(JSON.parse(sync.nextBatch)).toEqual(["mc-sss", "p1", null, null]);
  });

  it("send what changed in a room as it is, and a room first sent mid-connection in full", () => {
    const known = new Set(["!a:x.org"]);
    const sync = parseSlidingSync(
      {
        pos: "p2",
        rooms: {
          "!a:x.org": { timeline: [message("a2", BO, "more")], limited: true, prev_batch: "t2" },
          "!b:x.org": { initial: true, timeline: [message("b1", BO, "hi")] },
          "!c:x.org": { timeline: [] },
        },
      },
      { pos: "p1" },
      context({ known }),
    );
    const [a, b, c] = sync.joined;
    expect(a).toMatchObject({ limited: true, prevBatch: "t2" });
    expect(a!.initial).toBeUndefined();
    expect(a!.unread).toBeUndefined();
    expect(b).toMatchObject({ initial: true, limited: true });
    expect(c).toMatchObject({ limited: false });
    expect(c!.initial).toBeUndefined();
    expect([...known]).toEqual(["!a:x.org", "!b:x.org", "!c:x.org"]);
  });

  it("read invitations from their stripped state, all of them on a new connection", () => {
    const invite = { type: "m.room.member", state_key: ME, sender: BO, content: { membership: "invite", is_direct: true } };
    const fresh = parseSlidingSync({ pos: "p1", rooms: { "!inv:x.org": { invite_state: [invite, { type: "m.room.name", state_key: "", content: { name: "Plans" } }] } } }, {}, context());
    expect(fresh.invited).toEqual([{ roomId: "!inv:x.org", name: "Plans", inviter: BO, direct: true, space: false }]);
    expect(fresh.invitesFull).toBe(true);
    const later = parseSlidingSync({ pos: "p2", rooms: {} }, { pos: "p1" }, context());
    expect(later).not.toHaveProperty("invited");
    expect(later).not.toHaveProperty("invitesFull");
  });

  it("take rooms we left or were banned from as left, and skip invites and knocks", () => {
    const known = new Set(["!left:x.org", "!banned:x.org", "!back:x.org"]);
    const sync = parseSlidingSync(
      {
        pos: "p2",
        rooms: {
          "!left:x.org": { timeline: [message("x", ME, "bye"), member(ME, "leave")] },
          "!banned:x.org": { required_state: [member(ME, "ban")], timeline: [] },
          // The required state is the room's state now: we left and came back.
          "!back:x.org": { required_state: [member(ME, "join")], timeline: [member(ME, "leave"), member(ME, "join")] },
          "!invited:x.org": { invite_state: [member(ME, "invite")] },
          "!knocked:x.org": { knock_state: [] },
          "!pending:x.org": { required_state: [member(ME, "invite")], timeline: [] },
          // Malformed memberships are not ours to read.
          "!odd:x.org": { timeline: [5, { type: "m.room.member", state_key: ME, content: "leave" }, { type: "m.room.member", state_key: ME, content: { membership: 1 } }, member(BO, "leave")] },
        },
      },
      { pos: "p1" },
      context({ known }),
    );
    expect(sync.left).toEqual(["!left:x.org", "!banned:x.org"]);
    expect(sync.joined.map((u) => u.roomId)).toEqual(["!back:x.org", "!odd:x.org"]);
    expect([...known].sort()).toEqual(["!back:x.org", "!odd:x.org"]);
  });

  it("put typing and sticky events with their rooms, and drop them for rooms not sent before", () => {
    const known = new Set(["!quiet:x.org"]);
    const typing = (users: unknown) => ({ type: "m.typing", content: { user_ids: users } });
    const rtc = {
      type: "m.room.encrypted",
      event_id: "$sticky",
      sender: BO,
      origin_server_ts: 5,
      content: { algorithm: "m.megolm.v1.aes-sha2", session_id: "S", ciphertext: "c" },
      msc4354_sticky: { duration_ms: 1000 },
    };
    const sync = parseSlidingSync(
      {
        pos: "p3",
        rooms: { "!busy:x.org": { timeline: [message("b1", BO, "hi")] } },
        extensions: {
          typing: { rooms: { "!busy:x.org": typing([BO]), "!quiet:x.org": typing([BO, "junk"]), "!unknown:x.org": typing([BO]), nope: typing([BO]) } },
          [STICKY_EXTENSION]: { next_batch: "sticky_9", rooms: { "!quiet:x.org": { events: [rtc] }, "!busy:x.org": { events: [rtc] }, "!unknown:x.org": { events: [rtc] } } },
        },
      },
      { pos: "p2", sticky: "sticky_1" },
      context({ known }),
    );
    expect(sync.joined.map((u) => u.roomId)).toEqual(["!busy:x.org", "!quiet:x.org"]);
    const [busy, quiet] = sync.joined;
    expect(busy!.typing).toEqual([BO]);
    expect(busy!.sticky?.map((e) => e.id)).toEqual(["$sticky"]);
    expect(quiet).toMatchObject({ typing: [BO], timeline: [], limited: false });
    expect(quiet!.sticky?.map((e) => e.id)).toEqual(["$sticky"]);
    expect(JSON.parse(sync.nextBatch)[3]).toBe("sticky_9");
  });

  it("pass our latest read receipt on, public or private, outside threads, also for rooms not otherwise sent", () => {
    const known = new Set(["!quiet:x.org"]);
    const receipt = (content: unknown) => ({ type: "m.receipt", content });
    const sync = parseSlidingSync(
      {
        pos: "p",
        rooms: { "!busy:x.org": { timeline: [] }, "!others:x.org": { timeline: [] }, "!odd:x.org": { timeline: [] } },
        extensions: {
          receipts: {
            rooms: {
              "!busy:x.org": receipt({
                $old: { "m.read": { [ME]: { ts: 100 } } },
                $new: { "m.read.private": { [ME]: { ts: 300 } }, "m.read": { [BO]: { ts: 900 } } },
                $thread: { "m.read": { [ME]: { ts: 999, thread_id: "$root" } } },
                $main: { "m.read": { [ME]: { ts: 200, thread_id: "main" } } },
                bad: { "m.read": { [ME]: { ts: 999 } } },
                $junk: 5,
              }),
              "!others:x.org": receipt({ $e: { "m.read": { [BO]: { ts: 1 } } } }),
              "!odd:x.org": receipt({ $e: { "m.read": { [ME]: { ts: -5 } } }, $f: { "m.read": "x" } }),
              "!quiet:x.org": receipt({ $q: { "m.read": { [ME]: { ts: 50 } } } }),
              "!unknown:x.org": receipt({ $u: { "m.read": { [ME]: { ts: 50 } } } }),
            },
          },
        },
      },
      { pos: "o" },
      context({ known }),
    );
    const read = Object.fromEntries(sync.joined.map((u) => [u.roomId, u.read]));
    expect(read).toEqual({ "!busy:x.org": { id: "$new", ts: 300 }, "!others:x.org": undefined, "!odd:x.org": { id: "$e", ts: 0 }, "!quiet:x.org": { id: "$q", ts: 50 } });
    for (const content of [undefined, { type: "m.typing", content: {} }, { type: "m.receipt", content: [] }]) {
      const none = parseSlidingSync({ pos: "p", rooms: { "!r:x.org": { timeline: [] } }, extensions: { receipts: { rooms: { "!r:x.org": content } } } }, { pos: "o" }, context());
      expect(none.joined[0]!.read).toBeUndefined();
    }
  });

  it("read the DM list from global account data", () => {
    const sync = parseSlidingSync(
      { pos: "p", extensions: { account_data: { global: [{ type: "m.push_rules", content: {} }, "junk", { type: "m.direct", content: { [BO]: ["!dm:x.org", "bad"] } }] } } },
      { pos: "o" },
      context(),
    );
    expect(sync.directs).toEqual({ [BO]: ["!dm:x.org"] });
    expect(parseSlidingSync({ pos: "p", extensions: { account_data: { global: "no" } } }, { pos: "o" }, context()).directs).toBeUndefined();
    expect(parseSlidingSync({ pos: "p", extensions: { account_data: 5 } }, { pos: "o" }, context()).directs).toBeUndefined();
  });

  it("read image packs from global account data, and room packs from the required state", () => {
    const sync = parseSlidingSync(
      {
        pos: "p",
        rooms: { "!r:x.org": { required_state: [{ type: "im.ponies.room_emotes", state_key: "cats", content: { images: { cat: { url: "mxc://x.org/cat" } } } }], timeline: [] } },
        extensions: {
          account_data: {
            global: [
              { type: "im.ponies.user_emotes", content: { pack: { display_name: "Mine" }, images: {} } },
              { type: "im.ponies.emote_rooms", content: { rooms: { "!r:x.org": { cats: {} } } } },
            ],
          },
        },
      },
      { pos: "o" },
      context(),
    );
    expect(sync.userPack).toEqual({ name: "Mine", images: [] });
    expect(sync.packRooms).toEqual([{ roomId: "!r:x.org", stateKey: "cats" }]);
    expect(sync.joined[0]!.state.packs!.get("cats")!.images).toHaveLength(1);
  });

  it("hand to-device messages and key changes to the crypto library with sliding sync's meaning, and continue after them", () => {
    const toDevice = { type: "m.room_key", sender: BO, content: { a: 1 } };
    const sync = parseSlidingSync(
      {
        pos: "p",
        extensions: {
          to_device: { next_batch: "15", events: [toDevice, { type: "bad" }] },
          e2ee: { device_lists: { changed: [BO], left: [] }, device_one_time_keys_count: { signed_curve25519: 50 }, device_unused_fallback_key_types: ["signed_curve25519"] },
        },
      },
      { pos: "o", toDevice: "10" },
      context(),
    );
    expect(sync.crypto).toEqual({ toDevice: JSON.stringify([toDevice]), changed: [BO], left: [], oneTimeKeys: { signed_curve25519: 50 }, fallbackKeys: ["signed_curve25519"], sliding: true });
    expect(JSON.parse(sync.nextBatch)).toEqual(["mc-sss", "p", "15", null]);
  });

  it("keep where to-device messages got to when the response does not say, and mark device lists stale on a new connection", () => {
    const sync = parseSlidingSync({ pos: "p", extensions: { to_device: { next_batch: 15 }, e2ee: 3 } }, { toDevice: "10", sticky: "sticky_2" }, context());
    expect(sync.crypto).toEqual({ toDevice: "[]", changed: [], left: [], oneTimeKeys: {}, sliding: true, stale: true });
    expect(JSON.parse(sync.nextBatch)).toEqual(["mc-sss", "p", "10", "sticky_2"]);
    const none = parseSlidingSync({ pos: "p", extensions: 5, rooms: 5 }, { pos: "o", toDevice: "10" }, context({ encryption: false }));
    expect(none.crypto).toBeUndefined();
    expect(none.joined).toEqual([]);
    expect(JSON.parse(none.nextBatch)).toEqual(["mc-sss", "p", "10", null]);
  });

  it.each([[undefined], [[1]], [{}], [{ pos: "" }], [{ pos: 5 }]])("refuse an unreadable response %#", (raw) => {
    expect(() => parseSlidingSync(raw, {}, context())).toThrow("unreadable sync response");
  });
});

// --- The client: choosing the sync, falling back, starting over -------------------------

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Served {
  url: URL;
  method: string;
  body?: Record<string, any>;
}

/** A homeserver: /versions with these unstable features, and answers for /sync and sliding sync. */
function server(options: { features?: Record<string, boolean> | Response; sliding?: (request: Served) => Response; classic?: (request: Served) => Response; syncMode?: MxSyncMode } = {}) {
  const requests: Served[] = [];
  let pos = 0;
  let batch = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const request: Served = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined };
    requests.push(request);
    if (url.pathname === "/_matrix/client/versions") {
      const features = options.features ?? {};
      return features instanceof Response ? features : json({ versions: ["v1.11"], unstable_features: features });
    }
    if (url.pathname === SLIDING_SYNC_PATH) return options.sliding?.(request) ?? json({ pos: `pos${++pos}`, extensions: { to_device: { next_batch: `${pos * 10}`, events: [] } } });
    if (url.pathname === "/_matrix/client/v3/sync") return options.classic?.(request) ?? json({ next_batch: `s${++batch}`, rooms: { join: { "!r:x.org": { timeline: { events: [] } } } } });
    return json({ errcode: "M_UNRECOGNIZED" }, 404);
  });
  const client = createMatrixClient(fetchFn as unknown as typeof fetch, options.syncMode ? { syncMode: options.syncMode } : {});
  const paths = () => requests.map((r) => r.url.pathname.replace("/_matrix/client", ""));
  return { client, requests, paths };
}

const SLIDING = { "org.matrix.simplified_msc3575": true };

describe("choosing the sync", () => {
  it("syncs classically unless asked otherwise, without asking the server", async () => {
    const hs = server({ features: SLIDING });
    await hs.client.sync(SESSION, undefined, 0);
    await hs.client.sync(SESSION, "s1", 30000, "classic");
    expect(hs.paths()).toEqual(["/v3/sync", "/v3/sync"]);
    expect(hs.requests[1]!.url.searchParams.get("since")).toBe("s1");
  });

  it("uses sliding sync when the homeserver offers it, asking once per session", async () => {
    const hs = server({ features: SLIDING });
    const first = await hs.client.sync(SESSION, undefined, 0, "auto");
    const second = await hs.client.sync(SESSION, first.nextBatch, 30000, "auto");
    expect(hs.paths()).toEqual(["/versions", "/unstable/org.matrix.simplified_msc3575/sync", "/unstable/org.matrix.simplified_msc3575/sync"]);
    const [, one, two] = hs.requests;
    expect(one!.method).toBe("POST");
    expect(one!.url.searchParams.get("pos")).toBeNull();
    expect(one!.url.searchParams.get("timeout")).toBe("0");
    expect(one!.body!.extensions.to_device.since).toBeUndefined();
    // Sticky events only when the server has them.
    expect(two!.body!.extensions[STICKY_EXTENSION]).toBeUndefined();
    expect(two!.url.searchParams.get("pos")).toBe("pos1");
    expect(two!.url.searchParams.get("timeout")).toBe("30000");
    // The to-device messages of the first response are acknowledged only now, with the token the adapter passed back.
    expect(two!.body!.extensions.to_device.since).toBe("10");
    expect(JSON.parse(second.nextBatch)).toEqual(["mc-sss", "pos2", "20", null]);
  });

  it("asks for sticky events when the homeserver has them, and leaves encryption out for another client's device", async () => {
    const hs = server({ features: { ...SLIDING, "org.matrix.msc4354": true } });
    const session = { ...SESSION, ownDevice: false };
    const first = await hs.client.sync(session, undefined, 0, "auto");
    expect(first.crypto).toBeUndefined();
    await hs.client.sync(session, first.nextBatch, 30000, "auto");
    const body = hs.requests[2]!.body!;
    expect(body.extensions[STICKY_EXTENSION]).toEqual({ enabled: true, limit: EXTENSION_LIMIT });
    expect(body.extensions.to_device).toBeUndefined();
    expect(body.extensions.e2ee).toBeUndefined();
  });

  it.each([
    ["does not offer it", { "org.matrix.simplified_msc3575": false }],
    ["has no feature list", json({ versions: ["v1.11"] })],
    ["has no /versions", json({ errcode: "M_UNRECOGNIZED" }, 404)],
  ])("syncs classically when the homeserver %s", async (_name, features) => {
    const hs = server({ features: features as Record<string, boolean> | Response });
    await hs.client.sync(SESSION, undefined, 0, "auto");
    await hs.client.sync(SESSION, "s1", 30000, "auto");
    expect(hs.paths()).toEqual(["/versions", "/v3/sync", "/v3/sync"]);
  });

  it("fails the sync when /versions fails otherwise, to ask again next time", async () => {
    const hs = server({ features: json({ errcode: "M_UNKNOWN" }, 502) });
    await expect(hs.client.sync(SESSION, undefined, 0, "auto")).rejects.toThrow(MatrixError);
    expect(hs.paths()).toEqual(["/versions"]);
  });

  it.each([
    ["404", () => json({ errcode: "M_NOT_FOUND" }, 404)],
    ["405", () => new Response("", { status: 405 })],
    ["400", () => json({ errcode: "M_BAD_JSON" }, 400)],
    ["M_UNRECOGNIZED", () => json({ errcode: "M_UNRECOGNIZED" }, 403)],
  ])("falls back to classic sync for good when sliding sync is refused (%s)", async (_name, refusal) => {
    const hs = server({ features: SLIDING, sliding: refusal });
    const sync = await hs.client.sync(SESSION, undefined, 0, "auto");
    expect(sync.nextBatch).toBe("s1");
    await hs.client.sync(SESSION, sync.nextBatch, 30000, "auto");
    expect(hs.paths()).toEqual(["/versions", "/unstable/org.matrix.simplified_msc3575/sync", "/v3/sync", "/v3/sync"]);
    expect(hs.requests[3]!.url.searchParams.get("since")).toBe("s1");
  });

  it("passes other failures on, to retry sliding sync", async () => {
    const hs = server({ features: SLIDING, sliding: () => json({ errcode: "M_LIMIT_EXCEEDED" }, 429) });
    await expect(hs.client.sync(SESSION, undefined, 0, "auto")).rejects.toMatchObject({ errcode: "M_LIMIT_EXCEEDED" });
    const offline = server({ features: SLIDING, sliding: () => Promise.reject(new Error("offline")) as never });
    await expect(offline.client.sync(SESSION, undefined, 0, "auto")).rejects.toThrow("offline");
  });

  it("uses only sliding sync when forced, whatever the server says or the adapter asks", async () => {
    const hs = server({ syncMode: "sliding", sliding: () => json({ errcode: "M_UNRECOGNIZED" }, 404) });
    await expect(hs.client.sync(SESSION, undefined, 0, "classic")).rejects.toMatchObject({ errcode: "M_UNRECOGNIZED" });
    expect(hs.paths()).toEqual(["/versions", "/unstable/org.matrix.simplified_msc3575/sync"]);
    const ok = server({ syncMode: "sliding" });
    expect(JSON.parse((await ok.client.sync(SESSION, undefined, 0)).nextBatch)[1]).toBe("pos1");
  });

  it("opens a new connection when the server forgot the old one, keeping where to-device messages and sticky events got to", async () => {
    let calls = 0;
    const hs = server({
      features: { ...SLIDING, "org.matrix.msc4354": true },
      sliding: () => {
        calls++;
        if (calls === 2) return json({ errcode: "M_UNKNOWN_POS" }, 400);
        const rooms = calls === 1 ? {} : { "!r:x.org": { initial: true, timeline: [] } };
        return json({ pos: `pos${calls}`, rooms, extensions: { to_device: { next_batch: "10" } } });
      },
    });
    const first = await hs.client.sync(SESSION, undefined, 0, "auto");
    const token = JSON.parse(first.nextBatch) as unknown[];
    token[3] = "sticky_5";
    const again = await hs.client.sync(SESSION, JSON.stringify(token), 30000, "auto");
    const [, , forgotten, fresh] = hs.requests;
    expect(forgotten!.url.searchParams.get("pos")).toBe("pos1");
    expect(fresh!.url.searchParams.get("pos")).toBeNull();
    expect(fresh!.body!.extensions.to_device.since).toBe("10");
    // A new connection asks for sticky events once it has sent the rooms.
    expect(fresh!.body!.extensions[STICKY_EXTENSION]).toBeUndefined();
    expect(again.joined[0]).toMatchObject({ roomId: "!r:x.org", initial: true, limited: true });
    expect(again.crypto?.stale).toBe(true);
    expect(JSON.parse(again.nextBatch)).toEqual(["mc-sss", "pos3", "10", "sticky_5"]);
  });

  it("starts over when it cannot read a token, or the token is from classic sync", async () => {
    const hs = server({ features: SLIDING });
    await hs.client.sync(SESSION, undefined, 0, "auto");
    await hs.client.sync(SESSION, "garbage", 30000, "auto");
    expect(hs.requests[2]!.url.searchParams.get("pos")).toBeNull();

    const switching = server({ features: SLIDING });
    const classic = await switching.client.sync(SESSION, undefined, 0, "classic");
    const sliding = await switching.client.sync(SESSION, classic.nextBatch, 30000, "auto");
    expect(switching.requests[2]!.url.searchParams.get("pos")).toBeNull();
    expect(sliding.crypto?.stale).toBe(true);
  });

  it("starts classic sync over after sliding sync, every room sent in full", async () => {
    const hs = server({ features: SLIDING });
    const sliding = await hs.client.sync(SESSION, undefined, 0, "auto");
    const classic = await hs.client.sync(SESSION, sliding.nextBatch, 30000, "classic");
    expect(hs.requests[2]!.url.searchParams.get("since")).toBeNull();
    expect(classic.joined[0]).toMatchObject({ roomId: "!r:x.org", initial: true, limited: true });
    const next = await hs.client.sync(SESSION, classic.nextBatch, 30000, "classic");
    expect(hs.requests[3]!.url.searchParams.get("since")).toBe("s1");
    expect(next.joined[0]!.initial).toBeUndefined();
  });

  it("falls back to classic sync, starting over, when the server stops serving sliding sync", async () => {
    let calls = 0;
    const hs = server({ features: SLIDING, sliding: () => (++calls === 1 ? json({ pos: "pos1" }) : json({ errcode: "M_UNRECOGNIZED" }, 404)) });
    const first = await hs.client.sync(SESSION, undefined, 0, "auto");
    const classic = await hs.client.sync(SESSION, first.nextBatch, 30000, "auto");
    expect(hs.requests[3]!.url.pathname).toBe("/_matrix/client/v3/sync");
    expect(hs.requests[3]!.url.searchParams.get("since")).toBeNull();
    expect(classic.joined[0]!.initial).toBe(true);
  });

  it("gives up on a connection the server forgets at once", async () => {
    const hs = server({ features: SLIDING, sliding: () => json({ errcode: "M_UNKNOWN_POS" }, 400) });
    // A new connection refused as unknown is no sliding sync to use: classic it is.
    const sync = await hs.client.sync(SESSION, undefined, 0, "auto");
    expect(sync.nextBatch).toBe("s1");
  });
});
