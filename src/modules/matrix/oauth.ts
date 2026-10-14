// Matrix's OAuth 2.0 API (MSC3861 and friends, now in the spec): how
// homeservers that hand accounts to an authorization server, such as
// matrix.org and its account service, let apps sign in. Multicord uses the
// device authorization grant (RFC 8628): it shows a code, the user approves
// it in their browser, and Multicord gets a token for a device of its own.
// Everything the servers send is untrusted and checked here.

import type { MxOAuthSession } from "./api";
import { isRecord } from "./events";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** What Multicord registers itself as (RFC 7591). The account service shows the name and links the URI. */
export const CLIENT_METADATA = {
  client_name: "Multicord",
  client_uri: "https://github.com/sverredraaisma/Multicord",
  application_type: "native",
  token_endpoint_auth_method: "none",
  grant_types: [DEVICE_GRANT, "refresh_token"],
} as const;

/** Scopes for full API access on one device: the spec's names, and the MSC2967 names older servers know. */
export const SCOPES = {
  stable: (device: string) => `openid urn:matrix:client:api:* urn:matrix:client:device:${device}`,
  unstable: (device: string) => `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${device}`,
};

const MAX_URL = 2000;
const MAX_TOKEN = 4096;
/** Codes are short and typed by hand; anything else is not shown. */
const USER_CODE = /^[A-Za-z0-9 -]{1,32}$/;
const TOKEN = /^[\x21-\x7e]+$/;
const DEVICE_ID = /^[A-Z0-9]{10}$/;
const DEFAULT_INTERVAL_S = 5;
const MAX_INTERVAL_S = 60;
const MAX_EXPIRY_S = 3600;
const MAX_TOKEN_LIFETIME_S = 10 * 365 * 24 * 3600;

/** The authorization server's endpoints Multicord uses. */
export interface OAuthServer {
  issuer: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
}

/** A device authorization in progress: the code the user confirms, and where. */
export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** The same page with the code filled in, when the server offers one. */
  verificationUriComplete?: string;
  /** When the code stops working, epoch ms. */
  expiresAt: number;
  /** How long to wait between polls, ms. */
  interval: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

export type DevicePoll = { state: "pending" | "slow_down" | "denied" | "expired" } | { state: "done"; tokens: OAuthTokens };

/** An OAuth error response (RFC 6749 section 5.2), with its error code. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface MatrixOAuth {
  /** The homeserver's authorization server, or undefined when it has none that can sign Multicord in. */
  discover(baseUrl: string): Promise<OAuthServer | undefined>;
  /** Registers Multicord with the server; returns its client id. */
  register(server: OAuthServer): Promise<string>;
  /** Starts a device authorization for a device with this id. */
  authorizeDevice(server: OAuthServer, clientId: string, deviceId: string): Promise<DeviceGrant>;
  /** Asks once whether the user approved the code. */
  pollDevice(server: OAuthServer, clientId: string, deviceCode: string): Promise<DevicePoll>;
  refresh(session: MxOAuthSession): Promise<OAuthTokens>;
  /** Revokes a token, which ends the session (and its device) on the server. */
  revoke(session: MxOAuthSession, token: string, hint: "access_token" | "refresh_token"): Promise<void>;
}

/** An https URL without credentials, as a string; undefined for anything else. */
export function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A device id for the scope: ten letters and digits, as Element makes them. */
export function newDeviceId(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  // 252 is the largest multiple of 36 below 256: rejecting above it keeps every character equally likely.
  let id = "";
  while (id.length < 10) {
    for (const byte of random(new Uint8Array(16))) if (byte < 252 && id.length < 10) id += alphabet[byte % 36];
  }
  return id;
}

/** The server's metadata, if it is usable for device sign-in. */
export function parseServer(raw: unknown): OAuthServer | undefined {
  if (!isRecord(raw)) return undefined;
  const issuer = httpsUrl(raw.issuer);
  const deviceEndpoint = httpsUrl(raw.device_authorization_endpoint);
  const tokenEndpoint = httpsUrl(raw.token_endpoint);
  const registrationEndpoint = httpsUrl(raw.registration_endpoint);
  if (!issuer || !deviceEndpoint || !tokenEndpoint || !registrationEndpoint) return undefined;
  // A server that lists its grants must list the device grant.
  if (Array.isArray(raw.grant_types_supported) && !raw.grant_types_supported.includes(DEVICE_GRANT)) return undefined;
  const server: OAuthServer = { issuer, deviceEndpoint, tokenEndpoint, registrationEndpoint };
  const revocationEndpoint = httpsUrl(raw.revocation_endpoint);
  if (revocationEndpoint) server.revocationEndpoint = revocationEndpoint;
  return server;
}

