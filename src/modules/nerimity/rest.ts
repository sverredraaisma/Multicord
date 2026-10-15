import type { FileSource } from "../../engine/runtime";
import { isRecord, list, parseMessage, parseReactionCount, parseUser, type NerimityMessage, type NerimityReaction, type NerimityUser } from "./types";

/** An error from Nerimity's API or CDN, with the server's own message where it gave one. */
export class NerimityApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RestOptions {
  fetch: typeof fetch;
  /** Minimum gap between requests, to stay well under the server's rate limits. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** What a reaction request names: the Unicode emoji, or a custom emoji with its id and file kind. */
export interface ReactionTarget {
  name: string;
  emojiId?: string;
  gif?: boolean;
  webp?: boolean;
}

const MAX_RETRIES = 2;
/** Messages per page of history (the server allows up to 100). */
export const PAGE_SIZE = 50;
/** Pins per page, as the server gives them. */
export const PIN_PAGE = 10;
/** Search results asked for at once. */
export const SEARCH_PAGE = 25;
/** The longest search text the server takes. */
export const MAX_SEARCH = 50;
/** The CDN takes files up to 50 MB. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const READ_CHUNK = 1 << 20;

/** The message an error body carries: { message } from the API, { error } or plain text elsewhere. */
function errorMessage(data: unknown): string | undefined {
  const text = typeof data === "string" ? data : isRecord(data) ? (typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : undefined) : undefined;
  return text?.trim() ? text.trim().slice(0, 300) : undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Throttled REST client for one instance's API (https://<host>/api); the token never leaves the engine. */
export class NerimityRest {
  token: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly base: string,
    private readonly options: RestOptions,
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 150;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Serialises requests with a minimum gap, retrying a 429 once its wait is
   * over. Nerimity bans from a server whoever keeps sending into its limit,
   * so the gap matters.
   */
  request(method: string, path: string, body?: unknown, url?: string, raw?: { data: Uint8Array; headers: Record<string, string> }): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        const headers: Record<string, string> = this.token ? { Authorization: this.token } : {};
        if (raw) Object.assign(headers, raw.headers);
        else if (body !== undefined) headers["Content-Type"] = "application/json";
        const response = await this.options.fetch(url ?? `${this.base}${path}`, {
          method,
          headers,
          body: raw ? new Uint8Array(raw.data) : body === undefined ? undefined : JSON.stringify(body),
        });
        await this.sleep(this.minIntervalMs);
        if (response.status === 204) return undefined;
        const data = await readBody(response);
        if (response.ok) return data;
        if (response.status === 429 && attempt < MAX_RETRIES) {
          // The server says how long in milliseconds (ttl).
          const ms = isRecord(data) && typeof data.ttl === "number" && data.ttl > 0 ? Math.min(data.ttl, 60_000) : 1000;
          await this.sleep(Math.ceil(ms));
          continue;
        }
        throw new NerimityApiError(response.status, errorMessage(data) ?? `Request failed (HTTP ${response.status})`);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Signs in with an email address or username:tag and password; Nerimity has no second step. */
  async login(identity: string, password: string): Promise<string> {
    const data = await this.request("POST", "/users/login", identity.includes("@") ? { email: identity, password } : { usernameAndTag: identity, password });
    if (isRecord(data) && typeof data.token === "string" && data.token !== "") return data.token;
    throw new NerimityApiError(200, "Unexpected sign-in response");
  }

  /** Ends this session on the server, so the token cannot be used again. */
  async logout(): Promise<void> {
    await this.request("DELETE", "/users/logout");
  }

  /** The signed-in user, which also checks a token. */
  async me(): Promise<NerimityUser | undefined> {
    const data = await this.request("GET", "/users");
    return parseUser(isRecord(data) ? data.user : undefined);
  }

  /** Messages oldest first; `before` pages backwards. */
  async messages(channelId: string, before?: string): Promise<NerimityMessage[]> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) query.set("before", before);
    return list(await this.request("GET", `/channels/${channelId}/messages?${query}`)).flatMap((m) => parseMessage(m) ?? []);
  }

