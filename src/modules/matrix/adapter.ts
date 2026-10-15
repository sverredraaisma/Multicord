import type { AsyncSecretStore } from "../../engine/runtime";
import type { DirectConversation, HomeBadge, PlatformAdapter } from "../../shared/adapter";
import { BaseAdapter } from "../../shared/baseAdapter";
import { MAX_DIRECTS } from "../../shared/engine";
import { escapeMarkdown } from "../../shared/markdown";
import type { NativeAction, NativeAttachment, NativeMessage, NativePrompt, NativeSidebarItem, NativeViewState, NativeVoiceMember, NativeVoiceSession } from "../../shared/native";
import type { AccountStatus } from "../../shared/settings";
import {
  MatrixError,
  matrixErrcode,
  type MatrixApi,
  type MxCallMember,
  type MxContent,
  type MxEncryptedEvent,
  type MxEncryption,
  type MxEvent,
  type MxMedia,
  type MxMediaSource,
  type MxMember,
  type MxOAuthSession,
  type MxPage,
  type MxRoomState,
  type MxRtcTransport,
  type MxSession,
  type MxSync,
} from "./api";
import { CALL_KEYS_TYPE, HostNotAllowedError, MatrixCall, RTC_NOTIFICATION_TYPE, RTC_SLOT_TYPE, ringContent, SLOT_ID, slotContent, STICKY_EVENTS_FEATURE, type CallParticipant, type RtcJoin } from "./calls";
import type { E2ee, E2eeOptions, E2eeStatus } from "./crypto";
import { base64 } from "./client";
import { cleanName, isRecord, liveKitTransports, MAX_CALL_MEMBERS, serviceUrl, userId } from "./events";
import { AttachmentError, decryptAttachment } from "./media";
import { httpsUrl, newDeviceId, OAuthError, type DeviceGrant, type MatrixOAuth, type OAuthServer, type OAuthTokens } from "./oauth";
import type { Verification, VerificationState } from "./verification";

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
/** The sidebar entries that open recovery and verification with another device; Matrix ids never look like these. */
const VERIFY_ENTRY = "#verify";
const DEVICE_ENTRY = "#verify-device";
/** Another device's verification request, in the sidebar and as a notification's target. */
export const REQUEST_ENTRY = "#verify-request";
const EDITABLE = new Set(["m.text", "m.notice", "m.emote"]);
export const ENCRYPTED_TEXT = "🔒 Encrypted message — open this chat in Element to read it";
export const ENCRYPTED_NOTICE =
  "🔒 This room is end-to-end encrypted, which Multicord does not support. Messages here can only be read and sent in Element or another Matrix app with encryption; Multicord never sends unencrypted messages into it.";
export const TOKEN_NOTICE =
  "🔒 This room is end-to-end encrypted. With an access token, Multicord uses Element's device and cannot keep encryption keys of its own, so messages here can only be read and sent in Element. Sign out and sign in with your account (in the browser or with a password) to use encryption in Multicord.";
export const ALGORITHM_NOTICE = "🔒 This room uses an encryption algorithm Multicord does not support, so nothing can be sent here from Multicord.";
export const UNVERIFIED_LABEL = "unverified device";
const CONNECTION_LOST = "Connection lost. Reconnecting…";
/** The LiveKit services and SFU hosts known for this instance, stored so the next start's host lock includes them. */
const RTC_KEY = "rtc";
const MAX_RTC_HOSTS = 10;
/** Sidebar entries for a room's call: "#call:" and the room id. */
const CALL_ENTRY = "#call:";
/** How long joining a call may take before it is given up. */
export const CALL_JOIN_TIMEOUT_MS = 20_000;
/** A DM call rings only when it started this recently, not when an old one is seen after a restart. */
export const RING_WINDOW_MS = 120_000;
export const TOKEN_CALL_NOTICE =
  "With an access token, Multicord shares Element's device, so it cannot join calls as a device of its own. Sign out and sign in with your account (in the browser or with a password) to make calls.";
export const ENCRYPTED_CALL_NOTICE =
  "🔒 This room is end-to-end encrypted, and so are its calls, which this build of Multicord cannot encrypt. Multicord never joins an encrypted room's call unencrypted: join it in Element.";
export const OTHER_SERVER_LABEL = "other call server";
/** Largest media shown in the view (it travels as a data: URL); bigger files say so. */
export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
/** Media kept in memory for the view, all files together; the oldest go first. */
export const MEDIA_CACHE_BYTES = 200 * 1024 * 1024;
export const TOO_LARGE = "too large to show here; open it in Element";
/** loadMedia keys: "mx:", the room's local id and the local id of the event whose content is shown. */
const MEDIA_KEY = /^mx:(\d{1,12}):(\d{1,12})$/;

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
  /** Bytes of loaded media kept for the view (default MEDIA_CACHE_BYTES). */
  mediaBudget?: number;
}

/** The distinct hosts of these URLs, skipping any that are missing. */
export function hostsOf(...urls: (string | undefined)[]): string[] {
  return [...new Set(urls.filter((url): url is string => url !== undefined).map((url) => new URL(url).hostname.toLowerCase()))];
}

/** The screens of a verification by comparing emoji, one per phase. */
type VerifyStep = "verify-incoming" | "verify-wait" | "verify-emoji" | "verify-confirmed" | "verify-done" | "verify-cancelled";
type Step = "connecting" | "oauth" | "device" | "login" | "token" | "retry" | "chat" | "recovery" | VerifyStep;
/** The sign-in screens the secondary button cycles through. */
type SignInStep = "oauth" | "login" | "token";

const VERIFY_STEPS: Record<VerificationState["phase"], VerifyStep> = {
  incoming: "verify-incoming",
  waiting: "verify-wait",
  emoji: "verify-emoji",
  confirmed: "verify-confirmed",
  done: "verify-done",
  cancelled: "verify-cancelled",
};

const isVerifyStep = (step: Step): step is VerifyStep => step.startsWith("verify-");
/** Neither done nor cancelled. */
const going = (verification: Verification): boolean => !["done", "cancelled"].includes(verification.state().phase);

type Shown = Extract<MxEvent, { kind: "message" | "encrypted" }>;
type Message = Extract<MxEvent, { kind: "message" }>;
type RtcEvent = Extract<MxEvent, { kind: "rtc" }>;
/** Encrypted sticky events kept per room until their keys arrive. */
const MAX_STICKY_WAITING = 100;

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
  /** Call memberships by state key, expired ones included (they are filtered when read). */
  calls: Map<string, MxCallMember>;
  /**
   * Sticky call memberships (m.rtc.member) by sender and sticky key: the
   * current event of each, leaves included until they expire, so an older
   * event cannot bring a membership back.
   */
  rtc: Map<string, { id: string; expiresAt: number; member: MxCallMember | null }>;
  /** Encrypted sticky events from outside the timeline whose keys have not arrived; tried again when they do. */
  stickyWaiting: MxEncryptedEvent[];
}

