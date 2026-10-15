// Interop with matrix-js-sdk, the library Element Web is built on: a real
// MatrixClient with its Rust crypto talks to Multicord's Matrix code through
// one in-memory homeserver (interopServer.ts).

import { initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import { ClientEvent, createClient, MatrixEvent, SyncState, type MatrixClient } from "matrix-js-sdk";
import { CryptoEvent, VerificationPhase, VerifierEvent, type CryptoApi, type ShowSasCallbacks, type VerificationRequest } from "matrix-js-sdk/lib/crypto-api/index.js";
import { CallMembership, getCallNotificationExpiry, MatrixRTCSessionEvent, parseCallNotificationContent, RTC_SLOT_ENCRYPTION_PER_MEMBER } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MxSession } from "../../../src/modules/matrix/api";
import { MatrixAdapter } from "../../../src/modules/matrix/adapter";
import { createMatrixClient } from "../../../src/modules/matrix/client";
import { computeRtcIdentityRaw, isLeftMembershipContent } from "matrix-js-sdk/lib/matrixrtc/membershipData/index.js";
import { liveKitIdentity, membershipStateKey, rtcLeaveContent, rtcMembershipContent } from "../../../src/modules/matrix/calls";
import { openE2ee, type MatrixE2ee } from "../../../src/modules/matrix/crypto";
import { CALL_MEMBER_TYPE, parseCallMember, parseEvent, RTC_MEMBER_TYPE, rtcIdentity } from "../../../src/modules/matrix/events";
import type { IncomingCall } from "../../../src/shared/adapter";
import type { NativeViewState } from "../../../src/shared/native";
import { encryptAttachment } from "./attachments";
import { HS, InteropHomeserver, LIVEKIT_SERVICE, SFU } from "./interopServer";

const ALICE = "@alice:x.org";
const BOB = "@bob:x.org";
const ROOM = "!secret:x.org";
const MEGOLM = "m.megolm.v1.aes-sha2";

