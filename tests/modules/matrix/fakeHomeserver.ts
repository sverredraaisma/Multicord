// A homeserver in memory for the crypto tests: just enough of the keys,
// to-device, account data and key backup APIs for real OlmMachines to
// exchange keys through it.

import { MatrixError, type MxCryptoSync } from "../../../src/modules/matrix/api";
import type { CryptoHttp } from "../../../src/modules/matrix/crypto";

type Json = Record<string, any>;

interface DeviceState {
  keys?: Json;
  oneTimeKeys: Map<string, Json>;
  fallbackKeys: Map<string, Json>;
  inbox: Json[];
  /** Key change version seen at the last sync, per user. */
  seen: Map<string, number>;
}

export class FakeHomeserver {
  readonly devices = new Map<string, Map<string, DeviceState>>();
  readonly crossSigning = new Map<string, { master?: Json; self_signing?: Json; user_signing?: Json }>();
  readonly accountData = new Map<string, Map<string, Json>>();
  /** How often each user's keys changed. */
  private readonly versions = new Map<string, number>();
  backup: { version: string; algorithm: string; auth_data: Json; rooms: Json } | undefined;
  readonly calls: { user: string; method: string; path: string }[] = [];
  /** Makes the next matching call fail. */
  failNext: { path: string; error: Error } | undefined;

  private device(user: string, device: string): DeviceState {
    let devices = this.devices.get(user);
    if (!devices) this.devices.set(user, (devices = new Map()));
    let state = devices.get(device);
    if (!state) devices.set(device, (state = { oneTimeKeys: new Map(), fallbackKeys: new Map(), inbox: [], seen: new Map() }));
    return state;
  }

  private changed(user: string): void {
    this.versions.set(user, (this.versions.get(user) ?? 0) + 1);
  }

  /** The HTTP side as one device sees it. */
  http(user: string, device: string): CryptoHttp {
    return async (method, path, body, query) => {
      this.calls.push({ user, method, path });
      if (this.failNext && path.startsWith(this.failNext.path)) {
        const { error } = this.failNext;
        this.failNext = undefined;
        throw error;
      }
      return this.handle(user, device, method, path, (body ?? {}) as Json, query ?? {});
    };
  }

  account(user: string): (type: string) => Promise<Json | undefined> {
    return async (type) => this.accountData.get(user)?.get(type);
  }

  setAccountData(user: string, type: string, content: Json): void {
    let data = this.accountData.get(user);
    if (!data) this.accountData.set(user, (data = new Map()));
    data.set(type, content);
  }

  /** What a /sync would carry for this device's encryption. */
  sync(user: string, device: string): MxCryptoSync {
    const state = this.device(user, device);
    const toDevice = state.inbox.splice(0);
    const changed: string[] = [];
    for (const [other, version] of this.versions) {
      if (state.seen.get(other) !== version) changed.push(other);
      state.seen.set(other, version);
    }
    return {
      toDevice: JSON.stringify(toDevice),
      changed,
      left: [],
      oneTimeKeys: { signed_curve25519: state.oneTimeKeys.size },
      fallbackKeys: [...state.fallbackKeys.keys()].map((id) => id.split(":")[0]!),
    };
  }

