import { captchaToken, isAltchaChallenge, solveAltcha, type AltchaChallenge } from "./captcha";
import { isRecord, parseMessage, parseUser, type FluxerMessage, type FluxerUser } from "./types";

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

export type LoginResult = { token: string; user?: FluxerUser } | { mfa: true; ticket: string; totp: boolean };

export interface RestOptions {
  fetch: typeof fetch;
  /** Minimum gap between requests. A global 429 revokes a user token, so stay far below 50/s. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  solveCaptcha?: typeof solveAltcha;
}

const MAX_RETRIES = 2;
const MAX_CAPTCHA_ATTEMPTS = 2;

/** Throttled REST client for one instance; the token stays in the main process. */
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

  async sendMessage(channelId: string, content: string, nonce: string, replyTo?: string): Promise<FluxerMessage | undefined> {
    const body: Record<string, unknown> = { content, nonce };
    if (replyTo) body.message_reference = { message_id: replyTo };
    return parseMessage(await this.request("POST", `/channels/${channelId}/messages`, body));
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
  if (record.mfa === true && typeof record.ticket === "string") return { mfa: true, ticket: record.ticket, totp: record.totp !== false };
  throw new FluxerApiError(200, "UNEXPECTED_RESPONSE", "Unexpected login response", data);
}