const seconds = (value: unknown, fallback: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;

export function parseTokens(raw: unknown, now: number): OAuthTokens {
  const body = isRecord(raw) ? raw : {};
  const token = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_TOKEN && TOKEN.test(value);
  if (!token(body.access_token) || (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer")) {
    throw new Error("The account server sent an unreadable token response");
  }
  const tokens: OAuthTokens = { accessToken: body.access_token };
  if (token(body.refresh_token)) tokens.refreshToken = body.refresh_token;
  if (typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0) {
    tokens.expiresAt = now + Math.min(body.expires_in, MAX_TOKEN_LIFETIME_S) * 1000;
  }
  return tokens;
}

export function parseDeviceGrant(raw: unknown, now: number): DeviceGrant {
  const body = isRecord(raw) ? raw : {};
  const verificationUri = httpsUrl(body.verification_uri);
  const { device_code: deviceCode, user_code: userCode } = body;
  if (typeof deviceCode !== "string" || deviceCode === "" || deviceCode.length > MAX_TOKEN || typeof userCode !== "string" || !USER_CODE.test(userCode) || !verificationUri) {
    throw new Error("The account server sent an unreadable sign-in code");
  }
  const grant: DeviceGrant = {
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: now + seconds(body.expires_in, 600, MAX_EXPIRY_S) * 1000,
    interval: seconds(body.interval, DEFAULT_INTERVAL_S, MAX_INTERVAL_S) * 1000,
  };
  const complete = httpsUrl(body.verification_uri_complete);
  if (complete) grant.verificationUriComplete = complete;
  return grant;
}

/** OAuth over plain fetch (in the engine, the shell's HTTP bridge). */
export function createOAuthClient(fetchFn: typeof fetch, now: () => number = Date.now): MatrixOAuth {
  async function getJson(url: string): Promise<unknown> {
    try {
      const response = await fetchFn(url, { headers: { Accept: "application/json" } });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  }

  /** POSTs a form (or JSON); OAuth error responses become OAuthErrors. */
  async function post(url: string, body: Record<string, string> | object, json = false): Promise<unknown> {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded" },
      body: json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString(),
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = isRecord(parsed) ? parsed : {};
      const code = typeof error.error === "string" ? error.error.slice(0, 64) : "server_error";
      const description = typeof error.error_description === "string" && error.error_description !== "" ? error.error_description.slice(0, 200) : `HTTP ${response.status}`;
      throw new OAuthError(code, description);
    }
    return parsed;
  }

  return {
    async discover(baseUrl) {
      for (const path of ["/_matrix/client/v1/auth_metadata", "/_matrix/client/unstable/org.matrix.msc2965/auth_metadata"]) {
        const server = parseServer(await getJson(`${baseUrl}${path}`));
        if (server) return server;
      }
      // The oldest form names only the issuer, whose OpenID configuration has the rest.
      const issued = await getJson(`${baseUrl}/_matrix/client/unstable/org.matrix.msc2965/auth_issuer`);
      const issuer = isRecord(issued) ? httpsUrl(issued.issuer) : undefined;
      if (!issuer) return undefined;
      const server = parseServer(await getJson(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`));
      // The configuration must be the issuer's own.
      return server?.issuer === issuer ? server : undefined;
    },

    async register(server) {
      const body = await post(server.registrationEndpoint, CLIENT_METADATA, true);
      const clientId = isRecord(body) ? body.client_id : undefined;
      if (typeof clientId !== "string" || clientId === "" || clientId.length > 255) throw new Error("The account server sent an unreadable registration");
      // A server may accept the registration but drop grants it does not allow.
      if (isRecord(body) && Array.isArray(body.grant_types) && !body.grant_types.includes(DEVICE_GRANT)) {
        throw new OAuthError("unauthorized_client", "This server does not let apps sign in with a code");
      }
      return clientId;
    },

    async authorizeDevice(server, clientId, deviceId) {
      if (!DEVICE_ID.test(deviceId)) throw new Error("Invalid device id");
      const ask = (scope: string) => post(server.deviceEndpoint, { client_id: clientId, scope });
      let body: unknown;
      try {
        body = await ask(SCOPES.stable(deviceId));
      } catch (error) {
        // Servers from before the scopes were in the spec only know the MSC2967 names.
        if (!(error instanceof OAuthError) || error.code !== "invalid_scope") throw error;
        body = await ask(SCOPES.unstable(deviceId));
      }
      return parseDeviceGrant(body, now());
    },

    async pollDevice(server, clientId, deviceCode) {
      try {
        const body = await post(server.tokenEndpoint, { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId });
        return { state: "done", tokens: parseTokens(body, now()) };
      } catch (error) {
        // matrix.org's account service answers "pending" with 403, others with 400: the code is what counts.
        if (!(error instanceof OAuthError)) throw error;
        switch (error.code) {
          case "authorization_pending":
            return { state: "pending" };
          case "slow_down":
            return { state: "slow_down" };
          case "access_denied":
            return { state: "denied" };
          case "expired_token":
            return { state: "expired" };
          default:
            throw error;
        }
      }
    },

    async refresh(session) {
      if (!session.refreshToken) throw new OAuthError("invalid_grant", "No refresh token");
      const body = await post(session.tokenEndpoint, { grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: session.clientId });
      const tokens = parseTokens(body, now());
      // Servers may keep the refresh token as it was.
      tokens.refreshToken ??= session.refreshToken;
      return tokens;
    },

    async revoke(session, token, hint) {
      if (!session.revocationEndpoint) return;
      await post(session.revocationEndpoint, { token, token_type_hint: hint, client_id: session.clientId });
    },
  };
}
