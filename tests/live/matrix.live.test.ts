// Live check of Multicord's native Matrix module against a real homeserver
// (Synapse), with matrix-js-sdk (Element's library) as the other side.
// Skipped unless MULTICORD_LIVE_MATRIX names the homeserver and
// MULTICORD_LIVE_MATRIX_SECRET its registration shared secret, e.g.
//
//   MULTICORD_LIVE_MATRIX=http://localhost:18008 MULTICORD_LIVE_MATRIX_SECRET=... \
//     npx vitest run tests/live/matrix.live.test.ts
//
// Synapse needs max_event_delay_duration set (MSC4140 delayed events) and
// relaxed rate limits. Each run registers two new users (alice-<run>,
// bob-<run>) with the shared secret, so runs do not
// share cross-signing keys or rooms. Multicord only talks https; the test's
// fetch carries its https requests to the plain http server, as a TLS proxy in
// front of it would. The Electron shell's network policy is not part of this:
// the module's code runs here on Node's fetch.

import { initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import { ClientEvent, createClient, EventType, Preset, SyncState, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { CryptoEvent, VerificationPhase, VerifierEvent, type ShowSasCallbacks, type VerificationRequest } from "matrix-js-sdk/lib/crypto-api/index.js";
import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MxSession } from "../../src/modules/matrix/api";
import type { FileSource } from "../../src/engine/runtime";
import { MatrixAdapter } from "../../src/modules/matrix/adapter";
import { createMatrixClient } from "../../src/modules/matrix/client";
import { openE2ee, type MatrixE2ee } from "../../src/modules/matrix/crypto";
import { createOAuthClient } from "../../src/modules/matrix/oauth";
import type { NativeViewState } from "../../src/shared/native";
import { encryptAttachment } from "../modules/matrix/attachments";

const LIVE = process.env.MULTICORD_LIVE_MATRIX ?? "";
const SECRET = process.env.MULTICORD_LIVE_MATRIX_SECRET ?? "";
const run = Date.now().toString(36);
const ALICE = `alice-${run}`;
const BOB = `bob-${run}`;
const PASSWORD = `pw-${run}-${Math.random().toString(36).slice(2)}`;
const MEGOLM = "m.megolm.v1.aes-sha2";

/** The plain http server, with localhost as IPv4 (Docker publishes it there). */
const HTTP = LIVE.replace(/\/+$/, "").replace("//localhost", "//127.0.0.1");
/** The https address Multicord is given. */
const HTTPS = LIVE ? `https://${new URL(LIVE).host}` : "";

/** Multicord's fetch: its https requests to the server go over plain http. */
const liveFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return fetch(url.startsWith(`${HTTPS}/`) ? HTTP + url.slice(HTTPS.length) : url, init);
};

const quiet = ["log", "debug", "info", "warn", "trace"] as const;
const console0 = Object.fromEntries(quiet.map((name) => [name, console[name]]));

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const clients: MatrixClient[] = [];

/** Element: matrix-js-sdk with its Rust crypto, signed in with a password as a new device. */
async function element(user: string, password: string, cryptoCallbacks = {}): Promise<MatrixClient> {
  const login = await createClient({ baseUrl: HTTP }).loginRequest({ type: "m.login.password", identifier: { type: "m.id.user", user }, password, initial_device_display_name: "Element (live test)" });
  const client = createClient({ baseUrl: HTTP, userId: login.user_id, deviceId: login.device_id, accessToken: login.access_token, cryptoCallbacks });
  await client.initRustCrypto({ useIndexedDB: false });
  const ready = new Promise<void>((resolve) => client.on(ClientEvent.Sync, (state) => state === SyncState.Prepared && resolve()));
  await client.startClient({ initialSyncLimit: 20 });
  await ready;
  clients.push(client);
  return client;
}