// matrix-js-sdk and its crypto log a lot to the console, through loggers made per client and room.
const quiet = ["log", "debug", "info", "warn", "trace"] as const;
const console0 = Object.fromEntries(quiet.map((name) => [name, console[name]]));
beforeAll(async () => {
  for (const name of quiet) console[name] = () => {};
  await initAsync();
});
afterAll(() => {
  for (const name of quiet) console[name] = console0[name]!;
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Waits for a condition, checking every few milliseconds. */
async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Element: a matrix-js-sdk client with its Rust crypto, in memory, synced once. */
async function element(server: InteropHomeserver, user: string, device: string, cryptoCallbacks = {}): Promise<MatrixClient> {
  const client = createClient({ baseUrl: HS, userId: user, deviceId: device, accessToken: server.register(user, device), fetchFn: server.fetch, cryptoCallbacks });
  await client.initRustCrypto({ useIndexedDB: false });
  const ready = new Promise<void>((resolve) => client.on(ClientEvent.Sync, (state) => state === SyncState.Prepared && resolve()));
  await client.startClient({ initialSyncLimit: 50 });
  await ready;
  cleanups.push(() => client.stopClient());
  return client;
}

/** Multicord's whole Matrix adapter, signed in as a device of its own, over its own HTTP client. */
async function multicord(server: InteropHomeserver, user: string, device: string) {
  const session: MxSession = { baseUrl: HS, accessToken: server.register(user, device), userId: user, deviceId: device, ownDevice: true };
  const secrets = new Map([["session", JSON.stringify(session)]]);
  const renders: NativeViewState[] = [];
  const logs: string[] = [];
  let e2ee: MatrixE2ee | undefined;
  const adapter = new MatrixAdapter({
    def: { id: "matrix-native", name: "Matrix", url: "https://x.org" },
    secrets: {
      load: async (k) => secrets.get(k),
      save: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    render: (state) => renders.push(state),
    api: createMatrixClient(server.fetch),
    // In memory: Node has no IndexedDB.
    crypto: { open: async (options) => (e2ee = await openE2ee({ ...options, store: undefined })), deleteStore: async () => {} },
    log: (message) => logs.push(message),
  });
  await adapter.start();
  const chat = () => {
    const state = renders.at(-1);
    return state?.screen === "chat" ? state : undefined;
  };
  await until(() => chat() && e2ee, "Multicord's first sync");
  cleanups.push(() => adapter.signOut());
  const open = async (name: string) => {
    const item = await until(() => chat()?.sidebar.find((i) => i.name === name), `the room ${name} in the sidebar`);
    await adapter.handleAction({ type: "select", channelId: item.id });
  };
  const messages = () => chat()?.channel?.messages ?? [];
  return { adapter, session, e2ee: e2ee!, renders, logs, chat, open, messages, act: (action: Parameters<MatrixAdapter["handleAction"]>[0]) => adapter.handleAction(action) };
}

function encryptedRoom(server: InteropHomeserver, members: string[]): void {
  server.createRoom(ROOM, members[0]!, members, [
    { type: "m.room.name", content: { name: "Secret" } },
    { type: "m.room.encryption", content: { algorithm: MEGOLM } },
    { type: "m.room.history_visibility", content: { history_visibility: "shared" } },
  ]);
}

/** The clear content of the newest event from `sender` in Element's timeline, once decrypted. */
async function elementSees(client: MatrixClient, sender: string, body: string): Promise<MatrixEvent> {
  return until(async () => {
    const events = client.getRoom(ROOM)?.getLiveTimeline().getEvents() ?? [];
    for (const event of events) {
      if (event.getSender() !== sender || !event.isEncrypted()) continue;
      await client.decryptEventIfNeeded(event);
      if (event.getContent().body === body) return event;
    }
    return undefined;
  }, `Element to decrypt "${body}"`);
}

describe("encrypted messages with Element (matrix-js-sdk)", { timeout: 30_000 }, () => {
  it("decrypts what Element sends, and Element decrypts what Multicord sends", async () => {
    const server = new InteropHomeserver();
    encryptedRoom(server, [BOB, ALICE]);
    const mc = await multicord(server, ALICE, "MULTI");
    const bob = await element(server, BOB, "ELEMENT");

    await bob.sendTextMessage(ROOM, "hello from Element");
    await mc.open("Secret");
    const shown = await until(() => mc.messages().find((m) => m.content.includes("hello from Element")), "Multicord to show Element's message");
    // Bob has not cross-signed his Element device, and Multicord says so.
    expect(shown.author).toBe("bob · unverified device");

    await mc.act({ type: "send", content: "hello from Multicord" });
    const event = await elementSees(bob, ALICE, "hello from Multicord");
    expect(event.getContent()).toMatchObject({ msgtype: "m.text", body: "hello from Multicord" });
    expect(event.getWireType()).toBe("m.room.encrypted");
    expect(event.isDecryptionFailure()).toBe(false);
    expect(server.unknown).toEqual([]);
  });
});

describe("reactions with Element (matrix-js-sdk)", { timeout: 30_000 }, () => {
  it("shows Element's reactions, and Element shows Multicord's until it takes them back", async () => {
    const server = new InteropHomeserver();
    encryptedRoom(server, [BOB, ALICE]);
    const mc = await multicord(server, ALICE, "MULTI");
    const bob = await element(server, BOB, "ELEMENT");
    const { event_id: target } = await bob.sendTextMessage(ROOM, "react to this");
    await mc.open("Secret");
    const message = await until(() => mc.messages().find((m) => m.content === "react to this"), "Multicord to show Element's message");

    // Element sends reactions unencrypted, even here.
    await bob.sendEvent(ROOM, "m.reaction" as never, { "m.relates_to": { rel_type: "m.annotation", event_id: target, key: "👍" } } as never);
    expect(server.sent.at(-1)!.event.type).toBe("m.reaction");
    await until(() => mc.messages().find((m) => m.id === message.id)?.reactions.length, "Multicord to show Element's reaction");
    expect(mc.messages().find((m) => m.id === message.id)!.reactions).toEqual([{ key: "👍", label: "👍", count: 1, me: false }]);

    const reactions = () =>
      bob
        .getRoom(ROOM)
        ?.relations.getChildEventsForEvent(target, "m.annotation", "m.reaction")
        ?.getSortedAnnotationsByKey()
        ?.map(([key, events]) => [key, [...events].filter((e) => !e.isRedacted()).map((e) => e.getSender())] as const);
    await mc.act({ type: "react", messageId: message.id, emoji: "👍", add: true });
    expect(await until(() => reactions()?.find(([key, senders]) => key === "👍" && senders.length === 2), "Element to count Multicord's reaction")).toEqual(["👍", [BOB, ALICE]]);
    await mc.act({ type: "react", messageId: message.id, emoji: "👍", add: false });
    await until(() => reactions()?.find(([key, senders]) => key === "👍" && senders.length === 1), "Element to drop Multicord's reaction");
    expect(mc.messages().find((m) => m.id === message.id)!.reactions).toEqual([{ key: "👍", label: "👍", count: 1, me: false }]);
    expect(server.unknown).toEqual([]);
  });
});

describe("encrypted attachments with Element (matrix-js-sdk)", { timeout: 30_000 }, () => {
  it("shows a picture Element sends into an encrypted room, and refuses one the server changed", async () => {
    const server = new InteropHomeserver();
    encryptedRoom(server, [BOB, ALICE]);
    const mc = await multicord(server, ALICE, "MULTI");
    const bob = await element(server, BOB, "ELEMENT");
    const picture = new TextEncoder().encode("not really a PNG, but encrypted like one");
    const sendPicture = async (name: string, data: Uint8Array<ArrayBuffer>, info: Record<string, unknown>) => {
      const content = { msgtype: "m.image", body: name, file: { ...info, url: server.storeMedia(data) }, info: { mimetype: "image/png", size: picture.length } };
      await bob.sendMessage(ROOM, content as never);
    };
    const good = await encryptAttachment(picture);
    await sendPicture("photo.png", good.data, good.info);
    const swapped = await encryptAttachment(picture);
    swapped.data[0]! ^= 1;
    await sendPicture("swapped.png", swapped.data, swapped.info);

    await mc.open("Secret");
    const file = (name: string) => mc.messages().find((m) => m.attachments[0]?.name === name)?.attachments[0];
    for (const name of ["photo.png", "swapped.png"]) {
      const key = (await until(() => file(name)?.mediaKey, `Multicord to show ${name}`))!;
      await mc.act({ type: "loadMedia", key });
    }
    expect(file("photo.png")!.url).toBe(`data:image/png;base64,${Buffer.from(picture).toString("base64")}`);
    expect(file("swapped.png")).toMatchObject({ unavailable: "it does not match its checksum, so it may have been changed" });
    expect(file("swapped.png")!.url).toBeUndefined();
    expect(server.unknown).toEqual([]);
  });
});

/**
 * Alice's Element sets up encryption as Element does ("Set up recovery"):
 * cross-signing, then secret storage under a new recovery key (from a
 * security phrase when given), with a new key backup.
 */
async function elementWithRecovery(server: InteropHomeserver, phrase?: string) {
  let secretKey: Uint8Array | undefined;
  const alice = await element(server, ALICE, "ELEMENT", {
    getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }) => [Object.keys(keys)[0]!, secretKey!] as [string, Uint8Array],
  });
  const crypto = alice.getCrypto()!;
  const recovery = await crypto.createRecoveryKeyFromPassphrase(phrase);
  secretKey = recovery.privateKey;
  await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async (makeRequest) => void (await makeRequest(null)) });
  await crypto.bootstrapSecretStorage({ createSecretStorageKey: async () => recovery, setupNewSecretStorage: true, setupNewKeyBackup: true });
  expect(await crypto.isCrossSigningReady()).toBe(true);
  expect(await crypto.getActiveSessionBackupVersion()).toBe(server.backup?.version);
  return { alice, crypto, recoveryKey: recovery.encodedPrivateKey! };
}

