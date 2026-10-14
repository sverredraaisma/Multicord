import { BackupDecryptionKey, DeviceId, initAsync, OlmMachine, UserId, VerificationRequestPhase, type VerificationRequest } from "@matrix-org/matrix-sdk-crypto-wasm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openE2ee, type MatrixE2ee } from "../../../src/modules/matrix/crypto";
import { cancelReason, SasFlow, type Verification } from "../../../src/modules/matrix/verification";
import { FakeHomeserver } from "./fakeHomeserver";

const ALICE = "@alice:x.org";
const ROOM = "!room:x.org";
const MEGOLM = { encryption: { algorithm: "m.megolm.v1.aes-sha2" } };
const LATER = 11 * 60 * 1000;

afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  await initAsync();
});

async function device(server: FakeHomeserver, user: string, id: string): Promise<MatrixE2ee> {
  const e2ee = await openE2ee({ userId: user, deviceId: id, http: server.http(user, id), accountData: server.account(user), log: vi.fn() });
  await e2ee.receiveSync(server.sync(user, id));
  return e2ee;
}

/** Alice's Element: cross-signing set up and signed, optionally a key backup with one message in it. */
async function element(server: FakeHomeserver, backup = true) {
  const e2ee = await device(server, ALICE, "ELEMENT");
  const machine = (e2ee as unknown as { machine: import("@matrix-org/matrix-sdk-crypto-wasm").OlmMachine }).machine;
  const boot = await machine.bootstrapCrossSigning(true);
  const http = server.http(ALICE, "ELEMENT");
  await http("POST", "/v3/keys/device_signing/upload", JSON.parse(boot.uploadSigningKeysRequest.body));
  await http("POST", "/v3/keys/signatures/upload", JSON.parse(boot.uploadSignaturesRequest.body));
  if (backup) {
    const key = BackupDecryptionKey.createRandomKey();
    server.backup = { version: "1", algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: { public_key: key.megolmV1PublicKey.publicKeyBase64 }, rooms: {} };
    await machine.saveBackupDecryptionKey(key, "1");
    await e2ee.loadBackup();
    await e2ee.encrypt(ROOM, MEGOLM, [ALICE], "m.room.message", { msgtype: "m.text", body: "from before" });
    await e2ee.flush();
  }
  return { e2ee, machine };
}

/** Lets both devices sync until nothing more goes between them. */
async function exchange(server: FakeHomeserver, devices: [MatrixE2ee, string][], rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const [e2ee, id] of devices) await e2ee.receiveSync(server.sync(ALICE, id));
    // Change callbacks run after the library returns.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("verifying with another device by comparing emoji", () => {
  it("verifies Multicord from Element, then restores the key backup the other device sends", async () => {
    const server = new FakeHomeserver();
    const old = await element(server);
    const multicord = await device(server, ALICE, "MULTI");
    const devices: [MatrixE2ee, string][] = [
      [old.e2ee, "ELEMENT"],
      [multicord, "MULTI"],
    ];
    await exchange(server, devices, 2);
    expect(await multicord.status()).toEqual({ verified: false, backup: false });

    const incoming: Verification[] = [];
    old.e2ee.onVerification((v) => incoming.push(v));
    const status = vi.fn();
    multicord.onStatus(status);
    const keys = vi.fn();
    multicord.onKeys(keys);

    const ours = await multicord.requestVerification();
    expect(ours.outgoing).toBe(true);
    expect(ours.state()).toEqual({ phase: "waiting", device: "your other device" });
    await exchange(server, devices, 1);
    expect(incoming).toHaveLength(1);
    const theirs = incoming[0]!;
    expect(theirs.outgoing).toBe(false);
    expect(theirs.state()).toEqual({ phase: "incoming", device: "MULTI" });

    await theirs.accept();
    await exchange(server, devices);
    const shown = ours.state();
    expect(shown.phase).toBe("emoji");
    const emoji = shown.phase === "emoji" ? shown.emoji : [];
    expect(emoji).toHaveLength(7);
    expect(theirs.state()).toEqual({ phase: "emoji", emoji });

    await ours.confirm();
    expect(ours.state()).toEqual({ phase: "confirmed" });
    await theirs.confirm();
    await exchange(server, devices);
    expect(ours.state()).toEqual({ phase: "done" });
    expect(theirs.state()).toEqual({ phase: "done" });

    // Element signed Multicord's device; the backup key came over too, and older messages decrypt.
    await vi.waitFor(async () => expect(await multicord.status()).toEqual({ verified: true, backup: true }), { timeout: 5000 });
    expect(status).toHaveBeenCalled();
    expect(keys).toHaveBeenCalled();
    const seen = await old.machine.getDevice(new UserId(ALICE), new DeviceId("MULTI"));
    expect(seen?.isCrossSigningTrusted()).toBe(true);
  });
});