/** Multicord's Matrix adapter, signing in with a password through its own sign-in screen. */
async function multicord(user: string, password: string) {
  const secrets = new Map<string, string>();
  const renders: NativeViewState[] = [];
  const logs: string[] = [];
  let e2ee: MatrixE2ee | undefined;
  const api = createMatrixClient(liveFetch);
  /** What the file picker hands out, one list per attach. */
  const picks: FileSource[][] = [];
  const adapter = new MatrixAdapter({
    def: { id: "matrix-live", name: "Matrix", url: HTTPS },
    secrets: {
      load: async (k) => secrets.get(k),
      save: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    render: (state) => renders.push(state),
    api,
    oauth: createOAuthClient(liveFetch),
    // In memory: Node has no IndexedDB.
    crypto: { open: async (options) => (e2ee = await openE2ee({ ...options, store: undefined })), deleteStore: async () => {} },
    log: (message) => logs.push(message),
    files: { pick: async () => picks.shift() ?? [] },
  });
  const last = () => renders.at(-1);
  const prompt = (id: string) => {
    const state = last();
    return state?.screen === "prompt" && state.prompt.id === id && !state.busy && state;
  };
  const chat = () => {
    const state = last();
    return state?.screen === "chat" ? state : undefined;
  };
  await adapter.start();
  const login = await until(() => prompt("login"), "the password sign-in screen");
  expect(login.prompt.fields.map((f) => f.name)).toEqual(["user", "password"]);
  await adapter.handleAction({ type: "prompt", id: "login", values: { user, password } });
  await until(() => chat() && e2ee, "Multicord's first sync");
  const session = JSON.parse(secrets.get("session")!) as MxSession;
  const messages = () => chat()?.channel?.messages ?? [];
  const act = (action: Parameters<MatrixAdapter["handleAction"]>[0]) => adapter.handleAction(action);
  /** A raw client-server call as this session (for what Element's UI would do and Multicord does not offer, e.g. accepting an invite). */
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
  return { adapter, api, session, e2ee: () => e2ee!, renders, logs, picks, last, prompt, chat, messages, act, raw };
}
type Multicord = Awaited<ReturnType<typeof multicord>>;

/** The decrypted event from `sender` with this body in Element's timeline of the room. */
async function elementSees(client: MatrixClient, roomId: string, find: (event: MatrixEvent) => boolean, what: string): Promise<MatrixEvent> {
  return until(async () => {
    for (const event of client.getRoom(roomId)?.getLiveTimeline().getEvents() ?? []) {
      if (event.isEncrypted()) await client.decryptEventIfNeeded(event);
      if (find(event)) return event;
    }
    return undefined;
  }, what);
}

/** Cross-signing keys can be replaced only with the password (user-interactive auth). */
async function withPassword(user: string, password: string, makeRequest: (auth: Record<string, unknown> | null) => Promise<unknown>): Promise<void> {
  try {
    await makeRequest(null);
  } catch (error) {
    const session = (error as { data?: { session?: string } }).data?.session;
    if (!session) throw error;
    await makeRequest({ type: "m.login.password", identifier: { type: "m.id.user", user }, password, session });
  }
}

/** A PNG of one colour, for the server to make thumbnails of. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]));
}

/** Registers a user with the shared secret (Synapse's admin registration API). */
async function register(user: string): Promise<void> {
  const url = `${HTTP}/_synapse/admin/v1/register`;
  const { nonce } = (await (await fetch(url)).json()) as { nonce: string };
  const mac = createHmac("sha1", SECRET).update(`${nonce}\0${user}\0${PASSWORD}\0notadmin`).digest("hex");
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, username: user, password: PASSWORD, admin: false, mac }) });
  if (!response.ok) throw new Error(`Registering ${user}: ${response.status} ${await response.text()}`);
}

