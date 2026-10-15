import type { FileSource } from "../../engine/runtime";
import { isRecord, parseMessage, parseUnread, parseUser, type StoatMessage, type StoatUnread, type StoatUser } from "./types";

/** Error from the Stoat API, carrying its error type (e.g. InvalidCredentials). */
export class StoatApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where an instance's services live, from the API root's configuration. */
export interface StoatInstance {
  /** REST base, e.g. https://stoat.chat/api */
  api: string;
  /** Bonfire events WebSocket, e.g. wss://events.stoat.chat */
  ws: string;
  /** Autumn file server, for avatars, icons and uploads; absent when the instance has none. */
  autumn?: string;
}

export type LoginResult =
  | { token: string; userId?: string }
  | { mfa: true; ticket: string; totp: boolean; recovery: boolean };

/** What the second sign-in step sends: an authenticator code or a recovery code. */
export type MfaResponse = { totp_code: string } | { recovery_code: string };

export interface RestOptions {
  fetch: typeof fetch;
  /** Minimum gap between requests; Stoat's buckets allow about 10 messages per 10 s. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRIES = 2;
/** Files are read in pieces the shell's file bridge accepts. */
const READ_CHUNK = 8 * 1024 * 1024;
/** Multicord names its sessions honestly in the user's session list. */
export const FRIENDLY_NAME = "Multicord";

/** Readable text for the error types users can run into. */
const MESSAGES: Record<string, string> = {
  InvalidCredentials: "Wrong email or password.",
  InvalidToken: "That code is not valid.",
  InvalidSession: "Your session has ended. Please sign in again.",
  UnverifiedAccount: "Please verify your email address first.",
  DisabledAccount: "This account is disabled.",
  LockedOut: "Too many attempts. Please try again later.",
  CaptchaFailed: "This instance asks for a captcha, which Multicord cannot show.",
  MissingPermission: "You do not have permission to do that.",
  FileTooLarge: "The file is too large for this instance.",
  TooManyAttachments: "Too many attachments for one message.",
  PayloadTooLarge: "The message is too long.",
};

const https = (value: unknown, scheme: "https:" | "wss:"): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).protocol === scheme ? value.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads an instance's configuration from its API root (<origin>/api/), which
 * names the events WebSocket and the file server. URLs are used as published.
 */
export async function discoverInstance(origin: string, fetchFn: typeof fetch): Promise<StoatInstance> {
  const api = new URL("/api", origin).href;
  const response = await fetchFn(`${api}/`, { redirect: "follow" });
  if (!response.ok) throw new Error(`Instance discovery failed (HTTP ${response.status})`);
  const body: unknown = await response.json().catch(() => undefined);
  const config = isRecord(body) ? body : {};
  const ws = https(config.ws, "wss:");
  if (!ws) throw new Error("This does not look like a Stoat instance");
  const features = isRecord(config.features) ? config.features : {};
  const autumn = isRecord(features.autumn) && features.autumn.enabled !== false ? https(features.autumn.url, "https:") : undefined;
  return { api, ws, autumn };
}

/** The hosts an instance uses: its API, events WebSocket and file server. */
export function instanceHosts(instance: StoatInstance): string[] {
  const urls = [instance.api, instance.ws, ...(instance.autumn ? [instance.autumn] : [])];
  return [...new Set(urls.map((url) => new URL(url).hostname.toLowerCase()))];
}

