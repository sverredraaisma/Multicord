import { MatrixError, type MatrixApi, type MxLoginFlows, type MxPage, type MxSession, type MxSync } from "./api";
import { eventId, isRecord, parseMxc, parsePage, parseSync, userId } from "./events";

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
  "m.room.member",
];
/**
 * What /sync returns: members only as needed (lazy loading), no presence,
 * typing or receipts, and of the account data only the DM list.
 */
export const SYNC_FILTER = JSON.stringify({
  presence: { not_types: ["*"] },
  account_data: { types: ["m.direct"] },
  room: {
    state: { lazy_load_members: true },
    timeline: { limit: TIMELINE_LIMIT, types: TIMELINE_TYPES, lazy_load_members: true },
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
  },
});
const HISTORY_FILTER = JSON.stringify({ lazy_load_members: true, types: TIMELINE_TYPES });
/** Largest thumbnail kept: its data: URL must stay under MAX_DATA_IMAGE. */
export const MAX_THUMBNAIL_BYTES = 140_000;
const THUMBNAIL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ACCESS_TOKEN = 4096;

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

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The Client-Server API over plain fetch (in the engine, the shell's HTTP
 * bridge). No SDK: only the endpoints the adapter needs, every response
 * validated in events.ts or here.
 */
export function createMatrixClient(fetchFn: typeof fetch): MatrixApi {
  let txn = 0;
  /** Transaction ids make retried sends idempotent; they only need to be unique per device. */
  const txnId = (): string => `mc${Date.now().toString(36)}.${++txn}`;

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
    if (!response.ok) {
      const body = isRecord(json) ? json : {};
      const errcode = typeof body.errcode === "string" ? body.errcode.slice(0, 64) : "M_UNKNOWN";
      const message = typeof body.error === "string" && body.error !== "" ? body.error.slice(0, 200) : `HTTP ${response.status}`;
      throw new MatrixError(response.status, errcode, message);
    }
    if (!isRecord(json)) throw new Error("The homeserver sent an unreadable response");
    return json;
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

    async sync(session, since, timeoutMs): Promise<MxSync> {
      const query: Record<string, string> = { filter: SYNC_FILTER, timeout: String(timeoutMs), set_presence: "offline" };
      if (since) query.since = since;
      return parseSync(await call(session.baseUrl, `${CLIENT}/sync`, { token: session.accessToken, query }));
    },

    async messages(session, roomId, from, limit): Promise<MxPage> {
      const query = { dir: "b", from, limit: String(limit), filter: HISTORY_FILTER };
      return parsePage(await call(session.baseUrl, `${room(roomId)}/messages`, { token: session.accessToken, query }));
    },

    async encrypted(session, roomId) {
      try {
        await call(session.baseUrl, `${room(roomId)}/state/m.room.encryption/`, { token: session.accessToken });
        return true;
      } catch (error) {
        // Only a definite "no such state" means unencrypted; anything else is not an answer.
        if (error instanceof MatrixError && error.status === 404 && error.errcode === "M_NOT_FOUND") return false;
        throw error;
      }
    },

    async send(session, roomId, content) {
      const body = await call(session.baseUrl, `${room(roomId)}/send/m.room.message/${txnId()}`, { method: "PUT", token: session.accessToken, body: content });
      const id = eventId(body.event_id);
      if (!id) throw new Error("The homeserver sent an unreadable response");
      return id;
    },

    async redact(session, roomId, id) {
      await call(session.baseUrl, `${room(roomId)}/redact/${encodeURIComponent(id)}/${txnId()}`, { method: "PUT", token: session.accessToken, body: {} });
    },

    async markRead(session, roomId, id) {
      await call(session.baseUrl, `${room(roomId)}/read_markers`, { method: "POST", token: session.accessToken, body: { "m.fully_read": id, "m.read": id } });
    },

    async thumbnail(session, mxc) {
      const parsed = parseMxc(mxc);
      if (!parsed) return undefined;
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

    async logout(session) {
      await call(session.baseUrl, `${CLIENT}/logout`, { method: "POST", token: session.accessToken, body: {} });
    },
  };
}