/** Element (with cross-signing, and a display name if given) and a new Multicord device that know of each other. */
async function pair(options: { name?: string } = {}) {
  const server = new FakeHomeserver();
  const old = await element(server, false);
  const multicord = await device(server, ALICE, "MULTI");
  if (options.name) server.setDisplayName(ALICE, "ELEMENT", options.name);
  const devices: [MatrixE2ee, string][] = [
    [old.e2ee, "ELEMENT"],
    [multicord, "MULTI"],
  ];
  await exchange(server, devices, 2);
  const seen: Verification[] = [];
  multicord.onVerification((v) => seen.push(v));
  const elementSeen: Verification[] = [];
  old.e2ee.onVerification((v) => elementSeen.push(v));
  return { server, old, multicord, seen, elementSeen, exchange: (rounds?: number) => exchange(server, devices, rounds) };
}

/** Multicord asked, Element accepted, and both show the emoji. */
async function atEmoji(ctx: Awaited<ReturnType<typeof pair>>) {
  const ours = await ctx.multicord.requestVerification();
  await ctx.exchange(1);
  const theirs = ctx.elementSeen[0]!;
  await theirs.accept();
  await ctx.exchange();
  expect(ours.state().phase).toBe("emoji");
  return { ours, theirs };
}

describe("verification requests from the user's other devices", () => {
  it("hears of Element's request with its cleaned name, once, and goes on to the emoji", async () => {
    const ctx = await pair({ name: "Element‮ Desktop\u0007" });
    await ctx.old.e2ee.requestVerification();
    await ctx.exchange(1);
    expect(ctx.seen).toHaveLength(1);
    expect(ctx.seen[0]!.outgoing).toBe(false);
    expect(ctx.seen[0]!.state()).toEqual({ phase: "incoming", device: "Element Desktop (ELEMENT)" });
    await ctx.exchange(1);
    expect(ctx.seen).toHaveLength(1);
    await ctx.seen[0]!.accept();
    expect(ctx.seen[0]!.state()).toEqual({ phase: "waiting", device: "Element Desktop (ELEMENT)" });
    await ctx.exchange();
    expect(ctx.seen[0]!.state().phase).toBe("emoji");
  });

  it("ignores requests from other users, and broken ones", async () => {
    const ctx = await pair();
    const bob = await device(ctx.server, "@bob:x.org", "BOBDEV");
    const bobMachine = (bob as unknown as { machine: OlmMachine }).machine;
    await bobMachine.updateTrackedUsers([new UserId(ALICE)]);
    await bob.flush();
    const target = (await bobMachine.getDevice(new UserId(ALICE), new DeviceId("MULTI")))!;
    const [, toDevice] = target.requestVerification();
    await ctx.server.http("@bob:x.org", "BOBDEV")("PUT", `/v3/sendToDevice/${toDevice.event_type}/${toDevice.txn_id}`, JSON.parse(toDevice.body));
    ctx.server.deliver(ALICE, "MULTI", { type: "m.key.verification.request", sender: ALICE, content: { transaction_id: 5 } });
    ctx.server.deliver(ALICE, "MULTI", { type: "m.key.verification.request", sender: ALICE, content: { transaction_id: "x".repeat(256) } });
    ctx.server.deliver(ALICE, "MULTI", { type: "m.key.verification.request", sender: ALICE, content: { transaction_id: "unknown" } });
    ctx.server.deliver(ALICE, "MULTI", { type: "m.other", sender: ALICE, content: {} });
    await ctx.exchange(1);
    expect(ctx.seen).toEqual([]);
  });

  it("tells both sides when the emoji do not match", async () => {
    const ctx = await pair();
    const { ours, theirs } = await atEmoji(ctx);
    await theirs.cancel(true);
    await ctx.exchange(2);
    expect(theirs.state()).toEqual({ phase: "cancelled", reason: "the emoji did not match", byUs: true });
    expect(ours.state()).toEqual({ phase: "cancelled", reason: "the emoji did not match", byUs: false });
    // Nothing is left to confirm or cancel.
    await ours.confirm();
    await ours.cancel();
    expect(ours.state().phase).toBe("cancelled");
  });

  it("tells the asking device when the request is declined, and stops one nobody answers", async () => {
    const ctx = await pair();
    const ours = await ctx.multicord.requestVerification();
    await ctx.exchange(1);
    await ctx.elementSeen[0]!.cancel();
    expect(ctx.elementSeen[0]!.state()).toEqual({ phase: "cancelled", reason: "you cancelled it", byUs: true });
    await ctx.exchange(1);
    expect(ours.state()).toEqual({ phase: "cancelled", reason: "it was cancelled on the other device", byUs: false });

    const quiet = await ctx.multicord.requestVerification();
    const changed = vi.fn();
    quiet.onChange(changed);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + LATER);
    await ctx.multicord.receiveSync(ctx.server.sync(ALICE, "MULTI"));
    expect(quiet.state()).toEqual({ phase: "cancelled", reason: "it took too long: nothing happened for 10 minutes", byUs: true });
    expect(changed).toHaveBeenCalled();
  });

  it("times out at the emoji with the spec's code", async () => {
    const ctx = await pair();
    const { ours, theirs } = await atEmoji(ctx);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + LATER);
    await ctx.multicord.receiveSync(ctx.server.sync(ALICE, "MULTI"));
    vi.restoreAllMocks();
    expect(ours.state().phase).toBe("cancelled");
    await ctx.exchange(1);
    expect(theirs.state()).toEqual({ phase: "cancelled", reason: "it took too long: nothing happened for 10 minutes", byUs: false });
  });

  it("points to the recovery key when the other device has no backup key to send", async () => {
    const ctx = await pair();
    ctx.server.backup = { version: "1", algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: { public_key: "x" }, rooms: {} };
    const { ours, theirs } = await atEmoji(ctx);
    await ours.confirm();
    await theirs.confirm();
    await ctx.exchange();
    expect(ours.state()).toEqual({ phase: "done" });
    expect(await ctx.multicord.status()).toEqual({ verified: true, backup: false, restorable: true });
    ctx.server.backup = undefined;
    expect(await ctx.multicord.status()).toEqual({ verified: true, backup: false });
  });

  it("says why a request cannot be sent", async () => {
    const lonely = new FakeHomeserver();
    const alone = await device(lonely, ALICE, "MULTI");
    await expect(alone.requestVerification()).rejects.toThrow("no cross-signing keys yet");
    const server = new FakeHomeserver();
    const old = await element(server, false);
    await expect(old.e2ee.requestVerification()).rejects.toThrow("not signed in on another device");
  });
});