/** Throttled REST client for one instance; the session token never leaves the engine. */
export class StoatRest {
  token: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly instance: StoatInstance,
    private readonly options: RestOptions,
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 100;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** An API call; see send(). */
  request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const json = body === undefined ? undefined : JSON.stringify(body);
    return this.send(`${this.instance.api}${path}`, method, json, { ...(json === undefined ? {} : { "Content-Type": "application/json" }), ...headers });
  }

  /** Serialises requests with a minimum gap, retrying 429s after the advertised delay. */
  private send(url: string, method: string, body: string | Uint8Array | undefined, headers: Record<string, string>): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        const response = await this.options.fetch(url, {
          method,
          headers: { ...(this.token ? { "X-Session-Token": this.token } : {}), ...headers },
          body: body as BodyInit | undefined,
        });
        await this.sleep(this.minIntervalMs);
        if (response.status === 204) return undefined;
        const data: unknown = await response.json().catch(() => undefined);
        if (response.ok) return data;
        const record = isRecord(data) ? data : {};
        if (response.status === 429 && attempt < MAX_RETRIES) {
          // Stoat gives the wait in milliseconds, in a header and in the body.
          const header = Number(response.headers.get("x-ratelimit-reset-after"));
          const wait = Number.isFinite(header) && header > 0 ? header : typeof record.retry_after === "number" ? record.retry_after : 1000;
          await this.sleep(Math.min(Math.ceil(wait), 60_000));
          continue;
        }
        const type = typeof record.type === "string" ? record.type : `HTTP_${response.status}`;
        throw new StoatApiError(response.status, type, MESSAGES[type] ?? `Request failed (${type})`);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    return toLoginResult(await this.request("POST", "/auth/session/login", { email, password, friendly_name: FRIENDLY_NAME }));
  }

  async loginMfa(ticket: string, response: MfaResponse): Promise<LoginResult> {
    return toLoginResult(await this.request("POST", "/auth/session/login", { mfa_ticket: ticket, mfa_response: response, friendly_name: FRIENDLY_NAME }));
  }

  /** Deletes this session on the server, so the token cannot be used again. */
  async logout(): Promise<void> {
    await this.request("POST", "/auth/session/logout");
  }

  /** Messages oldest first, with their authors; `before` pages backwards. */
  async messages(channelId: string, before?: string): Promise<{ messages: StoatMessage[]; users: StoatUser[] }> {
    const query = new URLSearchParams({ limit: "50", include_users: "true", sort: "Latest" });
    if (before) query.set("before", before);
    const data = await this.request("GET", `/channels/${channelId}/messages?${query}`);
    const record = isRecord(data) ? data : { messages: data };
    const users = (Array.isArray(record.users) ? record.users : []).flatMap((u) => parseUser(u) ?? []);
    const messages = (Array.isArray(record.messages) ? record.messages : []).flatMap((m) => parseMessage(m) ?? []).reverse();
    return { messages, users };
  }

  /** Sends a message; the idempotency key stops a retried request from posting twice. */
  async sendMessage(channelId: string, content: string, nonce: string, replyTo?: string, attachments: string[] = []): Promise<StoatMessage | undefined> {
    const body: Record<string, unknown> = {};
    if (content !== "") body.content = content;
    if (replyTo) body.replies = [{ id: replyTo, mention: false }];
    if (attachments.length > 0) body.attachments = attachments;
    return parseMessage(await this.request("POST", `/channels/${channelId}/messages`, body, { "Idempotency-Key": nonce }));
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<StoatMessage | undefined> {
    return parseMessage(await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { content }));
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  /** emoji is a Unicode emoji or a custom emoji id; it is URI-encoded into the path. */
  async react(channelId: string, messageId: string, emoji: string, add: boolean): Promise<void> {
    await this.request(add ? "PUT" : "DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  async ack(channelId: string, messageId: string): Promise<void> {
    await this.request("PUT", `/channels/${channelId}/ack/${messageId}`);
  }

  async unreads(): Promise<StoatUnread[]> {
    const data = await this.request("GET", "/sync/unreads");
    return (Array.isArray(data) ? data : []).flatMap((u) => parseUnread(u) ?? []);
  }

  /** Synced user settings by key; each value is [timestamp, JSON text]. */
  async settings(keys: string[]): Promise<Record<string, unknown>> {
    const data = await this.request("POST", "/sync/settings/fetch", { keys });
    return isRecord(data) ? data : {};
  }

  /** Saves synced user settings: each key's value is JSON text, stamped with the time it changed. */
  async setSettings(values: Record<string, string>, now: number = Date.now()): Promise<void> {
    await this.request("POST", `/sync/settings/set?timestamp=${now}`, values);
  }

  /**
   * Uploads a file to Autumn's attachments bucket as multipart form data and
   * returns its id, which a message then claims.
   */
  async upload(file: FileSource): Promise<string> {
    if (!this.instance.autumn) throw new StoatApiError(0, "NoFileServer", "This instance does not accept files.");
    const boundary = `----multicord${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const name = file.filename.replace(/[\r\n"\\]/g, "_");
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ? file.contentType : "application/octet-stream";
    const encoder = new TextEncoder();
    const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + file.size + tail.length);
    body.set(head, 0);
    for (let start = 0; start < file.size; start += READ_CHUNK) {
      const chunk = await file.read(start, Math.min(file.size, start + READ_CHUNK));
      body.set(chunk.subarray(0, file.size - start), head.length + start);
    }
    body.set(tail, head.length + file.size);
    const data = await this.send(`${this.instance.autumn}/attachments`, "POST", body, { "Content-Type": `multipart/form-data; boundary=${boundary}` });
    const id = isRecord(data) ? data.id : undefined;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new StoatApiError(200, "UnexpectedResponse", "Unexpected upload response");
    return id;
  }
}

function toLoginResult(data: unknown): LoginResult {
  const record = isRecord(data) ? data : {};
  if (record.result === "Success" && typeof record.token === "string" && record.token !== "") {
    return { token: record.token, userId: typeof record.user_id === "string" ? record.user_id : undefined };
  }
  if (record.result === "MFA" && typeof record.ticket === "string") {
    const methods = Array.isArray(record.allowed_methods) ? record.allowed_methods : [];
    return { mfa: true, ticket: record.ticket, totp: methods.includes("Totp"), recovery: methods.includes("Recovery") };
  }
  if (record.result === "Disabled") throw new StoatApiError(200, "DisabledAccount", MESSAGES.DisabledAccount!);
  throw new StoatApiError(200, "UnexpectedResponse", "Unexpected login response");
}
