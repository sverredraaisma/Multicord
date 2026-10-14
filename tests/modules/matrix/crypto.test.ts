import { BackupDecryptionKey, DecryptionErrorCode, DeviceId, initAsync, MegolmDecryptionError, OlmMachine, ProcessedToDeviceEventType, RequestType, RoomMessageRequest, ShieldColor, UserId } from "@matrix-org/matrix-sdk-crypto-wasm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MxEncryptedEvent } from "../../../src/modules/matrix/api";
import { decryptBackedUpKey, decryptionProblem, deleteCryptoStore, MatrixE2ee, openE2ee, STORE_SUFFIXES, type CryptoHttp } from "../../../src/modules/matrix/crypto";
import { decodeRecoveryKey, encodeRecoveryKey, encryptBytes, encryptSecret, keyFromPassphrase, SECRET_STORAGE_ALGORITHM } from "../../../src/modules/matrix/recovery";
import { parseEvent } from "../../../src/modules/matrix/events";
import { FakeHomeserver } from "./fakeHomeserver";

const ALICE = "@alice:x.org";
const BOB = "@bob:x.org";
const ROOM = "!room:x.org";
const MEGOLM = { encryption: { algorithm: "m.megolm.v1.aes-sha2" } };

beforeAll(async () => {
  await initAsync();
});

async function device(server: FakeHomeserver, user: string, id: string): Promise<MatrixE2ee> {
  const log = vi.fn();
  const e2ee = await openE2ee({ userId: user, deviceId: id, http: server.http(user, id), accountData: server.account(user), log });
  await e2ee.receiveSync(server.sync(user, id));
  return e2ee;
}

let eventCount = 0;
/** The m.room.encrypted event the server would deliver for this content. */
function delivered(sender: string, content: Record<string, unknown>): MxEncryptedEvent {
  const raw = { type: "m.room.encrypted", content, event_id: `$e${++eventCount}`, sender, origin_server_ts: 1000 + eventCount, room_id: ROOM };
  return parseEvent(raw) as MxEncryptedEvent;
}

describe("encrypting between two devices", () => {
  it("shares the room key and decrypts on the other side", async () => {
    const server = new FakeHomeserver();
    const alice = await device(server, ALICE, "ALICEDEV");
    const bob = await device(server, BOB, "BOBDEV");
    const content = await alice.encrypt(ROOM, MEGOLM, [ALICE, BOB], "m.room.message", { msgtype: "m.text", body: "secret hello" });
    expect(content.algorithm).toBe("m.megolm.v1.aes-sha2");
    const event = delivered(ALICE, content);
    await bob.receiveSync(server.sync(BOB, "BOBDEV"));
    const clear = await bob.decrypt(ROOM, event);
    expect(clear).toMatchObject({ kind: "message", id: event.id, sender: ALICE, content: { text: "secret hello" } });
  });
});

type Machine = { machine: OlmMachine };
const machineOf = (e2ee: MatrixE2ee) => (e2ee as unknown as Machine).machine;
const SECRET_NAMES = ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing", "m.megolm_backup.v1"] as const;

/**
 * Alice's Element: cross-signing set up, a key backup, recovery in secret
 * storage under a recovery key, and one encrypted message in the backup.
 */
async function element(server: FakeHomeserver, options: { backup?: boolean; secrets?: readonly string[] } = {}) {
  const e2ee = await device(server, ALICE, "ELEMENT");
  const machine = machineOf(e2ee);
  const boot = await machine.bootstrapCrossSigning(true);
  const http = server.http(ALICE, "ELEMENT");
  await http("POST", "/v3/keys/device_signing/upload", JSON.parse(boot.uploadSigningKeysRequest.body));
  await http("POST", "/v3/keys/signatures/upload", JSON.parse(boot.uploadSignaturesRequest.body));
  const exported = (await machine.exportCrossSigningKeys())!;
  const backupKey = BackupDecryptionKey.createRandomKey();
  if (options.backup !== false) {
    server.backup = { version: "1", algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: { public_key: backupKey.megolmV1PublicKey.publicKeyBase64 }, rooms: {} };
    await machine.saveBackupDecryptionKey(backupKey, "1");
    await e2ee.loadBackup();
  }
  const content = await e2ee.encrypt(ROOM, MEGOLM, [ALICE], "m.room.message", { msgtype: "m.text", body: "from before" });
  await e2ee.flush();
  const recoveryKey = crypto.getRandomValues(new Uint8Array(32));
  const values: Record<string, string | undefined> = {
    "m.cross_signing.master": exported.masterKey,
    "m.cross_signing.self_signing": exported.self_signing_key,
    "m.cross_signing.user_signing": exported.userSigningKey,
    "m.megolm_backup.v1": backupKey.toBase64(),
  };
  server.setAccountData(ALICE, "m.secret_storage.default_key", { key: "KEY1" });
  const check = await encryptBytes(recoveryKey, "", new Uint8Array(32));
  server.setAccountData(ALICE, "m.secret_storage.key.KEY1", { algorithm: SECRET_STORAGE_ALGORITHM, iv: check.iv, mac: check.mac });
  for (const name of options.secrets ?? SECRET_NAMES) {
    server.setAccountData(ALICE, name, { encrypted: { KEY1: await encryptSecret(recoveryKey, name, values[name]!) } });
  }
  return { e2ee, machine, history: delivered(ALICE, content), recoveryKey: encodeRecoveryKey(recoveryKey), backupKey };
}