describe("recovery set up by Element (matrix-js-sdk)", { timeout: 30_000 }, () => {
  it("imports the cross-signing keys and restores the key backup with the recovery key", async () => {
    const server = new InteropHomeserver();
    encryptedRoom(server, [ALICE]);
    const { alice, crypto, recoveryKey } = await elementWithRecovery(server);
    await alice.sendTextMessage(ROOM, "from before Multicord");
    await until(() => Object.keys(server.backup?.rooms[ROOM]?.sessions ?? {}).length > 0, "Element to back the room key up");

    const mc = await multicord(server, ALICE, "MULTI");
    await mc.open("Secret");
    await until(() => mc.messages().length > 0, "the old message in Multicord");
    expect(await mc.e2ee.status()).toEqual({ verified: false, backup: false });
    expect(mc.messages().some((m) => m.content.includes("from before Multicord"))).toBe(false);

    const result = await mc.e2ee.recover(recoveryKey);
    expect(result).toEqual({ verified: true, backup: true, imported: 1 });
    await until(() => mc.messages().find((m) => m.content.includes("from before Multicord")), "Multicord to decrypt the backed-up message");

    // Element learns of the signature and trusts Multicord's device through cross-signing.
    const status = await until(async () => {
      const status = await crypto.getDeviceVerificationStatus(ALICE, "MULTI");
      return status?.crossSigningVerified && status;
    }, "Element to see Multicord's device cross-signed");
    expect(status.isVerified()).toBe(true);

    // Keys of Multicord's new messages go to Element's backup, which Element can read.
    await mc.act({ type: "send", content: "after recovery" });
    await elementSees(alice, ALICE, "after recovery");
    await until(() => Object.keys(server.backup!.rooms[ROOM].sessions).length > 1, "Multicord to back its room key up");
    expect(server.unknown).toEqual([]);
  });

  it("takes the security phrase Element's recovery was set up with", async () => {
    const server = new InteropHomeserver();
    encryptedRoom(server, [ALICE]);
    await elementWithRecovery(server, "correct horse battery staple");
    const mc = await multicord(server, ALICE, "MULTI");
    await expect(mc.e2ee.recover("wrong horse")).rejects.toThrow("That security phrase is not right.");
    expect(await mc.e2ee.recover("correct horse battery staple")).toMatchObject({ verified: true, backup: true });
  });
});