describe("backup keys from other devices", () => {
  it("ignores other secrets and unusable keys, and logs a backup that cannot be restored", async () => {
    const server = new FakeHomeserver();
    const log = vi.fn();
    const e2ee = await openE2ee({ userId: ALICE, deviceId: "MULTI", http: server.http(ALICE, "MULTI"), accountData: server.account(ALICE), log });
    const status = vi.fn();
    e2ee.onStatus(status);
    await e2ee.gossipedSecret("m.cross_signing.master", "x");
    expect(status).not.toHaveBeenCalled();
    await e2ee.gossipedSecret("m.megolm_backup.v1", "not a key");
    expect(status).toHaveBeenCalledTimes(1);
    server.failNext = { path: "/v3/room_keys/version", error: new Error("offline") };
    await e2ee.gossipedSecret("m.megolm_backup.v1", BackupDecryptionKey.createRandomKey().toBase64());
    expect(log).toHaveBeenCalledWith("Key backup not restored: offline");
    expect((await e2ee.status()).backup).toBe(false);
  });

  it("uses a backup key left in the inbox when it starts", async () => {
    const server = new FakeHomeserver();
    const key = BackupDecryptionKey.createRandomKey();
    server.backup = { version: "1", algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: { public_key: key.megolmV1PublicKey.publicKeyBase64 }, rooms: {} };
    const inbox = vi.spyOn(OlmMachine.prototype, "getSecretsFromInbox").mockResolvedValue(new Set([key.toBase64()]));
    const e2ee = await openE2ee({ userId: ALICE, deviceId: "MULTI", http: server.http(ALICE, "MULTI"), accountData: server.account(ALICE) });
    expect(inbox).toHaveBeenCalledWith("m.megolm_backup.v1");
    expect((await e2ee.status()).backup).toBe(true);
    // A second copy changes nothing.
    await e2ee.gossipedSecret("m.megolm_backup.v1", key.toBase64());
    expect((await e2ee.status()).backup).toBe(true);
  });
});

