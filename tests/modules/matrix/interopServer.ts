// The in-memory homeserver behind the interop tests, over HTTP: the same
// keys, to-device and key backup state as FakeHomeserver, plus rooms, /sync,
// account data and the few other endpoints matrix-js-sdk (Element's own
// library) and Multicord's client call. Both sides get its `fetch`, so they
// talk to one server state as they would to a real homeserver.

import { MatrixError } from "../../../src/modules/matrix/api";
import { FakeHomeserver } from "./fakeHomeserver";

type Json = Record<string, any>;

export const HS = "https://hs.x.org";
export const SERVER_NAME = "x.org";
/** The LiveKit service the server's .well-known names, and the SFU it grants. */
export const LIVEKIT_SERVICE = "https://lk.x.org";
export const SFU = "wss://sfu.x.org";

interface RoomData {
  /** Every event in order, with the server position it was added at. */
  events: { pos: number; event: Json }[];
  state: Map<string, Json>;
}

export class InteropHomeserver extends FakeHomeserver {
  private readonly tokens = new Map<string, { user: string; device: string }>();
  readonly rooms = new Map<string, RoomData>();
  /** Per user: account data type -> the position it last changed at. */
  private readonly accountPos = new Map<string, Map<string, number>>();
  /** Bumped by every change; sync tokens are positions. */
  private pos = 0;
  private waiters: (() => void)[] = [];
  private eventCount = 0;
  private readonly txns = new Map<string, string>();
  private backupVersion = 0;
  /** Requests nothing answers, for spotting what a client missed. */
  readonly unknown: string[] = [];
  /** State and room events as sent, for the RTC tests. */
  readonly sent: { user: string; device: string; event: Json }[] = [];

  /** A device with an access token. */
  register(user: string, device: string): string {
    const token = `tok_${user}_${device}`;
    this.tokens.set(token, { user, device });
    return token;
  }

  private bump(): void {
    this.pos++;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  override setAccountData(user: string, type: string, content: Json): void {
    super.setAccountData(user, type, content);
    let positions = this.accountPos.get(user);
    if (!positions) this.accountPos.set(user, (positions = new Map()));
    this.bump();
    positions.set(type, this.pos);
  }

  /** A room the users are joined to, with the given extra state (e.g. encryption). */
  createRoom(roomId: string, creator: string, members: string[], extraState: { type: string; state_key?: string; content: Json }[] = []): void {
    this.rooms.set(roomId, { events: [], state: new Map() });
    this.addEvent(roomId, creator, { type: "m.room.create", state_key: "", content: { creator, room_version: "10" } });
    for (const member of members) this.addEvent(roomId, member, { type: "m.room.member", state_key: member, content: { membership: "join", displayname: member.slice(1, member.indexOf(":")) } });
    for (const state of extraState) this.addEvent(roomId, creator, { state_key: "", ...state });
  }

  addEvent(roomId: string, sender: string, partial: { type: string; content: Json; state_key?: string }): Json {
    const room = this.rooms.get(roomId);
    if (!room) throw new MatrixError(404, "M_NOT_FOUND", "No such room");
    const event: Json = { ...partial, sender, room_id: roomId, event_id: `$ev${++this.eventCount}`, origin_server_ts: Date.now(), unsigned: {} };
    this.bump();
    room.events.push({ pos: this.pos, event });
    if (partial.state_key !== undefined) room.state.set(`${partial.type}\u0000${partial.state_key}`, event);
    return event;
  }

  stateEvents(roomId: string, type: string): Json[] {
    return [...(this.rooms.get(roomId)?.state.values() ?? [])].filter((event) => event.type === type);
  }

  /** The /sync response for one device. */
  private async syncFor(user: string, device: string, query: URLSearchParams): Promise<Json> {
    const since = query.get("since");
    const from = since ? Number(since) : 0;
    const timeout = Number(query.get("timeout") ?? "0");
    if (since && from >= this.pos && timeout > 0) {
      // Long-polling, but short: tests should not wait for nothing.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(timeout, 100));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const crypto = this.sync(user, device);
    const join: Json = {};
    for (const [id, room] of this.rooms) {
      const member = room.state.get(`m.room.member\u0000${user}`);
      if (member?.content.membership !== "join") continue;
      const events = room.events.filter((e) => e.pos > from).map((e) => e.event);
      if (since && events.length === 0) continue;
      join[id] = { state: { events: [] }, timeline: { events, limited: false, prev_batch: `p${from}` }, ephemeral: { events: [] }, account_data: { events: [] }, unread_notifications: {} };
    }
    const accountData = [...(this.accountPos.get(user) ?? [])].filter(([, at]) => at > from).map(([type]) => ({ type, content: this.accountData.get(user)!.get(type) }));
    return {
      next_batch: String(this.pos),
      rooms: { join, invite: {}, leave: {} },
      account_data: { events: accountData },
      to_device: { events: JSON.parse(crypto.toDevice) as Json[] },
      device_lists: { changed: crypto.changed, left: [] },
      device_one_time_keys_count: crypto.oneTimeKeys,
      device_unused_fallback_key_types: crypto.fallbackKeys,
    };
  }

  /** Uploaded files by "<server>/<media id>". */
  private readonly media = new Map<string, Uint8Array<ArrayBuffer>>();

  /** Stores a file as an upload would; returns its mxc:// URI. */
  storeMedia(bytes: Uint8Array<ArrayBuffer>): string {
    const id = `media${this.media.size + 1}`;
    this.media.set(`${SERVER_NAME}/${id}`, bytes);
    return `mxc://${SERVER_NAME}/${id}`;
  }

  /** Authenticated media downloads (Matrix 1.11). */
  private download(url: URL, authorization: string | null): Response | undefined {
    const match = /^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (url.origin !== HS || !match) return undefined;
    if (!this.tokens.has(authorization?.replace(/^Bearer /, "") ?? "")) return Response.json({ errcode: "M_MISSING_TOKEN", error: "No token" }, { status: 401 });
    const bytes = this.media.get(`${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`);
    return bytes ? new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }) : Response.json({ errcode: "M_NOT_FOUND", error: "No such media" }, { status: 404 });
  }

