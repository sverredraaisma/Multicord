import type { FileSource } from "../../engine/runtime";
import { captchaToken, isAltchaChallenge, solveAltcha, type AltchaChallenge } from "./captcha";
import { isRecord, parseChannel, parseGif, parseMessage, parseUser, type FluxerChannel, type FluxerGif, type FluxerMessage, type FluxerUser } from "./types";

/** Error from the Fluxer API, carrying its error code (e.g. CAPTCHA_REQUIRED). */
export class FluxerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** A file to attach: its size must be exact, as Fluxer checks it. */
/** A file to upload; see FileSource. */
export type UploadSource = FileSource;

/** What a sent message claims for each uploaded file. */
export interface UploadedAttachment {
  id: number;
  filename: string;
  upload_filename: string;
  file_size: number;
  content_type: string;
}

export type LoginResult =
  | { token: string; user?: FluxerUser }
  | { mfa: true; ticket: string; totp: boolean; backupCodes: boolean };

export interface RestOptions {
  fetch: typeof fetch;
  /** Minimum gap between requests. A global 429 revokes a user token, so stay far below 50/s. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  solveCaptcha?: typeof solveAltcha;
}

const MAX_RETRIES = 2;
const MAX_CAPTCHA_ATTEMPTS = 2;

/** Throttled REST client for one instance; the token never leaves the engine. */
export class FluxerRest {
  token: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly solveCaptcha: typeof solveAltcha;

  constructor(
    private readonly base: string,
    private readonly options: RestOptions,
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 100;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.solveCaptcha = options.solveCaptcha ?? solveAltcha;
  }

