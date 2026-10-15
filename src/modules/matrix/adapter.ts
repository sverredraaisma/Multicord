import type { AsyncSecretStore, EngineFiles, FileSource } from "../../engine/runtime";
import type { DirectConversation, HomeBadge, PlatformAdapter, RailServer } from "../../shared/adapter";
import { BaseAdapter } from "../../shared/baseAdapter";
import { MAX_DIRECTS, MAX_HTTP_BODY, MAX_READ, type PickedFile } from "../../shared/engine";
import { escapeMarkdown } from "../../shared/markdown";
import {
  MAX_ATTACHMENTS,
  MEMBER_ROWS_SHOWN,
  type NativeAction,
  type NativeAttachment,
  type NativeCustomEmoji,
  type NativeMemberList,
  type NativeMemberSection,
  type NativeMessage,
  type NativeMessageList,
  type NativePoll,
  type NativeSearchResults,
  type NativeProfile,
  type NativePrompt,
  type NativeReaction,
  type NativeSidebarItem,
  type NativeSticker,
  type NativeStickerPack,
  type NativeThreadView,
  type NativeUnread,
  type NativeViewState,
  type NativeVoiceMember,
  type NativeVoiceSession,
  type VoiceNoticeFlag,
} from "../../shared/native";
import { MAX_STATUS_TEXT, TYPING_SETTING, type AccountStatus, type ServiceSettingStatus, type ServiceSettingValues } from "../../shared/settings";
import {
  MatrixError,
  matrixErrcode,
  type MatrixApi,
  type MxCallMember,
  type MxContent,
  type MxEmote,
  type MxEncryptedEvent,
  type MxEncryption,
  type MxEvent,
  type MxMedia,
  type MxMediaSource,
  type MxMember,
  type MxOAuthSession,
  type MxPack,
  type MxPackImage,
  type MxPackRef,
  type MxPage,
  type MxPoll,
  type MxRoomState,
  type MxRtcTransport,
  type MxSession,
  type MxSpaceChild,
  type MxSpaceRoom,
  type MxInvite,
  type MxSync,
} from "./api";
import { CALL_KEYS_TYPE, HostNotAllowedError, MatrixCall, RTC_NOTIFICATION_TYPE, RTC_SLOT_TYPE, ringContent, SLOT_ID, slotContent, STICKY_EVENTS_FEATURE, type CallParticipant, type RtcJoin } from "./calls";
import type { E2ee, E2eeOptions, E2eeStatus } from "./crypto";
import { base64 } from "./client";
import { cleanName, isRecord, liveKitTransports, MAX_CALL_MEMBERS, MAX_ROOM_PACKS, MAX_SPACE_CHILDREN, mimeType, parseContent, parseDirects, parseEmotes, parseEvent, parseFormatting, parseHierarchy, parseJoinedMembers, parseMxc, parsePoll, parsePowerLevels, parsePresence, parseProfile, POLL_TYPES, UNSTABLE_TEXT, MAX_VIA, reactionKey, roomId as checkRoomId, serverName, serviceUrl, userId, type MxProfile } from "./events";
import { AttachmentError, decryptAttachment, encryptAttachment, imageSize } from "./media";
import { markdownHtml, richMarkdown } from "./format";
import { emoticonHtml, emoticonMarkdown, escapeHtml, HTML_FORMAT, packImageId, stickerFormat, textMentions } from "./packs";
import { httpsUrl, newDeviceId, OAuthError, type DeviceGrant, type MatrixOAuth, type OAuthServer, type OAuthTokens } from "./oauth";
import type { Verification, VerificationState } from "./verification";

export const PAGE_SIZE = 50;
/** Pinned messages the pins panel lists at most, newest pin first. */
export const MAX_LISTED_PINS = 50;
/** Search results listed at most, newest first. */
export const SEARCH_LIMIT = 50;
/** Profile pictures fetched per refresh; the rest show initials. */
export const AVATAR_LIMIT = 40;
/** Pictures of a room's members fetched for its member panel; the rest show initials. */
export const MEMBER_AVATAR_LIMIT = 30;
/** Member panel sections by power level (admins at 100 and up, moderators at 50 and up, members), and the role a profile card names. */
const RANKS = ["Admins", "Moderators", "Members"];
const ROLES = ["Admin", "Moderator"];
const rankOf = (level: number): number => (level >= 100 ? 0 : level >= 50 ? 1 : 2);
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
/** loadMedia keys of pack stickers: "mxs:" and the local id of the sticker's mxc:// address. */
const STICKER_KEY = /^mxs:(\d{1,12})$/;
/** Largest sticker shown in the picker. */
export const MAX_STICKER_BYTES = 1024 * 1024;
/** Pack pictures offered in a room, all packs together; the first packs' go first. */
export const MAX_OFFERED_IMAGES = 500;
/** Custom emoji pictures fetched per session (pack emoji and reactions); beyond this the rest are not shown. */
export const MAX_PICTURES = 2000;
/** Pictures fetched between renders while a room's emoji load. */
export const PICTURE_BATCH = 25;
/** Custom emoji names learned from reactions. */
const MAX_SHORTCODES = 2000;
/** The name of the user's own pack when it has none. */
export const USER_PACK_NAME = "Your pack";
/** What a file is sent as, by the first part of its MIME type; anything else goes as m.file. */
const MSGTYPES = ["image", "video", "audio"] as const;