  /** The fetch both clients use. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const media = method === "GET" ? this.download(url, new Headers(init?.headers).get("authorization")) : undefined;
    if (media) return media;
    const text = typeof init?.body === "string" ? init.body : undefined;
    const body = text ? (JSON.parse(text) as Json) : {};
    try {
      const result = await this.route(url, method, body, new Headers(init?.headers).get("authorization"));
      if (method !== "GET") this.bump();
      return Response.json(result);
    } catch (error) {
      if (error instanceof MatrixError) return Response.json({ errcode: error.errcode, error: error.message }, { status: error.status });
      throw error;
    }
  };

  private async route(url: URL, method: string, body: Json, authorization: string | null): Promise<Json> {
    if (url.origin === "https://x.org" && url.pathname === "/.well-known/matrix/client") {
      return { "m.homeserver": { base_url: HS }, "org.matrix.msc4143.rtc_foci": [{ type: "livekit", livekit_service_url: LIVEKIT_SERVICE }] };
    }
    if (url.origin === LIVEKIT_SERVICE && url.pathname === "/sfu/get" && method === "POST") return { url: SFU, jwt: "jwt.for.call" };
    if (url.origin !== HS) throw new MatrixError(404, "M_NOT_FOUND", `No server at ${url.origin}`);
    const path = url.pathname;
    if (path === "/_matrix/client/versions") return { versions: ["v1.1", "v1.5", "v1.11", "v1.12"], unstable_features: {} };
    const who = this.tokens.get(authorization?.replace(/^Bearer /, "") ?? "");
    if (!who) throw new MatrixError(401, "M_MISSING_TOKEN", "No token");
    const { user, device } = who;
    const query = Object.fromEntries(url.searchParams);
    const sub = path.replace(/^\/_matrix\/client/, "");
    const parts = sub.split("/").map(decodeURIComponent);
    const key = `${method} ${sub}`;

    if (key === "GET /v3/account/whoami") return { user_id: user, device_id: device };
    if (key === "GET /v3/sync") return this.syncFor(user, device, url.searchParams);
    if (key === "GET /v3/pushrules/") return { global: { override: [], content: [], room: [], sender: [], underride: [] } };
    if (key === "GET /v3/capabilities") return { capabilities: {} };
    if (key === "POST /v3/logout") return {};
    // Like most homeservers, no MSC4143 transports endpoint: clients fall back to .well-known.
    if (key === "GET /unstable/org.matrix.msc4143/rtc/transports") throw new MatrixError(404, "M_UNRECOGNIZED", "Unrecognized request");
    if (method === "POST" && /^\/v3\/user\/[^/]+\/filter$/.test(sub)) return { filter_id: "1" };
    if (method === "GET" && /^\/v3\/user\/[^/]+\/filter\/[^/]+$/.test(sub)) return {};
    if (method === "POST" && /^\/v3\/user\/[^/]+\/openid\/request_token$/.test(sub)) {
      return { access_token: "openid", token_type: "Bearer", matrix_server_name: SERVER_NAME, expires_in: 3600 };
    }
    if (parts[1] === "v3" && parts[2] === "user" && parts[4] === "account_data" && parts.length === 6) {
      const type = parts[5]!;
      if (method === "PUT") {
        this.setAccountData(user, type, body);
        return {};
      }
      const content = this.accountData.get(user)?.get(type);
      if (!content) throw new MatrixError(404, "M_NOT_FOUND", "No account data");
      return content;
    }
    if (parts[1] === "v3" && parts[2] === "rooms") return this.roomRoute(user, device, method, parts.slice(3), body);
    if (key === "POST /v3/room_keys/version") {
      this.backup = { version: String(++this.backupVersion), algorithm: body.algorithm, auth_data: body.auth_data, rooms: {} };
      return { version: this.backup.version };
    }
    if (method === "GET" && /^\/v3\/room_keys\/version\/[^/]+$/.test(sub)) {
      if (!this.backup || this.backup.version !== parts[4]) throw new MatrixError(404, "M_NOT_FOUND", "No backup");
      const { rooms: _rooms, ...info } = this.backup;
      return { ...info, count: 0, etag: "1" };
    }
    if (sub.startsWith("/v3/keys/") || sub.startsWith("/v3/sendToDevice/") || sub.startsWith("/v3/room_keys/")) {
      try {
        return await this.http(user, device)(method, sub, body, query);
      } catch (error) {
        if (error instanceof MatrixError && error.errcode === "M_UNRECOGNIZED") this.unknown.push(key);
        throw error;
      }
    }
    this.unknown.push(key);
    throw new MatrixError(404, "M_UNRECOGNIZED", `Not faked: ${key}`);
  }

  private roomRoute(user: string, device: string, method: string, parts: string[], body: Json): Json {
    const [roomId, what, ...rest] = parts;
    const room = this.rooms.get(roomId!);
    if (!room) throw new MatrixError(404, "M_NOT_FOUND", "No such room");
    if (what === "send" && method === "PUT") {
      const [type, txn] = rest;
      const id = `${user}|${device}|${txn}`;
      const known = this.txns.get(id);
      if (known) return { event_id: known };
      const event = this.addEvent(roomId!, user, { type: type!, content: body });
      this.sent.push({ user, device, event });
      this.txns.set(id, event.event_id);
      return { event_id: event.event_id };
    }
    if (what === "redact" && method === "PUT") {
      // Room version 10: `redacts` sits beside the content.
      const event = this.addEvent(roomId!, user, { type: "m.room.redaction", content: body, redacts: rest[0]! } as never);
      return { event_id: event.event_id };
    }
    if (what === "state") {
      const [type, stateKey = ""] = rest;
      if (method === "PUT") {
        const event = this.addEvent(roomId!, user, { type: type!, state_key: stateKey, content: body });
        this.sent.push({ user, device, event });
        return { event_id: event.event_id };
      }
      const event = room.state.get(`${type}\u0000${stateKey}`);
      if (!event) throw new MatrixError(404, "M_NOT_FOUND", "No such state");
      return event.content;
    }
    if (what === "messages" && method === "GET") return { chunk: [], start: "p0" };
    if (what === "members" && method === "GET") return { chunk: [...room.state.values()].filter((event) => event.type === "m.room.member") };
    if (what === "joined_members" && method === "GET") {
      const joined: Json = {};
      for (const event of room.state.values()) if (event.type === "m.room.member" && event.content.membership === "join") joined[event.state_key] = {};
      return { joined };
    }
    if ((what === "read_markers" || what === "receipt" || what === "typing") && method !== "GET") return {};
    this.unknown.push(`${method} rooms/${what}`);
    throw new MatrixError(404, "M_UNRECOGNIZED", `Not faked: rooms/${what}`);
  }
}