/** What is stored under RTC_KEY. */
interface RtcHosts {
  /** LiveKit services (MatrixRTC foci), the homeserver's preferred first. */
  foci: string[];
  /** Hosts of LiveKit servers (SFUs) the services sent us to. */
  sfu: string[];
  /**
   * The homeserver's LiveKit servers it hands out access to itself (MSC4195
   * transports with a url), with the service of the same transport.
   */
  servers?: { url: string; focus?: string }[];
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63}$/;

/** Stored LiveKit services and SFU hosts, if they are ones we wrote. */
function parseRtc(text: string | undefined): RtcHosts {
  try {
    const value: unknown = text ? JSON.parse(text) : undefined;
    const { foci, sfu, servers } = (value ?? {}) as Record<string, unknown>;
    const strings = (list: unknown): unknown[] => (Array.isArray(list) ? list.slice(0, MAX_RTC_HOSTS) : []);
    const rtc: RtcHosts = {
      foci: strings(foci).flatMap((url) => serviceUrl(url) ?? []),
      sfu: strings(sfu).filter((host): host is string => typeof host === "string" && host.length <= 253 && HOSTNAME.test(host)),
    };
    // Stored as the transports named them, so checked as transports again.
    const known = liveKitTransports(strings(servers).map((s) => (isRecord(s) ? { type: "livekit", url: s.url, livekit_service_url: s.focus } : s)));
    const kept = known.flatMap((t) => (t.sfu ? [serverOf(t.sfu, t.service)] : []));
    if (kept.length) rtc.servers = kept;
    return rtc;
  } catch {
    return { foci: [], sfu: [] };
  }
}

const serverOf = (url: string, focus: string | undefined): { url: string; focus?: string } => (focus ? { url, focus } : { url });

/** What the user sees for Matrix error codes. */
const FRIENDLY: Record<string, string> = {
  M_USER_DEACTIVATED: "This account has been deactivated.",
  M_LIMIT_EXCEEDED: "Too many attempts. Wait a while and try again.",
  M_UNKNOWN_TOKEN: "That access token is not valid (anymore).",
  M_MISSING_TOKEN: "That access token is not valid (anymore).",
};