  private handle(user: string, device: string, method: string, path: string, body: Json, query: Record<string, string>): Json {
    const key = `${method} ${path}`;
    if (key === "POST /v3/keys/upload") return this.upload(user, device, body);
    if (key === "POST /v3/keys/query") return this.query(user, body);
    if (key === "POST /v3/keys/claim") return this.claim(body);
    if (key === "POST /v3/keys/signatures/upload") return this.signatures(body);
    if (key === "POST /v3/keys/device_signing/upload") {
      this.crossSigning.set(user, { master: body.master_key, self_signing: body.self_signing_key, user_signing: body.user_signing_key });
      this.changed(user);
      return {};
    }
    if (method === "PUT" && path.startsWith("/v3/sendToDevice/")) {
      const type = decodeURIComponent(path.split("/")[3]!);
      for (const [target, devices] of Object.entries(body.messages as Json)) {
        for (const [id, content] of Object.entries(devices as Json)) {
          const ids = id === "*" ? [...(this.devices.get(target)?.keys() ?? [])] : [id];
          for (const one of ids) this.device(target, one).inbox.push({ type, sender: user, content });
        }
      }
      return {};
    }
    if (key === "GET /v3/room_keys/version") {
      if (!this.backup) throw new MatrixError(404, "M_NOT_FOUND", "No backup");
      const { rooms: _rooms, ...info } = this.backup;
      return { ...info, count: 0, etag: "1" };
    }
    if (key === "PUT /v3/room_keys/keys") {
      if (!this.backup || query.version !== this.backup.version) throw new MatrixError(403, "M_WRONG_ROOM_KEYS_VERSION", "Wrong version");
      for (const [room, data] of Object.entries((body.rooms ?? {}) as Json)) {
        this.backup.rooms[room] ??= { sessions: {} };
        Object.assign(this.backup.rooms[room].sessions, (data as Json).sessions);
      }
      return { count: 1, etag: "2" };
    }
    if (key === "GET /v3/room_keys/keys") return { rooms: this.backup?.rooms ?? {} };
    if (method === "GET" && path.startsWith("/v3/room_keys/keys/")) {
      const [, , , , room, session] = path.split("/");
      const data = this.backup?.rooms[decodeURIComponent(room!)]?.sessions[decodeURIComponent(session!)];
      if (!data) throw new MatrixError(404, "M_NOT_FOUND", "No key");
      return data;
    }
    throw new MatrixError(404, "M_UNRECOGNIZED", `Not faked: ${key}`);
  }

  private upload(user: string, device: string, body: Json): Json {
    const state = this.device(user, device);
    if (body.device_keys) {
      state.keys = body.device_keys;
      this.changed(user);
    }
    for (const [id, value] of Object.entries((body.one_time_keys ?? {}) as Json)) state.oneTimeKeys.set(id, value);
    for (const [id, value] of Object.entries((body.fallback_keys ?? {}) as Json)) state.fallbackKeys.set(id, value);
    return { one_time_key_counts: { signed_curve25519: state.oneTimeKeys.size } };
  }

  private query(requester: string, body: Json): Json {
    const response: Json = { device_keys: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {}, failures: {} };
    for (const user of Object.keys(body.device_keys as Json)) {
      response.device_keys[user] = {};
      for (const [id, state] of this.devices.get(user) ?? []) if (state.keys) response.device_keys[user][id] = state.keys;
      const cross = this.crossSigning.get(user);
      if (cross?.master) response.master_keys[user] = cross.master;
      if (cross?.self_signing) response.self_signing_keys[user] = cross.self_signing;
      if (cross?.user_signing && user === requester) response.user_signing_keys[user] = cross.user_signing;
    }
    return response;
  }

  private claim(body: Json): Json {
    const response: Json = { one_time_keys: {}, failures: {} };
    for (const [user, devices] of Object.entries(body.one_time_keys as Json)) {
      for (const id of Object.keys(devices as Json)) {
        const state = this.devices.get(user)?.get(id);
        if (!state) continue;
        const [keyId, value] = state.oneTimeKeys.entries().next().value ?? state.fallbackKeys.entries().next().value ?? [];
        if (!keyId) continue;
        state.oneTimeKeys.delete(keyId);
        response.one_time_keys[user] ??= {};
        response.one_time_keys[user][id] = { [keyId]: value };
      }
    }
    return response;
  }

  private signatures(body: Json): Json {
    for (const [user, objects] of Object.entries(body)) {
      for (const [keyId, signed] of Object.entries(objects as Json)) {
        const cross = this.crossSigning.get(user);
        const crossKey = Object.values(cross ?? {}).find((k) => k && Object.values(k.keys).includes(keyId));
        const target = this.devices.get(user)?.get(keyId)?.keys ?? crossKey;
        if (!target) continue;
        for (const [signer, sigs] of Object.entries((signed as Json).signatures as Json)) {
          target.signatures ??= {};
          target.signatures[signer] = { ...target.signatures[signer], ...(sigs as Json) };
        }
      }
      this.changed(user);
    }
    return { failures: {} };
  }
}
