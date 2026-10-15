import { MatrixError, type MatrixApi, type MxDownload, type MxEncryption, type MxLiveKitGrant, type MxLoginFlows, type MxOpenIdToken, type MxPage, type MxSession, type MxSync } from "./api";
import { CALL_MEMBER_TYPE, eventId, isRecord, liveKitServices, mimeType, parseEncryption, parseMembers, parseMxc, parsePage, parseSync, userId } from "./events";

const CLIENT = "/_matrix/client/v3";
/** Timeline events kept per room in a sync, and the event types asked for. */
export const TIMELINE_LIMIT = 20;
const TIMELINE_TYPES = [
  "m.room.message",
  "m.sticker",
  "m.room.encrypted",
  "m.room.redaction",
  "m.room.name",
  "m.room.canonical_alias",
  "m.room.avatar",
  "m.room.encryption",
  "m.room.history_visibility",
  "m.room.member",
];
/**
 * What /sync returns: members only as needed (lazy loading), no presence,
 * typing or receipts, and of the account data only the DM list. To-device
 * messages and device lists come unfiltered, for encryption. The timeline
 * also carries call memberships as they change.
 */
export const SYNC_FILTER = JSON.stringify({
  presence: { not_types: ["*"] },
  account_data: { types: ["m.direct"] },
  room: {
    state: { lazy_load_members: true },
    timeline: { limit: TIMELINE_LIMIT, types: [...TIMELINE_TYPES, CALL_MEMBER_TYPE], lazy_load_members: true },
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
  },
});
const HISTORY_FILTER = JSON.stringify({ lazy_load_members: true, types: TIMELINE_TYPES });
/** Largest thumbnail kept: its data: URL must stay under MAX_DATA_IMAGE. */
export const MAX_THUMBNAIL_BYTES = 140_000;
const THUMBNAIL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ACCESS_TOKEN = 4096;
/** OAuth access tokens are refreshed this long before they expire. */
export const REFRESH_MARGIN_MS = 60_000;
const ACCOUNT_DATA_TYPE = /^[A-Za-z0-9._-]{1,128}$/;