/** What Multicord's verification screen shows, once it is the given step. */
async function multicordPrompt(mc: Awaited<ReturnType<typeof multicord>>, id: string) {
  return until(() => {
    const state = mc.renders.at(-1);
    return state?.screen === "prompt" && state.prompt.id === id && !state.busy && state.prompt;
  }, `Multicord's ${id} screen`);
}

/** Element's side of an emoji comparison: shows the emoji, checks they are Multicord's, and says they match. */
async function elementCompares(request: VerificationRequest, mc: Awaited<ReturnType<typeof multicord>>, start: boolean): Promise<void> {
  await until(() => request.phase >= VerificationPhase.Ready, "the request to be accepted");
  // Element's user picks "Verify by emoji" once the other side accepted; Multicord may have started already.
  const verifier = request.verifier ?? (start ? await request.startVerification("m.sas.v1") : await until(() => request.verifier, "Multicord to start the emoji comparison"));
  const shown = new Promise<ShowSasCallbacks>((resolve) => verifier.once(VerifierEvent.ShowSas, resolve));
  const verified = verifier.verify();
  const sas = await shown;
  const emoji = sas.sas.emoji!;
  const screen = await multicordPrompt(mc, "verify-emoji");
  expect(screen.title).toBe(emoji.map(([symbol]) => symbol).join("  "));
  expect(screen.description).toContain(emoji.map(([, name]) => name).join(", "));
  await sas.confirm();
  await mc.act({ type: "prompt", id: "verify-emoji", values: {} });
  await verified;
}