  /** Serialises requests with a minimum gap, retrying 429s after the advertised delay. */
  request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        const response = await this.options.fetch(`${this.base}${path}`, {
          method,
          headers: {
            // Without this capability, thread and forum routes answer 404.
            "X-Fluxer-Features": "channel_threads",
            ...(this.token ? { Authorization: this.token } : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        await this.sleep(this.minIntervalMs);
        if (response.status === 204) return undefined;
        const data: unknown = await response.json().catch(() => undefined);
        if (response.ok) return data;
        const record = isRecord(data) ? data : {};
        if (response.status === 429 && attempt < MAX_RETRIES) {
          const seconds = typeof record.retry_after === "number" ? record.retry_after : 1;
          await this.sleep(Math.ceil(seconds * 1000));
          continue;
        }
        const code = typeof record.code === "string" ? record.code : `HTTP_${response.status}`;
        const message = typeof record.message === "string" ? record.message : `Request failed (HTTP ${response.status})`;
        throw new FluxerApiError(response.status, code, message, data);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Logs in, solving the instance's proof-of-work captcha when it asks for one. */
  async login(identity: "email" | "username", value: string, password: string): Promise<LoginResult> {
    const body = identity === "email" ? { email: value, password } : { login: value, password };
    let headers: Record<string, string> = {};
    for (let attempt = 0; ; attempt++) {
      try {
        return toLoginResult(await this.request("POST", "/auth/login", body, headers));
      } catch (error) {
        const challenge = captchaChallenge(error);
        if (!challenge || attempt >= MAX_CAPTCHA_ATTEMPTS) throw error;
        headers = { "X-Captcha-Token": captchaToken(challenge, await this.solveCaptcha(challenge)) };
      }
    }
  }

  async loginTotp(code: string, ticket: string): Promise<LoginResult> {
    return toLoginResult(await this.request("POST", "/auth/login/mfa/totp", { code, ticket }));
  }

  async logout(): Promise<void> {
    await this.request("POST", "/auth/logout");
  }

  /** Messages oldest first; `before` pages backwards. */
  async messages(channelId: string, before?: string): Promise<FluxerMessage[]> {
    const query = new URLSearchParams({ limit: "50" });
    if (before) query.set("before", before);
    const data = await this.request("GET", `/channels/${channelId}/messages?${query}`);
    return (Array.isArray(data) ? data : []).flatMap((m) => parseMessage(m) ?? []).reverse();
  }

  async sendMessage(
    channelId: string,
    content: string,
    nonce: string,
    replyTo?: string,
    attachments: UploadedAttachment[] = [],
    stickerIds: string[] = [],
  ): Promise<FluxerMessage | undefined> {
    const body: Record<string, unknown> = { content, nonce };
    if (replyTo) body.message_reference = { message_id: replyTo };
    if (attachments.length > 0) body.attachments = attachments;
    if (stickerIds.length > 0) body.sticker_ids = stickerIds;
    return parseMessage(await this.request("POST", `/channels/${channelId}/messages`, body));
  }

  /** Searches the instance's GIF provider; an empty query asks for its trending GIFs. */
  async gifs(query: string): Promise<FluxerGif[]> {
    const path = query === "" ? "/gifs/trending" : `/gifs/search?${new URLSearchParams({ q: query })}`;
    const data = await this.request("GET", path);
    return (Array.isArray(data) ? data : []).flatMap((g) => parseGif(g) ?? []);
  }

  /**
   * Uploads files with Fluxer's presigned flow: plan the uploads, PUT the
   * bytes (in parts for large files) to the returned URLs without our token,
   * complete multipart uploads, and return what the message must claim.
   */
  async upload(channelId: string, files: UploadSource[]): Promise<UploadedAttachment[]> {
    const plan = await this.request("POST", `/channels/${channelId}/attachments`, {
      attachments: files.map((f, id) => ({ id, filename: f.filename, file_size: f.size, content_type: f.contentType })),
    });
    const entries = isRecord(plan) && Array.isArray(plan.attachments) ? plan.attachments : [];
    if (entries.length !== files.length) throw new FluxerApiError(200, "UNEXPECTED_RESPONSE", "Unexpected upload plan", plan);

    const multipart: { upload_filename: string; upload_id: string }[] = [];
    const claimed: UploadedAttachment[] = [];
    for (const [index, raw] of entries.entries()) {
      const entry = isRecord(raw) ? raw : {};
      const file = files[index]!;
      const uploadFilename = typeof entry.upload_filename === "string" ? entry.upload_filename : "";
      const contentType = typeof entry.content_type === "string" ? entry.content_type : file.contentType;
      if (!uploadFilename) throw new FluxerApiError(200, "UNEXPECTED_RESPONSE", "Unexpected upload plan", plan);
      if (typeof entry.upload_url === "string") {
        await this.put(entry.upload_url, await file.read(0, file.size), contentType);
      } else if (typeof entry.upload_id === "string" && typeof entry.part_size === "number" && Array.isArray(entry.parts)) {
        for (const part of entry.parts) {
          const number = isRecord(part) && typeof part.part_number === "number" ? part.part_number : 0;
          const url = isRecord(part) && typeof part.upload_url === "string" ? part.upload_url : "";
          if (number < 1 || !url) throw new FluxerApiError(200, "UNEXPECTED_RESPONSE", "Unexpected upload plan", plan);
          const start = (number - 1) * entry.part_size;
          await this.put(url, await file.read(start, Math.min(file.size, start + entry.part_size)), contentType);
        }
        multipart.push({ upload_filename: uploadFilename, upload_id: entry.upload_id });
      } else {
        throw new FluxerApiError(200, "UNEXPECTED_RESPONSE", "Unexpected upload plan", plan);
      }
      claimed.push({ id: index, filename: file.filename, upload_filename: uploadFilename, file_size: file.size, content_type: contentType });
    }
    if (multipart.length > 0) await this.request("POST", `/channels/${channelId}/attachments/complete`, { uploads: multipart });
    return claimed;
  }

  /** PUTs bytes to a presigned URL as-is; it carries its own authorisation. */
  private async put(url: string, data: Uint8Array, contentType: string): Promise<void> {
    const body = new Uint8Array(data); // an ArrayBuffer-backed copy, as fetch bodies require
    const response = await this.options.fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body });
    if (!response.ok) throw new FluxerApiError(response.status, `HTTP_${response.status}`, `Upload failed (HTTP ${response.status})`, undefined);
  }

  /** Starts a forum post: a thread whose first message is `content`. */
  async createPost(forumId: string, name: string, content: string): Promise<FluxerChannel | undefined> {
    return parseChannel(await this.request("POST", `/channels/${forumId}/threads`, { name, message: { content } }));
  }

  async typing(channelId: string): Promise<void> {
    await this.request("POST", `/channels/${channelId}/typing`);
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<FluxerMessage | undefined> {
    return parseMessage(await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { content }));
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  /** emoji is the Unicode character or name:id; it is URI-encoded into the path. */
  async react(channelId: string, messageId: string, emoji: string, add: boolean): Promise<void> {
    const path = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
    await this.request(add ? "PUT" : "DELETE", path);
  }

  async ack(channelId: string, messageId: string): Promise<void> {
    await this.request("POST", "/read-states/ack", { read_states: [{ channel_id: channelId, message_id: messageId }] });
  }
}

function captchaChallenge(error: unknown): AltchaChallenge | undefined {
  if (!(error instanceof FluxerApiError)) return undefined;
  if (error.code !== "CAPTCHA_REQUIRED" && error.code !== "INVALID_CAPTCHA") return undefined;
  const challenge = isRecord(error.body) ? error.body.altcha_challenge : undefined;
  return isAltchaChallenge(challenge) ? challenge : undefined;
}

function toLoginResult(data: unknown): LoginResult {
  const record = isRecord(data) ? data : {};
  if (typeof record.token === "string" && record.token !== "") return { token: record.token, user: parseUser(record.user) };
  if (record.mfa === true && typeof record.ticket === "string") {
    return { mfa: true, ticket: record.ticket, totp: record.totp !== false, backupCodes: record.backup_codes === true };
  }
  throw new FluxerApiError(200, "UNEXPECTED_RESPONSE", "Unexpected login response", data);
}
