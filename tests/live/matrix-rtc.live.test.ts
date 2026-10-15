// Live check of Multicord's Matrix calls in MatrixRTC's newer format: sticky
// org.matrix.msc4143.rtc.member memberships (MSC4143 with MSC4354), access to
// the homeserver's own LiveKit server through the homeserver (MSC4195
// rtc/livekit/get_token) and hashed LiveKit identities. Against a real
// Synapse, LiveKit and Element's lk-jwt-service, with matrix-js-sdk's
// MatrixRTC (sending sticky memberships, as Element Call's "Matrix 2.0" mode
// does) as the other caller. Skipped unless these name the servers (plain
// http, as Docker publishes them):
//
//   MULTICORD_LIVE_MATRIX=http://localhost:18008 MULTICORD_LIVE_MATRIX_SECRET=... \
//   MULTICORD_LIVE_RTC_FOCUS=http://localhost:18080 \
//   MULTICORD_LIVE_LIVEKIT=http://localhost:17880 MULTICORD_LIVE_LIVEKIT_KEY=<key>:<secret> \
//   MULTICORD_LIVE_LIVEKIT_INTERNAL=ws://mc-rtc-lk:7880 \
//     npx vitest run tests/live/matrix-rtc.live.test.ts
//
// The servers are set up as for matrix-calls.live.test.ts, plus:
// - Synapse with experimental_features msc4354_enabled (sticky events),
//   msc4502_enabled and msc4512_enabled, and a matrix_rtc transport that names
//   both the service (livekit_service_url: https://<focus host>) and the
//   LiveKit server as lk-jwt-service names it (url: its LIVEKIT_URL, which is
//   MULTICORD_LIVE_LIVEKIT_INTERNAL);
// - lk-jwt-service as an application service of Synapse (LIVEKIT_AS_TOKEN,
//   LIVEKIT_HS_TOKEN, LIVEKIT_HS_SERVER_NAME, and LIVEKIT_CS_API_URL_OVERRIDES
//   pointing the server name at Synapse's client API), with a registration
//   that has Synapse proxy rtc/livekit to it (io.element.msc4512.proxy_prefix
//   and proxy_url) and may ask who is joined (io.element.msc4502.scopes).
//
// Multicord only talks https and wss, so as in matrix-calls.live.test.ts the
// test's fetch stands in for a TLS proxy: https requests go to the plain http
// servers, and the LiveKit server's internal address becomes wss://<LiveKit
// host> on the way to Multicord and back again on the way to the service.
//
// Not covered: the media itself (see matrix-calls.live.test.ts).

import { initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import { SignalResponse } from "@livekit/protocol";
import { ClientEvent, createClient, EventType, Preset, SyncState, type MatrixClient } from "matrix-js-sdk";
import { MatrixRTCSessionEvent, type CallMembership, type MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MxSession } from "../../src/modules/matrix/api";
import { MatrixAdapter } from "../../src/modules/matrix/adapter";
import { CALL_MEMBER_TYPE, rtcIdentity } from "../../src/modules/matrix/events";
import { createMatrixClient } from "../../src/modules/matrix/client";
import { openE2ee } from "../../src/modules/matrix/crypto";
import { createOAuthClient } from "../../src/modules/matrix/oauth";
import type { NativeViewState, NativeVoiceSession } from "../../src/shared/native";

const LIVE = process.env.MULTICORD_LIVE_MATRIX ?? "";
const SECRET = process.env.MULTICORD_LIVE_MATRIX_SECRET ?? "";
const FOCUS = process.env.MULTICORD_LIVE_RTC_FOCUS ?? "";
const LIVEKIT = process.env.MULTICORD_LIVE_LIVEKIT ?? "";
const LK_INTERNAL = process.env.MULTICORD_LIVE_LIVEKIT_INTERNAL ?? "";
const [LK_KEY = "", LK_SECRET = ""] = (process.env.MULTICORD_LIVE_LIVEKIT_KEY ?? "").split(/:(.*)/s);
const READY = LIVE && SECRET && FOCUS && LIVEKIT && LK_INTERNAL && LK_KEY && LK_SECRET;

const run = Date.now().toString(36);
const ALICE = `alice-rtc-${run}`;
const BOB = `bob-rtc-${run}`;
const PASSWORD = `pw-${run}-${Math.random().toString(36).slice(2)}`;
const MEGOLM = "m.megolm.v1.aes-sha2";
const GET_TOKEN = "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token";

/** A server's plain http address, with localhost as IPv4 (Docker publishes it there). */
const plain = (url: string): string => url.replace(/\/+$/, "").replace("//localhost", "//127.0.0.1");
/** The https address of a server, as Multicord is given it. */
const secure = (url: string, scheme = "https"): string => (url ? `${scheme}://${new URL(url).host}` : "");
const HTTP = plain(LIVE);
const HTTPS = secure(LIVE);
const FOCUS_HTTP = plain(FOCUS);
const FOCUS_HTTPS = secure(FOCUS);
const LK_HTTP = plain(LIVEKIT);
const LK_WSS = secure(LIVEKIT, "wss");

/** Swaps one LiveKit address for the other wherever a JSON body names it. */
const swap = (text: string, from: string, to: string): string => text.split(JSON.stringify(from)).join(JSON.stringify(to));

/**
 * Multicord's fetch, standing in for a TLS proxy: https to the homeserver and
 * the service goes over plain http; the LiveKit server is wss://<LiveKit host>
 * to Multicord and its internal address to the services.
 */
const liveFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const target = url.startsWith(`${HTTPS}/`) ? HTTP + url.slice(HTTPS.length) : url.startsWith(`${FOCUS_HTTPS}/`) ? FOCUS_HTTP + url.slice(FOCUS_HTTPS.length) : undefined;
  if (!target) return fetch(url, init);
  const body = typeof init?.body === "string" ? swap(init.body, LK_WSS, LK_INTERNAL) : init?.body;
  const response = await fetch(target, { ...init, body });
  const text = swap(await response.text(), LK_INTERNAL, LK_WSS);
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  // lk-jwt-service's /sfu/get names the LiveKit server as it reaches it.
  if (url.startsWith(`${FOCUS_HTTPS}/`) && typeof json.url === "string") json.url = LK_WSS;
  return new Response(JSON.stringify(json), { status: response.status, headers: { "Content-Type": "application/json" } });
};