/** Both sides end verified: Element trusts Multicord's device through cross-signing, and Multicord gets the backup key. */
async function bothVerified(crypto: CryptoApi, mc: Awaited<ReturnType<typeof multicord>>): Promise<void> {
  await multicordPrompt(mc, "verify-done");
  await until(async () => (await crypto.getDeviceVerificationStatus(ALICE, "MULTI"))?.crossSigningVerified, "Element to trust Multicord's device");
  await until(async () => {
    const status = await mc.e2ee.status();
    return status.verified && status.backup;
  }, "Multicord to be verified, with the backup key from Element");
}

describe("verifying with Element (matrix-js-sdk) by comparing emoji", { timeout: 30_000 }, () => {
  it("verifies when Multicord asks", async () => {
    const server = new InteropHomeserver();
    encryptedRoom(server, [ALICE]);
    const { alice, crypto } = await elementWithRecovery(server);
    const mc = await multicord(server, ALICE, "MULTI");
    const received = new Promise<VerificationRequest>((resolve) => alice.on(CryptoEvent.VerificationRequestReceived, resolve));

    const entry = await until(() => mc.chat()?.sidebar.find((i) => i.name === "📱 Verify with another device"), "the way to verify with another device");
    await mc.act({ type: "select", channelId: entry.id });
    const request = await received;
    expect(request.otherDeviceId).toBe("MULTI");
    await request.accept();
    await elementCompares(request, mc, false);
    await bothVerified(crypto, mc);
    expect(request.phase).toBe(VerificationPhase.Done);
  });

  it("verifies when Element asks, with both sides starting the emoji comparison", async () => {
    const server = new InteropHomeserver();
    encryptedRoom(server, [ALICE]);
    const { crypto } = await elementWithRecovery(server);
    const mc = await multicord(server, ALICE, "MULTI");

    const request = await crypto.requestOwnUserVerification();
    const entry = await until(() => mc.chat()?.sidebar.find((i) => i.name === "📱 Verification request"), "Element's request in Multicord's sidebar");
    await mc.act({ type: "select", channelId: entry.id });
    const incoming = await multicordPrompt(mc, "verify-incoming");
    expect(incoming.description).toContain("ELEMENT");
    await mc.act({ type: "prompt", id: "verify-incoming", values: {} });
    await elementCompares(request, mc, true);
    await bothVerified(crypto, mc);
  });
});

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

