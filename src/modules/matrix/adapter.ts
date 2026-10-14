import type { AsyncSecretStore } from "../../engine/runtime";
import type { DirectConversation, HomeBadge, PlatformAdapter } from "../../shared/adapter";
import { BaseAdapter } from "../../shared/baseAdapter";
import { MAX_DIRECTS } from "../../shared/engine";
import { escapeMarkdown } from "../../shared/markdown";
import type { NativeAction, NativeMessage, NativePrompt, NativeSidebarItem, NativeViewState } from "../../shared/native";
import type { AccountStatus } from "../../shared/settings";
import {
  MatrixError,
  matrixErrcode,
  type MatrixApi,
  type MxContent,
  type MxEncryptedEvent,
  type MxEncryption,
  type MxEvent,
  type MxMember,
  type MxOAuthSession,
  type MxPage,
  type MxRoomState,
  type MxSession,
  type MxSync,
} from "./api";
import type { E2ee, E2eeOptions, E2eeStatus } from "./crypto";
import { cleanName, userId } from "./events";
import { httpsUrl, newDeviceId, OAuthError, type DeviceGrant, type MatrixOAuth, type OAuthServer, type OAuthTokens } from "./oauth";

export const PAGE_SIZE = 50;
/** Profile pictures fetched per refresh; the rest show initials. */
export const AVATAR_LIMIT = 40;
/** How long the server may hold a /sync open; the HTTP bridge sets no timeout of its own. */
export const SYNC_TIMEOUT_MS = 30_000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60_000;
/** Added to the poll interval when the account server says to slow down (RFC 8628). */
const SLOW_DOWN_MS = 5000;
const SESSION_KEY = "session";
/** The OAuth client id Multicord registered, per account server. */
const OAUTH_CLIENT_KEY = "oauth-client";
/** The encrypted key store's name and passphrase. */
const CRYPTO_STORE_KEY = "crypto-store";
const MEGOLM = "m.megolm.v1.aes-sha2";
/** The sidebar entry that opens recovery; Matrix ids never look like this. */
const VERIFY_ENTRY = "#verify";
const EDITABLE = new Set(["m.text", "m.notice", "m.emote"]);
export const ENCRYPTED_TEXT = "🔒 Encrypted message — open this chat in Element to read it";
export const ENCRYPTED_NOTICE =
  "🔒 This room is end-to-end encrypted, which Multicord does not support. Messages here can only be read and sent in Element or another Matrix app with encryption; Multicord never sends unencrypted messages into it.";
export const TOKEN_NOTICE =
  "🔒 This room is end-to-end encrypted. With an access token, Multicord uses Element's device and cannot keep encryption keys of its own, so messages here can only be read and sent in Element. Sign out and sign in with your account (in the browser or with a password) to use encryption in Multicord.";
export const ALGORITHM_NOTICE = "🔒 This room uses an encryption algorithm Multicord does not support, so nothing can be sent here from Multicord.";
export const UNVERIFIED_LABEL = "unverified device";
const CONNECTION_LOST = "Connection lost. Reconnecting…";

export interface MatrixInstanceDef {
  id: string;
  name: string;
  /** The homeserver, or a server name whose .well-known points at it. */
  url: string;
}

/** End-to-end encryption, when the build has it: opening a device's crypto state, and deleting its store. */
export interface MatrixCryptoDeps {
  open(options: E2eeOptions): Promise<E2ee>;
  deleteStore(name: string): Promise<void>;
}

export interface MatrixAdapterDeps {
  def: MatrixInstanceDef;
  secrets: AsyncSecretStore;
  render(state: NativeViewState): void;
  api: MatrixApi;
  /** OAuth 2.0 sign-in; without it only passwords and access tokens are offered. */
  oauth?: MatrixOAuth;
  crypto?: MatrixCryptoDeps;
  /** Waits before retrying a failed sync, and between sign-in polls; tests pass their own. */
  delay?: (ms: number) => Promise<void>;
  /** Reports background failures (never secrets). */
  log?: (message: string) => void;
  /** Narrows what the engine may reach to these hosts, once they are known. */
  lockHosts?(hosts: string[]): Promise<void>;
}

/** The distinct hosts of these URLs, skipping any that are missing. */
export function hostsOf(...urls: (string | undefined)[]): string[] {
  return [...new Set(urls.filter((url): url is string => url !== undefined).map((url) => new URL(url).hostname.toLowerCase()))];
}

type Step = "connecting" | "oauth" | "device" | "login" | "token" | "retry" | "chat" | "recovery";
/** The sign-in screens the secondary button cycles through. */
type SignInStep = "oauth" | "login" | "token";

type Shown = Extract<MxEvent, { kind: "message" | "encrypted" }>;
type Message = Extract<MxEvent, { kind: "message" }>;

interface Room {
  id: string;
  /** The view's id for the room: actions carry digits only. */
  local: string;
  name: string;
  alias: string;
  avatar: string;
  encrypted: boolean;
  encryption?: MxEncryption;
  history?: string;
  members: Map<string, MxMember>;
  /** Joined and invited members, once fetched for encrypting; kept up to date from membership events. */
  memberIds?: Set<string>;
  heroes: string[];
  /** Messages and encrypted events, oldest first; edits are kept apart. */
  events: Shown[];
  /** The latest edit of each message, by "<sender>|<event id>": only the sender's own edits count. */
  edits: Map<string, Message>;
  prevBatch?: string;
  notifications: number;
  highlights: number;
  lastActivity: number;
  /** The last event we sent a read receipt for. */
  lastRead?: string;
}

/** What the user sees for Matrix error codes. */
const FRIENDLY: Record<string, string> = {
  M_FORBIDDEN: "That username or password is not right.",
  M_USER_DEACTIVATED: "This account has been deactivated.",
  M_LIMIT_EXCEEDED: "Too many attempts. Wait a while and try again.",
  M_UNKNOWN_TOKEN: "That access token is not valid (anymore).",
  M_MISSING_TOKEN: "That access token is not valid (anymore).",
};

function friendly(error: unknown): string {
  const code = matrixErrcode(error);
  if (code && FRIENDLY[code]) return FRIENDLY[code];
  return error instanceof Error ? error.message : String(error);
}

/** The server no longer accepts the token (M_UNKNOWN_TOKEN and friends come with 401). */
const ended = (error: unknown): boolean => error instanceof MatrixError && error.status === 401;

/** A message's text with its media label after it, so media-only messages still say something. */
export function messageText(content: MxContent): string {
  const text = content.msgtype === "m.emote" ? `* ${content.text}` : content.text;
  return [text, content.media].filter(Boolean).join("\n");
}

const optionalText = (value: unknown): boolean => value === undefined || (typeof value === "string" && value !== "" && value.length <= 4096);