describe("recovery", () => {
  it("verifies this device and restores history from the key backup", async () => {
    const server = new FakeHomeserver();
    const old = await element(server);
    expect(Object.keys(server.backup!.rooms[ROOM].sessions)).toHaveLength(1);
    const multicord = await device(server, ALICE, "MULTI");
    expect(await multicord.status()).toEqual({ verified: false, backup: false });
    expect(await multicord.decrypt(ROOM, old.history)).toMatchObject({ kind: "encrypted", problem: expect.stringContaining("recovery key") });

    const keys = vi.fn();
    multicord.onKeys(keys);
    const result = await multicord.recover(old.recoveryKey);
    expect(result).toEqual({ verified: true, backup: true, imported: 1 });
    expect(keys).toHaveBeenCalledWith([old.history.sessionId]);
    expect(await multicord.decrypt(ROOM, old.history)).toMatchObject({ kind: "message", content: { text: "from before" } });

    // Element sees the new device as verified once it learns of the signature.
    await old.e2ee.receiveSync(server.sync(ALICE, "ELEMENT"));
    const seen = await old.machine.getDevice(new UserId(ALICE), new DeviceId("MULTI"));
    expect(seen?.isCrossSigningTrusted()).toBe(true);

    // New messages go to the backup too.
    await multicord.encrypt(ROOM, MEGOLM, [ALICE], "m.room.message", { msgtype: "m.text", body: "after" });
    await multicord.flush();
    expect(Object.keys(server.backup!.rooms[ROOM].sessions)).toHaveLength(2);
  });
});

/** A decryption error with the given code, as the library throws them. */
function decryptionError(code: DecryptionErrorCode, withheldCode?: string): MegolmDecryptionError {
  const error = Object.create(MegolmDecryptionError.prototype) as MegolmDecryptionError;
  Object.defineProperty(error, "code", { value: code });
  Object.defineProperty(error, "withheldCode", { value: withheldCode });
  return error;
}

describe("decryption problems", () => {
  it("says why in a few words", () => {
    expect(decryptionProblem(new Error("x"), false)).toBe("the message is damaged");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.MissingRoomKey), false)).toContain("verify this device with your recovery key");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.MissingRoomKey), true)).toBe("the key is not in your key backup (yet)");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.UnknownMessageIndex), true)).toBe("this device only has the key for later messages");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.MismatchedIdentityKeys), true)).toBe("the sender's identity does not match");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.MismatchedSender), true)).toBe("the sender's identity does not match");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.UnknownSenderDevice), true)).toBe("the sender's device is not trusted");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.UnsignedSenderDevice), true)).toBe("the sender's device is not trusted");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.SenderIdentityVerificationViolation), true)).toBe("the sender's device is not trusted");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.UnableToDecrypt), true)).toBe("the message is damaged");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.MissingRoomKey, "m.unverified"), true)).toContain("only shares keys with verified devices");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.MissingRoomKey, "m.blacklisted"), true)).toBe("the sender has blocked this device");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.MissingRoomKey, "m.unauthorised"), true)).toBe("this device may not read it");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.MissingRoomKey, "m.no_olm"), true)).toBe("the sender could not reach this device");
    expect(decryptionProblem(decryptionError(DecryptionErrorCode.MissingRoomKey, "m.other"), true)).toBe("the sender withheld the key");
  });
});