describe("calls with Element Call's MatrixRTC (matrix-js-sdk)", { timeout: 30_000 }, () => {
  it("is a member Element understands, and exchanges media keys with it both ways", async () => {
    const server = new InteropHomeserver();
    encryptedRoom(server, [BOB, ALICE]);
    const mc = await multicord(server, ALICE, "MULTI");
    const bob = await element(server, BOB, "ELEMENT");

    // Bob is in the room's call, as Element Call joins it.
    const session = bob.matrixRTC.getRoomSession(bob.getRoom(ROOM)!);
    const keys: { key: string; index: number; userId: string; deviceId: string; identity: string }[] = [];
    session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, (key, index, membership, identity) =>
      keys.push({ key: base64(key), index, userId: membership.userId, deviceId: membership.deviceId, identity }),
    );
    const transport = { type: "livekit", livekit_service_url: LIVEKIT_SERVICE, livekit_alias: ROOM };
    session.join({ userId: BOB, deviceId: "ELEMENT", memberId: `${BOB}:ELEMENT` }, [transport], { callIntent: "audio" });
    cleanups.push(async () => void (await session.leave(1000)));

    // Multicord reads Element's membership: Bob's device, on Element's call service.
    const elementState = await until(() => server.stateEvents(ROOM, CALL_MEMBER_TYPE).find((e) => e.sender === BOB && e.content.device_id), "Element's membership");
    expect(elementState.state_key).toBe(membershipStateKey(BOB, "ELEMENT"));
    expect(parseCallMember(elementState)).toMatchObject({ stateKey: membershipStateKey(BOB, "ELEMENT"), member: { user: BOB, deviceId: "ELEMENT", focus: LIVEKIT_SERVICE, intent: "audio" } });
    const entry = await until(() => mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.name === "Secret" && i.members?.length), "Bob's call under Calls");
    expect(entry.members).toMatchObject([{ name: "bob" }]);

    // Multicord joins; Element sees its membership with its focus.
    await mc.act({ type: "joinVoice", channelId: entry.id });
    const member = await until(() => session.memberships.find((m) => m.userId === ALICE), "Element to see Multicord in the call");
    expect(member.deviceId).toBe("MULTI");
    expect(member.slotId).toBe("m.call#ROOM");
    expect(member.callIntent).toBe("audio");
    expect(member.transports).toEqual([transport]);
    expect(member.getTransport()).toEqual(transport);
    expect(member.backendIdentities).toEqual([liveKitIdentity(ALICE, "MULTI")]);
    expect(member.memberId).toBe(liveKitIdentity(ALICE, "MULTI"));
    expect(member.isExpired()).toBe(false);
    expect(member.getAbsoluteExpiry()).toBeGreaterThan(Date.now() + 3 * 3600 * 1000);
    const ownState = server.stateEvents(ROOM, CALL_MEMBER_TYPE).find((e) => e.sender === ALICE)!;
    expect(ownState.state_key).toBe(membershipStateKey(ALICE, "MULTI"));
    expect(CallMembership.membershipDataFromMatrixEvent(new MatrixEvent(ownState)).kind).toBe("session");

    // Multicord's media key reaches Element's encryption manager, for Multicord's LiveKit identity.
    const voice = () => mc.chat()?.voice;
    const ownKey = await until(() => voice()?.e2ee?.keys.find((k) => k.participant === liveKitIdentity(ALICE, "MULTI")), "Multicord's own media key");
    const fromMulticord = await until(() => keys.find((k) => k.userId === ALICE), "Element to accept Multicord's media key");
    expect(fromMulticord).toEqual({ key: ownKey.key, index: ownKey.index, userId: ALICE, deviceId: "MULTI", identity: liveKitIdentity(ALICE, "MULTI") });

    // Element's media key reaches Multicord, for Bob's LiveKit identity.
    const elementKey = await until(() => keys.find((k) => k.userId === BOB), "Element's own media key");
    expect(elementKey.identity).toBe(liveKitIdentity(BOB, "ELEMENT"));
    const received = await until(() => voice()?.e2ee?.keys.find((k) => k.participant === liveKitIdentity(BOB, "ELEMENT")), "Multicord to accept Element's media key");
    expect(received).toEqual({ participant: liveKitIdentity(BOB, "ELEMENT"), index: elementKey.index, key: elementKey.key });
    expect(voice()).toMatchObject({ url: `${SFU}/`, token: "jwt.for.call" });

    // Leaving: Element sees Multicord go.
    await mc.act({ type: "leaveVoice" });
    await until(() => !session.memberships.some((m) => m.userId === ALICE), "Element to see Multicord leave");
  });
});

describe("the newer call membership (m.rtc.member) with matrix-js-sdk", () => {
  it("is a membership matrix-js-sdk reads, on the LiveKit identity both compute", async () => {
    const content = rtcMembershipContent({ userId: ALICE, deviceId: "MULTI", memberId: "uuid-m", focus: LIVEKIT_SERVICE, sfu: "wss://sfu.x.org", intent: "audio" });
    const raw = { type: RTC_MEMBER_TYPE, sender: ALICE, event_id: "$m", origin_server_ts: Date.now(), room_id: ROOM, content, msc4354_sticky: { duration_ms: 3_600_000 } };
    const member = await CallMembership.parseFromEvent(new MatrixEvent(raw));
    expect([member.deviceId, member.memberId, member.slotId, member.callIntent]).toEqual(["MULTI", "uuid-m", "m.call#ROOM", "audio"]);
    expect(member.backendIdentities).toEqual([rtcIdentity(ALICE, "uuid-m")]);
    expect(await computeRtcIdentityRaw(ALICE, "uuid-m")).toBe(rtcIdentity(ALICE, "uuid-m"));
    // And Multicord reads it back the same.
    expect(parseEvent(raw)).toMatchObject({ kind: "rtc", member: { identities: member.backendIdentities, memberId: "uuid-m", sfu: "wss://sfu.x.org" } });
    // A membership on the service is known by user:device on both sides.
    const viaService = { ...raw, content: rtcMembershipContent({ userId: ALICE, deviceId: "MULTI", memberId: "uuid-m", focus: LIVEKIT_SERVICE, intent: "audio" }) };
    expect((await CallMembership.parseFromEvent(new MatrixEvent(viaService))).backendIdentities).toEqual([liveKitIdentity(ALICE, "MULTI")]);
    expect(parseEvent(viaService)).toMatchObject({ member: { identities: [liveKitIdentity(ALICE, "MULTI")] } });
    // The leave is one matrix-js-sdk takes as such.
    expect(isLeftMembershipContent(rtcLeaveContent("uuid-m"))).toBe(true);
  });
});