/** A stored session, if it is one we wrote. */
export function parseSession(text: string | undefined): MxSession | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<MxSession>;
    const { baseUrl, accessToken, deviceId, ownDevice, oauth } = value;
    if (
      typeof baseUrl === "string" &&
      baseUrl.startsWith("https://") &&
      typeof accessToken === "string" &&
      accessToken !== "" &&
      userId(value.userId) &&
      typeof deviceId === "string" &&
      typeof ownDevice === "boolean"
    ) {
      const session: MxSession = { baseUrl, accessToken, userId: value.userId!, deviceId, ownDevice };
      if (oauth !== undefined) {
        const { clientId, tokenEndpoint, revocationEndpoint, refreshToken, expiresAt } = oauth;
        if (
          typeof clientId !== "string" ||
          clientId === "" ||
          !httpsUrl(tokenEndpoint) ||
          (revocationEndpoint !== undefined && !httpsUrl(revocationEndpoint)) ||
          !optionalText(refreshToken) ||
          (expiresAt !== undefined && typeof expiresAt !== "number")
        ) {
          return undefined;
        }
        session.oauth = { clientId, tokenEndpoint };
        if (revocationEndpoint) session.oauth.revocationEndpoint = revocationEndpoint;
        if (refreshToken) session.oauth.refreshToken = refreshToken;
        if (expiresAt !== undefined) session.oauth.expiresAt = expiresAt;
      }
      return session;
    }
  } catch {
    // Not stored by us; sign in again.
  }
  return undefined;
}

/** A stored key store record, if it is one we wrote. */
function parseStore(text: string | undefined): { name: string; passphrase: string } | undefined {
  try {
    const value: unknown = text ? JSON.parse(text) : undefined;
    const { name, passphrase } = (value ?? {}) as Record<string, unknown>;
    return typeof name === "string" && typeof passphrase === "string" && passphrase.length >= 32 ? { name, passphrase } : undefined;
  } catch {
    return undefined;
  }
}