describe("decrypting room events", () => {
  async function pair() {
    const server = new FakeHomeserver();
    const alice = await device(server, ALICE, "ALICEDEV");
    const bob = await device(server, BOB, "BOBDEV");
    const send = async (content: Record<string, unknown>, type = "m.room.message") => {
      const encrypted = await alice.encrypt(ROOM, MEGOLM, [ALICE, BOB], type, content);
      await bob.receiveSync(server.sync(BOB, "BOBDEV"));
      return delivered(ALICE, encrypted);
    };
    return { server, alice, bob, send };
  }

  it("keeps edits as edits, with the relation from the readable part", async () => {
    const { bob, send } = await pair();
    const event = await send({ msgtype: "m.text", body: "* fixed", "m.new_content": { msgtype: "m.text", body: "fixed" }, "m.relates_to": { rel_type: "m.replace", event_id: "$orig" } });
    expect(event.replaces).toBe("$orig");
    expect(await bob.decrypt(ROOM, event)).toMatchObject({ kind: "message", replaces: "$orig", content: { text: "fixed" } });
  });

  it("takes the relation from the readable part when the encrypted content has none", async () => {
    const { bob, send } = await pair();
    // As some clients send edits: the new content inside, the relation only outside.
    const event = await send({ msgtype: "m.text", body: "* x", "m.new_content": { msgtype: "m.text", body: "x" } });
    const raw = JSON.parse(event.raw!);
    raw.content["m.relates_to"] = { rel_type: "m.replace", event_id: "$orig" };
    // The library checks only the ciphertext, so the outer relation is what the reader sees.
    const edited = await bob.decrypt(ROOM, { ...event, raw: JSON.stringify(raw) });
    expect(edited).toMatchObject({ kind: "message", replaces: "$orig" });
  });

  it("hides event types that are not shown, and says when an event is too large", async () => {
    const { bob, send } = await pair();
    expect(await bob.decrypt(ROOM, await send({ "m.relates_to": { rel_type: "m.annotation", event_id: "$x", key: "👍" } }, "m.reaction"))).toBeUndefined();
    const event = await send({ msgtype: "m.text", body: "x" });
    expect(await bob.decrypt(ROOM, { ...event, raw: undefined })).toMatchObject({ kind: "encrypted", problem: "the message is too large" });
  });

  it("marks messages from devices their owner has not verified", async () => {
    const { bob, send } = await pair();
    const clear = await bob.decrypt(ROOM, await send({ msgtype: "m.text", body: "hi" }));
    // Alice has no cross-signing, so her device is not verified by her.
    expect(clear).toMatchObject({ kind: "message", unverified: expect.any(String) });
  });

  it("says why without the key, and when the cleartext is odd", async () => {
    const { bob, alice } = await pair();
    // Encrypted for Alice only: Bob never gets the key.
    const event = delivered(ALICE, await alice.encrypt(ROOM, MEGOLM, [ALICE], "m.room.message", { msgtype: "m.text", body: "x" }));
    expect(await bob.decrypt(ROOM, event)).toMatchObject({ kind: "encrypted", problem: expect.stringContaining("has not arrived") });
    const machine = machineOf(bob);
    vi.spyOn(machine, "decryptRoomEvent").mockResolvedValueOnce({ event: "[]" } as never);
    expect(await bob.decrypt(ROOM, event)).toMatchObject({ problem: "the message is damaged" });
  });

  it("encrypts with the room's history visibility and rotation, one share at a time", async () => {
    const { server, alice, bob } = await pair();
    const room = { encryption: { algorithm: "m.megolm.v1.aes-sha2", rotationMs: 3_600_000, rotationMsgs: 5 }, history: "joined" };
    const [a, b] = await Promise.all([
      alice.encrypt(ROOM, room, [ALICE, BOB, "not a user"], "m.room.message", { msgtype: "m.text", body: "one" }),
      alice.encrypt(ROOM, room, [ALICE, BOB], "m.room.message", { msgtype: "m.text", body: "two" }),
    ]);
    // The second waited for the first, so both use the same session.
    expect(a.session_id).toBe(b.session_id);
    await bob.receiveSync(server.sync(BOB, "BOBDEV"));
    expect(await bob.decrypt(ROOM, delivered(ALICE, b))).toMatchObject({ content: { text: "two" } });
    await expect(alice.encrypt(ROOM, { encryption: { algorithm: "m.olm.v1" } }, [ALICE], "m.room.message", {})).rejects.toThrow("does not support");
    await expect(alice.encrypt(ROOM, { encryption: { algorithm: "m.megolm.v1.aes-sha2" }, history: "odd" }, [ALICE], "m.room.message", {})).resolves.toMatchObject({ algorithm: "m.megolm.v1.aes-sha2" });
  });
});