describe("verification edge cases", () => {
  it("drops a request cancelled in the same sync, and logs a step that fails to send", async () => {
    const ctx = await pair();
    const flow = { from_device: "ELEMENT", methods: ["m.sas.v1"], timestamp: Date.now(), transaction_id: "gone" };
    ctx.server.deliver(ALICE, "MULTI", { type: "m.key.verification.request", sender: ALICE, content: flow });
    ctx.server.deliver(ALICE, "MULTI", { type: "m.key.verification.cancel", sender: ALICE, content: { transaction_id: "gone", code: "m.user", reason: "no" } });
    await ctx.exchange(1);
    expect(ctx.seen).toEqual([]);

    await ctx.multicord.requestVerification();
    await ctx.exchange(1);
    const log = (ctx.old.e2ee as unknown as { options: { log: ReturnType<typeof vi.fn> } }).options.log;
    ctx.server.failNext = { path: "/v3/sendToDevice", error: new Error("offline") };
    await expect(ctx.elementSeen[0]!.accept()).rejects.toThrow("offline");
    expect(log).toHaveBeenCalledWith("Verification: offline");
  });

  it("carries on when the inbox cannot be cleared", async () => {
    const server = new FakeHomeserver();
    vi.spyOn(OlmMachine.prototype, "deleteSecretsFromInbox").mockRejectedValue(new Error("busy"));
    const e2ee = await openE2ee({ userId: ALICE, deviceId: "MULTI", http: server.http(ALICE, "MULTI"), accountData: server.account(ALICE) });
    await expect(e2ee.gossipedSecret("m.megolm_backup.v1", "x")).resolves.toBeUndefined();
  });

  /** A verification request as the library keeps it, for the corners real flows do not reach. */
  function fakeRequest(overrides: Record<string, unknown> = {}) {
    const callbacks: (() => Promise<void>)[] = [];
    const request = {
      registerChangesCallback: (callback: () => Promise<void>) => void callbacks.push(callback),
      weStarted: () => true,
      phase: () => VerificationRequestPhase.Ready,
      startSas: async () => undefined,
      getVerification: () => undefined,
      isDone: () => false,
      isCancelled: () => false,
      cancelInfo: undefined,
      acceptWithMethods: () => undefined,
      cancel: () => undefined,
      timedOut: () => false,
      ...overrides,
    };
    return { request: request as unknown as VerificationRequest, changed: () => callbacks[0]!() };
  }
  const host = () => ({ send: vi.fn(async () => {}), flush: vi.fn(async () => {}), done: vi.fn(async () => {}), log: vi.fn() });

  it("copes with the library having nothing to send", async () => {
    const { request, changed } = fakeRequest();
    const h = host();
    const flow = new SasFlow(request, h, "D");
    await flow.accept();
    await changed();
    expect(h.send).not.toHaveBeenCalled();
    expect(flow.state()).toEqual({ phase: "waiting", device: "D" });
    // Timed out by the library's own clock, with nothing to send for it.
    expect(await flow.expireIfDue()).toBe(true);
    (request as unknown as { timedOut: () => boolean }).timedOut = () => true;
    expect(await flow.expireIfDue()).toBe(false);
    expect(await flow.expireIfDue()).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("reports a cancellation without details, and logs failures that are not errors", async () => {
    const { request, changed } = fakeRequest({ isCancelled: () => true });
    const h = host();
    h.send.mockRejectedValue("refused");
    const flow = new SasFlow(request, h, "D");
    expect(flow.state()).toEqual({ phase: "cancelled", reason: "it was cancelled", byUs: false });
    (request as unknown as { cancel: () => unknown }).cancel = () => ({});
    await expect(flow.cancel()).rejects.toBe("refused");
    await changed();
    expect(h.log).toHaveBeenCalledWith("Verification: refused");
  });
});

describe("cancel reasons", () => {
  it("names known codes only", () => {
    expect(cancelReason("m.user", true)).toBe("you cancelled it");
    expect(cancelReason("m.user", false)).toBe("it was cancelled on the other device");
    expect(cancelReason("m.key_mismatch", false)).toBe("the devices' keys did not match");
    expect(cancelReason("org.example.weird", false)).toBe("it was cancelled (org.example.weird)");
    expect(cancelReason("<script>", false)).toBe("it was cancelled");
    expect(cancelReason("", false)).toBe("it was cancelled");
  });
});