const quiet = ["log", "debug", "info", "warn", "trace", "error"] as const;
const console0 = Object.fromEntries(quiet.map((name) => [name, console[name]]));

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Registers a user with the shared secret (Synapse's admin registration API). */
async function register(user: string): Promise<void> {
  const url = `${HTTP}/_synapse/admin/v1/register`;
  const { nonce } = (await (await fetch(url)).json()) as { nonce: string };
  const mac = createHmac("sha1", SECRET).update(`${nonce}\0${user}\0${PASSWORD}\0notadmin`).digest("hex");
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, username: user, password: PASSWORD, admin: false, mac }) });
  if (!response.ok) throw new Error(`Registering ${user}: ${response.status} ${await response.text()}`);
}

const clients: MatrixClient[] = [];
const sockets: WebSocket[] = [];

/** Element: matrix-js-sdk with its Rust crypto. */
async function element(user: string): Promise<MatrixClient> {
  const login = await createClient({ baseUrl: HTTP }).loginRequest({ type: "m.login.password", identifier: { type: "m.id.user", user }, password: PASSWORD });
  const client = createClient({ baseUrl: HTTP, userId: login.user_id, deviceId: login.device_id, accessToken: login.access_token });
  await client.initRustCrypto({ useIndexedDB: false });
  const ready = new Promise<void>((resolve) => client.on(ClientEvent.Sync, (state) => state === SyncState.Prepared && resolve()));
  await client.startClient({ initialSyncLimit: 20 });
  await ready;
  clients.push(client);
  return client;
}