describe("requests", () => {
  it("sends every request even when one fails, then reports the failure", async () => {
    const server = new FakeHomeserver();
    const e2ee = await openE2ee({ userId: ALICE, deviceId: "DEV", http: server.http(ALICE, "DEV"), accountData: server.account(ALICE) });
    server.failNext = { path: "/v3/keys/upload", error: new Error("offline") };
    await expect(e2ee.receiveSync(server.sync(ALICE, "DEV"))).rejects.toThrow("offline");
    // The query went out regardless; the upload goes again next time.
    expect(server.calls.map((c) => c.path)).toEqual(["/v3/keys/upload", "/v3/keys/query"]);
    await e2ee.receiveSync(server.sync(ALICE, "DEV"));
    expect(server.devices.get(ALICE)!.get("DEV")!.keys).toBeDefined();
  });

  it("runs one flush at a time, going again when asked meanwhile", async () => {
    const server = new FakeHomeserver();
    const e2ee = await openE2ee({ userId: ALICE, deviceId: "DEV", http: server.http(ALICE, "DEV"), accountData: server.account(ALICE) });
    const outgoing = vi.spyOn(machineOf(e2ee), "outgoingRequests");
    await Promise.all([e2ee.flush(), e2ee.flush(), e2ee.flush()]);
    expect(outgoing).toHaveBeenCalledTimes(2);
  });

  it("sends room messages and skips marking requests without an id", async () => {
    const server = new FakeHomeserver();
    const requests: string[] = [];
    const http: CryptoHttp = async (method, path) => {
      requests.push(`${method} ${path}`);
      return { event_id: "$x" };
    };
    const e2ee = await openE2ee({ userId: ALICE, deviceId: "DEV", http, accountData: server.account(ALICE) });
    const send = (e2ee as unknown as { send(r: unknown): Promise<void> }).send.bind(e2ee);
    const mark = vi.spyOn(machineOf(e2ee), "markRequestAsSent").mockResolvedValue(true);
    await send(new RoomMessageRequest("id1", ROOM, "txn1", "m.key.verification.ready", "{}"));
    expect(requests).toContain("PUT /v3/rooms/!room%3Ax.org/send/m.key.verification.ready/txn1");
    expect(mark).toHaveBeenCalledWith("id1", RequestType.RoomMessage, JSON.stringify({ event_id: "$x" }));
    mark.mockClear();
    await send({ type: RequestType.SignatureUpload, id: undefined, body: "{}" });
    expect(mark).not.toHaveBeenCalled();
    e2ee.close();
  });

  it("skips device list entries the library does not take as user ids", async () => {
    const server = new FakeHomeserver();
    const e2ee = await openE2ee({ userId: ALICE, deviceId: "DEV", http: server.http(ALICE, "DEV"), accountData: server.account(ALICE) });
    await e2ee.receiveSync({ toDevice: "[]", changed: ["@a:x.org", "@:"], left: ["nope"], oneTimeKeys: {} });
  });
});

describe("key stores", () => {
  it("deletes both of a store's databases", async () => {
    const names: string[] = [];
    const factory = {
      deleteDatabase(name: string) {
        names.push(name);
        const request: Record<string, (() => void) | null> = { onsuccess: null, onerror: null, onblocked: null };
        // One succeeds, one is blocked by an open connection: both count as done.
        const first = names.length === 1;
        queueMicrotask(() => (first ? request.onsuccess!() : request.onblocked!()));
        return request;
      },
    } as unknown as IDBFactory;
    await deleteCryptoStore("store1", factory);
    expect(names).toEqual(STORE_SUFFIXES.map((suffix) => `store1${suffix}`));
    await deleteCryptoStore("store1", undefined);
  });
});

describe("recovery failures", () => {
  it("needs recovery set up, in a supported way", async () => {
    const server = new FakeHomeserver();
    const multicord = await device(server, ALICE, "MULTI");
    await expect(multicord.recover("x")).rejects.toThrow("no recovery key yet");
    server.setAccountData(ALICE, "m.secret_storage.default_key", { key: "../evil" });
    await expect(multicord.recover("x")).rejects.toThrow("no recovery key yet");
    server.setAccountData(ALICE, "m.secret_storage.default_key", { key: "KEY1" });
    await expect(multicord.recover("x")).rejects.toThrow("does not support");
    server.setAccountData(ALICE, "m.secret_storage.key.KEY1", { algorithm: "m.secret_storage.v1.curve25519-aes-sha2" });
    await expect(multicord.recover("x")).rejects.toThrow("does not support");
  });

  it("tells a wrong recovery key from text that is not one", async () => {
    const server = new FakeHomeserver();
    const old = await element(server);
    const multicord = await device(server, ALICE, "MULTI");
    await expect(multicord.recover("not a key")).rejects.toThrow("That is not a recovery key");
    await expect(multicord.recover(encodeRecoveryKey(new Uint8Array(32).fill(9)))).rejects.toThrow("That recovery key is not right.");
    expect(await multicord.status()).toEqual({ verified: false, backup: false });
    await expect(multicord.recover(old.recoveryKey)).resolves.toMatchObject({ verified: true });
  });

  it("accepts the security phrase where recovery has one", async () => {
    const server = new FakeHomeserver();
    await element(server);
    const passphrase = { algorithm: "m.pbkdf2", salt: "saltysalt", iterations: 1000 };
    const key = await keyFromPassphrase("open sesame", passphrase);
    const check = await encryptBytes(key, "", new Uint8Array(32));
    server.setAccountData(ALICE, "m.secret_storage.key.KEY2", { algorithm: SECRET_STORAGE_ALGORITHM, iv: check.iv, mac: check.mac, passphrase });
    server.setAccountData(ALICE, "m.secret_storage.default_key", { key: "KEY2" });
    // Only the backup key is stored under the phrase's key; the cross-signing keys are not.
    const backup = BackupDecryptionKey.createRandomKey();
    server.backup = { version: "2", algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: { public_key: backup.megolmV1PublicKey.publicKeyBase64 }, rooms: {} };
    server.setAccountData(ALICE, "m.megolm_backup.v1", { encrypted: { KEY2: await encryptSecret(key, "m.megolm_backup.v1", backup.toBase64()) } });
    const multicord = await device(server, ALICE, "MULTI");
    await expect(multicord.recover("wrong phrase")).rejects.toThrow("That security phrase is not right.");
    // Without cross-signing secrets the device stays unverified, but the backup works.
    expect(await multicord.recover("open sesame")).toEqual({ verified: false, backup: true, imported: 0 });
  });

  it("refuses cross-signing keys that do not match the account", async () => {
    const server = new FakeHomeserver();
    const old = await element(server);
    // Someone resets cross-signing: the server's public keys no longer fit the stored secrets.
    const boot = await old.machine.bootstrapCrossSigning(true);
    await server.http(ALICE, "ELEMENT")("POST", "/v3/keys/device_signing/upload", JSON.parse(boot.uploadSigningKeysRequest.body));
    const multicord = await device(server, ALICE, "MULTI");
    await expect(multicord.recover(old.recoveryKey)).rejects.toThrow("do not match your account");
  });

  it("skips a missing or outdated backup, and secrets that are not keys", async () => {
    const server = new FakeHomeserver();
    const old = await element(server, { backup: false });
    const multicord = await device(server, ALICE, "MULTI");
    expect(await multicord.recover(old.recoveryKey)).toEqual({ verified: true, backup: false, imported: 0 });
    // A backup made after the stored key: the key is for an older one.
    server.backup = { version: "9", algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: { public_key: BackupDecryptionKey.createRandomKey().megolmV1PublicKey.publicKeyBase64 }, rooms: {} };
    expect(await multicord.recover(old.recoveryKey)).toMatchObject({ backup: false, imported: 0 });
    server.failNext = { path: "/v3/room_keys/version", error: new Error("offline") };
    await expect(multicord.recover(old.recoveryKey)).rejects.toThrow("offline");
    // A secret that decrypts to something other than a key is ignored, as is one stored for another key.
    const key = decodeRecoveryKey(old.recoveryKey)!;
    server.setAccountData(ALICE, "m.megolm_backup.v1", { encrypted: { KEY1: await encryptSecret(key, "m.megolm_backup.v1", "not a key") } });
    server.setAccountData(ALICE, "m.cross_signing.master", { encrypted: { OTHER: {} } });
    expect(await multicord.recover(old.recoveryKey)).toMatchObject({ imported: 0 });
  });
});