/** Bytes as MB, or KB below one, for messages. */
const sizeText = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`);

/** A picked file's bytes, read in pieces the engine's bridge allows; one that shrank meanwhile is refused. */
async function readFile(file: FileSource): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(file.size);
  for (let start = 0; start < file.size; start += MAX_READ) {
    const end = Math.min(file.size, start + MAX_READ);
    const chunk = await file.read(start, end);
    if (chunk.length !== end - start) throw new Error(`${cleanName(file.filename) ?? "a file"} changed while it was read`);
    bytes.set(chunk, start);
  }
  return bytes;
}

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
  /** Single sign-on: opens the homeserver's SSO page in the browser and gives the login token that comes back (the shell receives it). */
  sso?(url: string): Promise<string>;
  crypto?: MatrixCryptoDeps;
  /** Waits before retrying a failed sync, and between sign-in polls; tests pass their own. */
  delay?: (ms: number) => Promise<void>;
  /** Reports background failures (never secrets). */
  log?: (message: string) => void;
  /** Narrows what the engine may reach to these hosts, once they are known. */
  lockHosts?(hosts: string[]): Promise<void>;
  /** Bytes of loaded media kept for the view (default MEDIA_CACHE_BYTES). */
  mediaBudget?: number;
  /** Lets the user pick files; the engine reads only what was picked. */
  files?: EngineFiles;
  /** This instance's values for the manifest's settings (see SETTING); changes come through applySettings(). */
  settings?: ServiceSettingValues;
}

/** The keys of the settings each Matrix service gets: the manifest's, and the shell's typing choice (sendsTyping). */
export const SETTING = { typing: TYPING_SETTING, readReceipts: "readReceipts", slidingSync: "slidingSync", forgetCallServices: "forgetCallServices" } as const;

/** The distinct hosts of these URLs, skipping any that are missing. */
export function hostsOf(...urls: (string | undefined)[]): string[] {
  return [...new Set(urls.filter((url): url is string => url !== undefined).map((url) => new URL(url).hostname.toLowerCase()))];
}

/** The screens of a verification by comparing emoji, one per phase. */
type VerifyStep = "verify-incoming" | "verify-wait" | "verify-emoji" | "verify-confirmed" | "verify-done" | "verify-cancelled";
type Step = "connecting" | "oauth" | "sso" | "device" | "login" | "token" | "retry" | "chat" | "recovery" | VerifyStep;
/** The sign-in screens the secondary button cycles through. */
type SignInStep = "oauth" | "sso" | "login" | "token";

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
type Reaction = Extract<MxEvent, { kind: "reaction" }>;
type PollEvent = { target: string; sender: string; ts: number; answers?: string[] };
type ThreadOpen = { roomId: string; rootId: string; loading: boolean; error?: string; more?: boolean };
/** Encrypted sticky events kept per room until their keys arrive. */
const MAX_STICKY_WAITING = 100;
/** Reactions kept per room; beyond this the oldest go. */
export const MAX_REACTIONS = 5000;
/** Poll votes and ends kept per room; beyond this the oldest go. */
export const MAX_POLL_EVENTS = 5000;
/** A poll end's text, for clients that show it as a message. */
const POLL_ENDED = "The poll has ended.";
/** Threads kept per room, and replies per thread; beyond these the oldest go. */
export const MAX_THREADS = 200;
export const MAX_THREAD_REPLIES = 500;
/** Replies a thread's panel fetches when it opens: the latest. */
export const THREAD_PAGE = 50;
/** How long the server shows us typing unless renewed; renewed this often while typing goes on, and ended after this long idle (as Element does). */
export const TYPING_TIMEOUT_MS = 30_000;
export const TYPING_REPEAT_MS = 20_000;
export const TYPING_IDLE_MS = 10_000;
/** Top-level spaces shown in the rail; the rooms of any beyond these stay at home. */
export const MAX_SPACES = 100;

/** Rooms' badge together: unread if any is, with all their mentions. */
/** Whether a text has a word or phrase as a whole ("me" is not in "welcome"). */
function hasWord(text: string, word: string): boolean {
  let at = text.indexOf(word);
  const letter = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_]/u.test(char);
  while (at >= 0) {
    if (!letter(text[at - 1]) && !letter(text[at + word.length])) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}

const badge = (rooms: Room[]): HomeBadge => ({ unread: rooms.some((r) => r.notifications > 0), mentions: rooms.reduce((sum, r) => sum + r.highlights, 0) });

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A space's children in the spec's order: those with an order first, by it; then by when they were added; then by room id. */
const byOrder = ([a, x]: [string, MxSpaceChild], [b, y]: [string, MxSpaceChild]): number =>
  Number(x.order === undefined) - Number(y.order === undefined) || compareText(x.order ?? "", y.order ?? "") || x.ts - y.ts || compareText(a, b);

/** One heading of a space's sidebar: the space itself or one of its subspaces, with the rooms it lists. */
interface SpaceSection {
  space: Room;
  rooms: Room[];
}

/** How joined spaces group the rooms: top-level spaces (the rail's servers) and their sections, and the first space each room is in. */
interface SpaceLayout {
  servers: Map<string, SpaceSection[]>;
  owner: Map<string, string>;
}

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
  /** Reactions by their own event id (redacting that id takes one back), in the order they arrived. */
  reactions: Map<string, { target: string; key: string; sender: string }>;
  /** Poll votes (with the answers chosen) and ends (without) by their own event id, in the order they arrived. */
  polls: Map<string, PollEvent>;
  /** Who is typing, as the server last said (it ends typing that is not renewed). */
  typing: string[];
  prevBatch?: string;
  notifications: number;
  highlights: number;
  lastActivity: number;
  /** The last event we sent a read receipt for, or (sliding sync) the one our latest receipt names. */
  lastRead?: string;
  /** When we read up to there (epoch ms), for counting unread events when that event is not held. */
  readTs?: number;
  /** Call memberships by state key, expired ones included (they are filtered when read). */
  calls: Map<string, MxCallMember>;
  /**
   * Sticky call memberships (m.rtc.member) by sender and sticky key: the
   * current event of each, leaves included until they expire, so an older
   * event cannot bring a membership back.
   */
  rtc: Map<string, { id: string; expiresAt: number; member: MxCallMember | null }>;
  /** Threads' replies by their root event, oldest first; kept out of the timeline. */
  threads: Map<string, Shown[]>;
  /** Encrypted sticky events from outside the timeline whose keys have not arrived; tried again when they do. */
  stickyWaiting: MxEncryptedEvent[];
  /** The room is a space (m.room.create type m.space). */
  space: boolean;
  /** A space's children (m.space.child) by room id, joined or not; empty for other rooms. */
  children: Map<string, MxSpaceChild>;
  /** Its pinned events (m.room.pinned_events), oldest pin first. */
  pinned: string[];
  /** The room's image packs with pictures, by state key. */
  packs: Map<string, MxPack>;
}

/** The custom emoji and stickers usable in a room, from its packs, the user's and those the user enabled everywhere. */
interface Offer {
  /** Custom emoji by shortcode (the first pack's where two share one), with the name of their pack. */
  emoticons: Map<string, { image: MxPackImage; source: string }>;
  stickers: { id: string; name: string; images: MxPackImage[] }[];
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

const ALIAS = /^#[^\s:]{1,255}:[A-Za-z0-9.:[\]-]{1,255}$/;
/** A room id: "!" and an opaque part, with the server it was made on in room versions before 12. */
const ROOM_ID = /^![A-Za-z0-9._~=+-]{1,255}(?::[A-Za-z0-9.:[\]-]{1,255})?$/;

/**
 * What a typed room address joins: a room alias (#room:server), a room id
 * (!id or !id:server), or a matrix.to link to either, with the servers the
 * link names to join through (via); undefined for anything else.
 */
export function roomAddress(text: string): { target: string; via: string[] } | undefined {
  let target = text;
  let via: string[] = [];
  const link = /^https:\/\/matrix\.to\/#\/([^/?]+)[^?]*(?:\?(.*))?$/.exec(text);
  if (link) {
    try {
      target = decodeURIComponent(link[1]!);
    } catch {
      return undefined;
    }
    via = new URLSearchParams(link[2] ?? "").getAll("via").filter(serverName).slice(0, MAX_VIA);
  }
  return target.length <= 255 && (ALIAS.test(target) || ROOM_ID.test(target)) ? { target, via } : undefined;
}

/** A text message we sent, as shown: its text, and the custom emoji its formatted_body carries. */
function sentContent(msgtype: string, text: string, content: Record<string, unknown>): MxContent {
  const shown: MxContent = { msgtype, text };
  const emotes = parseEmotes(content);
  if (emotes) shown.emotes = emotes;
  const html = parseFormatting(content);
  if (html) shown.html = html;
  return shown;
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

/** What the module offers the shell; its manifest must declare the same (tested). */
export const CAPABILITIES: PlatformAdapter["capabilities"] = { directMessages: true, messagePreviews: true, voice: true, screenShare: true };

/**
 * Native Matrix adapter: signs in through the homeserver's account page
 * (OAuth 2.0), with a password or with an access token; lists direct chats
 * (m.direct) as direct messages in the rail and the unified Messages page,
 * top-level spaces as servers in the rail with their rooms (and their
 * subspaces' rooms) in its view's sidebar, and every other joined room in
 * the sidebar at home. Runs in its sandboxed
 * engine over plain Client-Server API calls. Devices Multicord owns get
 * end-to-end encryption (crypto.ts); with an access token copied from
 * Element encrypted rooms stay locked, and nothing is ever sent unencrypted
 * into an encrypted room but reactions, which Element sends unencrypted too.
 */
export class MatrixAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = CAPABILITIES;

  private step: Step = "connecting";
  private status: string | undefined;
  private busy = false;
  private error: string | undefined;
  private baseUrl: string | undefined;
  private passwordLogin = false;
  /** The homeserver offers single sign-on, and the engine can receive its token. */
  private ssoLogin = false;
  /** Waiting for single sign-on in the browser; a counter drops a token that comes after the user moved on. */
  private ssoWaiting = false;
  private ssoAttempt = 0;
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
  /** The user's own image pack, and the room packs enabled everywhere (account data). */
  private userPack: MxPack | undefined;
  private packRooms: MxPackRef[] = [];
  /** Rooms the user muted (by push rule): no notifications and no counts, only their unread state. */
  private mutedRooms = new Set<string>();
  /** Custom emoji pictures (pack emoji, and reactions with them) as data: URLs by mxc URI; failed ones are not asked for again. */
  private readonly pictures = new Map<string, string>();
  /** The composer's picker is open: only then do loaded sticker pictures go to the view. */
  private pickerOpen = false;
  private readonly picturesTried = new Set<string>();
  private loadingPictures = false;
  /** Custom emoji names by mxc URI, as reactions with them gave them. */
  private readonly shortcodes = new Map<string, string>();
  private selected: string | undefined;
  /** Where the open room's news began when it was opened: the read receipt and when it was, the newest event then, and how many counted as unread. */
  private unreadAt: { roomId: string; lastRead?: string; readTs?: number; newest?: string; count: number } | undefined;
  /** The open top-level space (a rail server), or undefined at home. */
  private openSpace: string | undefined;
  /** The room last opened in each space ("" for home), to open again on going back. */
  private readonly lastRoom = new Map<string, string>();
  /** The rail servers last sent, as JSON, so an unchanged list is not sent again. */
  private sentServers = "[]";
  private visible = false;
  /** Counts sign-ins and sign-outs, so a sync loop or task started for one session stops for the next. */
  private generation = 0;
  private rtc: RtcHosts = { foci: [], sfu: [] };
  /** Settings: others see while we type. */
  private typingNotices: boolean;
  /** Settings: others see how far we read; off, receipts are private (m.read.private). */
  private readReceipts: boolean;
  /** Settings: sync with sliding sync (MSC4186) when the homeserver has it; else always classic /sync. */
  private slidingSync: boolean;
  /** The hosts the engine locked itself to (and so its view); undefined while it is not locked. */
  private lockedHosts: string[] | undefined;
  /** The thread open beside the open room: its root, and how fetching its replies went. */
  private threadOpen: ThreadOpen | undefined;
  /** Invitations not answered yet, by room id. */
  private readonly invites = new Map<string, MxInvite>();
  /** A room just joined from here, opened once a sync brings it. */
  private opening: string | undefined;
  /** The rooms each opened space lists, from its hierarchy (fetched once per session); undefined while it is fetched. */
  private readonly hierarchies = new Map<string, MxSpaceRoom[] | undefined>();
  /** The open room's pinned messages, while its pins panel is open. */
  private pins: { roomId: string; list: NativeMessageList } | undefined;
  /** The open room's search results, until the search ends; and a count that drops answers to earlier searches. */
  private search: { roomId: string; results: NativeSearchResults } | undefined;
  private searchCount = 0;
  /** The view's member panel is open: the open room's members are fetched and shown. */
  private membersOpen = false;
  /** The open room's joined members and their power levels, fetched afresh when the panel opens on it. */
  private memberList: { roomId: string; members: MxProfile[]; levels: Map<string, number>; loading: boolean; error?: string } | undefined;
  /** The profile card the view asked for last. */
  private profile: NativeProfile | undefined;
  /** Pinned events fetched for the pins panel (decrypted where they could be), by event id; null for one the server would not give. */
  private readonly pinnedEvents = new Map<string, Shown | null>();
  /** Our device's call, joining or joined; one at a time. */
  private call: MatrixCall | undefined;
  /** Counts joins and leaves, so a join that finishes after the user moved on is dropped. */
  private callAttempt = 0;
  /** Counts joins asked for, so of those asked while the previous call is being left only the last goes ahead. */
  private joinRequests = 0;
  private callTimer: ReturnType<typeof setTimeout> | undefined;
  private callFlags = { mute: false, deaf: false, video: false, stream: false };
  /** A DM whose call is ringing, named in the banner. */
  private ringing: string | undefined;
  /** Our own typing notice: in which room, when it was last sent, and the timer that ends it. */
  private ownTyping: { roomId: string; sent: number; stop: ReturnType<typeof setTimeout> } | undefined;
  /** Files picked for each room's next message, and the rooms whose files are being sent. */
  private readonly pending = new Map<string, FileSource[]>();
  private readonly uploading = new Set<string>();
  /** The largest file that can be sent, once the homeserver was asked. */
  private uploadLimit: number | undefined;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: MatrixAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
    this.delay = deps.delay ?? defaultDelay;
    this.log = deps.log ?? ((message) => console.warn(`[matrix] ${message}`));
    this.typingNotices = deps.settings?.[SETTING.typing] !== false;
    this.readReceipts = deps.settings?.[SETTING.readReceipts] !== false;
    this.slidingSync = deps.settings?.[SETTING.slidingSync] !== false;
  }

  // --- Settings (the manifest's `settings`) ----------------------------------------

  applySettings(values: ServiceSettingValues): void {
    this.typingNotices = values[SETTING.typing] !== false;
    // From the next receipt on; one already public stays so.
    this.readReceipts = values[SETTING.readReceipts] !== false;
    // Takes effect with the next sync, which starts over in the other kind.
    this.slidingSync = values[SETTING.slidingSync] !== false;
    // Turned off while typing: end the notice now rather than letting it run out.
    if (!this.typingNotices) this.stopTyping();
  }

  /** The call hosts stored from discovery and from calls, which the host lock allows from each start. */
  settingsStatus(): ServiceSettingStatus {
    const hosts = [...new Set([...hostsOf(...this.rtc.foci, ...(this.rtc.servers ?? []).map((s) => s.url)), ...this.rtc.sfu])];
    if (hosts.length === 0) return { [SETTING.forgetCallServices]: { text: "None remembered yet.", disabled: true } };
    let text = `Remembered: ${hosts.join(", ")}`;
    if (text.length > MAX_STATUS_TEXT) text = `${text.slice(0, MAX_STATUS_TEXT - 1)}…`;
    return { [SETTING.forgetCallServices]: { text } };
  }

  /**
   * Settings' "Forget call services": drops what was learned, including call
   * servers calls ran into, and looks the services up again now. The host
   * lock stays as it is until the next start, as it can only narrow.
   */
  async runSettingAction(key: string): Promise<void> {
    if (key !== SETTING.forgetCallServices) return;
    this.rtc = { foci: [], sfu: [] };
    await this.deps.secrets.delete(RTC_KEY);
    await this.discoverFoci(this.session);
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
    const unreachable = (failure: unknown) => this.showRetry(`Could not reach a Matrix homeserver at ${this.host()}: ${friendly(failure)}`, () => this.showSignIn(error));
    let loginFailure: unknown;
    let flows: { password: boolean; sso: boolean } | undefined;
    try {
      this.baseUrl = await this.deps.api.discover(this.deps.def.url);
      flows = await this.deps.api.loginFlows(this.baseUrl).catch((failure: unknown) => void (loginFailure = failure));
    } catch (failure) {
      return unreachable(failure);
    }
    // Discovery never throws: without an account server, the other ways remain.
    this.oauthServer = await this.deps.oauth?.discover(this.baseUrl).catch(() => undefined);
    // A homeserver that signs in only through its account server need not serve the login endpoint (Synapse with MAS answers it with M_UNRECOGNIZED).
    if (!flows && !this.oauthServer) return unreachable(loginFailure);
    this.passwordLogin = flows?.password ?? false;
    this.ssoLogin = (flows?.sso ?? false) && this.deps.sso !== undefined;
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
    if (this.ssoLogin) steps.push("sso");
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
    // The notice ends by itself on the server; the session to end it with is gone.
    clearTimeout(this.ownTyping?.stop);
    this.ownTyping = undefined;
    // Files picked for this account are not sent from the next.
    this.pending.clear();
    this.uploadLimit = undefined;
    await this.deps.secrets.delete(SESSION_KEY);
    await this.stopCrypto(true);
  }

  // --- Shell interface ---------------------------------------------------------

  override async listDirectConversations(): Promise<DirectConversation[]> {
    return this.directs();
  }

  /** The rooms at home (DM bubbles and spaces carry their own badges), and each invitation waiting there. */
  homeBadge(): HomeBadge {
    const rooms = badge(this.audible(this.homeRooms(this.spaceLayout())));
    return this.invites.size ? { unread: true, mentions: rooms.mentions + this.invites.size } : rooms;
  }

  /** Home: DMs and the rooms in no space, with the room last open there. */
  async openHome(): Promise<void> {
    this.openSpace = undefined;
    await this.reselect([...this.dmRooms(), ...this.homeRooms(this.spaceLayout())], "", false);
  }

  /** Opens a top-level space: its rooms in the sidebar, and the room last open there (else its first). */
  async openServer(key: string): Promise<void> {
    const sections = this.spaceLayout().servers.get(key);
    if (!sections) throw new Error(`Matrix has no server ${key}`);
    this.openSpace = key;
    void this.loadHierarchy(key);
    await this.reselect(
      sections.flatMap((s) => s.rooms),
      key,
      true,
    );
  }

  async openConversation(key: string): Promise<void> {
    if (key === REQUEST_ENTRY) return this.select(this.local(REQUEST_ENTRY));
    // An invitation's notification: it waits at home.
    if (this.invites.has(key)) return this.openHome();
    const room = this.rooms.get(key);
    if (!room) return;
    // The room opens where it is listed: in the open space if that lists it, else in its first space, else at home.
    const layout = this.spaceLayout();
    const here = layout.servers.get(this.openSpace ?? "")?.some((s) => s.rooms.includes(room)) ?? false;
    // DMs are in no space, so they open at home.
    if (!here) this.openSpace = layout.owner.get(room.id);
    await this.select(room.local);
  }

  /** Keeps the open room if `rooms` lists it, else opens the one last open in this place, else (with `first`) the first. */
  private async reselect(rooms: Room[], place: string, first: boolean): Promise<void> {
    const open = this.selectedRoom();
    const last = this.rooms.get(this.lastRoom.get(place) ?? "");
    const room = open && rooms.includes(open) ? open : last && rooms.includes(last) ? last : first ? rooms[0] : undefined;
    if (room && room !== open) this.noteUnread(room);
    this.selected = room?.id;
    this.render();
    this.followMembers();
    if (room) await this.opened(room);
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
    this.forgetRooms();
    await this.showSignIn();
  }

  /** After the session ends: nothing open, and no chats or spaces left in the rail. */
  private forgetRooms(): void {
    this.selected = undefined;
    this.openSpace = undefined;
    this.lastRoom.clear();
    this.userPack = undefined;
    this.packRooms = [];
    this.mutedRooms.clear();
    this.pins = undefined;
    this.search = undefined;
    this.membersOpen = false;
    this.memberList = undefined;
    this.profile = undefined;
    this.pinnedEvents.clear();
    this.invites.clear();
    this.hierarchies.clear();
    this.threadOpen = undefined;
    this.opening = undefined;
    this.directsChanged.emit([]);
    this.publishServers();
  }

  /** Drops loaded media: decrypted files must not outlive the session they belong to. */
  private forgetMedia(): void {
    this.media.clear();
    this.mediaBytes = 0;
    this.mediaFailed.clear();
    this.mediaLoading.clear();
    this.pictures.clear();
    this.picturesTried.clear();
    this.shortcodes.clear();
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
    this.forgetRooms();
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
        return this.send(action.content, action.replyTo, action.thread);
      case "thread":
        return this.openThread(action.rootId);
      case "edit":
        return this.edit(action.messageId, action.content);
      case "delete":
        return this.remove(action.messageId);
      case "react":
        return this.react(action.messageId, action.emoji, action.add);
      case "mute":
        return this.mute(action.channelId, action.mute);
      case "typing":
        return this.sendTyping();
      case "attach":
        return this.attach();
      case "sendFile":
        return this.sendShared(action.file, action.replyTo);
      case "removeAttachment":
        // Not while the files are going out.
        if (!this.uploading.has(this.selected ?? "")) this.pending.get(this.selected ?? "")?.splice(action.index, 1);
        return this.render();
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
      case "voiceNotice":
        return this.callNotice(action.message, action.off);
      case "loadMedia":
        return this.loadMedia(action.key);
      case "picker":
        this.pickerOpen = action.open;
        return this.render();
      case "sendSticker":
        return this.sendSticker(action.stickerId, action.replyTo);
      case "pins":
        return this.showPins(action.open);
      case "forward":
        return this.forward(action.messageId, action.channelId);
      case "search":
        return this.searchMessages(action.query);
      case "pin":
        return this.pin(action.messageId, action.pin);
      case "vote":
        return this.vote(action.messageId, action.options);
      case "createPoll":
        return this.createPoll(action.question, action.answers, action.multiple);
      case "endPoll":
        return this.endPoll(action.messageId);
      case "join":
        return this.join(action.channelId);
      case "decline":
        return this.decline(action.channelId);
      case "joinAddress":
        return this.joinAddress(action.address);
      case "members":
        return this.setMembersOpen(action.open);
      case "profile":
        return this.showProfile(action.id);
      default:
        // Forums are not offered for Matrix.
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
    } else if (step === "oauth" || step === "sso" || step === "login" || step === "token") {
      const next = this.nextSignIn(step);
      if (!next) return;
      // A token the browser still brings is not used.
      this.ssoAttempt++;
      this.ssoWaiting = false;
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
    if (step === "sso") return this.startSso();
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

  /**
   * Single sign-on: the homeserver's sign-in page in the browser, whose
   * login token the shell receives on this computer; then m.login.token
   * gives Multicord a device of its own. A token that comes after the user
   * moved on is dropped unused (it expires by itself).
   */
  private async startSso(): Promise<void> {
    const attempt = ++this.ssoAttempt;
    const baseUrl = this.baseUrl!;
    this.ssoWaiting = true;
    this.error = undefined;
    this.status = "Waiting for you to sign in in your browser…";
    this.render();
    let session: MxSession | undefined;
    try {
      const token = await this.deps.sso!(`${baseUrl}/_matrix/client/v3/login/sso/redirect`);
      if (attempt !== this.ssoAttempt) return;
      session = await this.deps.api.loginToken(baseUrl, token);
      await this.deps.secrets.save(SESSION_KEY, JSON.stringify(session));
    } catch (error) {
      if (attempt !== this.ssoAttempt) return;
      this.error = `Single sign-on did not work: ${friendly(error)}`;
      session = undefined;
    }
    this.ssoWaiting = false;
    this.status = undefined;
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
      if (next) prompt.cancel = { oauth: "Sign in with the browser instead", sso: "Use single sign-on instead", login: "Use a password instead", token: "Use an access token instead" }[next];
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
      case "sso":
        return withCancel(
          {
            id: "sso",
            title: `Sign in to ${host}`,
            description: `You sign in on ${host}'s own sign-in page in your browser (single sign-on), which then hands Multicord a one-time sign-in token on this computer: your password never passes through Multicord. ${encryption}`,
            fields: [],
            submit: "Sign in with single sign-on",
          },
          "sso",
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
      // The timeline (read afresh each time, as removing an event replaces it), then each thread.
      const lists = [() => room.events, ...[...room.threads.values()].map((replies) => () => replies)];
      for (const list of lists) {
        for (const event of list().filter(due)) {
          const result = await crypto.decrypt(room.id, event).catch(() => event);
          if (crypto !== this.crypto) return;
          if (result?.kind === "encrypted") continue;
          changed = true;
          const current = list();
          const index = current.findIndex((e) => e.id === event.id);
          if (index < 0) continue;
          // A message takes the placeholder's place; anything else (an edit, a call membership, a hidden type) removes it.
          if (result?.kind === "message" && !result.replaces) current[index] = result;
          else {
            current.splice(index, 1);
            if (result?.kind === "rtc") rtc.push(result);
            else if (result) this.addEvent(room, result, false);
          }
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
        const sync = await this.deps.api.sync(session, since, since === undefined ? 0 : SYNC_TIMEOUT_MS, this.slidingSync ? "auto" : "classic");
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
        reactions: new Map(),
        polls: new Map(),
        threads: new Map(),
        typing: [],
        notifications: 0,
        highlights: 0,
        lastActivity: 0,
        calls: new Map(),
        rtc: new Map(),
        stickyWaiting: [],
        space: false,
        children: new Map(),
        packs: new Map(),
        pinned: [],
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
    if (state.pinned) {
      room.pinned = state.pinned;
      if (this.pins?.roomId === room.id) void this.loadPins(room);
    }
    if (state.space) room.space = true;
    // Only spaces list children; other rooms' m.space.child events mean nothing.
    for (const [id, child] of room.space ? (state.children ?? []) : []) {
      if (!child) room.children.delete(id);
      else if (room.children.has(id) || room.children.size < MAX_SPACE_CHILDREN) room.children.set(id, child);
    }
    for (const [key, pack] of state.packs ?? []) {
      if (pack.images.length === 0) room.packs.delete(key);
      else if (room.packs.has(key) || room.packs.size < MAX_ROOM_PACKS) room.packs.set(key, pack);
    }
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
    if (sync.userPack) this.userPack = sync.userPack;
    if (sync.packRooms) this.packRooms = sync.packRooms;
    if (sync.mutedRooms) this.mutedRooms = new Set(sync.mutedRooms);
    const invitedBefore = new Set(this.invites.keys());
    if (sync.invitesFull) this.invites.clear();
    for (const invite of sync.invited ?? []) this.invites.set(invite.roomId, invite);
    for (const id of sync.left) {
      this.invites.delete(id);
      this.rooms.delete(id);
      if (this.selected === id) this.selected = undefined;
      // Gone as a space whose last room is remembered, and as a remembered room.
      this.lastRoom.delete(id);
      for (const [place, last] of this.lastRoom) if (last === id) this.lastRoom.delete(place);
      if (this.ringing === id) this.ringing = undefined;
      if (this.call?.roomId === id) void this.leaveCall("You left the room, so you left its call too.");
    }
    let callChanged = false;
    for (const update of sync.joined) {
      const fresh = !this.rooms.has(update.roomId);
      const room = this.room(update.roomId);
      // Messages of a room sent in full (on joining, or as a sync starts over) are not news. (A call in it may still ring: see applyCalls.)
      const live = !initial && !update.initial;
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
      if (update.typing) room.typing = update.typing;
      if (update.unread) {
        room.notifications = update.unread.notifications;
        room.highlights = update.unread.highlights;
      }
      // Read here or on another device.
      if (update.read) {
        room.lastRead = update.read.id;
        room.readTs = update.read.ts;
      }
      if (fresh || (update.limited && !initial)) {
        // A gap: what we had no longer joins up with the new events (their reactions come again with them).
        if (!fresh) {
          room.events = [];
          room.reactions.clear();
          room.polls.clear();
          room.threads.clear();
        }
        room.prevBatch = update.prevBatch;
        // Membership changes may be in the gap too.
        room.memberIds = undefined;
      }
      for (const event of update.timeline) if (event.kind !== "rtc") this.addEvent(room, event, live);
      if (sync.countUnread) this.countUnread(room);
      // Joined, here or elsewhere: no longer an invitation.
      this.invites.delete(room.id);
    }
    if (!initial) for (const invite of this.invites.values()) if (!invitedBefore.has(invite.roomId)) this.notifyInvite(invite);
    const joined = this.opening ? this.rooms.get(this.opening) : undefined;
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
    // A room joined from here opens once it has arrived.
    if (joined) {
      this.opening = undefined;
      void this.openConversation(joined.id);
    }
  }

  /** An invitation that came in: a notification, as Element gives one. */
  private notifyInvite(invite: MxInvite): void {
    const who = invite.inviterName ?? invite.inviter ?? "Someone";
    const what = invite.direct ? "a direct chat" : invite.name ? `${invite.space ? "the space" : ""} ${invite.name}`.trim() : invite.space ? "a space" : "a room";
    this.notifications.emit({
      title: "Invitation",
      body: `${who} invited you to ${what}`.slice(0, 200),
      target: invite.roomId,
      railKey: "home",
      inView: false,
    });
  }

  /** An invitation's sidebar row: the room's name (for a direct chat without one, who sent it), and who invited. Its picture is not fetched. */
  private inviteItem(invite: MxInvite): NativeSidebarItem {
    const from = invite.inviterName ?? invite.inviter;
    const name = invite.name ?? (invite.direct ? from : undefined) ?? "Unnamed room";
    return { id: this.local(invite.roomId), name: invite.space ? `${name} (space)` : name, kind: invite.direct ? "dm" : "text", unread: true, mentions: 0, active: false, invite: from ? { from } : {} };
  }

  /** Fetches once per session which rooms a space lists (its hierarchy, one level down), so those not joined can be joined from it. */
  private async loadHierarchy(spaceId: string): Promise<void> {
    if (this.hierarchies.has(spaceId)) return;
    this.hierarchies.set(spaceId, undefined);
    const generation = this.generation;
    const raw = await this.deps.api.request(this.session!, "GET", `/v1/rooms/${encodeURIComponent(spaceId)}/hierarchy`, undefined, { max_depth: "1", limit: "50" }).catch(() => undefined);
    // Signed out meanwhile: it belongs to the previous account.
    if (generation !== this.generation) return;
    this.hierarchies.set(spaceId, parseHierarchy(raw));
    this.render();
  }

  /** The servers to join a room through that a space lists (its hierarchy names it), or undefined when no space lists it. */
  private listedVia(roomId: string): string[] | undefined {
    if (![...this.hierarchies.values()].some((rooms) => rooms?.some((r) => r.roomId === roomId))) return undefined;
    for (const space of this.rooms.values()) {
      const via = space.children.get(roomId)?.via;
      if (via) return via;
    }
    return [];
  }

  /** Accepts an invitation, or joins a room a space lists. */
  private async join(local: string): Promise<void> {
    const id = this.byLocal.get(local) ?? "";
    if (this.rooms.has(id)) return;
    const via = this.invites.has(id) ? [] : this.listedVia(id);
    if (via) await this.joinRoom(id, via);
  }

  /**
   * Joins a room by its id or alias (POST /join), through the servers given;
   * the room opens once a sync brings it. An accepted invitation to a direct
   * chat goes into m.direct, as Element does, so it shows as one.
   */
  private async joinRoom(target: string, via: string[]): Promise<void> {
    const session = this.session!;
    const invite = this.invites.get(target);
    await this.attempt(`Could not join ${invite?.name ?? target}`, async () => {
      const answer = await this.deps.api.request(session, "POST", `/v3/join/${encodeURIComponent(target)}`, {}, via.length ? { server_name: via[0]! } : undefined);
      this.opening = checkRoomId(answer.room_id);
      if (invite) {
        this.invites.delete(target);
        if (invite.direct && invite.inviter) await this.markDirect(session, invite.inviter, target).catch((error: unknown) => this.log(`Direct chat not listed: ${friendly(error)}`));
      }
      this.publish();
    });
    // A sync may have brought it already.
    const joined = this.rooms.get(this.opening ?? "");
    if (joined) {
      this.opening = undefined;
      await this.openConversation(joined.id);
    }
  }

  /** Adds a room to the user's direct chats with someone (m.direct), keeping the rest as the homeserver has them. */
  private async markDirect(session: MxSession, user: string, id: string): Promise<void> {
    const directs = parseDirects(await this.deps.api.accountData(session, "m.direct"));
    const rooms = directs[user] ?? [];
    if (!rooms.includes(id)) await this.deps.api.request(session, "PUT", `/v3/user/${encodeURIComponent(session.userId)}/account_data/m.direct`, { ...directs, [user]: [...rooms, id] });
    this.dmUsers.set(id, user);
  }

  /** Declines an invitation (POST /leave). */
  private async decline(local: string): Promise<void> {
    const invite = this.invites.get(this.byLocal.get(local) ?? "");
    if (!invite) return;
    await this.attempt("Could not decline the invitation", async () => {
      await this.deps.api.request(this.session!, "POST", `/v3/rooms/${encodeURIComponent(invite.roomId)}/leave`, {});
      this.invites.delete(invite.roomId);
      this.publish();
    });
  }

  /** Joins a room by the address typed (an alias, a room id or a matrix.to link); a room already joined opens. */
  private async joinAddress(text: string): Promise<void> {
    const address = roomAddress(text);
    if (!address) {
      this.error = `"${text.slice(0, 100)}" is not a room address. Use #room:server, !id:server or a matrix.to link.`;
      return this.render();
    }
    const known = [...this.rooms.values()].find((r) => r.id === address.target || r.alias === address.target);
    if (known) return this.openConversation(known.id);
    await this.joinRoom(address.target, address.via);
  }

  private removeEvent(room: Room, id: string): void {
    room.events = room.events.filter((e) => e.id !== id);
    room.reactions.delete(id);
    room.polls.delete(id);
    // In place: decrypting again holds on to the lists.
    for (const replies of room.threads.values()) {
      const index = replies.findIndex((e) => e.id === id);
      if (index >= 0) replies.splice(index, 1);
    }
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
      case "reaction":
        return this.addReaction(room, event);
      case "pollResponse":
      case "pollEnd":
        room.polls.set(event.id, { target: event.target, sender: event.sender, ts: event.ts, ...(event.kind === "pollResponse" ? { answers: event.answers } : {}) });
        if (room.polls.size > MAX_POLL_EVENTS) room.polls.delete(room.polls.keys().next().value!);
        return;
    }
    if (event.kind === "message" && event.replaces) {
      const key = `${event.sender}|${event.replaces}`;
      const known = room.edits.get(key);
      if (!known || known.ts <= event.ts) room.edits.set(key, event);
      return;
    }
    // An edit, a reaction or a poll's vote that cannot be read changes nothing that can be shown.
    if (event.kind === "encrypted" && (event.replaces || event.annotates || event.references)) return;
    if (event.thread) return this.addReply(room, event.thread, event, live);
    if (room.events.some((e) => e.id === event.id)) return;
    room.events.push(event);
    room.lastActivity = Math.max(room.lastActivity, event.ts);
    if (live && event.sender !== this.session!.userId) this.notify(room, event);
  }

  /** Keeps a thread's reply with its thread, in order, once; it notifies like any message. */
  private addReply(room: Room, root: string, event: Shown, live: boolean): void {
    let replies = room.threads.get(root);
    if (!replies) {
      room.threads.set(root, (replies = []));
      if (room.threads.size > MAX_THREADS) room.threads.delete(room.threads.keys().next().value!);
    }
    if (replies.some((e) => e.id === event.id)) return;
    replies.push(event);
    replies.sort((a, b) => a.ts - b.ts);
    if (replies.length > MAX_THREAD_REPLIES) replies.shift();
    room.lastActivity = Math.max(room.lastActivity, event.ts);
    if (live && event.sender !== this.session!.userId) this.notify(room, event);
  }

  /** Keeps a reaction; reactions neither notify nor count as activity, as in Element. */
  private addReaction(room: Room, event: Reaction): void {
    room.reactions.set(event.id, { target: event.target, key: event.key, sender: event.sender });
    if (room.reactions.size > MAX_REACTIONS) room.reactions.delete(room.reactions.keys().next().value!);
    if (event.shortcode && this.shortcodes.size < MAX_SHORTCODES) this.shortcodes.set(event.key, event.shortcode);
  }

  private mentionsMe(room: Room, event: Shown): boolean {
    if (event.kind !== "message") return false;
    const me = this.session!.userId;
    if (event.mentions) return event.mentionsRoom === true || event.mentions.includes(me);
    // Older clients do not say whom they mention: look for our name, or the whole room's, in the text.
    const text = event.content.text.toLowerCase();
    const name = room.members.get(me)?.name?.toLowerCase();
    return text.includes(me.toLowerCase()) || text.includes("@room") || (name !== undefined && hasWord(text, name));
  }

  /**
   * Unread counts for a sync that leaves them to the client (sliding sync):
   * others' messages after the one we read, or (when that one is not held)
   * after when we read it; highlights are those that mention us. Unlike the
   * server's counts, push rules are not applied (a muted room counts too).
   */
  private countUnread(room: Room): void {
    const me = this.session!.userId;
    const index = room.events.findIndex((e) => e.id === room.lastRead);
    const after = index >= 0 ? room.events.slice(index + 1) : room.events.filter((e) => e.ts > (room.readTs ?? -1));
    const unread = after.filter((e) => e.sender !== me);
    room.notifications = unread.length;
    room.highlights = unread.filter((e) => this.mentionsMe(room, e)).length;
  }

  private notify(room: Room, event: Shown): void {
    // A muted room raises nothing, mentions included, as in Element.
    if (this.mutedRooms.has(room.id)) return;
    const dm = this.dmUsers.has(room.id);
    if (!dm && !this.mentionsMe(room, event)) return;
    const title = this.title(room);
    this.notifications.emit({
      title: dm ? title : `${this.memberName(room, event.sender)} in ${title}`.slice(0, 200),
      body: this.eventText(room, event).slice(0, 200),
      target: room.id,
      railKey: dm ? `dm:${room.id}` : (this.spaceLayout().owner.get(room.id) ?? "home"),
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
      const spaces = [...this.spaceLayout().servers.keys()].map((id) => this.rooms.get(id)!);
      for (const room of [...this.dmRooms().slice(0, AVATAR_LIMIT), ...spaces]) {
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

  /** A DM's or space's picture: the room's own, else (for a DM) the other person's. */
  private avatarOf(room: Room): string | undefined {
    return room.avatar || room.members.get(this.dmUsers.get(room.id) ?? "")?.avatar;
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
    if (this.selected !== room.id) this.noteUnread(room);
    if (this.pins?.roomId !== room.id) this.pins = undefined;
    if (this.search?.roomId !== room.id) this.search = undefined;
    if (this.threadOpen?.roomId !== room.id) this.threadOpen = undefined;
    this.selected = room.id;
    this.lastRoom.set(this.openSpace ?? "", room.id);
    this.render();
    this.followMembers();
    await this.opened(room);
  }

  /** Notes where a room being opened has news, before it is marked read. */
  private noteUnread(room: Room): void {
    this.unreadAt = room.notifications > 0 ? { roomId: room.id, lastRead: room.lastRead, readTs: room.readTs, newest: room.events.at(-1)?.id, count: room.notifications } : undefined;
  }

  /**
   * The open room's unread marker: the first event from someone else after
   * the read receipt it had when opened; without a receipt in the loaded
   * events, the one after when it was read, if the loaded events reach back
   * that far; without either (classic sync sends no receipts), the one as
   * many from the end as counted unread, up to the newest event then.
   */
  private unreadView(room: Room, at: NonNullable<MatrixAdapter["unreadAt"]>): NativeUnread {
    const me = this.session!.userId;
    const events = room.events;
    const complete = room.prevBatch === undefined;
    const read = at.lastRead === undefined ? -1 : events.findIndex((e) => e.id === at.lastRead);
    let first: Shown | undefined;
    if (read >= 0) first = events.slice(read + 1).find((e) => e.sender !== me);
    else if (at.readTs !== undefined) first = complete || events.some((e) => e.ts <= at.readTs!) ? events.find((e) => e.ts > at.readTs! && e.sender !== me) : undefined;
    else {
      const newest = events.findIndex((e) => e.id === at.newest);
      const others = events.slice(0, newest + 1).filter((e) => e.sender !== me);
      first = others.length >= at.count ? others[others.length - at.count] : complete ? others[0] : undefined;
    }
    return first ? { firstId: this.local(first.id), count: at.count } : { count: at.count };
  }

  /** A room just opened: its first messages if none came yet, and a read receipt if it is in view. */
  private async opened(room: Room): Promise<void> {
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
        if (((event.kind === "message" || event.kind === "encrypted") && event.thread) || (event.kind === "message" && event.replaces) || event.kind === "reaction" || event.kind === "pollResponse" || event.kind === "pollEnd") this.addEvent(room, event, false);
        else if (event.kind === "redaction") this.removeEvent(room, event.redacts);
        else if ((event.kind === "message" || (event.kind === "encrypted" && !event.replaces && !event.annotates && !event.references)) && !known.has(event.id)) older.push(event);
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
    room.readTs = last.ts;
    void this.deps.api.markRead(this.session!, room.id, last.id, !this.readReceipts).catch(() => undefined);
  }

  /** Mutes or unmutes a room with a push rule of its own, as Element does, and follows it here at once. */
  private async mute(local: string, mute: boolean): Promise<void> {
    const room = this.rooms.get(this.byLocal.get(local) ?? "");
    if (!room || this.mutedRooms.has(room.id) === mute) return;
    await this.attempt(mute ? "Could not mute the room" : "Could not unmute the room", async () => {
      await this.deps.api.muteRoom(this.session!, room.id, mute);
      if (mute) this.mutedRooms.add(room.id);
      else this.mutedRooms.delete(room.id);
      this.publish();
    });
  }

  /** Opens the open room's pins panel and lists its pins, or closes it. */
  private async showPins(open: boolean): Promise<void> {
    const room = open ? this.selectedRoom() : undefined;
    this.pins = room ? { roomId: room.id, list: { messages: [], loading: true } } : undefined;
    this.render();
    if (room) await this.loadPins(room);
  }

  /**
   * Lists a room's pinned events, newest pin first (up to MAX_LISTED_PINS):
   * those in the timeline as they are, others fetched once and decrypted
   * where they can be. A reply for a panel since closed is dropped.
   */
  private async loadPins(room: Room): Promise<void> {
    const session = this.session!;
    const shown: Shown[] = [];
    for (const id of [...room.pinned].reverse().slice(0, MAX_LISTED_PINS)) {
      let event: Shown | null | undefined = room.events.find((e) => e.id === id) ?? this.pinnedEvents.get(id);
      if (event === undefined) {
        const raw = await this.deps.api.request(session, "GET", `/v3/rooms/${encodeURIComponent(room.id)}/event/${encodeURIComponent(id)}`).catch(() => undefined);
        const parsed = parseEvent(raw);
        const [found] = parsed ? await this.decryptAll(room.id, [parsed]) : [];
        event = found && (found.kind === "message" || found.kind === "encrypted") && found.id === id ? found : null;
        this.pinnedEvents.set(id, event);
      }
      if (event) shown.push(event);
    }
    if (this.pins?.roomId !== room.id) return;
    const messages = shown.map((event) => ({ id: this.local(event.id), author: this.memberName(room, event.sender), content: escapeMarkdown(this.eventText(room, event)), timestamp: new Date(event.ts).toISOString() }));
    this.pins = { roomId: room.id, list: { messages, loading: false, ...(shown.length < Math.min(room.pinned.length, MAX_LISTED_PINS) ? { note: "Some pinned messages could not be loaded." } : {}) } };
    this.render();
  }

  /**
   * Searches the open room on the homeserver (POST /search, newest first),
   * or ends the search with an empty query. The homeserver cannot read
   * encrypted messages, so in an encrypted room the results say so.
   */
  private async searchMessages(query: string): Promise<void> {
    const room = this.selectedRoom();
    const count = ++this.searchCount;
    const trimmed = query.trim();
    this.search = room && trimmed !== "" ? { roomId: room.id, results: { query: trimmed, messages: [], loading: true } } : undefined;
    this.render();
    if (!this.search || !room) return;
    let results: NativeSearchResults;
    try {
      const body = { search_categories: { room_events: { search_term: trimmed, order_by: "recent", filter: { rooms: [room.id], limit: SEARCH_LIMIT } } } };
      const answer = await this.deps.api.request(this.session!, "POST", "/v3/search", body);
      const categories = isRecord(answer.search_categories) ? answer.search_categories : {};
      const found = isRecord(categories.room_events) && Array.isArray(categories.room_events.results) ? categories.room_events.results : [];
      const events = found.slice(0, SEARCH_LIMIT).flatMap((hit) => {
        const event = parseEvent(isRecord(hit) ? hit.result : undefined);
        return event?.kind === "message" ? [event] : [];
      });
      const messages = events.map((event) => ({ id: this.local(event.id), author: this.memberName(room, event.sender), content: escapeMarkdown(this.eventText(room, event)), timestamp: new Date(event.ts).toISOString() }));
      results = { query: trimmed, messages, loading: false };
    } catch (error) {
      results = { query: trimmed, messages: [], loading: false, error: `Search failed: ${friendly(error)}` };
    }
    if (room.encrypted) results.note = "This room is encrypted, so the homeserver can only search messages sent before that.";
    if (count !== this.searchCount || this.search?.roomId !== room.id) return;
    this.search = { roomId: room.id, results };
    this.render();
  }

  /**
   * Forwards a message of the open room into another room listed in the
   * sidebar, as plain text: who wrote it, the text quoted, and the names of
   * its files (not the files: an encrypted file's key must not reach a room
   * it was not meant for). Empty m.mentions, so the copy pings nobody; into
   * an encrypted room it goes encrypted, as any message.
   */
  private async forward(local: string, target: string): Promise<void> {
    const room = this.selectedRoom();
    const event = room ? this.findEvent(room, local) : undefined;
    const to = this.rooms.get(this.byLocal.get(target) ?? "");
    if (!room || event?.kind !== "message" || !to) return;
    const { content } = this.shownContent(room, event);
    const lines = [...(content.text === "" ? [] : content.text.split("\n")), ...(content.attachment ? [`📎 ${content.attachment.name}`] : [])];
    const body = [`Forwarded from ${this.memberName(room, event.sender)}:`, ...lines.map((line) => `> ${line}`)].join("\n");
    await this.attempt("Message not forwarded", async () => {
      await this.sendContent(this.session!, to, { msgtype: "m.text", body, "m.mentions": {} });
    });
  }

  /** The view's member panel opened (fetching the open room's members afresh) or closed. */
  private async setMembersOpen(open: boolean): Promise<void> {
    this.membersOpen = open;
    this.memberList = undefined;
    this.render();
    if (open) await this.loadMembers();
  }

  /** With the panel open, its list follows the open room. */
  private followMembers(): void {
    if (this.membersOpen && this.memberList?.roomId !== this.selected) void this.loadMembers();
  }

  /**
   * Fetches the open room's joined members (GET joined_members) and power
   * levels, only while the panel shows them: a room may have thousands.
   * Pictures of the first members follow through the thumbnail path. The
   * homeserver sends no presence here (sync asks for none).
   */
  private async loadMembers(): Promise<void> {
    const room = this.selectedRoom();
    this.memberList = undefined;
    if (!room) return this.render();
    const list: NonNullable<MatrixAdapter["memberList"]> = { roomId: room.id, members: [], levels: new Map(), loading: true };
    this.memberList = list;
    this.render();
    const session = this.session!;
    const path = `/v3/rooms/${encodeURIComponent(room.id)}`;
    try {
      const [joined, levels] = await Promise.all([
        this.deps.api.request(session, "GET", `${path}/joined_members`),
        // Without power levels, everyone is listed as a member.
        this.deps.api.request(session, "GET", `${path}/state/m.room.power_levels/`).catch(() => undefined),
      ]);
      list.members = parseJoinedMembers(joined);
      list.levels = parsePowerLevels(levels);
    } catch (error) {
      list.error = `Could not load members: ${friendly(error)}`;
    }
    list.loading = false;
    // Closed, another room opened, or signed out meanwhile.
    if (this.memberList !== list) return;
    this.render();
    let found = false;
    for (const member of this.sortedMembers(list).slice(0, MEMBER_AVATAR_LIMIT)) {
      const mxc = member.avatar;
      if (!mxc || this.avatarsTried.has(mxc)) continue;
      this.avatarsTried.add(mxc);
      const url = await this.deps.api.thumbnail(session, mxc).catch(() => undefined);
      if (this.memberList !== list) return;
      if (url) this.avatars.set(mxc, url);
      found ||= url !== undefined;
    }
    if (found) this.render();
  }

  /** Admins (power level 100 and up) first, then moderators (50 and up), then members; by name within each. */
  private sortedMembers(list: NonNullable<MatrixAdapter["memberList"]>): MxProfile[] {
    const level = (m: MxProfile) => rankOf(list.levels.get(m.id) ?? 0);
    return [...list.members].sort((a, b) => level(a) - level(b) || (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }

  /** The member panel's list: at most MEMBER_ROWS_SHOWN, the rest counted. Members are mentioned by user id, which sending turns into a pill. */
  private memberView(room: Room, list: NonNullable<MatrixAdapter["memberList"]>): NativeMemberList {
    const sections: NativeMemberSection[] = [];
    const shown = this.sortedMembers(list).slice(0, MEMBER_ROWS_SHOWN);
    for (const member of shown) {
      const title = RANKS[rankOf(list.levels.get(member.id) ?? 0)]!;
      if (sections.at(-1)?.name !== title) sections.push({ name: title, members: [] });
      const avatarUrl = this.avatars.get(member.avatar ?? "");
      sections.at(-1)!.members.push({ id: member.id, name: member.name ?? this.memberName(room, member.id), mention: member.id, ...(avatarUrl ? { avatarUrl } : {}) });
    }
    const view: NativeMemberList = { sections, hasMore: false, loading: list.loading };
    if (list.members.length > shown.length) view.more = list.members.length - shown.length;
    if (list.error) view.error = list.error;
    return view;
  }

  /**
   * Someone's profile card: their name and picture in the open room, and
   * their role where the member list knows it, at once; then their own
   * profile and, where the homeserver shares it, their presence.
   */
  private async showProfile(id: string): Promise<void> {
    const user = userId(id);
    if (!user) return;
    const room = this.selectedRoom();
    const member = room?.members.get(user);
    const profile: NativeProfile = { id: user, username: user, loading: true };
    if (member?.name) profile.name = member.name;
    const known = this.avatars.get(member?.avatar ?? "");
    if (known) profile.avatarUrl = known;
    // The member list, where loaded, is the open room's.
    const rank = rankOf(this.memberList?.levels.get(user) ?? 0);
    if (rank < 2) profile.roles = [{ name: ROLES[rank]! }];
    this.profile = profile;
    this.render();
    const session = this.session!;
    const path = encodeURIComponent(user);
    const [found, presence] = await Promise.all([
      this.deps.api.request(session, "GET", `/v3/profile/${path}`).catch(() => undefined),
      this.deps.api.request(session, "GET", `/v3/presence/${path}/status`).catch(() => undefined),
    ]);
    if (this.profile !== profile) return;
    const own = parseProfile(user, found);
    if (!profile.name && own.name) profile.name = own.name;
    Object.assign(profile, parsePresence(presence));
    const mxc = own.avatar;
    if (!known && mxc) {
      const url = this.avatars.get(mxc) ?? (await this.deps.api.thumbnail(session, mxc).catch(() => undefined));
      if (this.profile !== profile) return;
      if (url) {
        this.avatars.set(mxc, url);
        profile.avatarUrl = url;
      }
    }
    delete profile.loading;
    this.render();
  }

  /** When a poll ended, by its end from whoever started it (the earliest); undefined while it is open. */
  private pollEnd(room: Room, poll: Message): number | undefined {
    let end: number | undefined;
    for (const e of room.polls.values()) if (e.target === poll.id && !e.answers && e.sender === poll.sender && (end === undefined || e.ts < end)) end = e.ts;
    return end;
  }

  /**
   * A poll as the view shows it, from the votes in the loaded timeline: each
   * person's latest vote counts if it came before the poll ended; answers the
   * poll does not offer are ignored, and only the first maxSelections count.
   * Votes show once it ended, or at once where it is disclosed; the user's own
   * choice always.
   */
  private pollView(room: Room, event: Message, poll: MxPoll, locked: boolean): NativePoll {
    const end = this.pollEnd(room, event);
    const latest = new Map<string, PollEvent>();
    for (const vote of room.polls.values()) {
      if (vote.target !== event.id || !vote.answers || (end !== undefined && vote.ts > end)) continue;
      if (vote.ts >= (latest.get(vote.sender)?.ts ?? -1)) latest.set(vote.sender, vote);
    }
    const offered = new Set(poll.answers.map((a) => a.id));
    const counts = new Map<string, number>();
    let total = 0;
    let mine: string[] = [];
    for (const [sender, vote] of latest) {
      const chosen = [...new Set(vote.answers!.filter((a) => offered.has(a)))].slice(0, poll.maxSelections);
      if (chosen.length === 0) continue;
      total++;
      for (const answer of chosen) counts.set(answer, (counts.get(answer) ?? 0) + 1);
      if (sender === this.session!.userId) mine = chosen;
    }
    const closed = end !== undefined;
    const shown = poll.disclosed || closed;
    const view: NativePoll = {
      question: poll.question,
      options: poll.answers.map((answer, i) => ({ id: `a${i}`, text: answer.text, ...(shown ? { votes: counts.get(answer.id) ?? 0 } : {}), ...(mine.includes(answer.id) ? { chosen: true } : {}) })),
      multiple: poll.maxSelections > 1,
      closed,
    };
    if (shown) view.total = total;
    if (!closed && !locked) view.canVote = true;
    // Only the end of whoever started it counts.
    if (!closed && !locked && event.sender === this.session!.userId) view.canEnd = true;
    return view;
  }

  /**
   * Votes in a poll of the open room: a poll response naming the answers
   * chosen (none takes the vote back), in the poll's own form (stable or
   * MSC3381's unstable one), encrypted where the room is.
   */
  private async vote(local: string, options: string[]): Promise<void> {
    const room = this.selectedRoom();
    const event = room ? this.findEvent(room, local) : undefined;
    const poll = event?.kind === "message" ? event.content.poll : undefined;
    if (!room || !poll || this.lock(room) || this.pollEnd(room, event as Message) !== undefined) return;
    const target = event!.id;
    const answers = [...new Set(options.flatMap((option) => poll.answers[Number(/^a(\d{1,2})$/.exec(option)?.[1] ?? NaN)]?.id ?? []))].slice(0, poll.maxSelections);
    const session = this.session!;
    const relation = { rel_type: "m.reference", event_id: target };
    const content = poll.stable ? { "m.relates_to": relation, "m.selections": answers } : { "m.relates_to": relation, [POLL_TYPES.response[1]]: { answers } };
    await this.attempt("Vote not sent", async () => {
      const id = await this.sendContent(session, room, content, POLL_TYPES.response[poll.stable ? 0 : 1]);
      this.addEvent(room, { kind: "pollResponse", id, sender: session.userId, ts: Date.now(), target, answers }, false);
      this.render();
    });
  }

  /**
   * Starts a poll in the open room, encrypted where the room is: an
   * m.poll.start with its answers numbered, disclosed (votes show as they
   * come, as Element's polls do). Beside the stable content it carries
   * MSC3381's unstable form and text fallbacks, which Element reads and
   * clients without polls show.
   */
  private async createPoll(question: string, answers: string[], multiple: boolean): Promise<void> {
    const room = this.selectedRoom();
    if (!room || this.lock(room)) return;
    const session = this.session!;
    const ids = answers.map((_, i) => `answer-${i + 1}`);
    const maxSelections = multiple ? answers.length : 1;
    const fallback = [question, ...answers.map((answer, i) => `${i + 1}. ${answer}`)].join("\n");
    const content: Record<string, unknown> = {
      "m.poll": {
        question: { "m.text": [{ body: question }] },
        kind: "m.disclosed",
        max_selections: maxSelections,
        answers: answers.map((answer, i) => ({ "m.id": ids[i], "m.text": [{ body: answer }] })),
      },
      "m.text": [{ body: fallback }],
      [POLL_TYPES.start[1]]: {
        question: { [UNSTABLE_TEXT]: question, body: question, msgtype: "m.text" },
        kind: "org.matrix.msc3381.poll.disclosed",
        max_selections: maxSelections,
        answers: answers.map((answer, i) => ({ id: ids[i], [UNSTABLE_TEXT]: answer })),
      },
      [UNSTABLE_TEXT]: fallback,
      body: fallback,
    };
    await this.attempt("Poll not sent", async () => {
      const id = await this.sendContent(session, room, content, POLL_TYPES.start[0]);
      const poll = parsePoll(content, true)!;
      this.addEvent(room, { kind: "message", id, sender: session.userId, ts: Date.now(), content: { msgtype: "m.poll", text: "", media: `📊 ${poll.question}`, poll }, mentions: [] }, false);
      this.publish();
    });
  }

  /** Ends a poll the user started in the open room: a poll end in the poll's own form, encrypted where the room is. */
  private async endPoll(local: string): Promise<void> {
    const room = this.selectedRoom();
    const event = room ? this.findEvent(room, local) : undefined;
    const poll = event?.kind === "message" ? event.content.poll : undefined;
    const session = this.session!;
    if (!room || !poll || event!.sender !== session.userId || this.lock(room) || this.pollEnd(room, event as Message) !== undefined) return;
    const target = event!.id;
    const relation = { rel_type: "m.reference", event_id: target };
    const content = poll.stable ? { "m.relates_to": relation, "m.text": [{ body: POLL_ENDED }] } : { "m.relates_to": relation, [POLL_TYPES.end[1]]: {}, [UNSTABLE_TEXT]: POLL_ENDED, body: POLL_ENDED };
    await this.attempt("Poll not ended", async () => {
      const id = await this.sendContent(session, room, content, POLL_TYPES.end[poll.stable ? 0 : 1]);
      this.addEvent(room, { kind: "pollEnd", id, sender: session.userId, ts: Date.now(), target }, false);
      this.render();
    });
  }

  /** Pins or unpins a message in the open room's m.room.pinned_events; the homeserver decides whether the user may. */
  private async pin(local: string, pin: boolean): Promise<void> {
    const room = this.selectedRoom();
    const event = room ? this.findEvent(room, local) : undefined;
    if (!room || !event) return;
    const pinned = [...room.pinned.filter((id) => id !== event.id), ...(pin ? [event.id] : [])];
    await this.attempt(pin ? "Message not pinned" : "Message not unpinned", async () => {
      await this.deps.api.sendState(this.session!, room.id, "m.room.pinned_events", "", { pinned });
      this.applyState(room, { members: {}, pinned });
      this.render();
    });
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
  private async sendContent(session: MxSession, room: Room, content: Record<string, unknown>, type = "m.room.message", clearMedia = false): Promise<string> {
    await this.checkEncryption(session, room);
    // A file uploaded unencrypted never goes into a room that turned encrypted meanwhile.
    if (clearMedia && room.encrypted) throw new Error("the room turned end-to-end encrypted while the file was uploading");
    const sealed = await this.seal(session, room, type, content);
    return sealed.type === "m.room.message" ? this.deps.api.send(session, room.id, sealed.content) : this.deps.api.send(session, room.id, sealed.content, sealed.type);
  }

  /** Asks the server whether a room is encrypted, unless we know it is; an unanswered question throws. */
  private async checkEncryption(session: MxSession, room: Room): Promise<void> {
    if (room.encrypted) return;
    const encryption = await this.deps.api.encryption(session, room.id);
    if (encryption) {
      room.encrypted = true;
      room.encryption = encryption;
    }
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

  /** An event of the timeline or of a thread, by the view's id for it. */
  private findEvent(room: Room, local: string): Shown | undefined {
    const id = this.byLocal.get(local);
    return id ? this.shownEvents(room).find((e) => e.id === id) : undefined;
  }

  /** The timeline's events and the threads' replies. */
  private shownEvents(room: Room): Shown[] {
    return [...room.events, ...[...room.threads.values()].flat()];
  }

  /**
   * Sends the open room's picked files, each a message of its own as Element
   * sends them, then the text. A reply goes with the text, or without text
   * with the first file. Files sent are dropped from the list at once, so a
   * failure part way sends only the rest next time.
   */
  private async send(text: string, replyTo?: string, thread?: string): Promise<void> {
    const room = this.selectedRoom();
    if (thread) return this.sendToThread(room, thread, text, replyTo);
    const files = room ? (this.pending.get(room.id) ?? []) : [];
    if (!room || this.uploading.has(room.id) || (text.trim() === "" && files.length === 0)) return;
    const session = this.session!;
    this.stopTyping();
    const replied = replyTo ? this.findEvent(room, replyTo) : undefined;
    const uploading = files.length > 0;
    if (uploading) {
      this.uploading.add(room.id);
      this.render();
    }
    await this.attempt("Message not sent", async () => {
      let fileReply = text.trim() === "" ? replied : undefined;
      while (files.length > 0) {
        await this.sendFile(session, room, files[0]!, fileReply);
        files.shift();
        fileReply = undefined;
      }
      if (text.trim() !== "") await this.sendText(session, room, text, replied);
      this.publish();
    });
    if (!uploading) return;
    this.uploading.delete(room.id);
    if (files.length === 0) this.pending.delete(room.id);
    this.render();
  }

  /**
   * Sends text, as a reply or into a thread. A thread's message answers the
   * message it replies to there (a reply without is_falling_back), else
   * points at the thread's latest message as a fallback reply
   * (is_falling_back), as the spec has it, for clients without threads.
   */
  private async sendText(session: MxSession, room: Room, text: string, replied: Shown | undefined, root?: Shown): Promise<void> {
    const mentioned = this.mentioned(session, text);
    const content: Record<string, unknown> = { msgtype: "m.text", body: text, "m.mentions": mentioned.length > 0 ? { user_ids: mentioned } : {} };
    const html = this.messageHtml(room, text, mentioned);
    if (html) Object.assign(content, { format: HTML_FORMAT, formatted_body: html });
    if (root && replied) content["m.relates_to"] = { rel_type: "m.thread", event_id: root.id, "m.in_reply_to": { event_id: replied.id } };
    else if (root) {
      const latest = room.threads.get(root.id)?.at(-1) ?? root;
      content["m.relates_to"] = { rel_type: "m.thread", event_id: root.id, is_falling_back: true, "m.in_reply_to": { event_id: latest.id } };
    } else if (replied) content["m.relates_to"] = { "m.in_reply_to": { event_id: replied.id } };
    const id = await this.sendContent(session, room, content);
    const sent: Message = { kind: "message", id, sender: session.userId, ts: Date.now(), content: sentContent("m.text", text, content), mentions: mentioned };
    if (root) sent.thread = root.id;
    if (replied) sent.replyTo = replied.id;
    this.addEvent(room, sent, false);
  }

  /**
   * Sends text into a thread of the open room, answering one of its
   * messages (the root or a reply) where `replyTo` names one; picked files
   * wait for the conversation's composer.
   */
  private async sendToThread(room: Room | undefined, local: string, text: string, replyTo: string | undefined): Promise<void> {
    const root = room ? this.findEvent(room, local) : undefined;
    if (!room || !root || text.trim() === "") return;
    const target = replyTo ? this.findEvent(room, replyTo) : undefined;
    const replied = target && (target.id === root.id || target.thread === root.id) ? target : undefined;
    this.stopTyping();
    await this.attempt("Message not sent", async () => {
      await this.sendText(this.session!, room, text, replied, root);
      this.publish();
    });
  }

  /** Opens a message's thread beside the open room, fetching its latest replies; or closes it. */
  private async openThread(local: string | undefined): Promise<void> {
    const room = this.selectedRoom();
    const root = room && local ? this.findEvent(room, local) : undefined;
    const open: ThreadOpen | undefined = room && root ? { roomId: room.id, rootId: root.id, loading: true } : undefined;
    this.threadOpen = open;
    this.render();
    if (!room || !open) return;
    try {
      const path = `/v1/rooms/${encodeURIComponent(room.id)}/relations/${encodeURIComponent(open.rootId)}/m.thread`;
      const answer = await this.deps.api.request(this.session!, "GET", path, undefined, { limit: String(THREAD_PAGE), dir: "b" });
      const parsed = (Array.isArray(answer.chunk) ? answer.chunk.slice(0, THREAD_PAGE) : []).flatMap((raw) => parseEvent(raw) ?? []);
      for (const event of await this.decryptAll(room.id, parsed)) {
        if ((event.kind === "message" || event.kind === "encrypted") && event.thread === open.rootId) this.addReply(room, open.rootId, event, false);
      }
      if (typeof answer.next_batch === "string") open.more = true;
    } catch (error) {
      open.error = `Could not load the thread: ${friendly(error)}`;
    }
    open.loading = false;
    if (this.threadOpen === open) this.render();
  }

  /** The open thread as the view shows it: its root and replies, and why nothing may be sent into it. */
  private threadState(room: Room, open: ThreadOpen, locked: string | undefined, reactions: Map<string, Map<string, Set<string>>>, emojiUrls: Map<string, string>): NativeThreadView {
    const root = room.events.find((e) => e.id === open.rootId);
    const events = [...(root ? [root] : []), ...(room.threads.get(open.rootId) ?? [])];
    const thread: NativeThreadView = { rootId: this.local(open.rootId), messages: events.map((e) => this.toNative(room, e, locked !== undefined, reactions, emojiUrls)), loading: open.loading };
    if (open.error) thread.error = open.error;
    if (open.more) thread.note = `Only the latest ${THREAD_PAGE} replies are listed; older ones may be missing.`;
    if (locked) thread.locked = locked;
    return thread;
  }

  /**
   * Uploads a picked file and sends it. Whether the room is encrypted is
   * settled before anything is uploaded: into an encrypted room only
   * ciphertext goes, with a key of its own inside the encrypted event and
   * without its name, and nothing at all without working encryption.
   */
  private async sendFile(session: MxSession, room: Room, file: FileSource, replied: Shown | undefined): Promise<void> {
    await this.checkEncryption(session, room);
    const lock = this.lock(room);
    if (lock) {
      this.render();
      throw new Error(lock.reason);
    }
    const bytes = await readFile(file);
    const mime = mimeType(file.contentType) ?? "application/octet-stream";
    const name = cleanName(file.filename, 255) ?? "file";
    const msgtype = MSGTYPES.find((type) => mime.startsWith(`${type}/`)) ?? "file";
    const info: Record<string, unknown> = { mimetype: mime, size: bytes.length };
    if (msgtype === "image") Object.assign(info, await imageSize(bytes, mime));
    const content: Record<string, unknown> = { msgtype: `m.${msgtype}`, body: name, info, "m.mentions": {} };
    if (room.encrypted) {
      const encrypted = await encryptAttachment(bytes);
      content.file = { ...encrypted.file, url: await this.deps.api.upload(session, encrypted.data, "application/octet-stream") };
    } else {
      content.url = await this.deps.api.upload(session, bytes, mime, name);
    }
    if (replied) content["m.relates_to"] = { "m.in_reply_to": { event_id: replied.id } };
    const id = await this.sendContent(session, room, content, "m.room.message", content.url !== undefined);
    // Shown at once from the bytes at hand, rather than downloaded again.
    const sent: Message = { kind: "message", id, sender: session.userId, ts: Date.now(), content: parseContent(content)!, mentions: [] };
    if (replied) sent.replyTo = replied.id;
    this.addEvent(room, sent, false);
    if (bytes.length <= MAX_MEDIA_BYTES) this.remember(`mx:${room.local}:${this.local(id)}`, `data:${mime};base64,${base64(bytes)}`);
  }

  /** Adds files from the OS picker to the open room's next message, leaving out any larger than can be sent. */
  private async attach(): Promise<void> {
    const room = this.selectedRoom();
    if (!room || !this.deps.files || this.uploading.has(room.id) || this.lock(room)) return;
    const session = this.session!;
    await this.attempt("Could not attach", async () => {
      // Picked first: the shell lets the engine open the picker only right after the user asked.
      const picked = await this.deps.files!.pick();
      const limit = await this.maxUpload(session);
      const list = this.pending.get(room.id) ?? [];
      for (const file of picked) {
        if (list.length >= MAX_ATTACHMENTS) {
          this.error = `At most ${MAX_ATTACHMENTS} files per message.`;
          break;
        }
        if (file.size > limit) this.error = `${cleanName(file.filename) ?? "A file"} is larger than the ${sizeText(limit)} ${this.host()} takes.`;
        else list.push(file);
      }
      this.pending.set(room.id, list);
      this.render();
    });
  }

  /** The largest file that can be sent: the homeserver's limit (asked once), within what the engine's bridge carries. */
  private async maxUpload(session: MxSession): Promise<number> {
    this.uploadLimit ??= Math.min((await this.deps.api.uploadLimit(session).catch(() => undefined)) ?? MAX_HTTP_BODY, MAX_HTTP_BODY);
    return this.uploadLimit;
  }

  /**
   * A file the shell hands over (a favourite, or a sticker sent as a
   * picture): it goes out at once, or waits with files already picked.
   */
  private async sendShared(picked: PickedFile, replyTo?: string): Promise<void> {
    const room = this.selectedRoom();
    if (!room || !this.deps.files?.open || this.uploading.has(room.id) || this.lock(room)) return;
    const file = this.deps.files.open(picked);
    await this.attempt("Could not send", async () => {
      const limit = await this.maxUpload(this.session!);
      if (file.size > limit) throw new Error(`${cleanName(file.filename) ?? "The file"} is larger than the ${sizeText(limit)} ${this.host()} takes.`);
      const list = this.pending.get(room.id) ?? [];
      if (list.length >= MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} files per message.`);
      list.push(file);
      this.pending.set(room.id, list);
      if (list.length === 1) return this.send("", replyTo);
      this.render();
    });
  }

  private async edit(local: string, text: string): Promise<void> {
    const room = this.selectedRoom();
    const session = this.session!;
    const target = room && this.findEvent(room, local);
    if (!room || target?.kind !== "message" || target.sender !== session.userId || !EDITABLE.has(target.content.msgtype)) return;
    await this.attempt("Message not edited", async () => {
      const { msgtype } = target.content;
      // The new content says everyone it mentions; the edit itself no one, so nobody is notified again.
      const mentioned = this.mentioned(session, text);
      const fresh: Record<string, unknown> = { msgtype, body: text, "m.mentions": mentioned.length > 0 ? { user_ids: mentioned } : {} };
      const content: Record<string, unknown> = {
        msgtype,
        body: `* ${text}`,
        "m.new_content": fresh,
        "m.relates_to": { rel_type: "m.replace", event_id: target.id },
        "m.mentions": {},
      };
      const html = this.messageHtml(room, text, mentioned);
      if (html) {
        Object.assign(fresh, { format: HTML_FORMAT, formatted_body: html });
        Object.assign(content, { format: HTML_FORMAT, formatted_body: `* ${html}` });
      }
      const id = await this.sendContent(session, room, content);
      this.addEvent(room, { kind: "message", id, sender: session.userId, ts: Date.now(), content: sentContent(msgtype, text, fresh), mentions: mentioned, replaces: target.id }, false);
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

  /** Our reaction with this key to this event: its event id, which redacting takes it back by. */
  private ownReaction(room: Room, target: string, key: string): string | undefined {
    const me = this.session!.userId;
    for (const [id, reaction] of room.reactions) if (reaction.target === target && reaction.key === key && reaction.sender === me) return id;
    return undefined;
  }

  /**
   * Adds or takes back our reaction to a message. As in Element, a reaction
   * goes out unencrypted even in an encrypted room: matrix-js-sdk never
   * encrypts m.reaction, since its relation is readable either way and an
   * encrypted one would notify like a message. Nothing goes into a room whose
   * encryption Multicord cannot take part in. Taking it back redacts it.
   */
  private async react(local: string, key: string, add: boolean): Promise<void> {
    const room = this.selectedRoom();
    const target = room && this.findEvent(room, local);
    if (!room || target?.kind !== "message" || !reactionKey(key) || this.lock(room)) return;
    const session = this.session!;
    const mine = this.ownReaction(room, target.id, key);
    if (add === (mine !== undefined)) return;
    await this.attempt(add ? "Reaction not sent" : "Reaction not removed", async () => {
      if (mine) {
        await this.deps.api.redact(session, room.id, mine);
        this.removeEvent(room, mine);
      } else {
        const content: Record<string, unknown> = { "m.relates_to": { rel_type: "m.annotation", event_id: target.id, key } };
        const reaction: Reaction = { kind: "reaction", id: "", sender: session.userId, ts: Date.now(), target: target.id, key };
        // A custom emoji's key is its mxc:// URI; its name goes along, as Beeper and Cinny send it.
        const shortcode = [...this.offer(room).emoticons.values()].find((e) => e.image.url === key)?.image.shortcode;
        if (shortcode) {
          content["com.beeper.reaction.shortcode"] = `:${shortcode}:`;
          reaction.shortcode = shortcode;
        }
        reaction.id = await this.deps.api.send(session, room.id, content, "m.reaction");
        this.addReaction(room, reaction);
      }
      this.render();
    });
  }

  /**
   * Tells the open room we are typing. Typing notices are never encrypted,
   * in Element either. The server shows one for TYPING_TIMEOUT_MS, so it is
   * renewed while typing goes on, and ended after a pause, on sending, or
   * on typing in another room.
   */
  private sendTyping(): void {
    const room = this.selectedRoom();
    if (!room || !this.typingNotices) return;
    const now = Date.now();
    const current = this.ownTyping?.roomId === room.id ? this.ownTyping : undefined;
    if (!current) this.stopTyping();
    const renew = !current || now - current.sent >= TYPING_REPEAT_MS;
    if (renew) this.typingNotice(room.id, true);
    clearTimeout(current?.stop);
    this.ownTyping = { roomId: room.id, sent: renew ? now : current.sent, stop: setTimeout(() => this.stopTyping(), TYPING_IDLE_MS) };
  }

  private stopTyping(): void {
    const typing = this.ownTyping;
    if (!typing) return;
    clearTimeout(typing.stop);
    this.ownTyping = undefined;
    this.typingNotice(typing.roomId, false);
  }

  /** Typing notices are best effort: a failed one changes nothing shown. */
  private typingNotice(roomId: string, typing: boolean): void {
    void this.deps.api.typing(this.session!, roomId, typing, TYPING_TIMEOUT_MS).catch(() => undefined);
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
    for (const event of this.shownEvents(room)) {
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
    const session = this.session;
    if (!session || this.media.has(key) || this.mediaLoading.has(key) || this.mediaFailed.has(key)) return;
    const sticker = STICKER_KEY.exec(key);
    const source = sticker ? this.stickerSource(sticker[1]!) : this.messageSource(key);
    if (!source) return;
    const generation = this.generation;
    this.mediaLoading.add(key);
    let url: string | undefined;
    let failure = TOO_LARGE;
    try {
      // A source has a file or a URL (events.ts sees to it).
      const download = await this.deps.api.download(session, source.file?.url ?? source.url!, sticker ? MAX_STICKER_BYTES : MAX_MEDIA_BYTES);
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

  /** What a message's media key names, when that message is shown. */
  private messageSource(key: string): MxMediaSource | undefined {
    const match = MEDIA_KEY.exec(key);
    const room = match ? this.rooms.get(this.byLocal.get(match[1]!) ?? "") : undefined;
    const id = match ? this.byLocal.get(match[2]!) : undefined;
    const media = room && id ? this.mediaOf(room, id) : undefined;
    return media && !media.problem ? this.mediaSource(media) : undefined;
  }

  /** A sticker's picture, when the open room offers it: stickers are not encrypted. */
  private stickerSource(local: string): MxMediaSource | undefined {
    const room = this.selectedRoom();
    const url = this.byLocal.get(local);
    const image = room ? this.offeredStickers(room).find((i) => i.url === url) : undefined;
    return image ? { url: image.url, mime: image.info.mimetype as string | undefined } : undefined;
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

  // --- Custom emoji and stickers (image packs, MSC2545) -------------------------------

  /**
   * What a room offers: its own packs, the user's pack, then the room packs
   * the user enabled everywhere (of rooms this account is in), at most
   * MAX_OFFERED_IMAGES pictures in all. A shortcode two packs share is the
   * first one's, so ":name:" in a message means one picture.
   */
  private offer(room: Room): Offer {
    const packs = [...room.packs.values()].map((pack) => ({ name: pack.name ?? this.title(room), pack }));
    if (this.userPack) packs.push({ name: this.userPack.name ?? USER_PACK_NAME, pack: this.userPack });
    for (const ref of this.packRooms) {
      const other = ref.roomId === room.id ? undefined : this.rooms.get(ref.roomId);
      const pack = other?.packs.get(ref.stateKey);
      if (pack) packs.push({ name: pack.name ?? this.title(other!), pack });
    }
    const offer: Offer = { emoticons: new Map(), stickers: [] };
    let left = MAX_OFFERED_IMAGES;
    for (const [index, { name, pack }] of packs.entries()) {
      const images = pack.images.slice(0, left);
      left -= images.length;
      for (const image of images) if (image.emoticon && !offer.emoticons.has(image.shortcode)) offer.emoticons.set(image.shortcode, { image, source: name });
      const stickers = images.filter((image) => image.sticker);
      if (stickers.length) offer.stickers.push({ id: `p${index}`, name, images: stickers });
    }
    return offer;
  }

  private offeredStickers(room: Room): MxPackImage[] {
    return this.offer(room).stickers.flatMap((pack) => pack.images);
  }

  /** A message's text as formatted_body with the room's custom emoji in it; undefined without any. */
  /** The users a message's text mentions by their ID, as the composer inserts mentions; never the user themselves. */
  private mentioned(session: MxSession, text: string): string[] {
    return textMentions(text).filter((user) => user !== session.userId);
  }

  /** formatted_body for a message: its markdown as HTML, its custom emoji as pictures and the users it mentions as pills; undefined for plain text. */
  private messageHtml(room: Room, text: string, mentioned: string[]): string | undefined {
    const { emoticons } = this.offer(room);
    const pill = (user: string) => (mentioned.includes(user) ? this.memberName(room, user) : undefined);
    return markdownHtml(text, (run) => emoticonHtml(run, (shortcode) => emoticons.get(shortcode)?.image, pill) ?? escapeHtml(run));
  }

  /** The loadMedia key of a sticker's picture. */
  private stickerKey(image: MxPackImage): string {
    return `mxs:${this.local(image.url)}`;
  }

  /**
   * Sends a sticker the open room offers as m.sticker, as Element does:
   * encrypted in an encrypted room like any message, its picture's address
   * the pack's own (pack pictures are not encrypted).
   */
  private async sendSticker(stickerId: string, replyTo?: string): Promise<void> {
    const room = this.selectedRoom();
    const image = room ? this.offeredStickers(room).find((i) => packImageId(i.url) === stickerId) : undefined;
    if (!room || !image || this.lock(room)) return;
    const session = this.session!;
    const replied = replyTo ? this.findEvent(room, replyTo) : undefined;
    this.stopTyping();
    await this.attempt("Sticker not sent", async () => {
      const content: Record<string, unknown> = { body: image.body ?? image.shortcode, url: image.url, info: image.info, "m.mentions": {} };
      if (replied) content["m.relates_to"] = { "m.in_reply_to": { event_id: replied.id } };
      const id = await this.sendContent(session, room, content, "m.sticker");
      const sent: Message = { kind: "message", id, sender: session.userId, ts: Date.now(), content: parseContent(content, true)!, mentions: [] };
      if (replied) sent.replyTo = replied.id;
      this.addEvent(room, sent, false);
      // Shown at once with the picture the picker loaded.
      const picture = this.media.get(this.stickerKey(image));
      if (picture) this.remember(`mx:${room.local}:${this.local(id)}`, picture);
      this.publish();
    });
  }

  /** The open room's custom emoji whose picture has loaded, for the pickers. */
  private customEmoji(offer: Offer): NativeCustomEmoji[] {
    return [...offer.emoticons.values()].flatMap(({ image, source }) => {
      const url = this.pictures.get(image.url);
      const id = packImageId(image.url);
      // The reaction key is the mxc URI, as Element and Cinny react with custom emoji.
      return url && id ? [{ id, name: image.shortcode, animated: false, url, source, text: `:${image.shortcode}:`, key: image.url }] : [];
    });
  }

  /** The open room's stickers, each with its picture or the key to load it by; those that could not load are left out. */
  private stickerPacks(offer: Offer): NativeStickerPack[] {
    return offer.stickers.flatMap((pack) => {
      const stickers = pack.images.flatMap((image): NativeSticker[] => {
        const id = packImageId(image.url);
        const key = this.stickerKey(image);
        if (!id || this.mediaFailed.has(key)) return [];
        const sticker: NativeSticker = { id, name: image.body ?? image.shortcode, format: stickerFormat(image) };
        // Loaded pictures (data: URLs) stay out of updates while the picker is closed; it shows none then.
        const url = this.pickerOpen ? this.media.get(key) : undefined;
        if (url) sticker.url = url;
        else sticker.mediaKey = key;
        return [sticker];
      });
      return stickers.length ? [{ id: pack.id, name: pack.name, stickers }] : [];
    });
  }

  /** A reaction as shown: a custom emoji's (an mxc URI key) with its picture and name, when known. */
  private reaction(key: string, senders: Set<string>): NativeReaction {
    const reaction: NativeReaction = { key, label: key, count: senders.size, me: senders.has(this.session!.userId) };
    const picture = this.pictures.get(key);
    const shortcode = this.shortcodes.get(key);
    if (picture) reaction.imageUrl = picture;
    if (shortcode) reaction.label = `:${shortcode}:`;
    return reaction;
  }

  /** The next custom emoji picture the open room wants: its packs' emoji, then reactions with custom emoji. */
  private nextPicture(): string | undefined {
    const room = this.selectedRoom();
    if (!room || this.picturesTried.size >= MAX_PICTURES) return undefined;
    const wanted = [...this.offer(room).emoticons.values()].map((e) => e.image.url);
    for (const event of room.events) {
      if (event.kind === "message") for (const emote of this.shownContent(room, event).content.emotes ?? []) wanted.push(emote.url);
    }
    for (const { key } of room.reactions.values()) if (parseMxc(key)) wanted.push(key);
    return wanted.find((url) => !this.picturesTried.has(url));
  }

  /**
   * Loads the open room's custom emoji pictures in the background, small
   * thumbnails through authenticated media, each once per session; the view
   * gets them in batches.
   */
  private async loadPictures(): Promise<void> {
    if (this.loadingPictures || this.step !== "chat") return;
    this.loadingPictures = true;
    const generation = this.generation;
    const session = this.session!;
    let unshown = 0;
    try {
      for (let url = this.nextPicture(); url; url = this.nextPicture()) {
        this.picturesTried.add(url);
        const picture = await this.deps.api.thumbnail(session, url).catch(() => undefined);
        // Signed out meanwhile: they belong to the previous account.
        if (generation !== this.generation) return;
        if (!picture) continue;
        this.pictures.set(url, picture);
        if (++unshown >= PICTURE_BATCH) {
          unshown = 0;
          this.render();
        }
      }
    } finally {
      this.loadingPictures = false;
    }
    if (unshown) this.render();
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
    const request = ++this.joinRequests;
    await this.leaveCall(undefined);
    // Asked again while leaving (a double click): that join runs instead, else both would join and one would never leave.
    if (request !== this.joinRequests) return;
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

  /** A problem the call survives: shown, with the camera or screen share that failed turned off. */
  private callNotice(message: string, off: VoiceNoticeFlag | undefined): void {
    if (!this.call) return;
    if (off) this.callFlags = { ...this.callFlags, [off]: false };
    this.error = message;
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

  /** Rooms at home: neither DMs nor spaces, nor in a space shown in the rail; latest first. */
  private homeRooms(layout: SpaceLayout): Room[] {
    return [...this.rooms.values()]
      .filter((r) => !this.dmUsers.has(r.id) && !r.space && !layout.owner.has(r.id))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  // --- Spaces -------------------------------------------------------------------

  /** A space's joined children in its order, as subspaces and rooms; DMs stay at home, and children not joined are not shown. */
  private spaceChildren(space: Room): { spaces: Room[]; rooms: Room[] } {
    const spaces: Room[] = [];
    const rooms: Room[] = [];
    for (const [id] of [...space.children].sort(byOrder)) {
      const child = this.rooms.get(id);
      if (!child || child === space || this.dmUsers.has(id)) continue;
      (child.space ? spaces : rooms).push(child);
    }
    return { spaces, rooms };
  }

  /**
   * The rail's spaces: those no other joined space lists, each with its own
   * rooms and then, depth first, those of its subspaces at any depth (each
   * subspace and room once). Spaces that only list each other (a cycle with
   * no way in from the top) would be lost, so the first of them by id counts
   * as top-level. Every walk keeps a set of spaces seen, so cycles end.
   */
  private spaceLayout(): SpaceLayout {
    const spaces = [...this.rooms.values()].filter((r) => r.space).sort((a, b) => compareText(a.id, b.id));
    const children = new Map(spaces.map((s) => [s.id, this.spaceChildren(s)]));
    const nested = new Set(spaces.flatMap((s) => children.get(s.id)!.spaces.map((c) => c.id)));
    const reached = new Set<string>();
    const top: Room[] = [];
    for (const space of [...spaces.filter((s) => !nested.has(s.id)), ...spaces]) {
      if (reached.has(space.id)) continue;
      top.push(space);
      const stack = [space];
      reached.add(space.id);
      while (stack.length) {
        for (const child of children.get(stack.pop()!.id)!.spaces) {
          if (reached.has(child.id)) continue;
          reached.add(child.id);
          stack.push(child);
        }
      }
    }
    const layout: SpaceLayout = { servers: new Map(), owner: new Map() };
    for (const space of top.slice(0, MAX_SPACES)) {
      const sections: SpaceSection[] = [];
      const seen = new Set([space.id]);
      const listed = new Set<Room>();
      const stack = [space];
      while (stack.length) {
        const current = stack.pop()!;
        const { spaces: subspaces, rooms } = children.get(current.id)!;
        const fresh = rooms.filter((r) => !listed.has(r));
        for (const room of fresh) {
          listed.add(room);
          if (!layout.owner.has(room.id)) layout.owner.set(room.id, space.id);
        }
        if (fresh.length) sections.push({ space: current, rooms: fresh });
        const next = subspaces.filter((s) => !seen.has(s.id));
        for (const s of next) seen.add(s.id);
        // Reversed onto the stack, so they come off in the space's order.
        stack.push(...next.reverse());
      }
      layout.servers.set(space.id, sections);
    }
    return layout;
  }

  railServers(): RailServer[] {
    return [...this.spaceLayout().servers].map(([id, sections]) => {
      const space = this.rooms.get(id)!;
      const server: RailServer = { key: id, account: this.account, name: this.title(space), ...badge(this.audible(sections.flatMap((s) => s.rooms))) };
      const icon = this.avatars.get(this.avatarOf(space) ?? "");
      if (icon) server.iconUrl = icon;
      return server;
    });
  }

  /** Sends the rail's spaces when they changed. */
  private publishServers(): void {
    const servers = this.railServers();
    const json = JSON.stringify(servers);
    if (json === this.sentServers) return;
    this.sentServers = json;
    this.setServers(servers);
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
          mentions: this.mutedRooms.has(room.id) ? 0 : room.notifications,
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
    this.publishServers();
    this.render();
  }

  /** A room's reactions by the event they react to, then by key (in the order keys first came): who reacted, each person once. */
  private reactionIndex(room: Room): Map<string, Map<string, Set<string>>> {
    const index = new Map<string, Map<string, Set<string>>>();
    for (const { target, key, sender } of room.reactions.values()) {
      let keys = index.get(target);
      if (!keys) index.set(target, (keys = new Map()));
      let senders = keys.get(key);
      if (!senders) keys.set(key, (senders = new Set()));
      senders.add(sender);
    }
    return index;
  }

  /**
   * A message's text as the view's markdown, its custom emoji whose picture
   * has loaded as <:shortcode:id>, with the picture noted in `emojiUrls`;
   * the others stay ":shortcode:".
   */
  private emoteMarkdown(text: string, emotes: MxEmote[], emojiUrls: Map<string, string>): string {
    return emoticonMarkdown(text, (shortcode) => {
      const url = emotes.find((e) => e.shortcode === shortcode)?.url;
      const picture = url ? this.pictures.get(url) : undefined;
      const id = picture ? packImageId(url!) : undefined;
      if (id) emojiUrls.set(id, picture!);
      return id;
    });
  }

  private toNative(room: Room, event: Shown, locked: boolean, reactions: Map<string, Map<string, Set<string>>>, emojiUrls: Map<string, string>): NativeMessage {
    const me = this.session!.userId;
    const mine = event.sender === me;
    const native: NativeMessage = {
      id: this.local(event.id),
      author: this.memberName(room, event.sender),
      // Mentioned by their user ID, which goes out as a pill (messageHtml) and in m.mentions.
      authorId: event.sender,
      ...(mine ? {} : { authorMention: event.sender }),
      content: escapeMarkdown(this.eventText(room, event)),
      timestamp: new Date(event.ts).toISOString(),
      edited: false,
      mine,
      canEdit: false,
      canDelete: mine,
      reactions: [...(reactions.get(event.id) ?? [])].map(([key, senders]) => this.reaction(key, senders)),
      attachments: [],
    };
    if (room.pinned.includes(event.id)) native.pinned = true;
    if (!locked) native.canPin = true;
    // A thread's root: the replies the homeserver counted, or those known here if more.
    const replies = room.threads.get(event.id) ?? [];
    const counted = event.kind === "message" ? event.threadInfo : undefined;
    const latest = replies.at(-1)?.sender ?? counted?.latest;
    const count = Math.max(counted?.count ?? 0, replies.length);
    if (count > 0) native.thread = latest ? { count, latest: this.memberName(room, latest) } : { count };
    if (event.kind !== "message") return native;
    if (!mine && this.mentionsMe(room, event)) native.mentionsMe = true;
    // A quiet note on the author line: the message decrypted, but from a device its owner has not verified.
    if (event.unverified) native.author = `${native.author} · ${UNVERIFIED_LABEL}`;
    const { content, edited, id } = this.shownContent(room, event);
    if (content.poll) {
      // The poll card shows the question; the label stays for previews and notifications.
      native.content = "";
      native.poll = this.pollView(room, event, content.poll, locked);
    } else if (content.attachment) {
      // Shown media speaks for itself: only its caption stays as text (the label remains for notifications and previews).
      native.content = escapeMarkdown(content.text);
      native.attachments = [this.attachment(room, id, content.attachment)];
    } else if (content.html || content.emotes) {
      const { emotes } = content;
      const escape = emotes ? (text: string) => this.emoteMarkdown(text, emotes, emojiUrls) : escapeMarkdown;
      // Formatting the view cannot show as it was meant shows as the plain body.
      const formatted = content.html && richMarkdown(content.html, escape);
      native.content = formatted ? `${content.msgtype === "m.emote" ? "\\* " : ""}${formatted}` : escape(messageText(content));
    }
    native.edited = edited;
    native.canEdit = mine && !locked && EDITABLE.has(event.content.msgtype);
    if (native.canEdit) native.source = content.text;
    // A reply within a thread may answer another of its replies.
    const replied = event.replyTo ? (room.events.find((e) => e.id === event.replyTo) ?? (event.thread ? room.threads.get(event.thread)?.find((e) => e.id === event.replyTo) : undefined)) : undefined;
    // Reply previews are plain text in the view.
    if (replied) native.reply = { author: this.memberName(room, replied.sender), content: this.eventText(room, replied).slice(0, 100) };
    return native;
  }

  /** Rooms that may badge the rail: muted ones stay out. */
  private audible(rooms: Room[]): Room[] {
    return rooms.filter((room) => !this.mutedRooms.has(room.id));
  }

  private sidebarItem(room: Room, dm: boolean): NativeSidebarItem {
    const muted = this.mutedRooms.has(room.id);
    const item: NativeSidebarItem = {
      id: room.local,
      name: this.title(room),
      kind: dm ? "dm" : "text",
      unread: room.notifications > 0,
      // A muted room shows it has news, without a count.
      mentions: muted ? 0 : dm ? room.notifications : room.highlights,
      active: room.id === this.selected,
      muted,
      canMute: true,
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
      const waiting = this.step === "verify-wait" || this.step === "verify-confirmed" || this.ssoWaiting;
      return { screen: "prompt", platform, prompt: this.prompt(), busy: this.busy || waiting, status: this.promptStatus(), error: this.error };
    }
    const layout = this.spaceLayout();
    // A space that is gone (left, or now inside another) leaves for home.
    const sections = layout.servers.get(this.openSpace ?? "");
    if (!sections) this.openSpace = undefined;
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
    if (sections) {
      // A space: its own rooms, then each subspace's under its name (as server categories show).
      for (const { space, rooms } of sections) {
        const heading = space.id === this.openSpace ? category("rooms", "Rooms") : category(`space:${space.local}`, this.title(space));
        sidebar.push(heading, ...rooms.map((r) => this.sidebarItem(r, false)));
      }
      // Its rooms not joined yet, to join from here (subspaces are not offered).
      const unjoined = (this.hierarchies.get(this.openSpace!) ?? []).filter((r) => !r.space && !this.rooms.has(r.roomId));
      const joinable = unjoined.map((r): NativeSidebarItem => ({ id: this.local(r.roomId), name: r.name ?? "Unnamed room", kind: "text", unread: false, mentions: 0, active: false, joinable: true }));
      if (joinable.length) sidebar.push(category("unjoined", "Not joined"), ...joinable);
    } else {
      const dms = this.dmRooms();
      const rooms = this.homeRooms(layout);
      if (this.invites.size) sidebar.push(category("invites", "Invitations"), ...[...this.invites.values()].map((i) => this.inviteItem(i)));
      if (dms.length) sidebar.push(category("dms", "Direct messages"), ...dms.map((r) => this.sidebarItem(r, true)));
      if (rooms.length) sidebar.push(category("rooms", "Rooms"), ...rooms.map((r) => this.sidebarItem(r, false)));
    }
    const room = this.selectedRoom();
    const userId = this.session!.userId;
    const locked = room ? this.lock(room)?.notice : undefined;
    const reactions = room ? this.reactionIndex(room) : new Map<string, Map<string, Set<string>>>();
    const offer = room ? this.offer(room) : undefined;
    const customEmoji = offer ? this.customEmoji(offer) : [];
    const stickers = offer ? this.stickerPacks(offer) : [];
    // Pictures of the custom emoji in the shown messages, noted as they are rendered.
    const emojiUrls = new Map<string, string>();
    return {
      screen: "chat",
      platform,
      title: sections ? this.title(this.rooms.get(this.openSpace!)!) : userId.slice(userId.indexOf(":") + 1),
      me: userId,
      joinAddress: `#room:${userId.slice(userId.indexOf(":") + 1)}`,
      sidebar,
      channel: room
        ? {
            id: room.local,
            name: this.title(room),
            messages: room.events.map((e) => this.toNative(room, e, locked !== undefined, reactions, emojiUrls)),
            loading: this.loading.has(room.id),
            hasOlder: room.prevBatch !== undefined,
            typing: room.typing.filter((user) => user !== userId).map((user) => this.memberName(room, user)),
            pending: (this.pending.get(room.id) ?? []).map((file) => ({ name: file.filename, size: file.size })),
            uploading: this.uploading.has(room.id),
            ...(locked ? { locked } : {}),
            ...(this.unreadAt?.roomId === room.id ? { unread: this.unreadView(room, this.unreadAt) } : {}),
            ...(this.pins?.roomId === room.id ? { pins: this.pins.list } : {}),
            ...(this.search?.roomId === room.id ? { search: this.search.results } : {}),
            ...(this.threadOpen?.roomId === room.id ? { thread: this.threadState(room, this.threadOpen, locked, reactions, emojiUrls) } : {}),
            ...(this.membersOpen && this.memberList?.roomId === room.id ? { members: this.memberView(room, this.memberList) } : {}),
            // A locked room takes nothing from here; typing notices follow the user's setting.
            can: { reply: !locked, react: !locked, attach: !locked && this.deps.files !== undefined, typing: this.typingNotices, members: true, stickers: !locked, pins: true, search: true, forward: !locked, threads: true, polls: !locked },
          }
        : null,
      // After the messages, which fill it.
      ...(emojiUrls.size ? { emojiUrls: Object.fromEntries(emojiUrls) } : {}),
      ...(customEmoji.length ? { customEmoji } : {}),
      ...(stickers.length ? { stickers } : {}),
      voice: this.voiceSession(),
      ...(this.profile ? { profile: this.profile } : {}),
      error: this.error ?? this.ringText(),
    };
  }

  private render(): void {
    this.deps.render(this.viewState());
    void this.loadPictures();
  }
}
