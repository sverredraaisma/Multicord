// Live check of Multicord's Matrix calls (MatrixRTC) against a real
// homeserver (Synapse), a real LiveKit SFU and Element's LiveKit service
// (lk-jwt-service), with matrix-js-sdk's MatrixRTC as the other side.
// Skipped unless these name the servers (plain http, as Docker publishes them):
//
//   MULTICORD_LIVE_MATRIX=http://localhost:18008 MULTICORD_LIVE_MATRIX_SECRET=... \
//   MULTICORD_LIVE_RTC_FOCUS=http://localhost:18080 \
//   MULTICORD_LIVE_LIVEKIT=http://localhost:17880 MULTICORD_LIVE_LIVEKIT_KEY=<key>:<secret> \
//     npx vitest run tests/live/matrix-calls.live.test.ts
//
// Synapse is set up as for matrix.live.test.ts, and also names the LiveKit
// service as https://<focus host> in its client .well-known
// (org.matrix.msc4143.rtc_foci, via extra_well_known_client_content) and in
// matrix_rtc.transports (experimental msc4143_enabled). lk-jwt-service lists
// the homeserver's server name in LIVEKIT_FULL_ACCESS_HOMESERVERS and checks
// OpenID tokens over federation, so Synapse also needs a TLS federation
// listener the service reaches by its server name (a self-signed certificate
// with LIVEKIT_INSECURE_SKIP_VERIFY_TLS=YES_I_KNOW_WHAT_I_AM_DOING).
//
// Multicord only talks https and wss: the test's fetch carries its https
// requests to the plain http servers, and the LiveKit address the service
// hands out (its LIVEKIT_URL, as the service reaches LiveKit) becomes
// wss://<LiveKit host>, as a TLS proxy in front of both would make it.
//
// Not covered: the media itself. It flows in the view (livekit-client with
// WebRTC and its E2EE worker in Chromium), which Node does not have. The test
// joins LiveKit's signalling with Multicord's token as the view would, and
// checks the media keys the view would be given.

import { initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import { SignalResponse } from "@livekit/protocol";
import { ClientEvent, createClient, EventType, Preset, SyncState, type MatrixClient } from "matrix-js-sdk";
import { MatrixRTCSessionEvent, type CallMembership, type MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MxSession } from "../../src/modules/matrix/api";
import { MatrixAdapter } from "../../src/modules/matrix/adapter";
import { CALL_MEMBER_TYPE } from "../../src/modules/matrix/events";
import { createMatrixClient } from "../../src/modules/matrix/client";
import { openE2ee } from "../../src/modules/matrix/crypto";
import { createOAuthClient } from "../../src/modules/matrix/oauth";
import type { NativeViewState, NativeVoiceSession } from "../../src/shared/native";

const LIVE = process.env.MULTICORD_LIVE_MATRIX ?? "";
const SECRET = process.env.MULTICORD_LIVE_MATRIX_SECRET ?? "";
const FOCUS = process.env.MULTICORD_LIVE_RTC_FOCUS ?? "";
const LIVEKIT = process.env.MULTICORD_LIVE_LIVEKIT ?? "";
const [LK_KEY = "", LK_SECRET = ""] = (process.env.MULTICORD_LIVE_LIVEKIT_KEY ?? "").split(/:(.*)/s);
const READY = LIVE && SECRET && FOCUS && LIVEKIT && LK_KEY && LK_SECRET;

const run = Date.now().toString(36);
const ALICE = `alice-${run}`;
const BOB = `bob-${run}`;
const PASSWORD = `pw-${run}-${Math.random().toString(36).slice(2)}`;
const MEGOLM = "m.megolm.v1.aes-sha2";

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

/** Multicord's fetch: https to the homeserver and the LiveKit service goes over plain http; the service's LiveKit address is the public wss one. */
const liveFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${HTTPS}/`)) return fetch(HTTP + url.slice(HTTPS.length), init);
  if (!url.startsWith(`${FOCUS_HTTPS}/`)) return fetch(url, init);
  const response = await fetch(FOCUS_HTTP + url.slice(FOCUS_HTTPS.length), init);
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.url === "string") body.url = LK_WSS;
  return new Response(JSON.stringify(body), { status: response.status, headers: { "Content-Type": "application/json" } });
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
  return { adapter, api, session, logs, chat, voice, raw, act: (action: Parameters<MatrixAdapter["handleAction"]>[0]) => adapter.handleAction(action) };
}

/** A JWT's claims (not verified: LiveKit does that). */
const claims = (jwt: string): Record<string, any> => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, any>;

/** Joins LiveKit's signalling with a grant, as livekit-client does in the view; resolves with the identity LiveKit gave us. */
async function joinLiveKit(url: string, jwt: string): Promise<string> {
  const address = new URL(url);
  expect(address.href).toBe(`${LK_WSS}/`);
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

describe.skipIf(!READY)("Matrix calls against a live homeserver, LiveKit and lk-jwt-service", { timeout: 120_000 }, () => {
  let mc: Awaited<ReturnType<typeof multicord>>;
  let bob: MatrixClient;
  let aliceId: string;
  let aliceIdentity: string;
  let bobIdentity: string;
  let room: string;
  let lkRoom: string;
  let rtc: MatrixRTCSession;
  /** The media keys Element's MatrixRTC handed its media layer: by LiveKit identity, as hex. */
  const elementKeys = new Map<string, { index: number; key: string }[]>();

  const membership = async () => {
    const response = await fetch(`${HTTP}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/${CALL_MEMBER_TYPE}/${encodeURIComponent(`_${aliceId}_${mc.session.deviceId}_m.call`)}`, {
      headers: { Authorization: `Bearer ${mc.session.accessToken}` },
    });
    return (await response.json()) as Record<string, any>;
  };
  const delayedLeaves = async () => {
    const body = await mc.raw("GET", "/unstable/org.matrix.msc4140/delayed_events");
    return (body.delayed_events as Record<string, any>[]).filter((d) => d.room_id === room && d.type === CALL_MEMBER_TYPE);
  };
  const elementSeesAlice = (): CallMembership | undefined => rtc.memberships.find((m) => m.userId === aliceId && m.deviceId === mc.session.deviceId);

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

  it("finds the call service in the homeserver's .well-known and rtc/transports", async () => {
    expect(await createMatrixClient(liveFetch).rtcFoci(HTTPS)).toEqual([FOCUS_HTTPS]);
    mc = await multicord(ALICE);
    aliceId = mc.session.userId;
    aliceIdentity = `${aliceId}:${mc.session.deviceId}`;
    // The homeserver may also name its LiveKit server for the newer format (matrix-rtc.live.test.ts); the older one uses the service.
    expect(await mc.api.rtcTransports(mc.session)).toEqual([expect.objectContaining({ service: FOCUS_HTTPS })]);
    expect(await mc.api.supports(mc.session, "org.matrix.msc4140")).toBe(true);
  });

  it("joins an encrypted room's call: OpenID token, LiveKit grant, membership and delayed leave", async () => {
    bob = await element(BOB);
    const created = await bob.createRoom({
      name: `Call ${run}`,
      preset: Preset.PrivateChat,
      invite: [aliceId],
      initial_state: [{ type: EventType.RoomEncryption, state_key: "", content: { algorithm: MEGOLM } }],
      // As Element makes rooms with calls on: everyone may announce a call membership.
      power_level_content_override: { events: { [CALL_MEMBER_TYPE]: 0 } },
    });
    room = created.room_id;
    await mc.raw("POST", `/v3/join/${encodeURIComponent(room)}`, {});
    await until(() => bob.getRoom(room)?.getJoinedMemberCount() === 2, "Element to see alice join");
    const item = await until(() => mc.chat()?.sidebar.find((i) => i.name === `Call ${run}`), "the room in Multicord's sidebar");
    await mc.act({ type: "select", channelId: item.id });
    const start = await until(() => mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.name === `Start a call in Call ${run}`), "the way to start a call");
    await mc.act({ type: "joinVoice", channelId: start.id });
    const voice = await until(() => (mc.voice()?.token ? mc.voice()! : undefined), `the LiveKit grant (${mc.chat()?.error ?? ""} ${mc.logs.join("; ")})`);
    expect(mc.chat()?.error).toBeUndefined();
    // Multicord lists itself in its call. (Loading the room's history once overwrote alice's
    // membership with her older invite, which left her out of her own call.)
    await until(() => mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.active && i.members?.[0]?.name === ALICE), "Multicord to list itself in the call");

    // The grant: for the call's LiveKit room, as alice's device.
    expect(voice.url).toBe(`${LK_WSS}/`);
    const grant = claims(voice.token!);
    expect(grant.sub).toBe(aliceIdentity);
    expect(grant.video).toMatchObject({ roomJoin: true, canPublish: true, canSubscribe: true });
    lkRoom = grant.video.room as string;
    expect(lkRoom).toBeTruthy();
    // Encrypted: our own media key is there before anyone else is.
    expect(voice.e2ee?.keys).toEqual([{ participant: aliceIdentity, index: 0, key: expect.any(String) }]);

    // The membership as Synapse holds it.
    const content = await until(async () => {
      const c = await membership();
      return c.device_id ? c : undefined;
    }, "the membership on the server");
    expect(content).toMatchObject({
      application: "m.call",
      call_id: "",
      scope: "m.room",
      device_id: mc.session.deviceId,
      focus_active: { type: "livekit", focus_selection: "multi_sfu" },
      foci_preferred: [{ type: "livekit", livekit_service_url: FOCUS_HTTPS, livekit_alias: room }],
    });
    // And the leave the server sends should Multicord vanish.
    const [delayed, ...more] = await delayedLeaves();
    expect(more).toEqual([]);
    expect(delayed).toMatchObject({ delay: 18_000, state_key: `_${aliceId}_${mc.session.deviceId}_m.call`, content: {} });
  });

  it("connects to the real LiveKit with Multicord's grant, as itself", async () => {
    const voice = mc.voice()!;
    expect(await joinLiveKit(voice.url!, voice.token!)).toBe(aliceIdentity);
    expect(await liveKitParticipants(lkRoom)).toEqual([aliceIdentity]);
  });

  it("is in the call for Element's MatrixRTC", async () => {
    rtc = bob.matrixRTC.getRoomSession(bob.getRoom(room)!);
    const seen = await until(elementSeesAlice, "Element's MatrixRTC to see alice in the call");
    expect(seen.isExpired()).toBe(false);
    expect(seen.transports).toEqual([{ type: "livekit", livekit_service_url: FOCUS_HTTPS, livekit_alias: room }]);
    // The identity Element looks for on LiveKit, and the one the service gave Multicord.
    expect(seen.backendIdentities).toEqual([aliceIdentity]);
    expect(seen.memberId).toBe(aliceIdentity);
  });

  it("Element joins too: its grant puts it in the same LiveKit room, and Multicord lists it", async () => {
    const bobId = bob.getUserId()!;
    bobIdentity = `${bobId}:${bob.getDeviceId()}`;
    rtc.on(MatrixRTCSessionEvent.EncryptionKeyChanged, (key, index, _membership, identity) => {
      elementKeys.set(identity, [...(elementKeys.get(identity) ?? []), { index, key: Buffer.from(key).toString("hex") }]);
    });
    rtc.join({ userId: bobId, deviceId: bob.getDeviceId()!, memberId: bobIdentity }, [{ type: "livekit", livekit_service_url: FOCUS_HTTPS, livekit_alias: room } as never], { manageMediaKeys: true });

    // Element Call's request for its grant (lk-jwt-service's /sfu/get).
    const openid = await bob.getOpenIdToken();
    const response = await fetch(`${FOCUS_HTTP}/sfu/get`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room, openid_token: openid, device_id: bob.getDeviceId() }) });
    expect(response.status).toBe(200);
    const grant = (await response.json()) as { url: string; jwt: string };
    expect(claims(grant.jwt).video.room).toBe(lkRoom);
    expect(await joinLiveKit(LK_WSS, grant.jwt)).toBe(bobIdentity);
    expect((await liveKitParticipants(lkRoom)).sort()).toEqual([aliceIdentity, bobIdentity].sort());

    const call = await until(() => mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.active && (i.members?.length ?? 0) === 2), "Multicord to list Element in the call");
    expect(call.members!.map((m) => m.name).sort()).toEqual([ALICE, BOB].sort());
  });

  it("exchanges media keys with Element over Olm-encrypted to-device messages", async () => {
    // Element's key reaches Multicord, which hands it to the view under Element's LiveKit identity.
    const fromElement = await until(() => {
      const own = elementKeys.get(bobIdentity)?.at(-1);
      const got = mc.voice()?.e2ee?.keys.filter((k) => k.participant === bobIdentity) ?? [];
      return own && got.some((k) => k.index === own.index && bytes(k.key) === own.key) && own;
    }, `Multicord to get Element's media key (${mc.logs.join("; ")})`);
    expect(fromElement.key).toHaveLength(32);

    // Multicord's key (rotated or not once Element joined) reaches Element, under Multicord's identity.
    await until(() => {
      const ours = mc.voice()?.e2ee?.keys.filter((k) => k.participant === aliceIdentity).at(-1);
      return ours && elementKeys.get(aliceIdentity)?.some((k) => k.index === ours.index && k.key === bytes(ours.key));
    }, `Element to get Multicord's current media key (${JSON.stringify([...elementKeys])})`);
  });

  it("keeps pushing the delayed leave back while in the call", async () => {
    const before = await delayedLeaves();
    expect(before).toHaveLength(1);
    // Longer than the 18 s delay: without the restarts, the server would have sent the leave.
    await sleep(21_000);
    expect(await delayedLeaves()).toEqual([expect.objectContaining({ delay_id: before[0]!.delay_id })]);
    expect((await membership()).device_id).toBe(mc.session.deviceId);
    expect(elementSeesAlice()).toBeDefined();
  }, 60_000);

  it("leaves: the membership is cleared through the scheduled leave, and Element sees it", async () => {
    await mc.act({ type: "leaveVoice" });
    expect(mc.voice()).toBeNull();
    await until(async () => Object.keys(await membership()).length === 0, "the membership to be cleared");
    expect(await delayedLeaves()).toEqual([]);
    await until(() => !elementSeesAlice(), "Element's MatrixRTC to see alice leave");
    // The view hangs up on leaving.
    sockets[0]!.close();
    await until(async () => !(await liveKitParticipants(lkRoom)).includes(aliceIdentity), "LiveKit to drop alice");
  });

  it("the server sends the leave when Multicord vanishes mid-call", async () => {
    const item = await until(() => mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.name === `Call ${run}`), "the ongoing call in the sidebar");
    await mc.act({ type: "joinVoice", channelId: item.id });
    await until(() => mc.voice()?.token, "the grant again");
    await until(async () => (await membership()).device_id === mc.session.deviceId, "the membership again");
    await until(elementSeesAlice, "Element to see alice again");
    expect(await delayedLeaves()).toHaveLength(1);
    // A crash: nothing restarts the delayed leave and nothing says goodbye.
    (mc.adapter as unknown as { call: { abandon(): void } }).call.abandon();
    await until(async () => Object.keys(await membership()).length === 0, "the server to send the leave", 40_000);
    await until(() => !elementSeesAlice(), "Element's MatrixRTC to see alice gone");
    await mc.act({ type: "leaveVoice" });

    // Element leaves as well; its own delayed leave goes too.
    expect(await rtc.leave(5_000)).toBe(true);
    await until(() => rtc.memberships.length === 0, "the call to be empty");
  }, 90_000);
});
