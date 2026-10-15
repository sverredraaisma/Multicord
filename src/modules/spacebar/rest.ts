import type { FileSource } from "../../engine/runtime";
import { isRecord, list, parseMember, parseMessage, parseUser, type SpacebarMember, type SpacebarMessage, type SpacebarUser } from "./types";

/** An error from the Spacebar API, with its code where it gave one. */
export class SpacebarApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where a sign-in step leaves the user: signed in, or asked for a second step. */
export type LoginStep = { token: string } | { mfa: true; ticket: string; webauthnOnly: boolean };
/** A password sign-in may also meet a captcha. */
export type LoginResult = LoginStep | { captcha: true };

export interface RestOptions {
  fetch: typeof fetch;
  /** Minimum gap between requests, to stay well under the instance's rate limits. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRIES = 2;
/** Messages per page of history. */
export const PAGE_SIZE = 50;
/** Members per page of a guild's member list. */
export const MEMBER_PAGE = 100;
/** Search results asked for at once. */
export const SEARCH_PAGE = 25;
const READ_CHUNK = 1 << 20;
/** The code an error gets when the instance asks for a captcha. */
export const CAPTCHA_REQUIRED = "CAPTCHA_REQUIRED";

/**
 * The first message an error body carries: Discord's form errors nest it
 * under the field ({ errors: { login: { _errors: [{ message }] } } }).
 */
function errorMessage(body: Record<string, unknown>): string | undefined {
  const nested = (value: unknown, depth: number): string | undefined => {
    if (!isRecord(value) || depth > 4) return undefined;
    for (const e of list(value._errors)) if (isRecord(e) && typeof e.message === "string" && e.message !== "") return e.message;
    for (const child of Object.values(value)) {
      const found = nested(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  const text = nested(body.errors, 0) ?? (typeof body.message === "string" && body.message !== "" ? body.message : undefined);
  return text?.slice(0, 300);
}

/** Throttled REST client for one instance; the token never leaves the engine. */
export class SpacebarRest {
  token: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly base: string,
    private readonly options: RestOptions,
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 100;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Serialises requests with a minimum gap, retrying 429s after the advertised delay. */
  request(method: string, path: string, body?: unknown, raw?: { data: Uint8Array; type: string }): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        const headers: Record<string, string> = this.token ? { Authorization: this.token } : {};
        if (raw) headers["Content-Type"] = raw.type;
        else if (body !== undefined) headers["Content-Type"] = "application/json";
        const response = await this.options.fetch(`${this.base}${path}`, {
          method,
          headers,
          body: raw ? new Uint8Array(raw.data) : body === undefined ? undefined : JSON.stringify(body),
        });
        await this.sleep(this.minIntervalMs);
        if (response.status === 204) return undefined;
        const data: unknown = await response.json().catch(() => undefined);
        if (response.ok) return data;
        const record = isRecord(data) ? data : {};
        if (response.status === 429 && attempt < MAX_RETRIES) {
          const seconds = typeof record.retry_after === "number" && record.retry_after > 0 ? Math.min(record.retry_after, 60) : 1;
          await this.sleep(Math.ceil(seconds * 1000));
          continue;
        }
        // A captcha answers with the captcha's kind instead of a message.
        const code = "captcha_key" in record ? CAPTCHA_REQUIRED : typeof record.code === "number" || typeof record.code === "string" ? String(record.code) : `HTTP_${response.status}`;
        throw new SpacebarApiError(response.status, code, errorMessage(record) ?? `Request failed (HTTP ${response.status})`);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Signs in with an email address (or phone number) and password. */
  async login(login: string, password: string): Promise<LoginResult> {
    let data: unknown;
    try {
      data = await this.request("POST", "/auth/login", { login, password, undelete: false });
    } catch (error) {
      // A captcha Multicord cannot show (hCaptcha, reCAPTCHA): the caller offers another way in.
      if (error instanceof SpacebarApiError && error.code === CAPTCHA_REQUIRED) return { captcha: true };
      throw error;
    }
    return toLoginResult(data);
  }

  /** The second step: an authenticator code or one of the account's backup codes. */
  async loginTotp(code: string, ticket: string): Promise<LoginStep> {
    return toLoginResult(await this.request("POST", "/auth/mfa/totp", { code, ticket }));
  }

  async logout(): Promise<void> {
    await this.request("POST", "/auth/logout", {});
  }

  /** The signed-in user, which also checks a token. */
  async me(): Promise<SpacebarUser | undefined> {
    return parseUser(await this.request("GET", "/users/@me"));
  }

  /** Messages oldest first; `before` pages backwards. */
  async messages(channelId: string, before?: string): Promise<SpacebarMessage[]> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) query.set("before", before);
    const data = await this.request("GET", `/channels/${channelId}/messages?${query}`);
    return list(data)
      .flatMap((m) => parseMessage(m) ?? [])
      .reverse();
  }

  /**
   * Sends a message: as JSON, or with files as multipart/form-data (files[n]
   * beside payload_json), the way Spacebar's server reads uploads.
   */
  async sendMessage(channelId: string, content: string, nonce: string, replyTo?: string, files: FileSource[] = []): Promise<SpacebarMessage | undefined> {
    const payload: Record<string, unknown> = { content, nonce };
    if (replyTo) payload.message_reference = { message_id: replyTo, channel_id: channelId };
    if (files.length === 0) return parseMessage(await this.request("POST", `/channels/${channelId}/messages`, payload));
    const boundary = `----multicord${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`)];
    for (const [index, file] of files.entries()) {
      const name = file.filename.replace(/[\r\n"\\]/g, "_");
      const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ? file.contentType : "application/octet-stream";
      parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="files[${index}]"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`));
      for (let start = 0; start < file.size; start += READ_CHUNK) {
        const chunk = await file.read(start, Math.min(file.size, start + READ_CHUNK));
        parts.push(chunk.subarray(0, Math.min(chunk.length, file.size - start)));
      }
      parts.push(encoder.encode("\r\n"));
    }
    parts.push(encoder.encode(`--${boundary}--\r\n`));
    const body = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      body.set(part, offset);
      offset += part.length;
    }
    return parseMessage(await this.request("POST", `/channels/${channelId}/messages`, undefined, { data: body, type: `multipart/form-data; boundary=${boundary}` }));
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<SpacebarMessage | undefined> {
    return parseMessage(await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { content }));
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  /** emoji is the Unicode character or name:id; it is URI-encoded into the path. */
  async react(channelId: string, messageId: string, emoji: string, add: boolean): Promise<void> {
    await this.request(add ? "PUT" : "DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  /** A channel's pinned messages, newest pin first (GET /channels/{id}/pins, which lists them all at once). */
  async pins(channelId: string): Promise<SpacebarMessage[]> {
    return list(await this.request("GET", `/channels/${channelId}/pins`)).flatMap((m) => parseMessage(m) ?? []);
  }

  /**
   * Searches one guild channel's messages for text (the first SEARCH_PAGE,
   * newest first), through the guild's search route; Spacebar answers with
   * each hit wrapped in a list of its own, as Discord does.
   */
  async search(guildId: string, channelId: string, query: string): Promise<SpacebarMessage[]> {
    const params = new URLSearchParams({ channel_id: channelId, content: query, limit: String(SEARCH_PAGE) });
    const data = await this.request("GET", `/guilds/${guildId}/messages/search?${params}`);
    return list(isRecord(data) ? data.messages : undefined).flatMap((hit) => parseMessage(list(hit)[0]) ?? []);
  }

  async pin(channelId: string, messageId: string, pin: boolean): Promise<void> {
    await this.request(pin ? "PUT" : "DELETE", `/channels/${channelId}/pins/${messageId}`);
  }

  /** Changes the user's notification settings for a guild (merged into what is stored), and returns them as stored. */
  async setGuildSettings(guildId: string, changes: Record<string, unknown>): Promise<unknown> {
    return this.request("PATCH", `/users/@me/guilds/${guildId}/settings`, changes);
  }

  async typing(channelId: string): Promise<void> {
    await this.request("POST", `/channels/${channelId}/typing`);
  }

  /** Marks a channel read up to a message. */
  async ack(channelId: string, messageId: string): Promise<void> {
    await this.request("POST", `/channels/${channelId}/messages/${messageId}/ack`, {});
  }

  /** One page of a guild's members, by user id; `after` continues after that id. */
  async members(guildId: string, after?: string): Promise<SpacebarMember[]> {
    const query = new URLSearchParams({ limit: String(MEMBER_PAGE) });
    if (after) query.set("after", after);
    return list(await this.request("GET", `/guilds/${guildId}/members?${query}`)).flatMap((m) => parseMember(m) ?? []);
  }
}

function toLoginResult(data: unknown): LoginStep {
  const record = isRecord(data) ? data : {};
  if (typeof record.token === "string" && record.token !== "") return { token: record.token };
  if (record.mfa === true && typeof record.ticket === "string" && record.ticket !== "") {
    // With a security key on the account, Spacebar asks for that instead of a code.
    return { mfa: true, ticket: record.ticket, webauthnOnly: record.webauthn !== undefined && record.webauthn !== null };
  }
  throw new SpacebarApiError(200, "UNEXPECTED_RESPONSE", "Unexpected sign-in response");
}
