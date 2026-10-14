// End-to-end encryption, with the Rust crypto library (matrix-sdk-crypto,
// as WebAssembly). The library is a state machine without network access:
// this file feeds it what the homeserver sends (to-device messages, device
// list changes, key counts), sends the requests it asks for (key uploads,
// queries and claims, to-device messages, signatures, backups), and uses it
// to decrypt and encrypt room events. Recovery with the user's recovery key
// (secret storage) imports the cross-signing keys, signs this device and
// turns on the key backup.

import {
  BackupDecryptionKey,
  DecryptionErrorCode,
  DecryptionSettings,
  DeviceId,
  DeviceLists,
  EncryptionSettings,
  HistoryVisibility,
  MegolmDecryptionError,
  OlmMachine,
  RequestType,
  RoomId,
  ShieldColor,
  TrustRequirement,
  UserId,
  type KeysBackupRequest,
  type KeysClaimRequest,
  type KeysQueryRequest,
  type KeysUploadRequest,
  type RoomMessageRequest,
  type SignatureUploadRequest,
  type ToDeviceRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import { MatrixError, type MxCryptoSync, type MxEncryptedEvent, type MxEncryption, type MxEvent } from "./api";
import { isRecord, parseEvent, roomId as checkRoomId } from "./events";
import { checkKey, decodeRecoveryKey, decryptSecret, fromBase64, keyFromPassphrase, parseEncryptedSecret, parseKeyDescription } from "./recovery";

export const MEGOLM = "m.megolm.v1.aes-sha2";
const BACKUP_ALGORITHM = "m.megolm_backup.v1.curve25519-aes-sha2";
/** The library's own defaults, which rooms may shorten but not lengthen. */
const ROTATION_MS = 7 * 24 * 3600 * 1000;
const ROTATION_MSGS = 100;
const MAX_BACKUP_ROOMS = 5000;
const MAX_BACKUP_SESSIONS = 10_000;
const MAX_BACKUP_FIELD = 65_536;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** Cross-signing and backup keys are 32 bytes, unpadded base64. */
const KEY_SECRET = /^[A-Za-z0-9+/]{43}=?$/;

/** A call to the homeserver as this session's user; `path` is below /_matrix/client. */
export type CryptoHttp = (method: string, path: string, body?: unknown, query?: Record<string, string>) => Promise<Record<string, unknown>>;

export interface E2eeOptions {
  userId: string;
  deviceId: string;
  /** The IndexedDB store the keys live in, and the passphrase it is encrypted with; in memory without one. */
  store?: { name: string; passphrase: string };
  http: CryptoHttp;
  accountData(type: string): Promise<Record<string, unknown> | undefined>;
  /** Reports failures in the background work (never secrets). */
  log?(message: string): void;
}

/** How a room encrypts, from its state. */
export interface RoomEncryption {
  encryption: MxEncryption;
  /** m.room.history_visibility; "shared" when unknown, as the spec defaults. */
  history?: string;
}

export interface E2eeStatus {
  /** This device is signed by the user's cross-signing keys. */
  verified: boolean;
  /** Keys are restored from (and saved to) the key backup. */
  backup: boolean;
}

export interface RecoveryResult extends E2eeStatus {
  /** Room keys restored from the backup. */
  imported: number;
}

/** What the adapter uses; MatrixE2ee implements it over the crypto library. */
export interface E2ee {
  receiveSync(sync: MxCryptoSync): Promise<void>;
  /** The decrypted event; undefined for event types that are not shown; the event with a `problem` when it cannot be decrypted. */
  decrypt(roomId: string, event: MxEncryptedEvent): Promise<MxEvent | undefined>;
  /** Shares the room key with `members`' devices and returns the m.room.encrypted content to send. */
  encrypt(roomId: string, room: RoomEncryption, members: string[], type: string, content: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(): Promise<E2eeStatus>;
  /** Verifies this device and restores the key backup with a recovery key or security phrase. */
  recover(input: string): Promise<RecoveryResult>;
  /** Calls back when room keys arrive, with their session ids. */
  onKeys(callback: (sessionIds: string[]) => void): void;
  close(): void;
}

const HISTORY: Record<string, HistoryVisibility> = {
  invited: HistoryVisibility.Invited,
  joined: HistoryVisibility.Joined,
  shared: HistoryVisibility.Shared,
  world_readable: HistoryVisibility.WorldReadable,
};

const WITHHELD: Record<string, string> = {
  "m.unverified": "the sender only shares keys with verified devices; verify this device with your recovery key",
  "m.blacklisted": "the sender has blocked this device",
  "m.unauthorised": "this device may not read it",
  "m.no_olm": "the sender could not reach this device",
};

/** Why a room event could not be decrypted, in a few words. */
export function decryptionProblem(error: unknown, backup: boolean): string {
  if (!(error instanceof MegolmDecryptionError)) return "the message is damaged";
  const withheld = error.withheldCode;
  if (withheld) return WITHHELD[withheld] ?? "the sender withheld the key";
  switch (error.code) {
    case DecryptionErrorCode.MissingRoomKey:
      return backup ? "the key is not in your key backup (yet)" : "the key has not arrived (yet); verify this device with your recovery key to load older keys";
    case DecryptionErrorCode.UnknownMessageIndex:
      return "this device only has the key for later messages";
    case DecryptionErrorCode.MismatchedIdentityKeys:
    case DecryptionErrorCode.MismatchedSender:
      return "the sender's identity does not match";
    case DecryptionErrorCode.UnknownSenderDevice:
    case DecryptionErrorCode.UnsignedSenderDevice:
    case DecryptionErrorCode.SenderIdentityVerificationViolation:
      return "the sender's device is not trusted";
    default:
      return "the message is damaged";
  }
}

/** A user id the library accepts, or undefined. */
function toUserId(id: string): UserId | undefined {
  try {
    return new UserId(id);
  } catch {
    return undefined;
  }
}

const userIds = (ids: string[]): UserId[] => ids.flatMap((id) => toUserId(id) ?? []);

/** The decrypted session in a backed-up key (KeyBackupData), or undefined. */
export function decryptBackedUpKey(key: BackupDecryptionKey, data: unknown): Record<string, unknown> | undefined {
  const sessionData = isRecord(data) ? data.session_data : undefined;
  if (!isRecord(sessionData)) return undefined;
  const { ephemeral, mac, ciphertext } = sessionData;
  const field = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_BACKUP_FIELD;
  if (!field(ephemeral) || !field(mac) || !field(ciphertext)) return undefined;
  try {
    const session: unknown = JSON.parse(key.decryptV1(ephemeral, mac, ciphertext));
    return isRecord(session) ? session : undefined;
  } catch {
    return undefined;
  }
}

/** Opens the crypto state for a device (the WebAssembly must be loaded). */
export async function openE2ee(options: E2eeOptions): Promise<MatrixE2ee> {
  const machine = await OlmMachine.initialize(new UserId(options.userId), new DeviceId(options.deviceId), options.store?.name, options.store?.passphrase);
  const e2ee = new MatrixE2ee(machine, options);
  await e2ee.loadBackup();
  return e2ee;
}

/** The IndexedDB databases the library keeps for a store name. */
export const STORE_SUFFIXES = ["::matrix-sdk-crypto", "::matrix-sdk-crypto-meta"];

/** Deletes a device's key store, e.g. on sign-out; nothing happens without IndexedDB. */
export async function deleteCryptoStore(name: string, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!factory) return;
  await Promise.all(
    STORE_SUFFIXES.map(
      (suffix) =>
        new Promise<void>((resolve) => {
          const request = factory.deleteDatabase(`${name}${suffix}`);
          // Blocked means another connection is still open; the deletion still happens once it closes.
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        }),
    ),
  );
}

type Request = KeysUploadRequest | KeysQueryRequest | KeysClaimRequest | ToDeviceRequest | SignatureUploadRequest | RoomMessageRequest | KeysBackupRequest;

export class MatrixE2ee implements E2ee {
  /** Decrypt whatever arrives, as Element does; the library takes these by value, so each call gets its own. */
  private readonly settings = (): DecryptionSettings => new DecryptionSettings(TrustRequirement.Untrusted);
  private flushing: Promise<void> | undefined;
  private again = false;
  /** Room key sharing runs one at a time per room, as the library asks. */
  private readonly sharing = new Map<string, Promise<unknown>>();
  private backup: { key: BackupDecryptionKey; version: string } | undefined;
  /** Sessions already looked up in the backup, so a missing key is asked for once. */
  private readonly lookedUp = new Set<string>();
  private keysCallback: (sessionIds: string[]) => void = () => {};

  constructor(
    private readonly machine: OlmMachine,
    private readonly options: E2eeOptions,
  ) {
    machine.registerRoomKeyUpdatedCallback(async (keys) => this.keysCallback(keys.map((k) => k.sessionId)));
  }

  onKeys(callback: (sessionIds: string[]) => void): void {
    this.keysCallback = callback;
  }

  close(): void {
    this.machine.close();
  }

  /** Picks up a backup key saved earlier, and saves new keys to that backup if it is still the current one. */
  async loadBackup(): Promise<void> {
    const keys = await this.machine.getBackupKeys();
    const key = keys.decryptionKey;
    const version = keys.backupVersion;
    if (!key || !version) return;
    this.backup = { key, version };
    try {
      const info = await this.options.http("GET", "/v3/room_keys/version");
      if (this.matchesBackup(info, key)) await this.machine.enableBackupV1(key.megolmV1PublicKey.publicKeyBase64, version);
    } catch (error) {
      // Restoring keys still works; saving new ones waits for the next start.
      this.options.log?.(`Key backup not checked: ${messageOf(error)}`);
    }
  }

  private matchesBackup(info: Record<string, unknown>, key: BackupDecryptionKey): info is Record<string, unknown> & { version: string } {
    return (
      info.algorithm === BACKUP_ALGORITHM &&
      typeof info.version === "string" &&
      info.version.length <= 255 &&
      isRecord(info.auth_data) &&
      info.auth_data.public_key === key.megolmV1PublicKey.publicKeyBase64
    );
  }

  // --- Sync and requests -------------------------------------------------------

  async receiveSync(sync: MxCryptoSync): Promise<void> {
    const lists = new DeviceLists(userIds(sync.changed), userIds(sync.left));
    await this.machine.receiveSyncChanges(
      sync.toDevice,
      lists,
      new Map(Object.entries(sync.oneTimeKeys)),
      sync.fallbackKeys ? new Set(sync.fallbackKeys) : undefined,
      this.settings(),
    );
    await this.flush();
  }

  /** Sends whatever the library wants sent, until it wants nothing more. One run at a time; a call during a run makes it go again. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.again = false;
          await this.sendOutgoing();
        } while (this.again);
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  private async sendOutgoing(): Promise<void> {
    let failure: unknown;
    const requests: Request[] = await this.machine.outgoingRequests();
    if (this.backup && (await this.machine.isBackupEnabled())) {
      const backup = await this.machine.backupRoomKeys();
      if (backup) requests.push(backup);
    }
    for (const request of requests) {
      // One failing request must not hold up the others; the library asks again for unsent ones.
      await this.send(request).catch((error: unknown) => (failure ??= error));
    }
    if (failure) throw failure;
  }

  private async send(request: Request): Promise<void> {
    const body: unknown = JSON.parse(request.body);
    const http = this.options.http;
    const enc = encodeURIComponent;
    let response: Record<string, unknown>;
    switch (request.type) {
      case RequestType.KeysUpload:
        response = await http("POST", "/v3/keys/upload", body);
        break;
      case RequestType.KeysQuery:
        response = await http("POST", "/v3/keys/query", body);
        break;
      case RequestType.KeysClaim:
        response = await http("POST", "/v3/keys/claim", body);
        break;
      case RequestType.ToDevice: {
        const toDevice = request as ToDeviceRequest;
        response = await http("PUT", `/v3/sendToDevice/${enc(toDevice.event_type)}/${enc(toDevice.txn_id)}`, body);
        break;
      }
      case RequestType.SignatureUpload:
        response = await http("POST", "/v3/keys/signatures/upload", body);
        break;
      case RequestType.RoomMessage: {
        const message = request as RoomMessageRequest;
        response = await http("PUT", `/v3/rooms/${enc(message.room_id)}/send/${enc(message.event_type)}/${enc(message.txn_id)}`, body);
        break;
      }
      default: {
        const backup = request as KeysBackupRequest;
        response = await http("PUT", "/v3/room_keys/keys", body, { version: backup.version });
      }
    }
    if (request.id) await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
  }

  // --- Room events ---------------------------------------------------------------

  async decrypt(roomId: string, event: MxEncryptedEvent): Promise<MxEvent | undefined> {
    if (!event.raw) return { ...event, problem: "the message is too large" };
    try {
      return await this.decryptRaw(roomId, event);
    } catch (error) {
      const missing = error instanceof MegolmDecryptionError && (error.code === DecryptionErrorCode.MissingRoomKey || error.code === DecryptionErrorCode.UnknownMessageIndex);
      if (missing && event.sessionId && (await this.fromBackup(roomId, event.sessionId))) {
        try {
          return await this.decryptRaw(roomId, event);
        } catch (again) {
          error = again;
        }
      }
      return { ...event, problem: decryptionProblem(error, this.backup !== undefined) };
    }
  }

  private async decryptRaw(roomId: string, event: MxEncryptedEvent): Promise<MxEvent | undefined> {
    const decrypted = await this.machine.decryptRoomEvent(event.raw!, new RoomId(roomId), this.settings());
    const clear: unknown = JSON.parse(decrypted.event);
    const outer = JSON.parse(event.raw!) as Record<string, unknown>;
    if (!isRecord(clear) || typeof clear.type !== "string") return { ...event, problem: "the message is damaged" };
    const content = isRecord(clear.content) ? { ...clear.content } : {};
    // Relations (replies are inside, edits outside) stay readable on the encrypted event; the spec has clients take them from there.
    const relation = isRecord(outer.content) ? outer.content["m.relates_to"] : undefined;
    if (content["m.relates_to"] === undefined && relation !== undefined) content["m.relates_to"] = relation;
    // The id, sender and time are the encrypted event's own: the library has checked the sender.
    const parsed = parseEvent({ type: clear.type, content, event_id: event.id, sender: event.sender, origin_server_ts: event.ts });
    if (parsed?.kind === "message") {
      const shield = decrypted.shieldState(false);
      if (shield.color !== ShieldColor.None) parsed.unverified = shield.message ?? "unverified device";
    }
    return parsed;
  }

  /** Looks a missing room key up in the backup, once per session. */
  private async fromBackup(roomId: string, sessionId: string): Promise<boolean> {
    const backup = this.backup;
    const id = `${roomId}|${sessionId}`;
    if (!backup || this.lookedUp.has(id)) return false;
    this.lookedUp.add(id);
    try {
      const data = await this.options.http("GET", `/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`, undefined, { version: backup.version });
      const session = decryptBackedUpKey(backup.key, data);
      if (!session) return false;
      const result = await this.machine.importBackedUpRoomKeys(new Map([[new RoomId(roomId), new Map([[sessionId, session]])]]), () => undefined, backup.version);
      return result.importedCount > 0;
    } catch (error) {
      if (!(error instanceof MatrixError && error.status === 404)) this.options.log?.(`Key backup lookup failed: ${messageOf(error)}`);
      return false;
    }
  }

  async encrypt(roomId: string, room: RoomEncryption, members: string[], type: string, content: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (room.encryption.algorithm !== MEGOLM) throw new Error("this room uses an encryption algorithm Multicord does not support");
    const previous = this.sharing.get(roomId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.shareAndEncrypt(roomId, room, members, type, content));
    this.sharing.set(roomId, task);
    try {
      return await task;
    } finally {
      if (this.sharing.get(roomId) === task) this.sharing.delete(roomId);
    }
  }

  private async shareAndEncrypt(roomId: string, room: RoomEncryption, members: string[], type: string, content: Record<string, unknown>): Promise<Record<string, unknown>> {
    // The library consumes the UserId objects it is given, so each call gets fresh ones.
    await this.machine.updateTrackedUsers(userIds(members));
    // Learn the members' devices (keys/query) before claiming keys for them.
    await this.flush();
    const claim = await this.machine.getMissingSessions(userIds(members));
    if (claim) await this.send(claim);
    const settings = new EncryptionSettings();
    settings.historyVisibility = HISTORY[room.history ?? "shared"] ?? HistoryVisibility.Shared;
    settings.rotationPeriod = BigInt(Math.min(room.encryption.rotationMs ?? ROTATION_MS, ROTATION_MS)) * 1000n;
    settings.rotationPeriodMessages = BigInt(Math.min(room.encryption.rotationMsgs ?? ROTATION_MSGS, ROTATION_MSGS));
    for (const request of await this.machine.shareRoomKey(new RoomId(roomId), userIds(members), settings)) await this.send(request);
    const encrypted: unknown = JSON.parse(await this.machine.encryptRoomEvent(new RoomId(roomId), type, JSON.stringify(content)));
    return encrypted as Record<string, unknown>;
  }

  // --- Verification and backup ---------------------------------------------------

  async status(): Promise<E2eeStatus> {
    const device = await this.machine.getDevice(this.machine.userId, this.machine.deviceId);
    return { verified: device?.isCrossSigningTrusted() ?? false, backup: this.backup !== undefined };
  }

  /** Asks the server for our own devices and cross-signing keys now. */
  private async queryOwnKeys(): Promise<void> {
    await this.send(this.machine.queryKeysForUsers([this.machine.userId]));
  }

  async recover(input: string): Promise<RecoveryResult> {
    const { accountData } = this.options;
    const defaultKey = await accountData("m.secret_storage.default_key");
    const keyId = defaultKey?.key;
    if (typeof keyId !== "string" || !KEY_ID.test(keyId)) {
      throw new Error("Your account has no recovery key yet. Set up recovery in Element (Settings > Encryption), then try again.");
    }
    const description = parseKeyDescription(await accountData(`m.secret_storage.key.${keyId}`));
    if (!description) throw new Error("Your account's recovery is set up in a way Multicord does not support.");
    let key = decodeRecoveryKey(input);
    const phrase = !key && description.passphrase !== undefined;
    if (phrase) key = await keyFromPassphrase(input, description.passphrase!);
    if (!key) throw new Error("That is not a recovery key. It is 48 letters and digits, in groups of four.");
    if (!(await checkKey(key, description))) throw new Error(phrase ? "That security phrase is not right." : "That recovery key is not right.");
    const recoveryKey = key;

    const secret = async (name: string): Promise<string | undefined> => {
      const data = await accountData(name);
      const encrypted = isRecord(data) && isRecord(data.encrypted) ? parseEncryptedSecret(data.encrypted[keyId]) : undefined;
      const value = encrypted ? await decryptSecret(recoveryKey, name, encrypted).catch(() => undefined) : undefined;
      return value !== undefined && KEY_SECRET.test(value) && fromBase64(value)?.length === 32 ? value : undefined;
    };
    const master = await secret("m.cross_signing.master");
    const selfSigning = await secret("m.cross_signing.self_signing");
    const userSigning = await secret("m.cross_signing.user_signing");
    const backupKey = await secret("m.megolm_backup.v1");

    if (master && selfSigning) {
      await this.queryOwnKeys();
      const imported = await this.machine.importCrossSigningKeys(master, selfSigning, userSigning ?? null).catch(() => undefined);
      if (!imported?.hasMaster || !imported.hasSelfSigning) throw new Error("The cross-signing keys in your recovery do not match your account. Reset them in Element, then try again.");
      // Sign this device with the self-signing key, so other devices see it as verified.
      const device = (await this.machine.getDevice(this.machine.userId, this.machine.deviceId))!;
      await this.send(await device.verify());
      await this.queryOwnKeys();
    }
    const imported = backupKey ? await this.restoreBackup(backupKey) : 0;
    return { ...(await this.status()), imported };
  }

  /** Turns on the key backup with its private key, and restores every key in it. */
  private async restoreBackup(secret: string): Promise<number> {
    const info = await this.options.http("GET", "/v3/room_keys/version").catch((error: unknown) => {
      if (error instanceof MatrixError && error.status === 404) return {};
      throw error;
    });
    const key = BackupDecryptionKey.fromBase64(secret);
    // A backup key for an older backup is of no use for the current one.
    if (!this.matchesBackup(info, key)) return 0;
    const { version } = info;
    await this.machine.saveBackupDecryptionKey(key, version);
    await this.machine.enableBackupV1(key.megolmV1PublicKey.publicKeyBase64, version);
    this.backup = { key, version };
    const all = await this.options.http("GET", "/v3/room_keys/keys", undefined, { version });
    let imported = 0;
    for (const [roomId, room] of Object.entries(isRecord(all.rooms) ? all.rooms : {}).slice(0, MAX_BACKUP_ROOMS)) {
      if (!checkRoomId(roomId) || !isRecord(room) || !isRecord(room.sessions)) continue;
      const sessions = new Map<string, unknown>();
      for (const [sessionId, data] of Object.entries(room.sessions).slice(0, MAX_BACKUP_SESSIONS)) {
        const session = sessionId.length <= 128 ? decryptBackedUpKey(key, data) : undefined;
        if (session) sessions.set(sessionId, session);
      }
      if (sessions.size === 0) continue;
      const result = await this.machine.importBackedUpRoomKeys(new Map([[new RoomId(roomId), sessions]]), () => undefined, version).catch(() => undefined);
      imported += result?.importedCount ?? 0;
    }
    return imported;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