function randomSecret(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Native Matrix adapter: signs in through the homeserver's account page
 * (OAuth 2.0), with a password or with an access token; lists direct chats
 * (m.direct) as direct messages in the rail and the unified Messages page,
 * and every other joined room in its view's sidebar. Runs in its sandboxed
 * engine over plain Client-Server API calls. Devices Multicord owns get
 * end-to-end encryption (crypto.ts); with an access token copied from
 * Element encrypted rooms stay locked, and nothing is ever sent unencrypted
 * into an encrypted room.
 */
export class MatrixAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

  private step: Step = "connecting";
  private status: string | undefined;
  private busy = false;
  private error: string | undefined;
  private baseUrl: string | undefined;
  private passwordLogin = false;
  private oauthServer: OAuthServer | undefined;
  /** The code on screen while signing in with OAuth, and a counter that stops the polling for an abandoned one. */
  private grant: DeviceGrant | undefined;
  private grantAttempt = 0;
  /** What "Try again" on the retry screen does. */
  private retry: (() => Promise<void>) | undefined;
  private session: MxSession | undefined;
  private hasSession = false;
  /** End-to-end encryption for this session; while unset, encrypted rooms are locked. */
  private crypto: E2ee | undefined;
  private cryptoStatus: E2eeStatus | undefined;
  /** Why encryption is off on a device of our own. */
  private cryptoProblem: string | undefined;
  private readonly rooms = new Map<string, Room>();
  /** DM room id -> the other user, from m.direct. */
  private dmUsers = new Map<string, string>();
  /** Matrix ids <-> the view's numeric ids, for rooms and events alike. */
  private readonly locals = new Map<string, string>();
  private readonly byLocal = new Map<string, string>();
  private nextLocal = 1;
  /** Thumbnails by mxc URI; failed ones are not asked for again. */
  private readonly avatars = new Map<string, string>();
  private readonly avatarsTried = new Set<string>();
  private loadingAvatars = false;
  private readonly loading = new Set<string>();
  private selected: string | undefined;
  private visible = false;
  /** Counts sign-ins and sign-outs, so a sync loop or task started for one session stops for the next. */
  private generation = 0;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: MatrixAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
    this.delay = deps.delay ?? defaultDelay;
    this.log = deps.log ?? ((message) => console.warn(`[matrix] ${message}`));
  }

  /** Resumes a saved session, else starts signing in. */
  async start(): Promise<void> {
    const saved = parseSession(await this.deps.secrets.load(SESSION_KEY));
    if (!saved) return this.showSignIn();
    this.hasSession = true;
    await this.resume(saved);
  }

  private host(): string {
    return new URL(this.deps.def.url).host;
  }

  /** From here on the engine needs only these hosts; a refused lock is logged and changes nothing. */
  private async lockToHosts(hosts: string[]): Promise<void> {
    await this.deps.lockHosts?.(hosts).catch((error: unknown) => this.log(`host lock refused: ${friendly(error)}`));
  }

  private async resume(saved: MxSession): Promise<void> {
    this.connecting(`Connecting to ${this.host()}…`);
    await this.lockToHosts(hostsOf(this.deps.def.url, saved.baseUrl, saved.oauth?.tokenEndpoint, saved.oauth?.revocationEndpoint));
    try {
      await this.deps.api.check(saved);
    } catch (error) {
      if (ended(error)) {
        await this.forgetSession();
        return this.showSignIn("Your Matrix session has ended. Sign in again.");
      }
      return this.showRetry(`Could not reach ${this.host()}: ${friendly(error)}`, () => this.resume(saved));
    }
    this.signedIn(saved);
  }

  /** Finds the homeserver and its sign-in options, then asks how to sign in. */
  private async showSignIn(error?: string): Promise<void> {
    this.connecting(`Looking up ${this.host()}…`);
    try {
      this.baseUrl = await this.deps.api.discover(this.deps.def.url);
      this.passwordLogin = (await this.deps.api.loginFlows(this.baseUrl)).password;
    } catch (failure) {
      return this.showRetry(`Could not reach a Matrix homeserver at ${this.host()}: ${friendly(failure)}`, () => this.showSignIn(error));
    }
    // Discovery never throws: without an account server, the other ways remain.
    this.oauthServer = await this.deps.oauth?.discover(this.baseUrl).catch(() => undefined);
    const server = this.oauthServer;
    await this.lockToHosts(hostsOf(this.deps.def.url, this.baseUrl, server?.issuer, server?.deviceEndpoint, server?.tokenEndpoint, server?.registrationEndpoint, server?.revocationEndpoint));
    this.step = this.signInSteps()[0]!;
    this.status = undefined;
    this.error = error;
    this.render();
  }

  private signInSteps(): SignInStep[] {
    const steps: SignInStep[] = [];
    if (this.oauthServer) steps.push("oauth");
    if (this.passwordLogin) steps.push("login");
    steps.push("token");
    return steps;
  }

  /** The sign-in screen the secondary button leads to, if there is another. */
  private nextSignIn(step: SignInStep): SignInStep | undefined {
    const steps = this.signInSteps();
    const next = steps[(steps.indexOf(step) + 1) % steps.length]!;
    return next === step ? undefined : next;
  }

  private showRetry(error: string, retry: () => Promise<void>): void {
    this.step = "retry";
    this.status = undefined;
    this.error = error;
    this.retry = retry;
    this.render();
  }

  private connecting(status: string): void {
    this.step = "connecting";
    this.status = status;
    this.render();
  }

  private signedIn(session: MxSession): void {
    this.session = session;
    this.hasSession = true;
    this.error = undefined;
    this.connecting("Loading your chats…");
    void this.syncLoop(++this.generation, session);
  }

  private async forgetSession(): Promise<void> {
    this.hasSession = false;
    this.session = undefined;
    await this.deps.secrets.delete(SESSION_KEY);
    await this.stopCrypto(true);
  }

  // --- Shell interface ---------------------------------------------------------

  override async listDirectConversations(): Promise<DirectConversation[]> {
    return this.directs();
  }

  /** Rooms other than DMs: DM bubbles carry their own badges. */
  homeBadge(): HomeBadge {
    let unread = false;
    let mentions = 0;
    for (const room of this.rooms.values()) {
      if (this.dmUsers.has(room.id)) continue;
      unread ||= room.notifications > 0;
      mentions += room.highlights;
    }
    return { unread, mentions };
  }

  async openHome(): Promise<void> {
    this.render();
  }

  async openServer(key: string): Promise<void> {
    throw new Error(`Matrix has no server ${key}`);
  }

  async openConversation(key: string): Promise<void> {
    const room = this.rooms.get(key);
    if (room) await this.select(room.local);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    const room = this.selectedRoom();
    if (visible && room) this.markRead(room);
  }

  accountStatus(): AccountStatus {
    if (this.session) return { state: "signed-in", name: this.session.userId };
    return this.hasSession ? { state: "signed-in" } : { state: "signed-out" };
  }

  async signOut(): Promise<void> {
    const session = this.session;
    this.generation++;
    // A token copied from another app is that app's device: ending it would sign that app out too.
    if (session?.ownDevice) {
      // An OAuth session ends by revoking its token at the account server, which removes the device.
      if (session.oauth && this.deps.oauth) await this.revoke(session.oauth, session.accessToken);
      else await this.deps.api.logout(session).catch(() => undefined);
    }
    await this.forgetSession();
    this.rooms.clear();
    this.dmUsers.clear();
    this.locals.clear();
    this.byLocal.clear();
    // Another account may sign in next; its chats must not show these pictures.
    this.avatars.clear();
    this.avatarsTried.clear();
    this.selected = undefined;
    this.directsChanged.emit([]);
    await this.showSignIn();
  }

  /** The server no longer accepts the token, e.g. after signing out elsewhere. */
  private async sessionEnded(): Promise<void> {
    this.generation++;
    await this.forgetSession();
    this.rooms.clear();
    this.dmUsers.clear();
    this.selected = undefined;
    this.directsChanged.emit([]);
    await this.showSignIn("Your Matrix session has ended. Sign in again.");
  }

  /**
   * Gets a new access token for an OAuth session (the client calls this when
   * the token is due), updating the session in place and storing it. A
   * refused refresh ends the session.
   */
  async refreshSession(session: MxSession): Promise<void> {
    const oauth = session.oauth;
    if (!oauth || !this.deps.oauth) throw new MatrixError(401, "M_UNKNOWN_TOKEN", "The session cannot be refreshed");
    let tokens: OAuthTokens;
    try {
      tokens = await this.deps.oauth.refresh(oauth);
    } catch (error) {
      // A network failure is worth another try later; the account server refusing is not.
      if (error instanceof OAuthError) throw new MatrixError(401, "M_UNKNOWN_TOKEN", "Your Matrix session has ended");
      throw error;
    }
    session.accessToken = tokens.accessToken;
    oauth.refreshToken = tokens.refreshToken;
    oauth.expiresAt = tokens.expiresAt;
    // Signed out meanwhile: nothing to keep.
    if (this.hasSession) await this.deps.secrets.save(SESSION_KEY, JSON.stringify(session));
  }

  async handleAction(action: NativeAction): Promise<void> {
    switch (action.type) {
      case "ready":
        return this.render();
      case "prompt":
        return this.answer(action.id, action.values);
      case "cancelPrompt":
        return this.cancel(action.id);
      case "select":
        return this.select(action.channelId);
      case "send":
        return this.send(action.content, action.replyTo);
      case "edit":
        return this.edit(action.messageId, action.content);
      case "delete":
        return this.remove(action.messageId);
      case "loadOlder":
        return this.loadOlder();
      case "logout":
        return this.signOut();
      default:
        // Reactions, uploads, typing, forums and voice are not offered for Matrix.
        return;
    }
  }

  // --- Signing in ---------------------------------------------------------------

  /** The secondary button: the next way to sign in, back from a code or out of recovery. */
  private cancel(step: string): void {
    if (step !== this.step || this.busy) return;
    if (step === "device") {
      this.grantAttempt++;
      this.grant = undefined;
      this.step = "oauth";
    } else if (step === "recovery") {
      this.step = "chat";
    } else if (step === "oauth" || step === "login" || step === "token") {
      const next = this.nextSignIn(step);
      if (!next) return;
      this.step = next;
    } else {
      return;
    }
    this.error = undefined;
    this.status = undefined;
    this.render();
  }

  private async answer(step: string, values: Record<string, string>): Promise<void> {
    if (step !== this.step || this.busy) return;
    if (step === "retry") return this.retry!();
    if (step === "oauth" || step === "device") return this.startDeviceSignIn();
    if (step === "recovery") return this.recover(values.key ?? "");
    this.busy = true;
    this.error = undefined;
    this.render();
    let session: MxSession | undefined;
    try {
      const baseUrl = this.baseUrl!;
      if (step === "login") {
        const user = (values.user ?? "").trim();
        if (user === "" || user.length > 255) throw new Error("Enter your username, e.g. @alice:matrix.org or alice.");
        session = await this.deps.api.login(baseUrl, user, values.password ?? "");
      } else {
        const token = (values.token ?? "").trim();
        if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error("That does not look like an access token.");
        const who = await this.deps.api.whoami(baseUrl, token);
        session = { baseUrl, accessToken: token, userId: who.userId, deviceId: who.deviceId ?? "", ownDevice: false };
      }
      await this.deps.secrets.save(SESSION_KEY, JSON.stringify(session));
    } catch (error) {
      this.error = friendly(error);
      session = undefined;
    }
    this.busy = false;
    if (session) return this.signedIn(session);
    this.render();
  }

  /** Multicord's client id at this account server, registering once. */
  private async clientId(server: OAuthServer): Promise<string> {
    try {
      const stored = JSON.parse((await this.deps.secrets.load(OAUTH_CLIENT_KEY)) ?? "null") as { issuer?: unknown; clientId?: unknown } | null;
      if (stored?.issuer === server.issuer && typeof stored.clientId === "string" && stored.clientId !== "") return stored.clientId;
    } catch {
      // Not ours; register again.
    }
    const clientId = await this.deps.oauth!.register(server);
    await this.deps.secrets.save(OAUTH_CLIENT_KEY, JSON.stringify({ issuer: server.issuer, clientId }));
    return clientId;
  }

  /** Gets a code for the user to approve in their browser, then waits for the approval. */
  private async startDeviceSignIn(): Promise<void> {
    const server = this.oauthServer!;
    const attempt = ++this.grantAttempt;
    this.error = undefined;
    this.connecting("Getting a sign-in code…");
    try {
      const clientId = await this.clientId(server);
      const deviceId = newDeviceId();
      const grant = await this.deps.oauth!.authorizeDevice(server, clientId, deviceId);
      if (attempt !== this.grantAttempt) return;
      this.grant = grant;
      this.step = "device";
      this.status = "Waiting for you to approve the sign-in…";
      this.render();
      void this.pollDevice(attempt, server, clientId, deviceId, grant);
    } catch (error) {
      if (attempt === this.grantAttempt) this.deviceFailed(`Could not start signing in: ${friendly(error)}`);
    }
  }

  private deviceFailed(error: string): void {
    this.grant = undefined;
    this.step = "oauth";
    this.status = undefined;
    this.error = error;
    this.render();
  }

  private async pollDevice(attempt: number, server: OAuthServer, clientId: string, deviceId: string, grant: DeviceGrant): Promise<void> {
    let interval = grant.interval;
    for (;;) {
      await this.delay(interval);
      if (attempt !== this.grantAttempt) return;
      if (Date.now() >= grant.expiresAt) return this.deviceFailed("The code expired. Get a new one to try again.");
      let tokens: OAuthTokens | undefined;
      try {
        const result = await this.deps.oauth!.pollDevice(server, clientId, grant.deviceCode);
        if (attempt !== this.grantAttempt) return result.state === "done" ? this.discard(server, clientId, result.tokens) : undefined;
        if (result.state === "denied") return this.deviceFailed("The sign-in was declined.");
        if (result.state === "expired") return this.deviceFailed("The code expired. Get a new one to try again.");
        if (result.state === "slow_down") interval += SLOW_DOWN_MS;
        if (result.state === "done") tokens = result.tokens;
      } catch (error) {
        if (attempt !== this.grantAttempt) return;
        // The account server refusing ends it; a lost connection is tried again at the next poll.
        if (error instanceof OAuthError) return this.deviceFailed(`Signing in failed: ${error.message}`);
      }
      if (tokens) return this.finishDeviceSignIn(attempt, server, clientId, deviceId, tokens);
    }
  }

  /** Revokes an OAuth session's token (the refresh token when there is one), which ends it on the server. */
  private async revoke(oauth: MxOAuthSession, accessToken: string): Promise<void> {
    const [token, hint] = oauth.refreshToken ? [oauth.refreshToken, "refresh_token" as const] : [accessToken, "access_token" as const];
    await this.deps.oauth!.revoke(oauth, token, hint).catch(() => undefined);
  }

  private oauthSession(server: OAuthServer, clientId: string, tokens: OAuthTokens): MxOAuthSession {
    const oauth: MxOAuthSession = { clientId, tokenEndpoint: server.tokenEndpoint };
    if (server.revocationEndpoint) oauth.revocationEndpoint = server.revocationEndpoint;
    if (tokens.refreshToken) oauth.refreshToken = tokens.refreshToken;
    if (tokens.expiresAt !== undefined) oauth.expiresAt = tokens.expiresAt;
    return oauth;
  }

  /** Ends the session the account server made for a sign-in that was abandoned or failed, so no stray device stays behind. */
  private discard(server: OAuthServer, clientId: string, tokens: OAuthTokens): void {
    void this.revoke(this.oauthSession(server, clientId, tokens), tokens.accessToken);
  }

  private async finishDeviceSignIn(attempt: number, server: OAuthServer, clientId: string, deviceId: string, tokens: OAuthTokens): Promise<void> {
    const baseUrl = this.baseUrl!;
    try {
      const who = await this.deps.api.whoami(baseUrl, tokens.accessToken);
      // Abandoned meanwhile (Back): keep nothing.
      if (attempt !== this.grantAttempt) return this.discard(server, clientId, tokens);
      const session: MxSession = { baseUrl, accessToken: tokens.accessToken, userId: who.userId, deviceId: who.deviceId ?? deviceId, ownDevice: true, oauth: this.oauthSession(server, clientId, tokens) };
      await this.deps.secrets.save(SESSION_KEY, JSON.stringify(session));
      this.grant = undefined;
      this.signedIn(session);
    } catch (error) {
      this.discard(server, clientId, tokens);
      if (attempt === this.grantAttempt) this.deviceFailed(`Signing in failed: ${friendly(error)}`);
    }
  }

  private prompt(): NativePrompt {
    const host = this.host();
    const withCancel = (prompt: NativePrompt, step: SignInStep): NativePrompt => {
      const next = this.nextSignIn(step);
      if (next) prompt.cancel = { oauth: "Sign in with the browser instead", login: "Use a password instead", token: "Use an access token instead" }[next];
      return prompt;
    };
    const encryption = this.deps.crypto ? "Multicord gets a device of its own, with end-to-end encryption." : "Encrypted rooms cannot be read in Multicord.";
    switch (this.step) {
      case "retry":
        return { id: "retry", title: "Matrix is not reachable", fields: [], submit: "Try again" };
      case "recovery":
        return {
          id: "recovery",
          title: "Verify this device",
          description:
            "Enter the recovery key you saved when you set up recovery in Element (48 letters and digits), or your security phrase. Multicord then signs this device with your cross-signing keys, so your other devices and contacts trust it, and restores your message keys from the key backup, so older encrypted messages can be read. " +
            "Verifying from another device (comparing emoji) is not supported yet; use your recovery key. It stays on this device and is never sent anywhere.",
          fields: [{ name: "key", label: "Recovery key or security phrase", type: "password", autocomplete: "off" }],
          submit: "Verify",
          cancel: "Not now",
        };
      case "device": {
        const grant = this.grant!;
        const page = new URL(grant.verificationUri).host;
        return {
          id: "device",
          title: `Your code: ${grant.userCode}`,
          description: `Open ${grant.verificationUri} in your browser, sign in to ${host} there if asked, and enter the code ${grant.userCode}. Multicord continues by itself once you approve.`,
          link: { url: grant.verificationUriComplete ?? grant.verificationUri, label: `Open ${page}` },
          fields: [],
          submit: "Get a new code",
          cancel: "Back",
        };
      }
      case "oauth":
        return withCancel(
          {
            id: "oauth",
            title: `Sign in to ${host}`,
            description: `You sign in on ${new URL(this.oauthServer!.issuer).host}, your homeserver's account page, in your browser, and confirm a code there: your password never passes through Multicord. ${encryption}`,
            fields: [],
            submit: "Sign in with the browser",
          },
          "oauth",
        );
      case "token":
        return withCancel(
          {
            id: "token",
            title: `Sign in to ${host} with an access token`,
            description:
              `${this.passwordLogin || this.oauthServer ? "" : `${host} does not offer password sign-in to other apps; homeservers that sign in through their own account page (such as matrix.org) work this way. `}` +
              "Copy an access token from Element: Settings > Help & About > Access token. Multicord then shares Element's session: signing out here only forgets the token, and signing out in Element ends it here too. Encrypted rooms stay locked, since the device is Element's. The token is stored encrypted on this device.",
            fields: [{ name: "token", label: "Access token", type: "password", autocomplete: "off" }],
            submit: "Sign in",
          },
          "token",
        );
      default:
        return withCancel(
          {
            id: "login",
            title: `Sign in to ${host}`,
            description: `Your password goes only to your homeserver, and your session is stored encrypted on this device. ${encryption}`,
            fields: [
              { name: "user", label: "Username", type: "text", autocomplete: "username", placeholder: "@alice:matrix.org" },
              { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
            ],
            submit: "Sign in",
          },
          "login",
        );
    }
  }

  // --- Encryption ---------------------------------------------------------------

  /** The key store's name and passphrase for this device, made once; another device's store is deleted. */
  private async cryptoStore(session: MxSession): Promise<{ name: string; passphrase: string }> {
    const name = `multicord:${this.deps.def.id}:${session.userId}:${session.deviceId}`;
    const stored = parseStore(await this.deps.secrets.load(CRYPTO_STORE_KEY));
    if (stored?.name === name) return stored;
    if (stored) await this.deps.crypto!.deleteStore(stored.name);
    const store = { name, passphrase: randomSecret() };
    await this.deps.secrets.save(CRYPTO_STORE_KEY, JSON.stringify(store));
    return store;
  }

  private async startCrypto(generation: number, session: MxSession): Promise<void> {
    this.cryptoProblem = undefined;
    if (!this.deps.crypto || !session.ownDevice || session.deviceId === "") return;
    try {
      const store = await this.cryptoStore(session);
      const crypto = await this.deps.crypto.open({
        userId: session.userId,
        deviceId: session.deviceId,
        store,
        http: (method, path, body, query) => this.deps.api.request(session, method, path, body, query),
        accountData: (type) => this.deps.api.accountData(session, type),
        log: this.log,
      });
      if (generation !== this.generation) return crypto.close();
      this.crypto = crypto;
      crypto.onKeys((sessions) => void this.retryDecryption(new Set(sessions)));
    } catch (error) {
      this.cryptoProblem = messageOf(error);
      this.log(`Encryption could not start: ${this.cryptoProblem}`);
    }
  }

  /** Closes the crypto state; on sign-out also deletes its store, so no keys stay behind. */
  private async stopCrypto(forget: boolean): Promise<void> {
    this.crypto?.close();
    this.crypto = undefined;
    this.cryptoStatus = undefined;
    if (!forget || !this.deps.crypto) return;
    const stored = parseStore(await this.deps.secrets.load(CRYPTO_STORE_KEY));
    if (stored) await this.deps.crypto.deleteStore(stored.name).catch((error: unknown) => this.log(`Key store not deleted: ${messageOf(error)}`));
    await this.deps.secrets.delete(CRYPTO_STORE_KEY);
  }

  private async refreshCryptoStatus(crypto: E2ee): Promise<void> {
    const status = await crypto.status().catch(() => undefined);
    if (crypto !== this.crypto || !status) return;
    this.cryptoStatus = status;
    this.render();
  }

  /** Decrypts what can be; events that cannot be stay, with the reason. */
  private async decryptAll(roomId: string, events: MxEvent[]): Promise<MxEvent[]> {
    const crypto = this.crypto;
    if (!crypto) return events;
    const out: MxEvent[] = [];
    for (const event of events) {
      if (event.kind !== "encrypted") {
        out.push(event);
        continue;
      }
      const decrypted = await crypto.decrypt(roomId, event).catch((error: unknown): MxEvent => ({ ...event, problem: messageOf(error) }));
      if (decrypted) out.push(decrypted);
    }
    return out;
  }

  /** Tries again to decrypt events whose keys may have arrived (all of them without `sessions`). */
  private async retryDecryption(sessions?: Set<string>): Promise<void> {
    const crypto = this.crypto;
    if (!crypto) return;
    let changed = false;
    for (const room of [...this.rooms.values()]) {
      const waiting = room.events.filter((e): e is MxEncryptedEvent => e.kind === "encrypted" && e.raw !== undefined && (!sessions || sessions.has(e.sessionId ?? "")));
      for (const event of waiting) {
        const result = await crypto.decrypt(room.id, event).catch(() => event);
        if (crypto !== this.crypto) return;
        if (result?.kind === "encrypted") continue;
        changed = true;
        const index = room.events.findIndex((e) => e.id === event.id);
        if (index < 0) continue;
        // A message takes the placeholder's place; anything else (an edit, a hidden type) removes it.
        if (result?.kind === "message" && !result.replaces) room.events[index] = result;
        else {
          room.events.splice(index, 1);
          if (result) this.addEvent(room, result, false);
        }
      }
    }
    if (changed) this.publish();
  }

  private async recover(input: string): Promise<void> {
    // The recovery screen opens only with encryption running, and signing out leaves it.
    const crypto = this.crypto!;
    this.busy = true;
    this.error = undefined;
    this.status = "Verifying… restoring keys can take a moment.";
    this.render();
    try {
      const result = await crypto.recover(input.trim());
      if (crypto !== this.crypto) return;
      this.cryptoStatus = { verified: result.verified, backup: result.backup };
      this.step = "chat";
      this.status = undefined;
      void this.retryDecryption();
    } catch (error) {
      this.error = friendly(error);
    } finally {
      this.busy = false;
    }
    this.render();
  }

  /** Why nothing may be sent into this room from here (the composer's notice, and the short form for errors), or undefined when it may. */
  private lock(room: Room): { notice: string; reason: string } | undefined {
    if (!room.encrypted) return undefined;
    if (!this.deps.crypto) return { notice: ENCRYPTED_NOTICE, reason: "this room is end-to-end encrypted, which Multicord does not support" };
    if (!this.session!.ownDevice) return { notice: TOKEN_NOTICE, reason: "this room is end-to-end encrypted, and with an access token Multicord cannot encrypt" };
    if (!this.crypto) {
      const why = this.cryptoProblem ? ` (${this.cryptoProblem})` : "";
      return {
        notice: `🔒 This room is end-to-end encrypted, but encryption could not start${why}. Nothing is sent here until it does; restart Multicord to try again.`,
        reason: `encryption could not start${why}`,
      };
    }
    if (room.encryption?.algorithm !== MEGOLM) return { notice: ALGORITHM_NOTICE, reason: "this room uses an encryption algorithm Multicord does not support" };
    return undefined;
  }

  // --- Syncing --------------------------------------------------------------------

  private async syncLoop(generation: number, session: MxSession): Promise<void> {
    await this.startCrypto(generation, session);
    let since: string | undefined;
    let wait = RETRY_MIN_MS;
    while (generation === this.generation) {
      try {
        // The first sync returns at once; later ones wait for news.
        const sync = await this.deps.api.sync(session, since, since === undefined ? 0 : SYNC_TIMEOUT_MS);
        if (generation !== this.generation) return;
        await this.receiveCrypto(session, sync, since === undefined);
        if (generation !== this.generation) return;
        this.applySync(sync, since === undefined);
        since = sync.nextBatch;
        wait = RETRY_MIN_MS;
      } catch (error) {
        if (generation !== this.generation) return;
        if (ended(error)) return this.sessionEnded();
        if (this.step === "chat") this.error = CONNECTION_LOST;
        else if (this.step === "connecting") this.status = `Could not reach ${this.host()}: ${friendly(error)}. Retrying…`;
        this.render();
        await this.delay(wait);
        wait = Math.min(wait * 2, RETRY_MAX_MS);
      }
    }
  }

  /** Hands the sync's keys and to-device messages to the crypto state, then decrypts its timelines. */
  private async receiveCrypto(session: MxSession, sync: MxSync, initial: boolean): Promise<void> {
    const crypto = this.crypto;
    if (!crypto) return;
    if (sync.crypto) {
      // The keys that did arrive are in; requests that failed are asked for again.
      await crypto.receiveSync(sync.crypto).catch((error: unknown) => this.log(`Encryption sync: ${messageOf(error)}`));
      if (initial || sync.crypto.changed.includes(session.userId)) void this.refreshCryptoStatus(crypto);
    }
    for (const update of sync.joined) update.timeline = await this.decryptAll(update.roomId, update.timeline);
  }

  private local(id: string): string {
    let local = this.locals.get(id);
    if (!local) {
      local = String(this.nextLocal++);
      this.locals.set(id, local);
      this.byLocal.set(local, id);
    }
    return local;
  }

  private room(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      room = { id, local: this.local(id), name: "", alias: "", avatar: "", encrypted: false, members: new Map(), heroes: [], events: [], edits: new Map(), notifications: 0, highlights: 0, lastActivity: 0 };
      this.rooms.set(id, room);
    }
    return room;
  }

  private applyState(room: Room, state: MxRoomState): void {
    if (state.name !== undefined) room.name = state.name;
    if (state.alias !== undefined) room.alias = state.alias;
    if (state.avatar !== undefined) room.avatar = state.avatar;
    if (state.encrypted) room.encrypted = true;
    if (state.encryption) room.encryption = state.encryption;
    if (state.history !== undefined) room.history = state.history;
    for (const [user, member] of Object.entries(state.members)) {
      room.members.set(user, member);
      // Whoever joins or is invited gets the keys of the next encrypted message; whoever leaves does not.
      if (member.membership === "join" || member.membership === "invite") room.memberIds?.add(user);
      else room.memberIds?.delete(user);
    }
  }

  private applySync(sync: MxSync, initial: boolean): void {
    if (sync.directs) {
      this.dmUsers = new Map(Object.entries(sync.directs).flatMap(([user, ids]) => ids.map((id): [string, string] => [id, user])));
    }
    for (const id of sync.left) {
      this.rooms.delete(id);
      if (this.selected === id) this.selected = undefined;
    }
    for (const update of sync.joined) {
      const fresh = !this.rooms.has(update.roomId);
      const room = this.room(update.roomId);
      this.applyState(room, update.state);
      if (update.heroes) room.heroes = update.heroes;
      if (update.unread) {
        room.notifications = update.unread.notifications;
        room.highlights = update.unread.highlights;
      }
      if (fresh || (update.limited && !initial)) {
        // A gap: what we had no longer joins up with the new events.
        if (!fresh) room.events = [];
        room.prevBatch = update.prevBatch;
        // Membership changes may be in the gap too.
        room.memberIds = undefined;
      }
      for (const event of update.timeline) this.addEvent(room, event, !initial);
    }
    // Recovery is a screen of its own; syncs carry on behind it.
    if (this.step !== "recovery") this.step = "chat";
    this.status = undefined;
    if (this.error === CONNECTION_LOST) this.error = undefined;
    const open = this.selectedRoom();
    if (open && this.visible) this.markRead(open);
    this.publish();
    void this.loadAvatars();
  }

  private removeEvent(room: Room, id: string): void {
    room.events = room.events.filter((e) => e.id !== id);
    for (const [key, edit] of room.edits) if (edit.id === id || key.endsWith(`|${id}`)) room.edits.delete(key);
  }

  /** Adds a timeline event; `live` ones (from a sync after the first) may notify. */
  private addEvent(room: Room, event: MxEvent, live: boolean): void {
    switch (event.kind) {
      case "redacted":
        return this.removeEvent(room, event.id);
      case "redaction":
        return this.removeEvent(room, event.redacts);
    }
    if (event.kind === "message" && event.replaces) {
      const key = `${event.sender}|${event.replaces}`;
      const known = room.edits.get(key);
      if (!known || known.ts <= event.ts) room.edits.set(key, event);
      return;
    }
    // An edit that cannot be read changes nothing that can be shown.
    if (event.kind === "encrypted" && event.replaces) return;
    if (room.events.some((e) => e.id === event.id)) return;
    room.events.push(event);
    room.lastActivity = Math.max(room.lastActivity, event.ts);
    if (live && event.sender !== this.session!.userId) this.notify(room, event);
  }

  private mentionsMe(room: Room, event: Shown): boolean {
    if (event.kind !== "message") return false;
    const me = this.session!.userId;
    if (event.mentions) return event.mentions.includes(me);
    // Older clients do not say whom they mention: look for our name in the text.
    const text = event.content.text.toLowerCase();
    const name = room.members.get(me)?.name?.toLowerCase();
    return text.includes(me.toLowerCase()) || (name !== undefined && text.includes(name));
  }

  private notify(room: Room, event: Shown): void {
    const dm = this.dmUsers.has(room.id);
    if (!dm && !this.mentionsMe(room, event)) return;
    const title = this.title(room);
    this.notifications.emit({
      title: dm ? title : `${this.memberName(room, event.sender)} in ${title}`.slice(0, 200),
      body: this.eventText(room, event).slice(0, 200),
      target: room.id,
      railKey: dm ? `dm:${room.id}` : "home",
      inView: this.visible && this.selected === room.id,
    });
  }

  private async loadAvatars(): Promise<void> {
    if (this.loadingAvatars) return;
    this.loadingAvatars = true;
    const generation = this.generation;
    const session = this.session!;
    let found = false;
    try {
      for (const room of this.dmRooms().slice(0, AVATAR_LIMIT)) {
        const mxc = this.avatarOf(room);
        if (!mxc || this.avatarsTried.has(mxc)) continue;
        this.avatarsTried.add(mxc);
        const url = await this.deps.api.thumbnail(session, mxc).catch(() => undefined);
        // Signed out meanwhile: these chats belong to the previous account.
        if (generation !== this.generation) return;
        if (url) {
          this.avatars.set(mxc, url);
          found = true;
        }
      }
    } finally {
      this.loadingAvatars = false;
    }
    if (found) this.publish();
  }

  /** A DM's picture: the room's own, else the other person's. */
  private avatarOf(room: Room): string | undefined {
    return room.avatar || room.members.get(this.dmUsers.get(room.id)!)?.avatar;
  }

  // --- Rooms and messages -------------------------------------------------------

  private selectedRoom(): Room | undefined {
    return this.selected ? this.rooms.get(this.selected) : undefined;
  }

  private async select(local: string): Promise<void> {
    if (this.byLocal.get(local) === VERIFY_ENTRY) {
      if (!this.crypto || this.step !== "chat") return;
      this.step = "recovery";
      this.error = undefined;
      this.status = undefined;
      return this.render();
    }
    const room = this.rooms.get(this.byLocal.get(local) ?? "");
    if (!room) return;
    this.selected = room.id;
    this.render();
    if (room.events.length === 0 && room.prevBatch) await this.fetchHistory(room);
    if (this.visible) this.markRead(room);
  }

  private async fetchHistory(room: Room): Promise<void> {
    const session = this.session!;
    if (!room.prevBatch || this.loading.has(room.id)) return;
    const generation = this.generation;
    this.loading.add(room.id);
    this.render();
    let page: MxPage | undefined;
    try {
      page = await this.deps.api.messages(session, room.id, room.prevBatch, PAGE_SIZE);
      page.events = await this.decryptAll(room.id, page.events);
    } catch (error) {
      this.error = `Could not load messages: ${friendly(error)}`;
    }
    this.loading.delete(room.id);
    if (generation !== this.generation) return;
    if (page) {
      this.applyState(room, page.state);
      const known = new Set(room.events.map((e) => e.id));
      const older: Shown[] = [];
      for (const event of page.events) {
        if (event.kind === "message" && event.replaces) this.addEvent(room, event, false);
        else if (event.kind === "redaction") this.removeEvent(room, event.redacts);
        else if ((event.kind === "message" || (event.kind === "encrypted" && !event.replaces)) && !known.has(event.id)) older.push(event);
      }
      // Redactions in this page may also remove events from it.
      const redacted = new Set(page.events.flatMap((e) => (e.kind === "redaction" ? [e.redacts] : [])));
      room.events = [...older.filter((e) => !redacted.has(e.id)), ...room.events];
      room.prevBatch = page.end;
      for (const event of older) room.lastActivity = Math.max(room.lastActivity, event.ts);
    }
    this.publish();
  }

  private async loadOlder(): Promise<void> {
    const room = this.selectedRoom();
    if (room) await this.fetchHistory(room);
  }

  /** Clears a room's unread state, and tells the server once per newest event. */
  private markRead(room: Room): void {
    const last = room.events.at(-1);
    if (room.notifications === 0 && room.highlights === 0) return;
    room.notifications = 0;
    room.highlights = 0;
    this.publish();
    if (!last || room.lastRead === last.id) return;
    room.lastRead = last.id;
    void this.deps.api.markRead(this.session!, room.id, last.id).catch(() => undefined);
  }

  private async attempt(what: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.error = `${what}: ${friendly(error)}`;
      this.render();
    }
  }

  /**
   * Sends a message's content, encrypted when the room is. The cached state
   * could be stale, so unless it already says the room is encrypted, the
   * server is asked first; if it cannot answer, nothing is sent. Into an
   * encrypted room nothing goes without working encryption.
   */
  private async sendContent(session: MxSession, room: Room, content: Record<string, unknown>): Promise<string> {
    if (!room.encrypted) {
      const encryption = await this.deps.api.encryption(session, room.id);
      if (encryption) {
        room.encrypted = true;
        room.encryption = encryption;
      }
    }
    if (!room.encrypted) return this.deps.api.send(session, room.id, content);
    const lock = this.lock(room);
    if (lock) {
      this.render();
      throw new Error(lock.reason);
    }
    // The member list (who gets the room key) is fetched in full once; lazy-loaded syncs only name some members.
    room.memberIds ??= new Set(await this.deps.api.members(session, room.id));
    const encrypted = await this.crypto!.encrypt(room.id, { encryption: room.encryption!, history: room.history }, [...room.memberIds], "m.room.message", content);
    return this.deps.api.send(session, room.id, encrypted, "m.room.encrypted");
  }

  private findEvent(room: Room, local: string): Shown | undefined {
    const id = this.byLocal.get(local);
    return id ? room.events.find((e) => e.id === id) : undefined;
  }

  private async send(text: string, replyTo?: string): Promise<void> {
    const room = this.selectedRoom();
    if (!room || text.trim() === "") return;
    const session = this.session!;
    await this.attempt("Message not sent", async () => {
      const content: Record<string, unknown> = { msgtype: "m.text", body: text, "m.mentions": {} };
      const replied = replyTo ? this.findEvent(room, replyTo) : undefined;
      if (replied) content["m.relates_to"] = { "m.in_reply_to": { event_id: replied.id } };
      const id = await this.sendContent(session, room, content);
      const sent: Message = { kind: "message", id, sender: session.userId, ts: Date.now(), content: { msgtype: "m.text", text }, mentions: [] };
      if (replied) sent.replyTo = replied.id;
      this.addEvent(room, sent, false);
      this.publish();
    });
  }

  private async edit(local: string, text: string): Promise<void> {
    const room = this.selectedRoom();
    const session = this.session!;
    const target = room && this.findEvent(room, local);
    if (!room || target?.kind !== "message" || target.sender !== session.userId || !EDITABLE.has(target.content.msgtype)) return;
    await this.attempt("Message not edited", async () => {
      const { msgtype } = target.content;
      const id = await this.sendContent(session, room, {
        msgtype,
        body: `* ${text}`,
        "m.new_content": { msgtype, body: text, "m.mentions": {} },
        "m.relates_to": { rel_type: "m.replace", event_id: target.id },
        "m.mentions": {},
      });
      this.addEvent(room, { kind: "message", id, sender: session.userId, ts: Date.now(), content: { msgtype, text }, mentions: [], replaces: target.id }, false);
      this.publish();
    });
  }

  private async remove(local: string): Promise<void> {
    const room = this.selectedRoom();
    const session = this.session!;
    const target = room && this.findEvent(room, local);
    // Redactions carry no content, so they are fine in encrypted rooms too.
    if (!room || !target || target.sender !== session.userId) return;
    await this.attempt("Message not deleted", async () => {
      await this.deps.api.redact(session, room.id, target.id);
      this.removeEvent(room, target.id);
      this.publish();
    });
  }

  // --- Output -------------------------------------------------------------------

  private memberName(room: Room, user: string): string {
    // User ids are checked to start with "@", so a cleaned one is never empty.
    return room.members.get(user)?.name ?? cleanName(user)!;
  }

  /** The room's name, else (for DMs) the other person, else its alias or members, as Matrix names rooms. */
  private title(room: Room): string {
    const other = this.dmUsers.get(room.id);
    const me = this.session!.userId;
    const heroes = room.heroes.filter((u) => u !== me).map((u) => this.memberName(room, u));
    const title = room.name || (other ? this.memberName(room, other) : "") || room.alias || heroes.join(", ") || "Empty room";
    return cleanName(title) ?? "Empty room";
  }

  private shownContent(room: Room, event: Message): { content: MxContent; edited: boolean } {
    const edit = room.edits.get(`${event.sender}|${event.id}`);
    return edit ? { content: edit.content, edited: true } : { content: event.content, edited: false };
  }

  private eventText(room: Room, event: Shown): string {
    if (event.kind === "encrypted") return event.problem ? `🔒 Unable to decrypt: ${event.problem}` : ENCRYPTED_TEXT;
    return messageText(this.shownContent(room, event).content);
  }

  private dmRooms(): Room[] {
    return [...this.rooms.values()].filter((r) => this.dmUsers.has(r.id)).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  private otherRooms(): Room[] {
    return [...this.rooms.values()].filter((r) => !this.dmUsers.has(r.id)).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  directs(): DirectConversation[] {
    return this.dmRooms()
      .slice(0, MAX_DIRECTS)
      .map((room) => {
        const direct: DirectConversation = {
          key: room.id,
          account: this.account,
          title: this.title(room),
          lastActivity: room.lastActivity,
          unread: room.notifications > 0,
          mentions: room.notifications,
        };
        const avatar = this.avatars.get(this.avatarOf(room) ?? "");
        if (avatar) direct.avatarUrl = avatar;
        const last = room.events.at(-1);
        if (last) direct.preview = (last.kind === "encrypted" ? "🔒 Encrypted message" : this.eventText(room, last)).replace(/\s+/g, " ").slice(0, 200);
        return direct;
      });
  }

  private publish(): void {
    this.directsChanged.emit(this.directs());
    this.render();
  }

  private toNative(room: Room, event: Shown, locked: boolean): NativeMessage {
    const mine = event.sender === this.session!.userId;
    const native: NativeMessage = {
      id: this.local(event.id),
      author: this.memberName(room, event.sender),
      content: escapeMarkdown(this.eventText(room, event)),
      timestamp: new Date(event.ts).toISOString(),
      edited: false,
      mine,
      canEdit: false,
      canDelete: mine,
      reactions: [],
      attachments: [],
    };
    if (event.kind !== "message") return native;
    // A quiet note on the author line: the message decrypted, but from a device its owner has not verified.
    if (event.unverified) native.author = `${native.author} · ${UNVERIFIED_LABEL}`;
    const { content, edited } = this.shownContent(room, event);
    native.edited = edited;
    native.canEdit = mine && !locked && EDITABLE.has(event.content.msgtype);
    if (native.canEdit) native.source = content.text;
    const replied = event.replyTo ? room.events.find((e) => e.id === event.replyTo) : undefined;
    // Reply previews are plain text in the view.
    if (replied) native.reply = { author: this.memberName(room, replied.sender), content: this.eventText(room, replied).slice(0, 100) };
    return native;
  }

  private sidebarItem(room: Room, dm: boolean): NativeSidebarItem {
    const item: NativeSidebarItem = {
      id: room.local,
      name: this.title(room),
      kind: dm ? "dm" : "text",
      unread: room.notifications > 0,
      mentions: dm ? room.notifications : room.highlights,
      active: room.id === this.selected,
    };
    const avatar = dm ? this.avatars.get(this.avatarOf(room) ?? "") : undefined;
    if (avatar) item.iconUrl = avatar;
    return item;
  }

  private viewState(): NativeViewState {
    const platform = this.deps.def.name;
    if (this.step === "connecting") return { screen: "connecting", platform, status: this.status! };
    if (this.step !== "chat") return { screen: "prompt", platform, prompt: this.prompt(), busy: this.busy, status: this.status, error: this.error };
    const dms = this.dmRooms();
    const rooms = this.otherRooms();
    const sidebar: NativeSidebarItem[] = [];
    const category = (id: string, name: string): NativeSidebarItem => ({ id, name, kind: "category", unread: false, mentions: 0, active: false });
    // Until this device is verified, the way to verify it sits at the top.
    if (this.crypto && this.cryptoStatus && !this.cryptoStatus.verified) {
      sidebar.push(category("security", "Encryption"), { id: this.local(VERIFY_ENTRY), name: "🔑 Verify this device", kind: "text", unread: false, mentions: 0, active: false });
    }
    if (dms.length) sidebar.push(category("dms", "Direct messages"), ...dms.map((r) => this.sidebarItem(r, true)));
    if (rooms.length) sidebar.push(category("rooms", "Rooms"), ...rooms.map((r) => this.sidebarItem(r, false)));
    const room = this.selectedRoom();
    const userId = this.session!.userId;
    const locked = room ? this.lock(room)?.notice : undefined;
    return {
      screen: "chat",
      platform,
      title: userId.slice(userId.indexOf(":") + 1),
      me: userId,
      sidebar,
      channel: room
        ? {
            id: room.local,
            name: this.title(room),
            messages: room.events.map((e) => this.toNative(room, e, locked !== undefined)),
            loading: this.loading.has(room.id),
            hasOlder: room.prevBatch !== undefined,
            typing: [],
            pending: [],
            uploading: false,
            ...(locked ? { locked } : {}),
          }
        : null,
      voice: null,
      error: this.error,
    };
  }

  private render(): void {
    this.deps.render(this.viewState());
  }
}