function friendly(error: unknown, signingIn = false): string {
  const code = matrixErrcode(error);
  // Signing in, M_FORBIDDEN means the credentials; elsewhere the server's own words say what is not allowed.
  if (signingIn && code === "M_FORBIDDEN") return "That username or password is not right.";
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
  /** The verification by comparing emoji on screen, or another device's request waiting in the sidebar. */
  private verification: Verification | undefined;
  /** Counts verification requests, so one answered after it was cancelled is dropped. */
  private verifyAttempt = 0;
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
  /** Media loaded for the view, as data: URLs by media key, oldest first; and why some could not be. */
  private readonly media = new Map<string, string>();
  private mediaBytes = 0;
  private readonly mediaFailed = new Map<string, string>();
  private readonly mediaLoading = new Set<string>();
  private readonly loading = new Set<string>();
  private selected: string | undefined;
  private visible = false;
  /** Counts sign-ins and sign-outs, so a sync loop or task started for one session stops for the next. */
  private generation = 0;
  private rtc: RtcHosts = { foci: [], sfu: [] };
  /** The hosts the engine locked itself to (and so its view); undefined while it is not locked. */
  private lockedHosts: string[] | undefined;
  /** Our device's call, joining or joined; one at a time. */
  private call: MatrixCall | undefined;
  /** Counts joins and leaves, so a join that finishes after the user moved on is dropped. */
  private callAttempt = 0;
  private callTimer: ReturnType<typeof setTimeout> | undefined;
  private callFlags = { mute: false, deaf: false, video: false, stream: false };
  /** A DM whose call is ringing, named in the banner. */
  private ringing: string | undefined;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: MatrixAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
    this.delay = deps.delay ?? defaultDelay;
    this.log = deps.log ?? ((message) => console.warn(`[matrix] ${message}`));
  }

  /** Resumes a saved session, else starts signing in. */
  async start(): Promise<void> {
    this.rtc = parseRtc(await this.deps.secrets.load(RTC_KEY));
    const saved = parseSession(await this.deps.secrets.load(SESSION_KEY));
    if (!saved) return this.showSignIn();
    this.hasSession = true;
    await this.resume(saved);
  }

  private host(): string {
    return new URL(this.deps.def.url).host;
  }

  /**
   * From here on the engine needs only these hosts, plus those of the call
   * services and their LiveKit servers: the view, which carries calls,
   * reaches no more than the engine. A refused lock is logged and changes nothing.
   */
  private async lockToHosts(hosts: string[]): Promise<void> {
    if (!this.deps.lockHosts) return;
    const all = [...new Set([...hosts, ...hostsOf(...this.rtc.foci, ...(this.rtc.servers ?? []).map((s) => s.url)), ...this.rtc.sfu])];
    try {
      await this.deps.lockHosts(all);
      this.lockedHosts = all;
    } catch (error) {
      this.log(`host lock refused: ${friendly(error)}`);
    }
  }

  /** Whether the engine and its view may reach a host. */
  private hostAllowed(host: string): boolean {
    return this.lockedHosts?.includes(host.toLowerCase()) ?? true;
  }

  /**
   * Looks up the call services (MatrixRTC foci) before the host lock: the
   * homeserver's own list (with a session) first, then the server's
   * .well-known. The homeserver's list may also name LiveKit servers it
   * grants access to itself (MSC4195). A failed lookup keeps what was stored.
   */
  private async discoverFoci(session?: MxSession): Promise<void> {
    const [offered, known] = await Promise.all([
      session ? this.deps.api.rtcTransports(session).catch((): MxRtcTransport[] => []) : [],
      this.deps.api.rtcFoci(this.deps.def.url).catch((): string[] => []),
    ]);
    const foci = [...new Set([...offered.flatMap((t) => t.service ?? []), ...known])].slice(0, MAX_RTC_HOSTS);
    const servers = offered.flatMap((t) => (t.sfu ? [serverOf(t.sfu, t.service)] : [])).slice(0, MAX_RTC_HOSTS);
    if (foci.length === 0 && servers.length === 0) return;
    const rtc: RtcHosts = { ...this.rtc, foci: foci.length > 0 ? foci : this.rtc.foci };
    if (servers.length > 0) rtc.servers = servers;
    await this.saveRtc(rtc);
  }

  private async saveRtc(rtc: RtcHosts): Promise<void> {
    const before = JSON.stringify(this.rtc);
    this.rtc = rtc;
    if (JSON.stringify(rtc) !== before) await this.deps.secrets.save(RTC_KEY, JSON.stringify(rtc)).catch(() => undefined);
  }

  private async resume(saved: MxSession): Promise<void> {
    this.connecting(`Connecting to ${this.host()}…`);
    await this.discoverFoci(saved);
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
    this.signedIn(saved, true);
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
    await this.discoverFoci();
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

  /** Starts syncing; after signing in (not on resuming, which looked them up), also asks the homeserver for its call transports, which need a session. */
  private signedIn(session: MxSession, resumed = false): void {
    this.session = session;
    this.hasSession = true;
    this.error = undefined;
    this.connecting("Loading your chats…");
    // Hosts they add are allowed from the next start, as for services found late.
    if (!resumed) void this.discoverFoci(session);
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
    if (key === REQUEST_ENTRY) return this.select(this.local(REQUEST_ENTRY));
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
    // The membership goes while the session can still send it.
    await this.leaveCall(undefined);
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
    this.forgetMedia();
    this.selected = undefined;
    this.directsChanged.emit([]);
    await this.showSignIn();
  }

  /** Drops loaded media: decrypted files must not outlive the session they belong to. */
  private forgetMedia(): void {
    this.media.clear();
    this.mediaBytes = 0;
    this.mediaFailed.clear();
    this.mediaLoading.clear();
  }

  /** The server no longer accepts the token, e.g. after signing out elsewhere. */
  private async sessionEnded(): Promise<void> {
    this.generation++;
    // The server no longer takes our requests; the membership expires (or its delayed leave fires) by itself.
    this.call?.abandon();
    this.call = undefined;
    this.ringing = undefined;
    clearTimeout(this.callTimer);
    await this.forgetSession();
    this.rooms.clear();
    this.dmUsers.clear();
    this.forgetMedia();
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
      case "joinVoice":
        return this.joinCall(action.channelId);
      case "leaveVoice":
        return this.leaveCall(undefined);
      case "voiceState":
        return this.setCallFlags(action);
      case "voiceError":
        return this.leaveCall(`The call ended: ${action.message}`);
      case "loadMedia":
        return this.loadMedia(action.key);
      default:
        // Reactions, uploads, typing and forums are not offered for Matrix.
        return;
    }
  }

  // --- Signing in ---------------------------------------------------------------

  /** The secondary button: the next way to sign in, back from a code or out of recovery. */
  private async cancel(step: string): Promise<void> {
    if (step !== this.step || this.busy) return;
    if (isVerifyStep(step)) return this.cancelVerification(step);
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
    if (isVerifyStep(step)) return this.answerVerification(step);
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
      this.error = friendly(error, true);
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
    if (isVerifyStep(this.step)) return this.verifyPrompt(this.step);
    switch (this.step) {
      case "retry":
        return { id: "retry", title: "Matrix is not reachable", fields: [], submit: "Try again" };
      case "recovery": {
        const field = { name: "key", label: "Recovery key or security phrase", type: "password", autocomplete: "off" } as const;
        const kept = "It stays on this device and is never sent anywhere.";
        if (this.cryptoStatus?.verified) {
          return {
            id: "recovery",
            title: "Restore older messages",
            description: `Enter the recovery key you saved when you set up recovery in Element (48 letters and digits), or your security phrase. Multicord then restores your message keys from the key backup, so older encrypted messages can be read. ${kept}`,
            fields: [field],
            submit: "Restore",
            cancel: "Not now",
          };
        }
        return {
          id: "recovery",
          title: "Verify this device",
          description:
            "Enter the recovery key you saved when you set up recovery in Element (48 letters and digits), or your security phrase. Multicord then signs this device with your cross-signing keys, so your other devices and contacts trust it, and restores your message keys from the key backup, so older encrypted messages can be read. " +
            `To compare emoji with another device instead, choose "Verify with another device" in the sidebar. ${kept}`,
          fields: [field],
          submit: "Verify",
          cancel: "Not now",
        };
      }
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
      crypto.onStatus(() => void this.refreshCryptoStatus(crypto));
      crypto.onVerification((verification) => this.verificationRequested(crypto, verification));
      crypto.onToDevice(CALL_KEYS_TYPE, (event) => this.call?.keys?.receive(event));
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
    this.verification = undefined;
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
    const due = (e: MxEvent): e is MxEncryptedEvent => e.kind === "encrypted" && e.raw !== undefined && (!sessions || sessions.has(e.sessionId ?? ""));
    for (const room of [...this.rooms.values()]) {
      const rtc: RtcEvent[] = [];
      for (const event of room.events.filter(due)) {
        const result = await crypto.decrypt(room.id, event).catch(() => event);
        if (crypto !== this.crypto) return;
        if (result?.kind === "encrypted") continue;
        changed = true;
        const index = room.events.findIndex((e) => e.id === event.id);
        if (index < 0) continue;
        // A message takes the placeholder's place; anything else (an edit, a call membership, a hidden type) removes it.
        if (result?.kind === "message" && !result.replaces) room.events[index] = result;
        else {
          room.events.splice(index, 1);
          if (result?.kind === "rtc") rtc.push(result);
          else if (result) this.addEvent(room, result, false);
        }
      }
      // Sticky memberships from beside the timeline, whose keys came late.
      for (const event of room.stickyWaiting.filter(due)) {
        const result = await crypto.decrypt(room.id, event).catch(() => event);
        if (crypto !== this.crypto) return;
        if (result?.kind === "encrypted") continue;
        room.stickyWaiting = room.stickyWaiting.filter((e) => e !== event);
        if (result?.kind === "rtc") rtc.push(result);
      }
      if (rtc.length === 0) continue;
      changed = true;
      this.applyCalls(room, new Map(), rtc, false);
      const call = this.call;
      if (call?.roomId === room.id && call.grant) void call.keys?.update(this.participants(room));
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

  // --- Verifying by comparing emoji -------------------------------------------------

  /** Follows a verification: the screen shows its phase; one waiting in the sidebar disappears once it ends elsewhere. */
  private follow(verification: Verification): void {
    this.verification = verification;
    verification.onChange(() => {
      if (verification !== this.verification) return;
      if (isVerifyStep(this.step)) this.step = VERIFY_STEPS[verification.state().phase];
      else if (!going(verification)) this.verification = undefined;
      this.render();
    });
  }

  /** Another of the user's devices asks to verify: a sidebar entry and a notification, never a screen taking over the chat. */
  private verificationRequested(crypto: E2ee, verification: Verification): void {
    // One at a time: a request during another verification is left to time out.
    if (crypto !== this.crypto || (this.verification && going(this.verification))) return;
    this.follow(verification);
    const state = verification.state();
    const device = state.phase === "incoming" ? state.device : "Your other device";
    this.notifications.emit({
      title: "Verification request",
      body: `${device} asks to verify by comparing emoji.`.slice(0, 200),
      target: REQUEST_ENTRY,
      railKey: "home",
      inView: this.visible && this.step === "chat",
    });
    this.render();
  }

  /** Sends a verification request to the user's other devices and waits for one to answer. */
  private async startVerification(): Promise<void> {
    const crypto = this.crypto!;
    const attempt = ++this.verifyAttempt;
    this.verification = undefined;
    this.step = "verify-wait";
    this.error = undefined;
    this.render();
    try {
      const verification = await crypto.requestVerification();
      // Cancelled meanwhile, or signed out.
      if (attempt !== this.verifyAttempt || crypto !== this.crypto) return void verification.cancel().catch(() => undefined);
      this.follow(verification);
      this.step = VERIFY_STEPS[verification.state().phase];
    } catch (error) {
      if (attempt !== this.verifyAttempt || crypto !== this.crypto) return;
      this.step = "verify-cancelled";
      this.error = friendly(error);
    }
    this.render();
  }

  private async answerVerification(step: VerifyStep): Promise<void> {
    const verification = this.verification;
    // The waiting screens' buttons are disabled.
    if (step === "verify-wait" || step === "verify-confirmed") return;
    if (step === "verify-done" || step === "verify-cancelled" || !verification) return this.closeVerification();
    this.busy = true;
    this.error = undefined;
    this.render();
    try {
      await (step === "verify-incoming" ? verification.accept() : verification.confirm());
    } catch (error) {
      this.error = friendly(error);
    } finally {
      this.busy = false;
    }
    if (verification !== this.verification) return;
    this.step = VERIFY_STEPS[verification.state().phase];
    this.render();
  }

  /** Back to the chat; a finished verification is forgotten. */
  private closeVerification(): void {
    if (this.verification && !going(this.verification)) this.verification = undefined;
    this.step = "chat";
    this.error = undefined;
    this.status = undefined;
    this.render();
  }

  /** The secondary button: "They don't match", "Try again", or declining or stopping the verification. */
  private async cancelVerification(step: VerifyStep): Promise<void> {
    const verification = this.verification;
    if (step === "verify-cancelled") return this.verification?.outgoing === false ? this.closeVerification() : this.startVerification();
    if (step === "verify-emoji" && verification) {
      // Shows why it ended: the emoji did not match.
      await verification.cancel(true).catch((error: unknown) => this.log(`Verification not cancelled: ${messageOf(error)}`));
      if (verification !== this.verification) return;
      this.step = VERIFY_STEPS[verification.state().phase];
      return this.render();
    }
    this.verifyAttempt++;
    this.verification = undefined;
    this.closeVerification();
    await verification?.cancel().catch((error: unknown) => this.log(`Verification not cancelled: ${messageOf(error)}`));
  }

  private verifyPrompt(step: VerifyStep): NativePrompt {
    const state = this.verification?.state();
    const device = state && "device" in state ? state.device : "your other device";
    const outgoing = this.verification?.outgoing !== false;
    switch (step) {
      case "verify-incoming":
        return {
          id: step,
          title: "Verify your other device?",
          description: `${device}, signed in to your account, asks to verify by comparing emoji. Accept only if you started this on that device just now. Once verified, your devices trust each other.`,
          fields: [],
          submit: "Accept",
          cancel: "Decline",
        };
      case "verify-wait":
        return {
          id: step,
          title: outgoing ? "Verify with another device" : `Verifying ${device}`,
          description: outgoing
            ? `Open Element (or another Matrix app) where you are signed in as ${this.session!.userId}, and accept the verification request there. You then compare emoji on both screens.`
            : `Waiting for ${device} to show the emoji. If it asks how to verify, choose to compare emoji.`,
          fields: [],
          submit: "Waiting…",
          cancel: "Cancel",
        };
      case "verify-emoji": {
        // This screen shows only while the verification is at the emoji.
        const { emoji } = state as Extract<VerificationState, { phase: "emoji" }>;
        return {
          id: step,
          title: emoji.map((e) => e.symbol).join("  "),
          description: `Check that your other device shows the same emoji in the same order: ${emoji.map((e) => e.name).join(", ")}. If they differ, someone may be listening in: choose "They don't match".`,
          fields: [],
          submit: "They match",
          cancel: "They don't match",
        };
      }
      case "verify-confirmed":
        return { id: step, title: "Waiting for your other device", description: "Confirm on your other device that the emoji match.", fields: [], submit: "Waiting…", cancel: "Cancel" };
      case "verify-done":
        return {
          id: step,
          title: "Verified",
          description: "Your devices now trust each other: your messages from here show as verified, and your other devices share message keys with this one.",
          fields: [],
          submit: "Done",
        };
      default: {
        const reason = state?.phase === "cancelled" ? ` It ended because ${state.reason}.` : "";
        const prompt: NativePrompt = { id: step, title: "Verification cancelled", description: `The devices were not verified.${reason}`, fields: [], submit: "Close" };
        if (outgoing) prompt.cancel = "Try again";
        return prompt;
      }
    }
  }

  /** The prompt's status line; the verification screens say what they wait for. */
  private promptStatus(): string | undefined {
    if (this.step === "verify-wait") return this.verification ? "Waiting for your other device…" : "Sending the request…";
    if (this.step === "verify-done") return this.backupNote();
    return this.status;
  }

  /** After a verification: whether older messages can be read, or how to make them readable. */
  private backupNote(): string | undefined {
    const status = this.cryptoStatus;
    if (status?.backup) return "Your key backup is on, so older encrypted messages can be read.";
    if (status?.restorable) return 'To read older encrypted messages, choose "Restore older messages" in the sidebar and enter your recovery key.';
    return undefined;
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
    for (const update of sync.joined) {
      update.timeline = await this.decryptAll(update.roomId, update.timeline);
      if (update.sticky) update.sticky = await this.decryptAll(update.roomId, update.sticky);
    }
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
      room = {
        id,
        local: this.local(id),
        name: "",
        alias: "",
        avatar: "",
        encrypted: false,
        members: new Map(),
        heroes: [],
        events: [],
        edits: new Map(),
        notifications: 0,
        highlights: 0,
        lastActivity: 0,
        calls: new Map(),
        rtc: new Map(),
        stickyWaiting: [],
      };
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
      if (this.ringing === id) this.ringing = undefined;
      if (this.call?.roomId === id) void this.leaveCall("You left the room, so you left its call too.");
    }
    let callChanged = false;
    for (const update of sync.joined) {
      const fresh = !this.rooms.has(update.roomId);
      const room = this.room(update.roomId);
      this.applyState(room, update.state);
      // Sticky memberships come in the timeline, or (after a gap, or on joining) beside it; those still encrypted wait for their keys.
      const rtc = [...(update.sticky ?? []), ...update.timeline].filter((e): e is RtcEvent => e.kind === "rtc");
      for (const event of update.sticky ?? []) {
        if (event.kind === "encrypted" && event.raw) room.stickyWaiting = [...room.stickyWaiting, event].slice(-MAX_STICKY_WAITING);
      }
      if (update.calls || rtc.length > 0) {
        this.applyCalls(room, update.calls ?? new Map(), rtc, !initial);
        callChanged ||= room.id === this.call?.roomId;
      }
      // A call joined unencrypted does not carry on once the room turns encrypted.
      if (room.encrypted && this.call?.roomId === room.id && !this.call.encrypted) void this.leaveCall("This room is now end-to-end encrypted. Join the call again to encrypt it too.");
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
      for (const event of update.timeline) if (event.kind !== "rtc") this.addEvent(room, event, !initial);
    }
    // Recovery and verification are screens of their own; syncs carry on behind them.
    if (this.step !== "recovery" && !isVerifyStep(this.step)) this.step = "chat";
    this.status = undefined;
    if (this.error === CONNECTION_LOST) this.error = undefined;
    const open = this.selectedRoom();
    if (open && this.visible) this.markRead(open);
    // Whoever joined the call gets our media key; when someone left, everyone gets a new one.
    const call = this.call;
    if (callChanged && call?.grant) void call.keys?.update(this.participants(this.rooms.get(call.roomId)!));
    this.publish();
    void this.loadAvatars();
  }

  private removeEvent(room: Room, id: string): void {
    room.events = room.events.filter((e) => e.id !== id);
    // A redacted sticky membership no longer counts (as matrix-js-sdk has it).
    for (const [key, entry] of room.rtc) if (entry.id === id) room.rtc.set(key, { ...entry, member: null });
    for (const [key, edit] of room.edits) if (edit.id === id || key.endsWith(`|${id}`)) room.edits.delete(key);
  }

  /** Adds a timeline event; `live` ones (from a sync after the first) may notify. */
  private addEvent(room: Room, event: Exclude<MxEvent, RtcEvent>, live: boolean): void {
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
    const entry = this.byLocal.get(local);
    if (entry === VERIFY_ENTRY || entry === DEVICE_ENTRY || entry === REQUEST_ENTRY) {
      if (!this.crypto || this.step !== "chat") return;
      if (entry === DEVICE_ENTRY) return this.startVerification();
      if (entry === REQUEST_ENTRY) {
        // The notification may outlive the request.
        if (!this.verification) return;
        this.step = VERIFY_STEPS[this.verification.state().phase];
      } else {
        this.step = "recovery";
      }
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
      // The page's state is older than the room's: it only names senders not known yet.
      for (const [user, member] of Object.entries(page.state.members)) if (!room.members.has(user)) room.members.set(user, member);
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
  private async sendContent(session: MxSession, room: Room, content: Record<string, unknown>, type = "m.room.message"): Promise<string> {
    if (!room.encrypted) {
      const encryption = await this.deps.api.encryption(session, room.id);
      if (encryption) {
        room.encrypted = true;
        room.encryption = encryption;
      }
    }
    const sealed = await this.seal(session, room, type, content);
    return sealed.type === "m.room.message" ? this.deps.api.send(session, room.id, sealed.content) : this.deps.api.send(session, room.id, sealed.content, sealed.type);
  }

  /** A room event as it may be sent: encrypted when the room (as we know it) is; nothing without working encryption. */
  private async seal(session: MxSession, room: Room, type: string, content: Record<string, unknown>): Promise<{ type: string; content: Record<string, unknown> }> {
    if (!room.encrypted) return { type, content };
    const lock = this.lock(room);
    if (lock) {
      this.render();
      throw new Error(lock.reason);
    }
    // The member list (who gets the room key) is fetched in full once; lazy-loaded syncs only name some members.
    room.memberIds ??= new Set(await this.deps.api.members(session, room.id));
    const encrypted = await this.crypto!.encrypt(room.id, { encryption: room.encryption!, history: room.history }, [...room.memberIds], type, content);
    return { type: "m.room.encrypted", content: encrypted };
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

  // --- Media --------------------------------------------------------------------------

  /** What to download for the view: the file, or for a picture too large to show, its thumbnail; undefined when neither fits. */
  private mediaSource(media: MxMedia): MxMediaSource | undefined {
    if (media.size === undefined || media.size <= MAX_MEDIA_BYTES) return media;
    const thumbnail = media.thumbnail;
    const picture = media.kind === "image" || media.kind === "sticker";
    return picture && thumbnail && (thumbnail.size === undefined || thumbnail.size <= MAX_MEDIA_BYTES) ? thumbnail : undefined;
  }

  private attachment(room: Room, id: string, media: MxMedia): NativeAttachment {
    const key = `mx:${room.local}:${this.local(id)}`;
    const shown: NativeAttachment = { name: media.name, kind: media.kind, mime: media.mime, size: media.size, width: media.width, height: media.height };
    if (media.loop) shown.loop = true;
    const url = this.media.get(key);
    if (url) shown.url = url;
    else if (media.problem) shown.unavailable = media.problem;
    else if (this.mediaFailed.has(key)) shown.unavailable = this.mediaFailed.get(key);
    else if (!this.mediaSource(media)) shown.unavailable = TOO_LARGE;
    else shown.mediaKey = key;
    return shown;
  }

  /** The media a shown message carries, by the id of the event its content came from. */
  private mediaOf(room: Room, id: string): MxMedia | undefined {
    for (const event of room.events) {
      if (event.kind !== "message") continue;
      const shown = this.shownContent(room, event);
      if (shown.id === id) return shown.content.attachment;
    }
    return undefined;
  }

  /**
   * Downloads a message's media for the view, once. Keys come from the view,
   * so they only name a message on screen: nothing else is fetched. An
   * encrypted file is checked against its hash and decrypted here; the view
   * never gets its ciphertext.
   */
  private async loadMedia(key: string): Promise<void> {
    const match = MEDIA_KEY.exec(key);
    const session = this.session;
    if (!match || !session || this.media.has(key) || this.mediaLoading.has(key) || this.mediaFailed.has(key)) return;
    const room = this.rooms.get(this.byLocal.get(match[1]!) ?? "");
    const id = this.byLocal.get(match[2]!);
    const media = room && id ? this.mediaOf(room, id) : undefined;
    const source = media && !media.problem ? this.mediaSource(media) : undefined;
    if (!source) return;
    const generation = this.generation;
    this.mediaLoading.add(key);
    let url: string | undefined;
    let failure = TOO_LARGE;
    try {
      // A source has a file or a URL (events.ts sees to it).
      const download = await this.deps.api.download(session, source.file?.url ?? source.url!, MAX_MEDIA_BYTES);
      if (download) {
        const bytes = source.file ? await decryptAttachment(download.bytes, source.file) : download.bytes;
        // An encrypted file's type is the sender's (inside the encrypted event); the server only sees ciphertext.
        const mime = source.mime ?? (source.file ? undefined : download.type) ?? "application/octet-stream";
        url = `data:${mime};base64,${base64(bytes)}`;
      }
    } catch (error) {
      failure = error instanceof AttachmentError ? error.message : `could not load: ${friendly(error)}`;
    } finally {
      this.mediaLoading.delete(key);
    }
    // Signed out meanwhile: it belongs to the previous session.
    if (generation !== this.generation) return;
    if (url) this.remember(key, url);
    else this.mediaFailed.set(key, failure);
    this.render();
  }

  /** Keeps a loaded file, dropping the oldest ones beyond the budget (never the newest). */
  private remember(key: string, url: string): void {
    this.media.set(key, url);
    this.mediaBytes += url.length;
    for (const [old, kept] of this.media) {
      if (this.mediaBytes <= (this.deps.mediaBudget ?? MEDIA_CACHE_BYTES) || old === key) break;
      this.media.delete(old);
      this.mediaBytes -= kept.length;
    }
  }

  // --- Calls --------------------------------------------------------------------------

  /**
   * The devices in a room's call now: memberships not expired, of people
   * still in the room, one per device; a device in both formats counts by its
   * sticky membership, as matrix-js-sdk prefers it.
   */
  private activeMembers(room: Room): MxCallMember[] {
    const now = Date.now();
    const seen = new Set<string>();
    const active: MxCallMember[] = [];
    const sticky = [...room.rtc.values()].flatMap((entry) => entry.member ?? []);
    for (const member of [...sticky, ...room.calls.values()]) {
      const membership = room.members.get(member.user)?.membership;
      const key = `${member.user}|${member.deviceId}`;
      if (member.expiresAt <= now || (membership !== undefined && membership !== "join") || seen.has(key)) continue;
      seen.add(key);
      active.push(member);
    }
    return active.sort((a, b) => a.createdTs - b.createdTs).slice(0, MAX_CALL_MEMBERS);
  }

  /** Other people's devices in a room's call. */
  private othersInCall(room: Room): MxCallMember[] {
    return this.activeMembers(room).filter((m) => m.user !== this.session!.userId);
  }

  /** The other devices in a room's call, for the media key exchange (our other devices included). */
  private participants(room: Room): CallParticipant[] {
    const { userId: me, deviceId } = this.session!;
    return this.activeMembers(room)
      .filter((m) => m.user !== me || m.deviceId !== deviceId)
      .map((m) => ({ userId: m.user, deviceId: m.deviceId, createdTs: m.createdTs, identities: m.identities }));
  }

  /**
   * Applies call membership changes, of state events and sticky events (a
   * sticky one replaces the current event of its key only when it outlasts
   * it, as matrix-js-sdk orders them); a call starting in a DM rings, unless
   * we are in it on some device.
   */
  private applyCalls(room: Room, changes: Map<string, MxCallMember | null>, rtc: RtcEvent[], live: boolean): void {
    const { userId: me, deviceId } = this.session!;
    const before = this.othersInCall(room).length;
    for (const [key, member] of changes) {
      if (!member) {
        room.calls.delete(key);
        continue;
      }
      room.calls.set(key, member);
      if (member.user === me && member.deviceId === deviceId && this.call?.roomId === room.id) this.call.ownMembership(member.createdTs);
    }
    const now = Date.now();
    for (const [key, entry] of room.rtc) if (entry.expiresAt <= now) room.rtc.delete(key);
    for (const event of rtc) {
      const current = room.rtc.get(event.key);
      const newer = current ? event.expiresAt > current.expiresAt || (event.expiresAt === current.expiresAt && event.id > current.id) : room.rtc.size < MAX_CALL_MEMBERS * 2;
      if (newer && event.expiresAt > now) room.rtc.set(event.key, { id: event.id, expiresAt: event.expiresAt, member: event.member });
    }
    if (!this.dmUsers.has(room.id)) return;
    const others = this.othersInCall(room);
    if (others.length === 0) {
      if (this.ringing === room.id) this.ringing = undefined;
      return;
    }
    const caller = others[0]!;
    const inCall = this.call?.roomId === room.id || this.activeMembers(room).some((m) => m.user === me);
    if (!live || before > 0 || inCall || Date.now() - caller.createdTs > RING_WINDOW_MS) return;
    this.ringing = room.id;
    this.incomingCalls.emit({ conversationKey: room.id, from: this.memberName(room, caller.user), video: caller.intent === "video" });
  }

  /**
   * The call service to use in a room: one the people already in the call
   * use (the most used first), so we hear them, else the homeserver's own;
   * only services on hosts the engine may reach.
   */
  private pickFocus(room: Room): string | undefined {
    const counts = new Map<string, number>();
    for (const member of this.othersInCall(room)) if (member.focus) counts.set(member.focus, (counts.get(member.focus) ?? 0) + 1);
    const used = [...counts].sort((a, b) => b[1] - a[1]).map(([focus]) => focus);
    return [...used, ...this.rtc.foci].find((focus) => this.hostAllowed(new URL(focus).hostname));
  }

  /** The homeserver's LiveKit server to publish on in the newer format: one the people in the call use, else its first; only on hosts the engine may reach. */
  private pickServer(room: Room): { url: string; focus?: string } | undefined {
    const servers = (this.rtc.servers ?? []).filter((s) => this.hostAllowed(new URL(s.url).hostname));
    const used = new Set(this.othersInCall(room).flatMap((m) => m.sfu ?? []));
    return servers.find((s) => used.has(s.url)) ?? servers[0];
  }

  /**
   * Which format to join a room's call in: the newer one (a sticky
   * m.rtc.member) when someone in the call uses it, or when only it is
   * possible here, and the homeserver has sticky events; else the state
   * event Element Call has long sent. In the newer format we publish on the
   * homeserver's LiveKit server where it names one (hashed identity), else
   * on the service.
   */
  private async callFormat(session: MxSession, room: Room): Promise<{ focus: string; rtc?: { sfu?: string } } | undefined> {
    const { userId: me, deviceId } = session;
    const sticky = this.activeMembers(room).some((m) => m.memberId !== undefined && (m.user !== me || m.deviceId !== deviceId));
    const focus = this.pickFocus(room);
    const server = this.pickServer(room);
    if ((sticky || !focus) && (focus || server) && (await this.deps.api.supports(session, STICKY_EVENTS_FEATURE).catch(() => false))) {
      return server ? { focus: server.focus ?? focus ?? "", rtc: { sfu: server.url } } : { focus: focus!, rtc: {} };
    }
    return focus ? { focus } : undefined;
  }

  /** Why we cannot join a room's call, or how: encrypted or not, in which format, and through which call service. */
  private async callReady(session: MxSession, room: Room): Promise<string | { encrypted: boolean; focus: string; rtc?: { sfu?: string } }> {
    if (!session.ownDevice || session.deviceId === "") return TOKEN_CALL_NOTICE;
    if (!room.encrypted) {
      // As with sending, the server is asked: our state may be stale, and an encrypted room's call must not be joined unencrypted.
      try {
        const encryption = await this.deps.api.encryption(session, room.id);
        if (encryption) {
          room.encrypted = true;
          room.encryption = encryption;
        }
      } catch (error) {
        return `Could not check whether this room is encrypted, so Multicord did not join its call: ${friendly(error)}`;
      }
    }
    if (room.encrypted && !this.crypto) {
      if (!this.deps.crypto) return ENCRYPTED_CALL_NOTICE;
      const why = this.cryptoProblem ? ` (${this.cryptoProblem})` : "";
      return `🔒 This room is end-to-end encrypted, and so are its calls, but encryption could not start${why}. Multicord never joins an encrypted room's call unencrypted; restart Multicord to try again.`;
    }
    const format = await this.callFormat(session, room);
    if (format) return { encrypted: room.encrypted, ...format };
    const known = [...this.rtc.foci, ...(this.rtc.servers ?? []).map((s) => s.url)];
    if (known.length === 0) return `${this.host()} offers no calls: its homeserver names no call service (MatrixRTC with LiveKit), which Element Call needs as well.`;
    const blocked = known.find((url) => !this.hostAllowed(new URL(url).hostname));
    if (blocked) return `The call service ${new URL(blocked).host} is new to Multicord, which fixes the hosts it may reach when it starts. Restart Multicord to use it.`;
    return `${this.host()} offers calls only in MatrixRTC's newer format, which needs sticky events (MSC4354), and its homeserver does not have them.`;
  }

  private async joinCall(local: string): Promise<void> {
    const entry = this.byLocal.get(local) ?? "";
    const room = entry.startsWith(CALL_ENTRY) ? this.rooms.get(entry.slice(CALL_ENTRY.length)) : undefined;
    const session = this.session;
    if (!room || !session || this.step !== "chat" || this.call?.roomId === room.id) return;
    await this.leaveCall(undefined);
    const attempt = ++this.callAttempt;
    this.error = undefined;
    const ready = await this.callReady(session, room);
    if (attempt !== this.callAttempt || session !== this.session) return;
    if (typeof ready === "string") {
      this.error = ready;
      return this.render();
    }
    const rtc: RtcJoin | undefined = ready.rtc && { ...ready.rtc, seal: (type, content) => this.seal(session, room, type, content) };
    const call = new MatrixCall({
      api: this.deps.api,
      session,
      roomId: room.id,
      focus: ready.focus,
      intent: "audio",
      ...(rtc ? { rtc } : {}),
      e2ee: ready.encrypted ? this.crypto : undefined,
      allowHost: (host) => this.hostAllowed(host),
      changed: () => this.render(),
      // A call reports failure only before it is left, and every call is left before the next one starts.
      failed: (message) => void this.leaveCall(message),
      log: this.log,
    });
    this.call = call;
    this.callFlags = { mute: false, deaf: false, video: false, stream: false };
    if (this.ringing === room.id) this.ringing = undefined;
    this.render();
    // Cleared once joined, and by leaving.
    this.callTimer = setTimeout(() => void this.leaveCall("Could not join the call: the call service did not answer."), CALL_JOIN_TIMEOUT_MS);
    try {
      await call.join();
    } catch (error) {
      if (call !== this.call) return;
      if (!(error instanceof HostNotAllowedError)) return this.leaveCall(`Could not join the call: ${friendly(error)}`);
      // The LiveKit server is known only now; the next start allows it.
      await this.saveRtc({ ...this.rtc, sfu: [...new Set([...this.rtc.sfu, error.host])].slice(-MAX_RTC_HOSTS) });
      return this.leaveCall(
        `The call server ${error.host} is new to Multicord, which fixes the hosts it may reach (and so calls) when it starts. Restart Multicord once to allow it; calls work from then on.`,
      );
    }
    if (call !== this.call) return;
    clearTimeout(this.callTimer);
    void call.keys?.update(this.participants(room));
    // A call starting in a DM rings the other side, as Element does.
    if (this.dmUsers.has(room.id) && this.othersInCall(room).length === 0) void this.ring(session, room, call);
    this.render();
  }

  /** Rings the other side of a DM. Element rings only for a call whose slot is open, so it is opened first; older clients ring without it. */
  private async ring(session: MxSession, room: Room, call: MatrixCall): Promise<void> {
    await this.deps.api.sendState(session, room.id, RTC_SLOT_TYPE, SLOT_ID, slotContent(call.encrypted)).catch((error: unknown) => this.log(`Call slot not opened: ${friendly(error)}`));
    await this.sendContent(session, room, ringContent(call.membershipEventId!, "audio", Date.now()), RTC_NOTIFICATION_TYPE).catch((error: unknown) => this.log(`Ring not sent: ${friendly(error)}`));
  }

  /** Leaves our call, if any: the view hangs up at once, the membership goes after. */
  private async leaveCall(error: string | undefined): Promise<void> {
    const call = this.call;
    if (!call) return;
    this.callAttempt++;
    this.call = undefined;
    clearTimeout(this.callTimer);
    if (error) this.error = error;
    this.render();
    await call.leave();
  }

  private setCallFlags(flags: { mute: boolean; deaf: boolean; video: boolean; stream: boolean }): void {
    if (!this.call) return;
    this.callFlags = { mute: flags.mute, deaf: flags.deaf, video: flags.video, stream: flags.stream };
    this.render();
  }

  /** Who is in a room's call, one row per person; people on a call service we do not use cannot be heard, and say so. */
  private callMembers(room: Room): NativeVoiceMember[] {
    const shown = new Set<string>();
    const rows: NativeVoiceMember[] = [];
    for (const member of this.activeMembers(room)) {
      if (shown.has(member.user)) continue;
      shown.add(member.user);
      const call = this.call?.roomId === room.id ? this.call : undefined;
      // On a transport we do not use: a service other than ours, or a LiveKit server other than ours.
      const named = member.focus !== undefined || member.sfu !== undefined;
      const elsewhere = call !== undefined && named && member.focus !== call.focus && (member.sfu === undefined || member.sfu !== call.sfu);
      const row: NativeVoiceMember = { name: `${this.memberName(room, member.user)}${elsewhere ? ` · ${OTHER_SERVER_LABEL}` : ""}`, muted: false, video: false };
      const avatar = this.avatars.get(room.members.get(member.user)?.avatar ?? "");
      if (avatar) row.avatarUrl = avatar;
      rows.push(row);
    }
    return rows;
  }

  /** The sidebar's calls: ours first, then ongoing ones; and a way to start one in the open room. */
  private callItems(): NativeSidebarItem[] {
    const ours = this.call?.roomId;
    const rooms = [...this.rooms.values()]
      .filter((room) => room.id === ours || this.activeMembers(room).length > 0)
      .sort((a, b) => Number(b.id === ours) - Number(a.id === ours) || b.lastActivity - a.lastActivity);
    const items = rooms.map(
      (room): NativeSidebarItem => ({
        id: this.local(CALL_ENTRY + room.id),
        name: this.title(room),
        kind: "voice",
        unread: room.id === this.ringing,
        mentions: room.id === this.ringing ? 1 : 0,
        active: room.id === ours,
        members: this.callMembers(room),
      }),
    );
    const open = this.selectedRoom();
    if (open && !rooms.includes(open) && (this.rtc.foci.length > 0 || this.rtc.servers !== undefined)) {
      items.push({ id: this.local(CALL_ENTRY + open.id), name: `Start a call in ${this.title(open)}`, kind: "voice", unread: false, mentions: 0, active: false });
    }
    return items;
  }

  private voiceSession(): NativeVoiceSession | null {
    const call = this.call;
    if (!call) return null;
    // Leaving the room leaves its call, so the room is there.
    const room = this.rooms.get(call.roomId)!;
    const voice: NativeVoiceSession = { channelId: this.local(CALL_ENTRY + call.roomId), channelName: this.title(room), guildName: "", ...this.callFlags };
    if (call.grant) {
      voice.url = call.grant.url;
      voice.token = call.grant.jwt;
    }
    // Encrypted or not is decided once, when joining; the view then never connects without encryption.
    if (call.keys) voice.e2ee = { keys: call.keys.keys() };
    return voice;
  }

  /** The banner while a DM call rings and nothing else needs saying. */
  private ringText(): string | undefined {
    const room = this.ringing ? this.rooms.get(this.ringing) : undefined;
    return room ? `📞 ${this.title(room)} is calling. Join under Calls in the sidebar.` : undefined;
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

  /** What a message shows: its latest edit's content, if any; `id` is the event that content came from. */
  private shownContent(room: Room, event: Message): { content: MxContent; edited: boolean; id: string } {
    const edit = room.edits.get(`${event.sender}|${event.id}`);
    return edit ? { content: edit.content, edited: true, id: edit.id } : { content: event.content, edited: false, id: event.id };
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
    const { content, edited, id } = this.shownContent(room, event);
    if (content.attachment) {
      // Shown media speaks for itself: only its caption stays as text (the label remains for notifications and previews).
      native.content = escapeMarkdown(content.text);
      native.attachments = [this.attachment(room, id, content.attachment)];
    }
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
    // A verification can move on before it says so (our "They match" is still being sent while a sync renders): the screen is its phase's.
    if (isVerifyStep(this.step) && this.verification) this.step = VERIFY_STEPS[this.verification.state().phase];
    if (this.step !== "chat") {
      // The waiting screens have nothing to submit.
      const waiting = this.step === "verify-wait" || this.step === "verify-confirmed";
      return { screen: "prompt", platform, prompt: this.prompt(), busy: this.busy || waiting, status: this.promptStatus(), error: this.error };
    }
    const dms = this.dmRooms();
    const rooms = this.otherRooms();
    const sidebar: NativeSidebarItem[] = [];
    const category = (id: string, name: string): NativeSidebarItem => ({ id, name, kind: "category", unread: false, mentions: 0, active: false });
    const entry = (id: string, name: string, attention = false): NativeSidebarItem => ({ id: this.local(id), name, kind: "text", unread: attention, mentions: attention ? 1 : 0, active: false });
    // Until this device is verified, the ways to verify it sit at the top, with another device's request and the way to older messages.
    const security: NativeSidebarItem[] = [];
    const status = this.crypto ? this.cryptoStatus : undefined;
    if (this.verification?.state().phase === "incoming") security.push(entry(REQUEST_ENTRY, "📱 Verification request", true));
    if (status && !status.verified) security.push(entry(VERIFY_ENTRY, "🔑 Verify this device"), entry(DEVICE_ENTRY, "📱 Verify with another device"));
    if (status?.verified && status.restorable) security.push(entry(VERIFY_ENTRY, "🔑 Restore older messages"));
    if (security.length) sidebar.push(category("security", "Encryption"), ...security);
    const calls = this.callItems();
    if (calls.length) sidebar.push(category("calls", "Calls"), ...calls);
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
      voice: this.voiceSession(),
      error: this.error ?? this.ringText(),
    };
  }

  private render(): void {
    this.deps.render(this.viewState());
  }
}