describe("the key backup", () => {
  it("looks a missing key up in the backup, once per session", async () => {
    const server = new FakeHomeserver();
    const old = await element(server);
    const multicord = await device(server, ALICE, "MULTI");
    await multicord.recover(old.recoveryKey);
    // A message whose key Multicord never got: only the backup has it.
    const later = delivered(ALICE, await old.e2ee.encrypt("!other:x.org", MEGOLM, [ALICE], "m.room.message", { msgtype: "m.text", body: "later" }));
    await old.e2ee.flush();
    expect(await multicord.decrypt("!other:x.org", later)).toMatchObject({ kind: "message", content: { text: "later" } });
    const lookups = () => server.calls.filter((c) => c.path.startsWith("/v3/room_keys/keys/")).length;
    expect(lookups()).toBe(1);

    const unknown = delivered(ALICE, await old.e2ee.encrypt("!third:x.org", MEGOLM, [ALICE], "m.room.message", { msgtype: "m.text", body: "x" }));
    expect(await multicord.decrypt("!third:x.org", unknown)).toMatchObject({ problem: "the key is not in your key backup (yet)" });
    expect(await multicord.decrypt("!third:x.org", unknown)).toMatchObject({ kind: "encrypted" });
    expect(lookups()).toBe(2);
  });

  it("logs failed lookups other than a missing key, and ignores unreadable backup data", async () => {
    const server = new FakeHomeserver();
    const old = await element(server);
    const log = vi.fn();
    const multicord = await openE2ee({ userId: ALICE, deviceId: "MULTI", http: server.http(ALICE, "MULTI"), accountData: server.account(ALICE), log });
    await multicord.receiveSync(server.sync(ALICE, "MULTI"));
    await multicord.recover(old.recoveryKey);
    const one = delivered(ALICE, await old.e2ee.encrypt("!a:x.org", MEGOLM, [ALICE], "m.room.message", { msgtype: "m.text", body: "1" }));
    server.failNext = { path: "/v3/room_keys/keys/", error: new Error("offline") };
    expect(await multicord.decrypt("!a:x.org", one)).toMatchObject({ kind: "encrypted" });
    expect(log).toHaveBeenCalledWith("Key backup lookup failed: offline");
    const two = delivered(ALICE, await old.e2ee.encrypt("!b:x.org", MEGOLM, [ALICE], "m.room.message", { msgtype: "m.text", body: "2" }));
    await old.e2ee.flush();
    server.backup!.rooms["!b:x.org"].sessions[two.sessionId!] = { session_data: { ephemeral: 1 } };
    expect(await multicord.decrypt("!b:x.org", two)).toMatchObject({ kind: "encrypted" });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("decrypts backed-up keys only when they are well formed", () => {
    const key = BackupDecryptionKey.createRandomKey();
    expect(decryptBackedUpKey(key, null)).toBeUndefined();
    expect(decryptBackedUpKey(key, { session_data: "x" })).toBeUndefined();
    expect(decryptBackedUpKey(key, { session_data: { ephemeral: "a", mac: "b", ciphertext: "x".repeat(70_000) } })).toBeUndefined();
    expect(decryptBackedUpKey(key, { session_data: { ephemeral: "a", mac: "b", ciphertext: "c" } })).toBeUndefined();
  });

  it("picks the backup up again on start, saving to it only while it is current", async () => {
    const server = new FakeHomeserver();
    const old = await element(server);
    const log = vi.fn();
    (old.e2ee as unknown as { options: { log?: (m: string) => void } }).options.log = log;
    server.failNext = { path: "/v3/room_keys/version", error: new Error("offline") };
    await old.e2ee.loadBackup();
    expect(log).toHaveBeenCalledWith("Key backup not checked: offline");
    server.backup!.auth_data.public_key = "other";
    await old.e2ee.loadBackup();
    expect((await old.e2ee.status()).backup).toBe(true);
  });
});

describe("crypto edge cases", () => {
  /** A decryption result as the library returns it. */
  const result = (event: unknown, shield: { color: ShieldColor; message?: string }) => ({ event: JSON.stringify(event), shieldState: () => shield }) as never;

  it("reads odd cleartext defensively and copies a missing relation", async () => {
    const server = new FakeHomeserver();
    const bob = await device(server, BOB, "BOBDEV");
    const machine = machineOf(bob);
    const outer = { type: "m.room.encrypted", event_id: "$o1", sender: ALICE, origin_server_ts: 1, content: { "m.relates_to": { rel_type: "m.replace", event_id: "$orig" } } };
    const event: MxEncryptedEvent = { kind: "encrypted", id: "$o1", sender: ALICE, ts: 1, raw: JSON.stringify(outer) };
    const spy = vi.spyOn(machine, "decryptRoomEvent");
    spy.mockResolvedValueOnce(result({ type: "m.room.message", content: { msgtype: "m.text", body: "* x", "m.new_content": { msgtype: "m.text", body: "x" } } }, { color: ShieldColor.None }));
    expect(await bob.decrypt(ROOM, event)).toEqual({ kind: "message", id: "$o1", sender: ALICE, ts: 1, content: { msgtype: "m.text", text: "x" }, mentions: undefined, replaces: "$orig" });
    spy.mockResolvedValueOnce(result({ type: "m.room.message" }, { color: ShieldColor.Red }));
    expect(await bob.decrypt(ROOM, { ...event, raw: JSON.stringify({ ...outer, content: "x" }) })).toMatchObject({ kind: "redacted" });
    spy.mockResolvedValueOnce(result({ type: "m.room.message", content: { msgtype: "m.text", body: "hi" } }, { color: ShieldColor.Grey }));
    expect(await bob.decrypt(ROOM, { ...event, raw: JSON.stringify({ ...outer, content: {} }) })).toMatchObject({ unverified: "unverified device" });
  });

  it("tries the backup for keys that start too late, and reports the second failure", async () => {
    const server = new FakeHomeserver();
    const bob = await device(server, BOB, "BOBDEV");
    const machine = machineOf(bob);
    const internals = bob as unknown as { fromBackup(room: string, session: string): Promise<boolean> };
    const fromBackup = vi.spyOn(internals, "fromBackup").mockResolvedValue(true);
    vi.spyOn(machine, "decryptRoomEvent").mockRejectedValueOnce(decryptionError(DecryptionErrorCode.UnknownMessageIndex)).mockRejectedValueOnce(decryptionError(DecryptionErrorCode.UnableToDecrypt));
    const event: MxEncryptedEvent = { kind: "encrypted", id: "$o1", sender: ALICE, ts: 1, raw: "{}", sessionId: "S" };
    expect(await bob.decrypt(ROOM, event)).toMatchObject({ problem: "the message is damaged" });
    expect(fromBackup).toHaveBeenCalledWith(ROOM, "S");
  });

  it("lets the next message through after a failed one", async () => {
    const server = new FakeHomeserver();
    const alice = await device(server, ALICE, "ALICEDEV");
    server.failNext = { path: "/v3/keys/query", error: new Error("offline") };
    const first = alice.encrypt(ROOM, MEGOLM, [ALICE, BOB], "m.room.message", { msgtype: "m.text", body: "1" });
    const second = alice.encrypt(ROOM, MEGOLM, [ALICE], "m.room.message", { msgtype: "m.text", body: "2" });
    await expect(first).rejects.toThrow("offline");
    await expect(second).resolves.toMatchObject({ algorithm: "m.megolm.v1.aes-sha2" });
  });

  it("reads the status without a device record as unverified", async () => {
    const server = new FakeHomeserver();
    const alice = await device(server, ALICE, "ALICEDEV");
    vi.spyOn(machineOf(alice), "getDevice").mockResolvedValueOnce(undefined);
    expect(await alice.status()).toEqual({ verified: false, backup: false });
  });

  it("recovers without a user-signing key, skipping secrets that do not decrypt", async () => {
    const server = new FakeHomeserver();
    const old = await element(server, { secrets: ["m.cross_signing.master", "m.cross_signing.self_signing", "m.megolm_backup.v1"] });
    const key = decodeRecoveryKey(old.recoveryKey)!;
    // Not valid UTF-8 once decrypted; and one secret that is not even an object.
    server.setAccountData(ALICE, "m.cross_signing.user_signing", { encrypted: { KEY1: await encryptBytes(key, "m.cross_signing.user_signing", new Uint8Array([0xff, 0xfe])) } });
    const multicord = await device(server, ALICE, "MULTI");
    expect(await multicord.recover(old.recoveryKey)).toEqual({ verified: true, backup: true, imported: 1 });
    server.setAccountData(ALICE, "m.cross_signing.user_signing", { encrypted: "x" });
    expect(await multicord.recover(old.recoveryKey)).toMatchObject({ verified: true });
  });

  it("skips unusable rooms and keys in the backup, and failed imports", async () => {
    const server = new FakeHomeserver();
    const old = await element(server);
    const sessions = server.backup!.rooms[ROOM].sessions;
    const [sessionId, data] = Object.entries(sessions)[0]!;
    server.backup!.rooms = {
      bad: { sessions: { [sessionId]: data } },
      "!junk:x.org": "x",
      "!nosessions:x.org": {},
      "!empty:x.org": { sessions: { ["s".repeat(129)]: data, other: { session_data: {} } } },
      [ROOM]: { sessions },
    };
    const multicord = await device(server, ALICE, "MULTI");
    expect((await multicord.recover(old.recoveryKey)).imported).toBe(1);
    vi.spyOn(machineOf(multicord), "importBackedUpRoomKeys").mockRejectedValueOnce(new Error("store full"));
    expect((await multicord.recover(old.recoveryKey)).imported).toBe(0);
    server.backup!.rooms = "junk" as unknown as Record<string, never>;
    expect((await multicord.recover(old.recoveryKey)).imported).toBe(0);
  });

  it("only takes backed-up sessions that decrypt to objects", () => {
    const key = { decryptV1: () => "[1]" } as unknown as BackupDecryptionKey;
    expect(decryptBackedUpKey(key, { session_data: { ephemeral: "a", mac: "b", ciphertext: "c" } })).toBeUndefined();
  });

  it("logs failures that are not errors as text", async () => {
    const server = new FakeHomeserver();
    const old = await element(server);
    const log = vi.fn();
    (old.e2ee as unknown as { options: { log?: (m: string) => void } }).options.log = log;
    server.failNext = { path: "/v3/room_keys/version", error: "offline" as unknown as Error };
    await old.e2ee.loadBackup();
    expect(log).toHaveBeenCalledWith("Key backup not checked: offline");
  });
});

describe("encrypted to-device messages", () => {
  const TYPE = "io.element.call.encryption_keys";

  it("sends a message Olm-encrypted, and the other side learns which device sent it", async () => {
    const server = new FakeHomeserver();
    const alice = await device(server, ALICE, "ALICEDEV");
    const bob = await device(server, BOB, "BOBDEV");
    const received = vi.fn();
    bob.onToDevice(TYPE, received);
    await alice.sendToDevices(TYPE, [{ userId: BOB, deviceId: "BOBDEV" }, { userId: BOB, deviceId: "GONE" }, { userId: "not a user", deviceId: "X" }], { room_id: ROOM, n: 1 });
    // Only the encrypted copy went out, to the device that exists.
    const sent = server.calls.filter((c) => c.path.startsWith("/v3/sendToDevice/"));
    expect(sent.map((c) => c.path)).toEqual([expect.stringMatching(/^\/v3\/sendToDevice\/m\.room\.encrypted\//)]);
    await bob.receiveSync(server.sync(BOB, "BOBDEV"));
    expect(received).toHaveBeenCalledWith({ userId: ALICE, deviceId: "ALICEDEV", content: { room_id: ROOM, n: 1 } });

    // Bob knows Alice's device now; a second message names it at once.
    await alice.sendToDevices(TYPE, [{ userId: BOB, deviceId: "BOBDEV" }], { room_id: ROOM, n: 2 });
    await bob.receiveSync(server.sync(BOB, "BOBDEV"));
    expect(received).toHaveBeenLastCalledWith({ userId: ALICE, deviceId: "ALICEDEV", content: { room_id: ROOM, n: 2 } });
  });

  it("drops messages sent in the clear, of other types, or from a device it cannot find", async () => {
    const server = new FakeHomeserver();
    const alice = await device(server, ALICE, "ALICEDEV");
    const log = vi.fn();
    const bob = await openE2ee({ userId: BOB, deviceId: "BOBDEV", http: server.http(BOB, "BOBDEV"), accountData: server.account(BOB), log });
    await bob.receiveSync(server.sync(BOB, "BOBDEV"));
    const received = vi.fn();
    bob.onToDevice(TYPE, received);
    server.deliver(BOB, "BOBDEV", { type: TYPE, sender: ALICE, content: { room_id: ROOM } });
    await alice.sendToDevices("m.other", [{ userId: BOB, deviceId: "BOBDEV" }], { a: 1 });
    await bob.receiveSync(server.sync(BOB, "BOBDEV"));
    expect(received).not.toHaveBeenCalled();
  });

  /** A crypto state over a stand-in machine that decrypts one to-device event, naming no device. */
  function withDecrypted(rawEvent: string, devices: { deviceId: string; key?: string }[]) {
    const http = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
    const machine = {
      registerRoomKeyUpdatedCallback: vi.fn(),
      registerReceiveSecretCallback: vi.fn(),
      receiveSyncChanges: vi.fn(async () => [
        { type: ProcessedToDeviceEventType.Decrypted, rawEvent, encryptionInfo: { sender: new UserId(ALICE), senderDevice: undefined, senderCurve25519Key: "KEY-A" } },
      ]),
      outgoingRequests: vi.fn(async () => []),
      updateTrackedUsers: vi.fn(async () => {}),
      queryKeysForUsers: vi.fn(() => ({ id: undefined, type: RequestType.KeysQuery, body: "{}" })),
      getUserDevices: vi.fn(async () => ({
        devices: () => devices.map((d) => ({ deviceId: new DeviceId(d.deviceId), curve25519Key: d.key ? { toBase64: () => d.key } : undefined })),
      })),
    };
    const log = vi.fn();
    const e2ee = new MatrixE2ee(machine as unknown as OlmMachine, { userId: BOB, deviceId: "BOBDEV", http, accountData: async () => undefined, log });
    const received = vi.fn();
    e2ee.onToDevice(TYPE, received);
    const sync = { toDevice: "[]", changed: [], left: [], oneTimeKeys: {} };
    return { e2ee, machine, http, log, received, sync };
  }

  it("looks a sender's device up by its key when the library does not name it", async () => {
    const ctx = withDecrypted(JSON.stringify({ type: TYPE, sender: ALICE, content: { a: 1 } }), [{ deviceId: "OTHER" }, { deviceId: "ALICEDEV", key: "KEY-A" }]);
    await ctx.e2ee.receiveSync(ctx.sync);
    expect(ctx.http).toHaveBeenCalledWith("POST", "/v3/keys/query", {});
    expect(ctx.received).toHaveBeenCalledWith({ userId: ALICE, deviceId: "ALICEDEV", content: { a: 1 } });
  });

  it("drops a message from a device it cannot find, and malformed or unwanted ones", async () => {
    const unknown = withDecrypted(JSON.stringify({ type: TYPE, sender: ALICE, content: {} }), [{ deviceId: "ALICEDEV", key: "KEY-B" }]);
    await unknown.e2ee.receiveSync(unknown.sync);
    expect(unknown.received).not.toHaveBeenCalled();
    expect(unknown.log).toHaveBeenCalledWith(`Dropped ${TYPE} from an unknown device`);
    for (const raw of [JSON.stringify({ type: TYPE, content: "x" }), JSON.stringify({ content: {} }), "[]", JSON.stringify({ type: "m.other", content: {} })]) {
      const ctx = withDecrypted(raw, []);
      await ctx.e2ee.receiveSync(ctx.sync);
      expect(ctx.received).not.toHaveBeenCalled();
      expect(ctx.machine.getUserDevices).not.toHaveBeenCalled();
    }
  });

  it("skips devices it cannot encrypt for, and sends nothing when none is left", async () => {
    const server = new FakeHomeserver();
    const log = vi.fn();
    const alice = await openE2ee({ userId: ALICE, deviceId: "ALICEDEV", http: server.http(ALICE, "ALICEDEV"), accountData: server.account(ALICE), log });
    await alice.receiveSync(server.sync(ALICE, "ALICEDEV"));
    await device(server, BOB, "BOBDEV");
    // Bob's device has no one-time or fallback keys left: no Olm session can be made.
    const bob = server.devices.get(BOB)!.get("BOBDEV")!;
    bob.oneTimeKeys.clear();
    bob.fallbackKeys.clear();
    await alice.sendToDevices(TYPE, [{ userId: BOB, deviceId: "BOBDEV" }], { a: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Not sent to a device: /));
    expect(server.calls.some((c) => c.path.startsWith("/v3/sendToDevice/"))).toBe(false);
  });
});