/** Multicord's Matrix adapter, signed in with a password. */
async function multicord(user: string) {
  const secrets = new Map<string, string>();
  const renders: NativeViewState[] = [];
  const logs: string[] = [];
  let e2ee = false;
  const api = createMatrixClient(liveFetch);
  const adapter = new MatrixAdapter({
    def: { id: "matrix-live", name: "Matrix", url: HTTPS },
    secrets: { load: async (k) => secrets.get(k), save: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) },
    render: (state) => renders.push(state),
    api,
    oauth: createOAuthClient(liveFetch),
    crypto: {
      open: async (options) => {
        const opened = await openE2ee({ ...options, store: undefined });
        e2ee = true;
        return opened;
      },
      deleteStore: async () => {},
    },
    log: (message) => logs.push(message),
  });
  const chat = () => {
    const state = renders.at(-1);
    return state?.screen === "chat" ? state : undefined;
  };
  await adapter.start();
  await until(() => {
    const state = renders.at(-1);
    return state?.screen === "prompt" && state.prompt.id === "login" && !state.busy;
  }, "the password sign-in screen");
  await adapter.handleAction({ type: "prompt", id: "login", values: { user, password: PASSWORD } });
  await until(() => chat() && e2ee, "Multicord's first sync");
  const session = JSON.parse(secrets.get("session")!) as MxSession;
  const raw = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${HTTP}/_matrix/client${path}`, {
      method,
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, any>;
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const voice = (): NativeVoiceSession | null | undefined => chat()?.voice;
  return { adapter, api, session, secrets, logs, chat, voice, raw, act: (action: Parameters<MatrixAdapter["handleAction"]>[0]) => adapter.handleAction(action) };
}

/** A JWT's claims (not verified: LiveKit does that). */
const claims = (jwt: string): Record<string, any> => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, any>;

/** Joins LiveKit's signalling with a grant, as livekit-client does in the view; resolves with the identity LiveKit gave us. */
async function joinLiveKit(url: string, jwt: string): Promise<string> {
  expect(new URL(url).host).toBe(new URL(LK_WSS).host);
  const ws = new WebSocket(`${LK_HTTP.replace(/^http/, "ws")}/rtc?access_token=${encodeURIComponent(jwt)}&protocol=16&auto_subscribe=1&sdk=js`);
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  const first = await new Promise<ArrayBuffer>((resolve, reject) => {
    ws.onmessage = (event) => resolve(event.data as ArrayBuffer);
    ws.onerror = () => reject(new Error("LiveKit refused the connection"));
    ws.onclose = (event) => reject(new Error(`LiveKit closed the connection: ${event.code} ${event.reason}`));
  });
  ws.onmessage = null;
  ws.onclose = null;
  const response = SignalResponse.fromBinary(new Uint8Array(first));
  if (response.message.case !== "join") throw new Error(`LiveKit answered ${response.message.case}`);
  return response.message.value.participant!.identity;
}

/** The identities in a LiveKit room, from its server API (an admin token signed with the API secret). */
async function liveKitParticipants(room: string): Promise<string[]> {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: LK_KEY, sub: "multicord-live-test", nbf: now - 5, exp: now + 300, video: { roomAdmin: true, room } })}`;
  const token = `${unsigned}.${createHmac("sha256", LK_SECRET).update(unsigned).digest("base64url")}`;
  const response = await fetch(`${LK_HTTP}/twirp/livekit.RoomService/ListParticipants`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ room }) });
  if (!response.ok) throw new Error(`ListParticipants: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { participants?: { identity: string }[] };
  return (body.participants ?? []).map((p) => p.identity);
}

const bytes = (base64: string): string => Buffer.from(base64, "base64").toString("hex");

describe.skipIf(!READY)("Matrix calls in MatrixRTC's newer format against a live homeserver, LiveKit and lk-jwt-service", { timeout: 120_000 }, () => {
  let mc: Awaited<ReturnType<typeof multicord>>;
  let bob: MatrixClient;
  let aliceId: string;
  let bobId: string;
  let bobMemberId: string;
  let bobIdentity: string;
  let aliceIdentity: string;
  let room: string;
  let lkRoom: string;
  let rtc: MatrixRTCSession;
  /** The media keys Element's MatrixRTC handed its media layer: by LiveKit identity, as hex. */
  const elementKeys = new Map<string, { index: number; key: string }[]>();

  const call = () => (mc.adapter as unknown as { call: { memberId: string; identity: string; sticky: boolean } | undefined }).call;
  const elementSeesAlice = (): CallMembership | undefined => rtc.memberships.find((m) => m.userId === aliceId && m.deviceId === mc.session.deviceId);
  /** A sender's newest sticky event in the room, as the server holds it. */
  const stickyOnWire = (sender: string) =>
    until(async () => {
      const messages = await mc.raw("GET", `/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=50`);
      return (messages.chunk as Record<string, any>[]).find((e) => e.sender === sender && e.msc4354_sticky);
    }, `a sticky event from ${sender} in the room`);
  const delayedLeaves = async () => {
    const body = await mc.raw("GET", "/unstable/org.matrix.msc4140/delayed_events");
    return (body.delayed_events as Record<string, any>[]).filter((d) => d.room_id === room);
  };

  beforeAll(async () => {
    for (const name of quiet) console[name] = () => {};
    await initAsync();
    await register(ALICE);
    await register(BOB);
  });
  afterAll(async () => {
    for (const ws of sockets) ws.close();
    await rtc?.leave(2_000).catch(() => undefined);
    for (const client of clients) client.stopClient();
    for (const name of quiet) console[name] = console0[name]!;
  });

  it("finds the homeserver's LiveKit server beside its service, and that it has sticky events", async () => {
    mc = await multicord(ALICE);
    aliceId = mc.session.userId;
    expect(await mc.api.rtcTransports(mc.session)).toEqual([{ service: FOCUS_HTTPS, sfu: LK_WSS }]);
    expect(await mc.api.supports(mc.session, "org.matrix.msc4354")).toBe(true);
    expect(JSON.parse(mc.secrets.get("rtc")!)).toMatchObject({ servers: [{ url: LK_WSS, focus: FOCUS_HTTPS }] });
  });

  it("sees Element's sticky, encrypted membership in an encrypted room's call", async () => {
    bob = await element(BOB);
    bobId = bob.getUserId()!;
    const created = await bob.createRoom({
      name: `Sticky call ${run}`,
      preset: Preset.PrivateChat,
      invite: [aliceId],
      initial_state: [{ type: EventType.RoomEncryption, state_key: "", content: { algorithm: MEGOLM } }],
    });
    room = created.room_id;
    await mc.raw("POST", `/v3/join/${encodeURIComponent(room)}`, {});
    await until(() => bob.getRoom(room)?.getJoinedMemberCount() === 2, "Element to see alice join");

    // Element Call in its "Matrix 2.0" mode: a new member id, the homeserver's LiveKit server, sticky memberships.
    rtc = bob.matrixRTC.getRoomSession(bob.getRoom(room)!);
    rtc.on(MatrixRTCSessionEvent.EncryptionKeyChanged, (key, index, _membership, identity) => {
      elementKeys.set(identity, [...(elementKeys.get(identity) ?? []), { index, key: Buffer.from(key).toString("hex") }]);
    });
    bobMemberId = randomUUID();
    bobIdentity = rtcIdentity(bobId, bobMemberId);
    rtc.join({ userId: bobId, deviceId: bob.getDeviceId()!, memberId: bobMemberId }, [{ type: "livekit", url: LK_WSS } as never], { manageMediaKeys: true, unstableSendStickyEvents: true, callIntent: "audio" });

    // Element Call's request for its grant: the homeserver's get_token, which Synapse hands to lk-jwt-service.
    const response = await fetch(`${HTTP}${GET_TOKEN}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bob.getAccessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: LK_INTERNAL, room_id: room, slot_id: "m.call#ROOM", member_id: bobMemberId }),
    });
    expect(response.status).toBe(200);
    const { jwt } = (await response.json()) as { jwt: string };
    expect(claims(jwt).sub).toBe(bobIdentity);
    lkRoom = claims(jwt).video.room as string;
    expect(await joinLiveKit(LK_WSS, jwt)).toBe(bobIdentity);

    // On the wire the membership is encrypted and sticky; Multicord decrypts it and lists Bob.
    expect(await stickyOnWire(bobId)).toMatchObject({ type: "m.room.encrypted", msc4354_sticky: { duration_ms: 3_600_000 } });
    const entry = await until(() => mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.name === `Sticky call ${run}` && i.members?.length), `Bob's call under Calls (${mc.logs.join("; ")})`);
    expect(entry.members!.map((m) => m.name)).toEqual([BOB]);
  });

  it("joins in the newer format: a grant from the homeserver, the hashed identity, a sticky encrypted membership and delayed leave", async () => {
    const entry = mc.chat()!.sidebar.find((i) => i.kind === "voice" && i.name === `Sticky call ${run}`)!;
    await mc.act({ type: "joinVoice", channelId: entry.id });
    const voice = await until(() => (mc.voice()?.token ? mc.voice()! : undefined), `the LiveKit grant (${mc.chat()?.error ?? ""} ${mc.logs.join("; ")})`);
    expect(mc.chat()?.error).toBeUndefined();
    expect(call()!.sticky).toBe(true);
    const memberId = call()!.memberId;
    expect(memberId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    aliceIdentity = rtcIdentity(aliceId, memberId);
    expect(call()!.identity).toBe(aliceIdentity);

    // The grant: for the same LiveKit room as Element, as alice's hashed identity, and LiveKit admits it so.
    expect(voice.url).toBe(LK_WSS);
    const grant = claims(voice.token!);
    expect(grant.sub).toBe(aliceIdentity);
    expect(grant.video).toMatchObject({ room: lkRoom, roomJoin: true, canPublish: true, canSubscribe: true });
    expect(await joinLiveKit(voice.url!, voice.token!)).toBe(aliceIdentity);
    expect((await liveKitParticipants(lkRoom)).sort()).toEqual([aliceIdentity, bobIdentity].sort());

    // No state membership; the sticky one is encrypted on the wire, and Element reads it.
    const state = await fetch(`${HTTP}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/${CALL_MEMBER_TYPE}/${encodeURIComponent(`_${aliceId}_${mc.session.deviceId}_m.call`)}`, { headers: { Authorization: `Bearer ${mc.session.accessToken}` } });
    expect(state.status).toBe(404);
    expect(await stickyOnWire(aliceId)).toMatchObject({ type: "m.room.encrypted", msc4354_sticky: { duration_ms: 3_600_000 } });
    const seen = await until(elementSeesAlice, "Element's MatrixRTC to see alice in the call");
    expect(seen.memberId).toBe(memberId);
    expect(seen.backendIdentities).toEqual([aliceIdentity]);
    expect(seen.transports).toEqual([{ type: "livekit", url: LK_WSS }]);
    expect(seen.callIntent).toBe("audio");

    // The leave the server sends should Multicord vanish: sticky, encrypted, 18 s.
    const [delayed, ...more] = await delayedLeaves();
    expect(more).toEqual([]);
    expect(delayed).toMatchObject({ type: "m.room.encrypted", delay: 18_000 });
    expect(delayed!.state_key).toBeUndefined();

    // Multicord lists both, on the same LiveKit server.
    const listed = await until(() => mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.active && (i.members?.length ?? 0) === 2), "Multicord to list both");
    expect(listed.members!.map((m) => m.name).sort()).toEqual([ALICE, BOB].sort());
  });

  it("exchanges media keys with Element under the hashed identities, both ways", async () => {
    const fromElement = await until(() => {
      const own = elementKeys.get(bobIdentity)?.at(-1);
      const got = mc.voice()?.e2ee?.keys.filter((k) => k.participant === bobIdentity) ?? [];
      return own && got.some((k) => k.index === own.index && bytes(k.key) === own.key) && own;
    }, `Multicord to get Element's media key under Element's hashed identity (${JSON.stringify(mc.voice()?.e2ee?.keys.map((k) => k.participant))} ${mc.logs.join("; ")})`);
    expect(fromElement.key).toHaveLength(32);
    // Nothing goes under the older user:device identity, which neither side uses here.
    expect(mc.voice()!.e2ee!.keys.some((k) => k.participant === `${bobId}:${bob.getDeviceId()}`)).toBe(false);

    await until(() => {
      const ours = mc.voice()?.e2ee?.keys.filter((k) => k.participant === aliceIdentity).at(-1);
      return ours && elementKeys.get(aliceIdentity)?.some((k) => k.index === ours.index && k.key === bytes(ours.key));
    }, `Element to get Multicord's current media key under alice's hashed identity (${JSON.stringify([...elementKeys.keys()])})`);
  });

  it("keeps pushing the delayed leave back while in the call", async () => {
    const before = await delayedLeaves();
    expect(before).toHaveLength(1);
    await sleep(21_000);
    expect(await delayedLeaves()).toEqual([expect.objectContaining({ delay_id: before[0]!.delay_id })]);
    expect(elementSeesAlice()).toBeDefined();
  }, 60_000);

  it("leaves: the scheduled sticky leave goes out, and Element sees alice go", async () => {
    await mc.act({ type: "leaveVoice" });
    expect(mc.voice()).toBeNull();
    await until(async () => (await delayedLeaves()).length === 0, "the scheduled leave to be sent");
    await until(() => !elementSeesAlice(), "Element's MatrixRTC to see alice leave");
    await until(() => (mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.name === `Sticky call ${run}`)?.members ?? []).length === 1, "Multicord to list only Bob");
    sockets[1]!.close();
    await until(async () => !(await liveKitParticipants(lkRoom)).includes(aliceIdentity), "LiveKit to drop alice");
  });

  it("the server sends the sticky leave when Multicord vanishes mid-call", async () => {
    const item = await until(() => mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.name === `Sticky call ${run}`), "the ongoing call in the sidebar");
    await mc.act({ type: "joinVoice", channelId: item.id });
    await until(() => mc.voice()?.token, "the grant again");
    // A new member id for the new membership.
    expect(rtcIdentity(aliceId, call()!.memberId)).not.toBe(aliceIdentity);
    await until(elementSeesAlice, "Element to see alice again");
    expect(await delayedLeaves()).toHaveLength(1);
    (mc.adapter as unknown as { call: { abandon(): void } }).call.abandon();
    await until(() => !elementSeesAlice(), "Element's MatrixRTC to see alice gone", 40_000);
    await mc.act({ type: "leaveVoice" });

    expect(await rtc.leave(5_000)).toBe(true);
    await until(() => !mc.chat()?.sidebar.some((i) => i.kind === "voice" && i.name === `Sticky call ${run}`), "the call to be empty for Multicord");
  }, 90_000);
});