/** An https URL as a client API base: no credentials, query or trailing slash. */
export function httpsBase(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** Bytes as base64, in pieces small enough for String.fromCharCode. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface MatrixClientOptions {
  /**
   * Gets a new access token for an OAuth session, updating the session in
   * place. Called shortly before the token expires, and once when the server
   * says it expired (M_UNKNOWN_TOKEN with soft_logout).
   */
  refresh?(session: MxSession): Promise<void>;
  now?(): number;
}

/**
 * The Client-Server API over plain fetch (in the engine, the shell's HTTP
 * bridge). No SDK: only the endpoints the adapter needs, every response
 * validated in events.ts or here.
 */
export function createMatrixClient(fetchFn: typeof fetch, config: MatrixClientOptions = {}): MatrixApi {
  let txn = 0;
  const now = config.now ?? Date.now;
  /** Transaction ids make retried sends idempotent; they only need to be unique per device. */
  const txnId = (): string => `mc${now().toString(36)}.${++txn}`;
  /** One refresh at a time per session; concurrent calls wait for it. */
  const refreshing = new WeakMap<MxSession, Promise<void>>();

  function refresh(session: MxSession): Promise<void> {
    let pending = refreshing.get(session);
    if (!pending) {
      pending = config.refresh!(session).finally(() => refreshing.delete(session));
      refreshing.set(session, pending);
    }
    return pending;
  }

  /** Refreshes an OAuth token that is about to expire. */
  async function fresh(session: MxSession): Promise<void> {
    const expiresAt = session.oauth?.expiresAt;
    if (config.refresh && expiresAt !== undefined && now() >= expiresAt - REFRESH_MARGIN_MS) await refresh(session);
  }

  async function call(
    base: string,
    path: string,
    options: { method?: string; token?: string; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await fetchFn(url.href, init);
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw failure(response.status, json);
    if (!isRecord(json)) throw new Error("The homeserver sent an unreadable response");
    return json;
  }

  /** A call as the session's user: an OAuth token is refreshed when due, and once more if the server says it expired. */
  async function authed(
    session: MxSession,
    path: string,
    options: { method?: string; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<Record<string, unknown>> {
    await fresh(session);
    const token = session.accessToken;
    try {
      return await call(session.baseUrl, path, { ...options, token });
    } catch (error) {
      const expired = error instanceof MatrixError && error.status === 401 && error.errcode === "M_UNKNOWN_TOKEN" && error.softLogout;
      if (!expired || !config.refresh || !session.oauth?.refreshToken) throw error;
      // Another call may have refreshed meanwhile.
      if (session.accessToken === token) await refresh(session);
      return call(session.baseUrl, path, { ...options, token: session.accessToken });
    }
  }

  const room = (roomId: string): string => `${CLIENT}/rooms/${encodeURIComponent(roomId)}`;

  return {
    async discover(serverUrl) {
      const server = httpsBase(serverUrl);
      if (!server) throw new Error("The homeserver address must be an https URL");
      try {
        const response = await fetchFn(`${new URL(server).origin}/.well-known/matrix/client`, { headers: { Accept: "application/json" } });
        if (response.ok) {
          const body: unknown = await response.json();
          const found = isRecord(body) && isRecord(body["m.homeserver"]) ? httpsBase(body["m.homeserver"].base_url) : undefined;
          if (found) return found;
        }
      } catch {
        // No discovery document: the address is the homeserver itself.
      }
      return server;
    },

    async loginFlows(baseUrl): Promise<MxLoginFlows> {
      const body = await call(baseUrl, `${CLIENT}/login`);
      const flows = Array.isArray(body.flows) ? body.flows : [];
      return { password: flows.some((flow) => isRecord(flow) && flow.type === "m.login.password") };
    },

    async login(baseUrl, user, password): Promise<MxSession> {
      const body = await call(baseUrl, `${CLIENT}/login`, {
        method: "POST",
        body: {
          type: "m.login.password",
          identifier: { type: "m.id.user", user },
          password,
          initial_device_display_name: "Multicord",
        },
      });
      const { access_token: accessToken, device_id: deviceId } = body;
      const id = userId(body.user_id);
      if (typeof accessToken !== "string" || accessToken === "" || accessToken.length > MAX_ACCESS_TOKEN || !id || typeof deviceId !== "string" || deviceId === "" || deviceId.length > 255) {
        throw new Error("The homeserver sent an unreadable sign-in response");
      }
      // The server may name a different client API base for this account.
      const wellKnown = isRecord(body.well_known) && isRecord(body.well_known["m.homeserver"]) ? httpsBase(body.well_known["m.homeserver"].base_url) : undefined;
      return { baseUrl: wellKnown ?? baseUrl, accessToken, userId: id, deviceId, ownDevice: true };
    },

    async whoami(baseUrl, accessToken) {
      const body = await call(baseUrl, `${CLIENT}/account/whoami`, { token: accessToken });
      const id = userId(body.user_id);
      if (!id) throw new Error("The homeserver sent an unreadable account response");
      return typeof body.device_id === "string" && body.device_id !== "" && body.device_id.length <= 255 ? { userId: id, deviceId: body.device_id } : { userId: id };
    },

    async check(session) {
      const body = await authed(session, `${CLIENT}/account/whoami`);
      // A token that now belongs to someone else must not show this account's chats.
      if (body.user_id !== session.userId) throw new MatrixError(401, "M_UNKNOWN_TOKEN", "The session belongs to another account");
    },

    async sync(session, since, timeoutMs): Promise<MxSync> {
      const query: Record<string, string> = { filter: SYNC_FILTER, timeout: String(timeoutMs), set_presence: "offline" };
      if (since) query.since = since;
      return parseSync(await authed(session, `${CLIENT}/sync`, { query }));
    },

    async messages(session, roomId, from, limit): Promise<MxPage> {
      const query = { dir: "b", from, limit: String(limit), filter: HISTORY_FILTER };
      return parsePage(await authed(session, `${room(roomId)}/messages`, { query }));
    },

    async encryption(session, roomId): Promise<MxEncryption | undefined> {
      try {
        return parseEncryption(await authed(session, `${room(roomId)}/state/m.room.encryption/`));
      } catch (error) {
        // Only a definite "no such state" means unencrypted; anything else is not an answer.
        if (error instanceof MatrixError && error.status === 404 && error.errcode === "M_NOT_FOUND") return undefined;
        throw error;
      }
    },

    async members(session, roomId) {
      return parseMembers(await authed(session, `${room(roomId)}/members`, { query: { not_membership: "leave" } }));
    },

    async send(session, roomId, content, type = "m.room.message") {
      const body = await authed(session, `${room(roomId)}/send/${encodeURIComponent(type)}/${txnId()}`, { method: "PUT", body: content });
      const id = eventId(body.event_id);
      if (!id) throw new Error("The homeserver sent an unreadable response");
      return id;
    },

    async redact(session, roomId, id) {
      await authed(session, `${room(roomId)}/redact/${encodeURIComponent(id)}/${txnId()}`, { method: "PUT", body: {} });
    },

    async markRead(session, roomId, id) {
      await authed(session, `${room(roomId)}/read_markers`, { method: "POST", body: { "m.fully_read": id, "m.read": id } });
    },

    async thumbnail(session, mxc) {
      const parsed = parseMxc(mxc);
      if (!parsed) return undefined;
      await fresh(session);
      // Authenticated media (Matrix 1.11): the media repository wants the access token too.
      const url = new URL(`${session.baseUrl}/_matrix/client/v1/media/thumbnail/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.media)}`);
      for (const [name, value] of Object.entries({ width: "64", height: "64", method: "crop", animated: "false" })) url.searchParams.set(name, value);
      const response = await fetchFn(url.href, { headers: { Authorization: `Bearer ${session.accessToken}` } });
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!response.ok || !THUMBNAIL_TYPES.has(type)) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES) return undefined;
      return `data:${type};base64,${base64(bytes)}`;
    },

    async download(session, mxc, maxBytes): Promise<MxDownload | undefined> {
      const parsed = parseMxc(mxc);
      if (!parsed) throw new Error("Invalid media address");
      await fresh(session);
      // Authenticated media (Matrix 1.11), as for thumbnails.
      const url = `${session.baseUrl}/_matrix/client/v1/media/download/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.media)}`;
      const response = await fetchFn(url, { headers: { Authorization: `Bearer ${session.accessToken}` } });
      if (!response.ok) throw failure(response.status, await response.json().catch(() => undefined));
      // The size is checked before and after reading: a server may not say, or say wrong.
      if (Number(response.headers.get("content-length")) > maxBytes) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) return undefined;
      const download: MxDownload = { bytes };
      const type = mimeType((response.headers.get("content-type") ?? "").split(";")[0]);
      if (type) download.type = type;
      return download;
    },

    async accountData(session, type) {
      if (!ACCOUNT_DATA_TYPE.test(type)) throw new Error("Invalid account data type");
      try {
        return await authed(session, `${CLIENT}/user/${encodeURIComponent(session.userId)}/account_data/${type}`);
      } catch (error) {
        if (error instanceof MatrixError && error.status === 404) return undefined;
        throw error;
      }
    },

    async request(session, method, path, body, query) {
      return authed(session, `/_matrix/client${path}`, { method, body, query });
    },

    async logout(session) {
      await authed(session, `${CLIENT}/logout`, { method: "POST", body: {} });
    },

    async rtcFoci(serverUrl) {
      const server = httpsBase(serverUrl);
      if (!server) return [];
      const response = await fetchFn(`${new URL(server).origin}/.well-known/matrix/client`, { headers: { Accept: "application/json" } });
      const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
      return isRecord(body) ? liveKitServices(body["org.matrix.msc4143.rtc_foci"]) : [];
    },

    async rtcTransports(session) {
      try {
        const body = await authed(session, `${UNSTABLE_RTC}/rtc/transports`);
        return liveKitServices(body.rtc_transports);
      } catch (error) {
        // Most homeservers do not have the endpoint (yet).
        if (error instanceof MatrixError && (error.status === 404 || error.status === 400 || error.status === 405)) return [];
        throw error;
      }
    },

    async supports(session, feature) {
      const body = await authed(session, "/_matrix/client/versions");
      return isRecord(body.unstable_features) && body.unstable_features[feature] === true;
    },

    async openIdToken(session): Promise<MxOpenIdToken> {
      const body = await authed(session, `${CLIENT}/user/${encodeURIComponent(session.userId)}/openid/request_token`, { method: "POST", body: {} });
      const { access_token: accessToken, token_type: tokenType, matrix_server_name: serverName, expires_in: expiresIn } = body;
      const text = (value: unknown, max: number): value is string => typeof value === "string" && value !== "" && value.length <= max;
      if (!text(accessToken, MAX_ACCESS_TOKEN) || !text(tokenType, 64) || !text(serverName, 255) || typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
        throw new Error("The homeserver sent an unreadable OpenID token");
      }
      return { access_token: accessToken, token_type: tokenType, matrix_server_name: serverName, expires_in: expiresIn };
    },

    async sendState(session, roomId, type, stateKey, content) {
      const body = await authed(session, `${room(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`, { method: "PUT", body: content });
      const id = eventId(body.event_id);
      if (!id) throw new Error("The homeserver sent an unreadable response");
      return id;
    },

    async sendDelayedState(session, roomId, type, stateKey, content, delayMs) {
      const query = { [`${DELAYED_EVENTS}.delay`]: String(delayMs) };
      const body = await authed(session, `${room(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`, { method: "PUT", body: content, query });
      const id = body.delay_id;
      if (typeof id !== "string" || id === "" || id.length > 255) throw new Error("The homeserver sent an unreadable response");
      return id;
    },

    async updateDelayed(session, delayId, action) {
      const path = `/_matrix/client/unstable/${DELAYED_EVENTS}/delayed_events/${encodeURIComponent(delayId)}`;
      try {
        await authed(session, `${path}/${action}`, { method: "POST", body: {} });
      } catch (error) {
        // Servers from before the action moved into the path take it in the body.
        if (!(error instanceof MatrixError && error.errcode === "M_UNRECOGNIZED")) throw error;
        await authed(session, path, { method: "POST", body: { action } });
      }
    },

    async liveKitGrant(serviceUrl, roomId, deviceId, token): Promise<MxLiveKitGrant> {
      const body = await call(serviceUrl, "/sfu/get", { method: "POST", body: { room: roomId, openid_token: token, device_id: deviceId } });
      const url = liveKitUrl(body.url);
      const jwt = body.jwt;
      if (!url || typeof jwt !== "string" || !/^[A-Za-z0-9_.-]{1,8192}$/.test(jwt)) throw new Error("The call service sent an unreadable answer");
      return { url, jwt };
    },
  };
}

/** A homeserver's error response as a MatrixError, with its error code. */
function failure(status: number, json: unknown): MatrixError {
  const body = isRecord(json) ? json : {};
  const errcode = typeof body.errcode === "string" ? body.errcode.slice(0, 64) : "M_UNKNOWN";
  const message = typeof body.error === "string" && body.error !== "" ? body.error.slice(0, 200) : `HTTP ${status}`;
  return new MatrixError(status, errcode, message, body.soft_logout === true);
}

const UNSTABLE_RTC = "/_matrix/client/unstable/org.matrix.msc4143";
/** Delayed events (MSC4140): the leave Element Call schedules, sent by the server should the client vanish. */
const DELAYED_EVENTS = "org.matrix.msc4140";

/** A LiveKit server's address: wss (or https, which LiveKit turns into wss), no credentials. */
export function liveKitUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "wss:" || url.protocol === "https:") && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