  /** Sends a message: text, a reply (which notifies whom it answers, as Nerimity's client does by default), or a file uploaded to the CDN. */
  async sendMessage(channelId: string, content: string, replyTo?: string, fileId?: string): Promise<NerimityMessage | undefined> {
    const body: Record<string, unknown> = {};
    if (content.trim() !== "") body.content = content;
    if (replyTo) Object.assign(body, { replyToMessageIds: [replyTo], mentionReplies: true });
    if (fileId) body.nerimityCdnFileId = fileId;
    return parseMessage(await this.request("POST", `/channels/${channelId}/messages`, body));
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<NerimityMessage | undefined> {
    return parseMessage(await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { content }));
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  /** Adds or removes the user's reaction; the answer says how many now reacted with it. */
  async react(channelId: string, messageId: string, target: ReactionTarget, add: boolean): Promise<NerimityReaction | undefined> {
    const body: Record<string, unknown> = { name: target.name };
    if (target.emojiId) Object.assign(body, { emojiId: target.emojiId, gif: target.gif === true, webp: target.webp === true });
    return parseReactionCount(await this.request("POST", `/channels/${channelId}/messages/${messageId}/reactions${add ? "" : "/remove"}`, body));
  }

  /** One page of a channel's pins (PIN_PAGE, newest pin first); `after` continues after that pinned message. */
  async pins(channelId: string, after?: string): Promise<NerimityMessage[]> {
    const query = after ? `?${new URLSearchParams({ afterId: after })}` : "";
    const data = await this.request("GET", `/channels/${channelId}/messages/pins${query}`);
    return list(isRecord(data) ? data.messages : undefined).flatMap((m) => parseMessage(m) ?? []);
  }

  /** Searches a channel's messages for text (the newest SEARCH_PAGE that match), newest first. */
  async search(channelId: string, query: string): Promise<NerimityMessage[]> {
    const params = new URLSearchParams({ query, limit: String(SEARCH_PAGE) });
    // The server picks the newest matches and answers them oldest first.
    return list(await this.request("GET", `/channels/${channelId}/messages/search?${params}`))
      .flatMap((m) => parseMessage(m) ?? [])
      .reverse();
  }

  /** Sets a server channel's ping and sound modes (POST /users/notifications); null follows the server. */
  async setChannelNotifications(serverId: string, channelId: string, mode: number | null): Promise<void> {
    await this.request("POST", "/users/notifications", { serverId, channelId, notificationPingMode: mode, notificationSoundMode: mode });
  }

  /** Pins or unpins a message (POST or DELETE /channels/{id}/messages/pins/{message}). */
  async pin(channelId: string, messageId: string, pin: boolean): Promise<void> {
    await this.request(pin ? "POST" : "DELETE", `/channels/${channelId}/messages/pins/${messageId}`);
  }

  async typing(channelId: string): Promise<void> {
    await this.request("POST", `/channels/${channelId}/typing`);
  }

  /** A short-lived token for uploading one channel's files to the CDN. */
  async cdnToken(channelId: string): Promise<string> {
    const data = await this.request("POST", `/channels/${channelId}/cdn/token`);
    if (isRecord(data) && typeof data.token === "string" && data.token !== "") return data.token;
    throw new NerimityApiError(200, "The server gave no upload token");
  }

  /**
   * Uploads a file to the CDN (POST <cdn>/attachments/<channel id>, the
   * bytes as the body, named in File-Name) with an upload token in place
   * of the session's; returns the file id a message then names.
   */
  async upload(cdn: string, channelId: string, uploadToken: string, file: FileSource): Promise<string> {
    if (file.size > MAX_UPLOAD_BYTES) throw new NerimityApiError(413, "Nerimity takes files up to 50 MB.");
    const data = new Uint8Array(file.size);
    for (let start = 0; start < file.size; start += READ_CHUNK) {
      const chunk = await file.read(start, Math.min(file.size, start + READ_CHUNK));
      data.set(chunk.subarray(0, Math.min(chunk.length, file.size - start)), start);
    }
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ? file.contentType : "application/octet-stream";
    const headers = { Authorization: uploadToken, "Content-Type": type, "File-Name": encodeURIComponent(file.filename) };
    const answer = await this.request("POST", "", undefined, `${cdn}/attachments/${channelId}`, { data, headers });
    if (isRecord(answer) && typeof answer.fileId === "string" && /^\d{1,20}$/.test(answer.fileId)) return answer.fileId;
    throw new NerimityApiError(200, "The CDN gave no file id");
  }
}