/** An encrypted DM between Alice and Bob, as Element makes them: both may notify the room. */
function dmRoom(server: InteropHomeserver): void {
  server.createRoom(ROOM, ALICE, [ALICE, BOB], [
    { type: "m.room.power_levels", content: { users: { [ALICE]: 100, [BOB]: 100 }, users_default: 0, events_default: 0, state_default: 50, notifications: { room: 50 } } },
    { type: "m.room.encryption", content: { algorithm: MEGOLM } },
  ]);
  server.setAccountData(ALICE, "m.direct", { [BOB]: [ROOM] });
}

describe("ringing for a call in a DM, with Element (matrix-js-sdk)", { timeout: 30_000 }, () => {
  it("sends a ring Element accepts", async () => {
    const server = new InteropHomeserver();
    dmRoom(server);
    const mc = await multicord(server, ALICE, "MULTI");
    const bob = await element(server, BOB, "ELEMENT");

    await mc.open("bob");
    const start = await until(() => mc.chat()?.sidebar.find((i) => i.kind === "voice" && i.name.startsWith("Start a call")), "the way to start a call");
    await mc.act({ type: "joinVoice", channelId: start.id });
    const room = bob.getRoom(ROOM)!;
    const ring = await until(() => room.getLiveTimeline().getEvents().find((e) => e.getType() === "org.matrix.msc4075.rtc.notification"), "Element to get the ring");
    const parsed = await parseCallNotificationContent(ring, { room, userId: BOB });
    expect(parsed).toMatchObject({ notification_type: "ring", slot_id: "m.call#ROOM", "m.call.intent": "audio" });
    expect(getCallNotificationExpiry(parsed, ring.getTs())).toBeGreaterThan(Date.now());
    // The slot Multicord opened says the call's media is encrypted per device.
    const session = bob.matrixRTC.getRoomSession(room);
    expect(session.isSlotOpen()).toBe(true);
    expect(session.getRtcSlot()).toEqual({ status: "open", application: { type: "m.call" }, encryption: { type: RTC_SLOT_ENCRYPTION_PER_MEMBER } });
  });

  it("rings when Element starts a call in the DM", async () => {
    const server = new InteropHomeserver();
    dmRoom(server);
    const mc = await multicord(server, ALICE, "MULTI");
    const calls: IncomingCall[] = [];
    mc.adapter.onIncomingCall((call) => calls.push(call));
    const bob = await element(server, BOB, "ELEMENT");

    const session = bob.matrixRTC.getRoomSession(bob.getRoom(ROOM)!);
    await session.ensureRtcSlotOpen({ encryption: { type: RTC_SLOT_ENCRYPTION_PER_MEMBER } });
    session.join({ userId: BOB, deviceId: "ELEMENT", memberId: `${BOB}:ELEMENT` }, [{ type: "livekit", livekit_service_url: LIVEKIT_SERVICE, livekit_alias: ROOM }], { callIntent: "video", notificationType: "ring" });
    cleanups.push(async () => void (await session.leave(1000)));
    await until(() => calls.length > 0, "Multicord to ring");
    expect(calls).toEqual([{ conversationKey: ROOM, from: "bob", video: true }]);
  });
});