describe.skipIf(!LIVE || !SECRET)("Matrix against a live homeserver", { timeout: 120_000 }, () => {
  let bob: MatrixClient;
  let aliceElement: MatrixClient;
  let recoveryKey: string;
  let aliceId: string;
  let bobId: string;
  let vault: string;
  let mc: Multicord;
  let dm: string;
  let lobby: string;

  beforeAll(async () => {
    for (const name of quiet) console[name] = () => {};
    await initAsync();
    await register(ALICE);
    await register(BOB);
  });
  afterAll(async () => {
    for (const client of clients) client.stopClient();
    for (const name of quiet) console[name] = console0[name]!;
  });

  it("sets up recovery in Element: cross-signing, secret storage and key backup, and a message only the backup holds", async () => {
    let secretKey: Uint8Array | undefined;
    aliceElement = await element(ALICE, PASSWORD, {
      getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }) => [Object.keys(keys)[0]!, secretKey!] as [string, Uint8Array],
    });
    aliceId = aliceElement.getUserId()!;
    const crypto = aliceElement.getCrypto()!;
    const recovery = await crypto.createRecoveryKeyFromPassphrase();
    secretKey = recovery.privateKey;
    await crypto.bootstrapCrossSigning({ setupNewCrossSigning: true, authUploadDeviceSigningKeys: (makeRequest) => withPassword(ALICE, PASSWORD, makeRequest) });
    await crypto.bootstrapSecretStorage({ createSecretStorageKey: async () => recovery, setupNewSecretStorage: true, setupNewKeyBackup: true });
    expect(await crypto.isCrossSigningReady()).toBe(true);
    expect(await crypto.getActiveSessionBackupVersion()).toBeTruthy();
    recoveryKey = recovery.encodedPrivateKey!;

    const created = await aliceElement.createRoom({
      name: `Vault ${run}`,
      preset: Preset.PrivateChat,
      initial_state: [{ type: EventType.RoomEncryption, state_key: "", content: { algorithm: MEGOLM } }],
    });
    vault = created.room_id;
    // Element sends in the clear until it has synced the room's encryption state.
    await until(() => crypto.isEncryptionEnabledInRoom(vault), "Element to see the vault is encrypted");
    const kept = await aliceElement.sendTextMessage(vault, "kept in the backup");
    expect(aliceElement.getRoom(vault)!.findEventById(kept.event_id)?.getWireType()).toBe("m.room.encrypted");
    // matrix-js-sdk backs a room key up when keys arrive (its room-key callback), not when it makes
    // its own outbound session: nudge its backup loop, as the next incoming key would.
    const backupManager = (crypto as unknown as { backupManager: { maybeUploadKey(): Promise<void> } }).backupManager;
    await until(async () => {
      await backupManager.maybeUploadKey();
      const version = (await crypto.getActiveSessionBackupVersion())!;
      const response = await fetch(`${HTTP}/_matrix/client/v3/room_keys/keys?version=${encodeURIComponent(version)}`, { headers: { Authorization: `Bearer ${aliceElement.getAccessToken()}` } });
      const backup = (await response.json()) as { rooms?: Record<string, unknown> };
      return backup.rooms?.[vault];
    }, "the vault's key in the backup");
  });

  it("signs in with a password (Synapse offers m.login.password, no OAuth) and syncs", async () => {
    mc = await multicord(ALICE, PASSWORD);
    expect(mc.session).toMatchObject({ baseUrl: HTTPS, userId: aliceId, ownDevice: true });
    expect(mc.session.oauth).toBeUndefined();
    expect(mc.adapter.accountStatus()).toEqual({ state: "signed-in", name: aliceId });
    // The device is new and not cross-signed: Multicord offers to verify it.
    const sidebar = mc.chat()!.sidebar.map((i) => i.name);
    expect(sidebar).toContain("🔑 Verify this device");
    expect(sidebar).toContain("📱 Verify with another device");
    expect(await mc.e2ee().status()).toMatchObject({ verified: false, backup: false });
    // The vault room alice made in Element is in the room list.
    await until(() => mc.chat()?.sidebar.find((i) => i.name === `Vault ${run}`), "the vault room in the sidebar");
  });

  it("lists an encrypted DM Element makes, and its messages decrypt both ways", async () => {
    bob = await element(BOB, PASSWORD);
    bobId = bob.getUserId()!;
    // Bob starts a DM with alice, as Element does: a trusted private chat, encrypted, marked direct.
    const created = await bob.createRoom({
      is_direct: true,
      invite: [aliceId],
      preset: Preset.TrustedPrivateChat,
      initial_state: [{ type: EventType.RoomEncryption, state_key: "", content: { algorithm: MEGOLM } }],
    });
    dm = created.room_id;
    await bob.setAccountData(EventType.Direct, { [aliceId]: [dm] } as never);
    // Alice accepts in Element (Multicord shows no invites); Element marks the room direct for her too.
    await mc.raw("POST", `/v3/join/${encodeURIComponent(dm)}`, {});
    const direct = await mc.raw("GET", `/v3/user/${encodeURIComponent(aliceId)}/account_data/m.direct`).catch((): Record<string, any> => ({}));
    const others = (direct[bobId] as string[] | undefined) ?? [];
    await mc.raw("PUT", `/v3/user/${encodeURIComponent(aliceId)}/account_data/m.direct`, { ...direct, [bobId]: [...others, dm] });

    const conversation = await until(async () => (await mc.adapter.listDirectConversations()).find((c) => c.key === dm), "the DM in Multicord's DM list");
    expect(conversation.title).toBe(BOB);

    await until(() => bob.getRoom(dm)?.getJoinedMemberCount() === 2, "Bob's Element to see alice join");
    await until(() => bob.getCrypto()!.isEncryptionEnabledInRoom(dm), "Bob's Element to see the DM is encrypted");
    await bob.sendTextMessage(dm, "hello from Element");
    await mc.adapter.openConversation(dm);
    const shown = await until(() => mc.messages().find((m) => m.content.includes("hello from Element")), "Multicord to decrypt Element's message");
    expect(shown.author).toBe(`${BOB} · unverified device`);

    await mc.act({ type: "send", content: "hello from Multicord" });
    const event = await elementSees(bob, dm, (e) => e.getSender() === aliceId && e.getContent().body === "hello from Multicord", "Element to decrypt Multicord's message");
    expect(event.getWireType()).toBe("m.room.encrypted");
    expect(event.isDecryptionFailure()).toBe(false);
  });

  it("lists an unencrypted group room, and its messages", async () => {
    const created = await bob.createRoom({ name: `Lobby ${run}`, preset: Preset.PublicChat, invite: [aliceId] });
    lobby = created.room_id;
    await mc.raw("POST", `/v3/join/${encodeURIComponent(lobby)}`, {});
    await bob.sendTextMessage(lobby, "plain hello");
    const item = await until(() => mc.chat()?.sidebar.find((i) => i.name === `Lobby ${run}`), "the lobby in the sidebar");
    await mc.act({ type: "select", channelId: item.id });
    const shown = await until(() => mc.messages().find((m) => m.content.includes("plain hello")), "the lobby's message");
    expect(shown.author).toBe(BOB);
    // Not a DM.
    expect((await mc.adapter.listDirectConversations()).some((c) => c.key === lobby)).toBe(false);
  });

  it("shows a space as a server with its rooms, and a room added to it later", async () => {
    const via = [bobId.slice(bobId.indexOf(":") + 1)];
    const roomNamed = async (name: string) => (await bob.createRoom({ name, preset: Preset.PublicChat, invite: [aliceId] })).room_id;
    const hall = await roomNamed(`Hall ${run}`);
    const garden = await roomNamed(`Garden ${run}`);
    const { room_id: space } = await bob.createRoom({
      name: `Space ${run}`,
      preset: Preset.PublicChat,
      invite: [aliceId],
      creation_content: { type: "m.space" },
      initial_state: [{ type: EventType.SpaceChild, state_key: hall, content: { via } }],
    });
    for (const id of [space, hall, garden]) await mc.raw("POST", `/v3/join/${encodeURIComponent(id)}`, {});
    const server = await until(async () => (await mc.adapter.listServers()).find((s) => s.key === space), "the space in the rail");
    expect(server.name).toBe(`Space ${run}`);
    const names = () => mc.chat()?.sidebar.map((i) => i.name) ?? [];
    // Garden is in no space yet, so it is at home; Hall is not.
    await until(() => names().includes(`Garden ${run}`), "the second room at home");
    expect(names()).not.toContain(`Hall ${run}`);
    await mc.adapter.openServer(space);
    await until(() => mc.chat()?.title === `Space ${run}` && names().includes(`Hall ${run}`), "the space's room in its sidebar");
    // A child added later comes in an incremental sync.
    await bob.sendStateEvent(space, EventType.SpaceChild, { via }, garden);
    await until(() => names().includes(`Garden ${run}`), "the room added later, in the space");
    expect(names().indexOf(`Hall ${run}`)).toBeLessThan(names().indexOf(`Garden ${run}`));
    await mc.adapter.openHome();
    expect(names()).not.toContain(`Garden ${run}`);
  });

  it("loads an encrypted image and an unencrypted file over authenticated media", async () => {
    // A 1x1 PNG.
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
    const encrypted = await encryptAttachment(png);
    const upload = await bob.uploadContent(new Blob([encrypted.data], { type: "application/octet-stream" }), { type: "application/octet-stream", name: "encrypted" });
    await bob.sendMessage(dm, { msgtype: "m.image", body: "dot.png", file: { ...encrypted.info, url: upload.content_uri }, info: { mimetype: "image/png", size: png.length, w: 1, h: 1 } } as never);

    const text = new TextEncoder().encode("plain file contents\n");
    const plainUpload = await bob.uploadContent(new Blob([text], { type: "text/plain" }), { type: "text/plain", name: "notes.txt" });
    await bob.sendMessage(lobby, { msgtype: "m.file", body: "notes.txt", url: plainUpload.content_uri, info: { mimetype: "text/plain", size: text.length } } as never);

    const attachment = (name: string) => mc.messages().find((m) => m.attachments[0]?.name === name)?.attachments[0];
    await mc.adapter.openConversation(dm);
    const imageKey = await until(() => attachment("dot.png")?.mediaKey, "the encrypted image in Multicord");
    await mc.act({ type: "loadMedia", key: imageKey });
    const image = await until(() => (attachment("dot.png")?.url ? attachment("dot.png") : undefined), "the image to load");
    expect(image).toMatchObject({ kind: "image", mime: "image/png", url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` });

    const item = mc.chat()!.sidebar.find((i) => i.name === `Lobby ${run}`)!;
    await mc.act({ type: "select", channelId: item.id });
    const fileKey = await until(() => attachment("notes.txt")?.mediaKey, "the file in Multicord");
    await mc.act({ type: "loadMedia", key: fileKey });
    const file = await until(() => (attachment("notes.txt")?.url ? attachment("notes.txt") : undefined), `the file to load (${JSON.stringify(attachment("notes.txt"))})`);
    expect(file.url).toBe(`data:text/plain;base64,${Buffer.from(text).toString("base64")}`);
  });

  it("reacts, shows typing and sends files, encrypted in the DM and plain in the lobby, as Element reads them", async () => {
    await mc.adapter.openConversation(dm);
    const { event_id: target } = await bob.sendTextMessage(dm, "react here");
    const message = await until(() => mc.messages().find((m) => m.content === "react here"), "Multicord to show the message to react to");

    // Reactions: Element's (unencrypted, as Element sends them) in Multicord, Multicord's in Element, and taking one back.
    await bob.sendEvent(dm, EventType.Reaction, { "m.relates_to": { rel_type: "m.annotation", event_id: target, key: "👍" } } as never);
    await until(() => mc.messages().find((m) => m.id === message.id)?.reactions.some((r) => r.key === "👍" && r.count === 1 && !r.me), "Multicord to show Element's reaction");
    const reactions = () =>
      bob
        .getRoom(dm)
        ?.relations.getChildEventsForEvent(target, "m.annotation", "m.reaction")
        ?.getRelations()
        .filter((e) => !e.isRedacted() && e.getSender() === aliceId)
        .map((e) => e.getRelation()?.key);
    await mc.act({ type: "react", messageId: message.id, emoji: "🎉", add: true });
    await until(() => reactions()?.includes("🎉"), "Element to see Multicord's reaction");
    await mc.act({ type: "react", messageId: message.id, emoji: "🎉", add: false });
    await until(() => reactions()?.length === 0, "Element to see Multicord take its reaction back");
    expect(mc.messages().find((m) => m.id === message.id)!.reactions).toEqual([{ key: "👍", label: "👍", count: 1, me: false }]);

    // Typing, both ways; sending ends Multicord's.
    await bob.sendTyping(dm, true, 30_000);
    await until(() => mc.chat()?.channel?.typing.includes(BOB), "Multicord to show Element typing");
    await bob.sendTyping(dm, false, 30_000);
    await until(() => mc.chat()?.channel?.typing.length === 0, "Multicord to stop showing Element typing");
    const typing = () => bob.getRoom(dm)?.getMember(aliceId)?.typing;
    await mc.act({ type: "typing" });
    await until(() => typing() === true, "Element to show Multicord typing");

    // A picture into the encrypted DM: ciphertext on the server, the key in the encrypted event.
    expect(await mc.api.uploadLimit(mc.session)).toBeGreaterThan(0);
    const png = solidPng(8, 6, [20, 120, 220]);
    mc.picks.push([{ filename: "blue.png", size: png.length, contentType: "image/png", read: async (start, end) => png.slice(start, end) }]);
    await mc.act({ type: "attach" });
    await mc.act({ type: "send", content: "a blue picture" });
    await until(() => typing() === false, "Element to see Multicord stop typing");
    const sent = await elementSees(bob, dm, (e) => e.getSender() === aliceId && e.getContent().body === "blue.png", "Element to decrypt Multicord's picture");
    expect(sent.getWireType()).toBe("m.room.encrypted");
    const content = sent.getContent();
    expect(content).toMatchObject({ msgtype: "m.image", info: { mimetype: "image/png", size: png.length } });
    expect(content.url).toBeUndefined();
    const download = async (mxc: string) => {
      const response = await fetch(`${HTTP}/_matrix/client/v1/media/download/${mxc.slice("mxc://".length)}`, { headers: { Authorization: `Bearer ${bob.getAccessToken()}` } });
      expect(response.status).toBe(200);
      return Buffer.from(await response.arrayBuffer());
    };
    const ciphertext = await download(content.file.url);
    expect(createHash("sha256").update(ciphertext).digest("base64").replace(/=+$/, "")).toBe(content.file.hashes.sha256);
    const decipher = createDecipheriv("aes-256-ctr", Buffer.from(content.file.key.k, "base64url"), Buffer.from(content.file.iv, "base64"));
    expect(Buffer.concat([decipher.update(ciphertext), decipher.final()]).equals(Buffer.from(png))).toBe(true);
    await elementSees(bob, dm, (e) => e.getSender() === aliceId && e.getContent().body === "a blue picture", "Element to see the text after the picture");
    expect(mc.messages().find((m) => m.attachments[0]?.name === "blue.png")!.attachments[0]!.url).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);

    // A file into the unencrypted lobby: in the clear, with its name.
    const notes = new TextEncoder().encode("lobby notes\n");
    const lobbyItem = mc.chat()!.sidebar.find((i) => i.name === `Lobby ${run}`)!;
    await mc.act({ type: "select", channelId: lobbyItem.id });
    mc.picks.push([{ filename: "lobby.txt", size: notes.length, contentType: "text/plain", read: async (start, end) => notes.slice(start, end) }]);
    await mc.act({ type: "attach" });
    await mc.act({ type: "send", content: "" });
    const file = await elementSees(bob, lobby, (e) => e.getSender() === aliceId && e.getContent().body === "lobby.txt", "Element to see Multicord's file");
    expect(file.getContent()).toMatchObject({ msgtype: "m.file", info: { mimetype: "text/plain", size: notes.length } });
    expect((await download(file.getContent().url)).toString()).toBe("lobby notes\n");
    expect(mc.chat()?.error).toBeUndefined();
  });

  it("replies, edits and deletes, both ways, and moves the read marker", async () => {
    await mc.adapter.openConversation(dm);
    const fromBob = mc.messages().find((m) => m.content.includes("hello from Element"))!;

    // A reply from Multicord, as Element reads it.
    await mc.act({ type: "send", content: "a reply", replyTo: fromBob.id });
    const bobOriginal = await elementSees(bob, dm, (e) => e.getSender() === bobId && e.getContent().body === "hello from Element", "Bob's own message");
    const reply = await elementSees(bob, dm, (e) => e.getSender() === aliceId && e.getContent().body === "a reply", "Element to see the reply");
    expect(reply.getContent()["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: bobOriginal.getId() } });
    expect(await until(() => mc.messages().find((m) => m.content.includes("a reply"))?.reply, "Multicord's reply preview")).toMatchObject({ author: BOB });

    // An edit from Multicord.
    const mine = await until(() => mc.messages().find((m) => m.content === "a reply" && m.canEdit), "the reply to be editable");
    await mc.act({ type: "edit", messageId: mine.id, content: "an edited reply" });
    const edit = await elementSees(bob, dm, (e) => e.getSender() === aliceId && e.getContent()["m.new_content"]?.body === "an edited reply", "Element to see the edit");
    expect(edit.getContent()["m.relates_to"]).toMatchObject({ rel_type: "m.replace", event_id: reply.getId() });
    await until(() => mc.messages().find((m) => m.id === mine.id && m.edited && m.content.includes("an edited reply")), "Multicord to show its edit");

    // A deletion from Multicord.
    await mc.act({ type: "delete", messageId: mine.id });
    await until(() => bob.getRoom(dm)?.findEventById(reply.getId()!)?.isRedacted(), "Element to see the deletion");
    await until(() => !mc.messages().some((m) => m.id === mine.id), "Multicord to drop its deleted message");

    // Bob edits, then deletes his message; Multicord follows.
    await bob.sendMessage(dm, { msgtype: "m.text", body: "* hello again", "m.new_content": { msgtype: "m.text", body: "hello again" }, "m.relates_to": { rel_type: "m.replace", event_id: bobOriginal.getId()! } } as never);
    await until(() => mc.messages().find((m) => m.id === fromBob.id && m.edited && m.content.includes("hello again")), "Multicord to show Bob's edit");
    await bob.redactEvent(dm, bobOriginal.getId()!);
    await until(() => !mc.messages().some((m) => m.id === fromBob.id), "Multicord to drop Bob's deleted message");

    // Bob writes; Multicord, showing the room, marks it read up to there.
    mc.adapter.setVisible(true);
    const sent = await bob.sendTextMessage(dm, "read me");
    await until(() => mc.messages().find((m) => m.content.includes("read me")), "Multicord to show the new message");
    await until(async () => (await mc.raw("GET", `/v3/user/${encodeURIComponent(aliceId)}/rooms/${encodeURIComponent(dm)}/account_data/m.fully_read`).catch((): Record<string, any> => ({}))).event_id === sent.event_id, "the read marker on Bob's message");
    await until(() => bob.getRoom(dm)?.getEventReadUpTo(aliceId) === sent.event_id, "Element to see alice's read receipt");
  });

  it("pages back through encrypted history after a gap, missing nothing", async () => {
    await mc.adapter.openConversation(dm);
    // More than a sync's timeline (20) and a history page (50) hold, sent faster than Multicord syncs.
    const count = 60;
    for (let i = 0; i < count; i++) await bob.sendTextMessage(dm, `numbered ${i}`);
    await until(() => mc.messages().find((m) => m.content.includes(`numbered ${count - 1}`)), "the newest numbered message");
    const numbers = () => mc.messages().flatMap((m) => /numbered (\d+)/.exec(m.content)?.[1] ?? []).map(Number);
    for (let pages = 0; !numbers().includes(0) && pages < 5; pages++) {
      expect(mc.chat()!.channel!.hasOlder).toBe(true);
      await mc.act({ type: "loadOlder" });
    }
    expect(numbers()).toEqual([...Array(count).keys()]);
    expect(mc.messages().filter((m) => /numbered/.test(m.content)).every((m) => m.author === `${BOB} · unverified device`)).toBe(true);
  });

  it("shows the other person's profile picture on the DM (authenticated thumbnails)", async () => {
    const png = solidPng(96, 96, [200, 40, 40]);
    const upload = await bob.uploadContent(new Blob([png], { type: "image/png" }), { type: "image/png", name: "avatar.png" });
    await bob.setAvatarUrl(upload.content_uri);
    const direct = await until(async () => (await mc.adapter.listDirectConversations()).find((c) => c.key === dm && c.avatarUrl), "the DM's picture");
    expect(direct.avatarUrl).toMatch(/^data:image\/(png|jpeg|webp);base64,/);
  });

  it("sends a delayed state event (MSC4140), as for a call's leave, and restarts and sends it", async () => {
    expect(await mc.api.supports(mc.session, "org.matrix.msc4140")).toBe(true);
    // Synapse has no MSC4143 transports endpoint by default: no call services from it.
    expect(await mc.api.rtcTransports(mc.session)).toEqual([]);
    const type = "org.example.live_test";
    const delayId = await mc.api.sendDelayedState(mc.session, vault, type, aliceId, { left: true }, 60_000);
    await mc.api.updateDelayed(mc.session, delayId, "restart");
    const state = () => mc.raw("GET", `/v3/rooms/${encodeURIComponent(vault)}/state/${type}/${encodeURIComponent(aliceId)}`).catch(() => undefined);
    expect(await state()).toBeUndefined();
    await mc.api.updateDelayed(mc.session, delayId, "send");
    expect(await until(state, "the delayed state to be sent")).toEqual({ left: true });
  });

  it("verifies with the recovery key from Element and restores the key backup", async () => {
    // Before: the vault's message was sent before this device existed, so it cannot be read yet.
    const vaultItem = await until(() => mc.chat()?.sidebar.find((i) => i.name === `Vault ${run}`), "the vault room");
    await mc.act({ type: "select", channelId: vaultItem.id });
    await until(() => mc.messages().length > 0, "the vault's message, still locked");
    expect(mc.messages().some((m) => m.content.includes("kept in the backup"))).toBe(false);
    const status =await until(async () => (await mc.e2ee().status()).verified === false && mc.chat()?.sidebar.find((i) => i.name === "🔑 Verify this device"), "the way to verify");
    await mc.act({ type: "select", channelId: status.id });
    await until(() => mc.prompt("recovery"), "the recovery screen");
    await mc.act({ type: "prompt", id: "recovery", values: { key: recoveryKey } });
    await until(async () => {
      const s = await mc.e2ee().status();
      return s.verified && s.backup;
    }, `Multicord to be verified with the backup (${mc.logs.join("; ")})`);
    // The vault's message, whose key only the backup has, now decrypts.
    const item = await until(() => mc.chat()?.sidebar.find((i) => i.name === `Vault ${run}`), "the vault room");
    await mc.act({ type: "select", channelId: item.id });
    await until(() => mc.messages().find((m) => m.content.includes("kept in the backup")), "Multicord to decrypt the backed-up message");
    // Element trusts Multicord's device through cross-signing.
    await until(async () => (await aliceElement.getCrypto()!.getDeviceVerificationStatus(aliceId, mc.session.deviceId))?.crossSigningVerified, "Element to see Multicord's device cross-signed");
  });

  it("signs out, which ends the device on the server", async () => {
    const { accessToken, deviceId } = mc.session;
    await mc.act({ type: "logout" });
    await until(() => mc.prompt("login"), "the sign-in screen again");
    expect(mc.adapter.accountStatus()).toEqual({ state: "signed-out" });
    const whoami = await fetch(`${HTTP}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(whoami.status).toBe(401);
    const devices = await aliceElement.getDevices();
    expect(devices.devices.some((d) => d.device_id === deviceId)).toBe(false);
  });

  it("verifies a new device by comparing emoji with Element, then gets the backup key from it", async () => {
    mc = await multicord(ALICE, PASSWORD);
    const received = new Promise<VerificationRequest>((resolve) => aliceElement.on(CryptoEvent.VerificationRequestReceived, resolve));
    const entry = await until(() => mc.chat()?.sidebar.find((i) => i.name === "📱 Verify with another device"), "the way to verify with another device");
    await mc.act({ type: "select", channelId: entry.id });
    const request = await received;
    expect(request.otherDeviceId).toBe(mc.session.deviceId);
    await request.accept();
    await until(() => request.phase >= VerificationPhase.Ready, "the request to be accepted");
    const verifier = request.verifier ?? (await until(() => request.verifier, "Multicord to start the emoji comparison"));
    const shown = new Promise<ShowSasCallbacks>((resolve) => verifier.once(VerifierEvent.ShowSas, resolve));
    const verified = verifier.verify();
    const sas = await shown;
    const emoji = sas.sas.emoji!;
    const screen = await until(() => mc.prompt("verify-emoji"), "Multicord's emoji");
    expect(screen.prompt.title).toBe(emoji.map(([symbol]) => symbol).join("  "));
    await sas.confirm();
    await mc.act({ type: "prompt", id: "verify-emoji", values: {} });
    await verified;
    await until(() => mc.prompt("verify-done"), "Multicord's done screen");
    expect(request.phase).toBe(VerificationPhase.Done);
    await until(async () => (await aliceElement.getCrypto()!.getDeviceVerificationStatus(aliceId, mc.session.deviceId))?.crossSigningVerified, "Element to trust Multicord's device");
    await until(async () => {
      const s = await mc.e2ee().status();
      return s.verified && s.backup;
    }, `Multicord to be verified, with the backup key from Element (${mc.logs.join("; ")})`);
    await mc.act({ type: "cancelPrompt", id: "verify-done" });
    const item = await until(() => mc.chat()?.sidebar.find((i) => i.name === `Vault ${run}`), "the vault room");
    await mc.act({ type: "select", channelId: item.id });
    await until(() => mc.messages().find((m) => m.content.includes("kept in the backup")), "the backed-up message on the new device");
    await mc.act({ type: "logout" });
    await until(() => mc.prompt("login"), "the sign-in screen again");
  });
});
