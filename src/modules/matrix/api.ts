// The slice of Matrix's Client-Server API the adapter uses, in plain data.
// client.ts implements it with fetch over the engine bridge; tests use a
// fake. Everything here has already been validated (see events.ts):
// ids are bounded strings, times epoch milliseconds.

/** A signed-in device: what is stored to skip signing in next time. */
export interface MxSession {
  /** The homeserver's client API base, e.g. https://matrix-client.matrix.org */
  baseUrl: string;
  accessToken: string;
  userId: string;
  deviceId: string;
  /**
   * Whether Multicord created this device by signing in. A token copied from
   * another client belongs to that client's device: signing out here only
   * forgets it, since /logout would end the other client's session too.
   * Only our own devices get end-to-end encryption: keys uploaded for
   * another client's device would clash with that client's own.
   */
  ownDevice: boolean;
  /** Set for sessions from OAuth 2.0 sign-in: how to refresh and revoke the token. */
  oauth?: MxOAuthSession;
}

/** The OAuth 2.0 side of a session (Matrix's OAuth 2.0 API, as with matrix.org's account service). */
export interface MxOAuthSession {
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  refreshToken?: string;
  /** When the access token expires, epoch ms. */
  expiresAt?: number;
}

/** A room's m.room.encryption settings. */
export interface MxEncryption {
  /** Only m.megolm.v1.aes-sha2 is supported; "" when the event named none. */
  algorithm: string;
  rotationMs?: number;
  rotationMsgs?: number;
}

/** What a sync carries for end-to-end encryption, as the crypto library takes it. */
export interface MxCryptoSync {
  /** The to-device events, a JSON array of checked events. */
  toDevice: string;
  /** Users whose devices changed, and users we no longer share a room with. */
  changed: string[];
  left: string[];
  /** One-time keys left on the server, by algorithm. */
  oneTimeKeys: Record<string, number>;
  /** Algorithms of unused fallback keys; absent when the server did not say. */
  fallbackKeys?: string[];
}

export interface MxLoginFlows {
  password: boolean;
}

export interface MxMember {
  name?: string;
  /** mxc:// URI of the profile picture. */
  avatar?: string;
  membership: string;
}

/** State seen in a sync or history page; only what changed is set. */
export interface MxRoomState {
  name?: string;
  alias?: string;
  avatar?: string;
  /** Set once the room has m.room.encryption state; Matrix never turns it off. */
  encrypted?: boolean;
  /** The m.room.encryption settings, from a well-formed event. */
  encryption?: MxEncryption;
  /** m.room.history_visibility, e.g. "shared". */
  history?: string;
  members: Record<string, MxMember>;
}

interface MxEventBase {
  id: string;
  sender: string;
  /** origin_server_ts, epoch ms. */
  ts: number;
}

/** A message's displayable content: text, a media label, or both. */
export interface MxContent {
  msgtype: string;
  text: string;
  /** A short label for media, e.g. "📷 Image". */
  media?: string;
}

export type MxEvent =
  | (MxEventBase & {
      kind: "message";
      content: MxContent;
      /** Who the message mentions, from m.mentions (undefined when the sender did not say). */
      mentions?: string[];
      replyTo?: string;
      /** Set on edits: the event this one replaces, with the new content. */
      replaces?: string;
      /** Decrypted messages from a device its owner has not verified: why, in a few words. */
      unverified?: string;
    })
  | (MxEventBase & {
      kind: "encrypted";
      /** The whole event as JSON, for decrypting; absent when it is too large to be genuine. */
      raw?: string;
      /** The Megolm session it was encrypted with. */
      sessionId?: string;
      /** Set when it is an encrypted edit: the event it replaces (the relation stays unencrypted). */
      replaces?: string;
      /** Why it could not be decrypted, once that was tried. */
      problem?: string;
    })
  | (MxEventBase & { kind: "redaction"; redacts: string })
  /** An event whose content was removed; it is dropped from view. */
  | (MxEventBase & { kind: "redacted" });

export type MxEncryptedEvent = Extract<MxEvent, { kind: "encrypted" }>;

export interface MxRoomUpdate {
  roomId: string;
  state: MxRoomState;
  /** Timeline events, oldest first, without state events. */
  timeline: MxEvent[];
  /** Events were left out between the previous sync and this timeline. */
  limited: boolean;
  /** Token for /messages to fetch what came before this timeline. */
  prevBatch?: string;
  /** Unread counts as the server computes them (absent when unchanged). */
  unread?: { notifications: number; highlights: number };
  /** m.heroes: members the server picked to name an unnamed room. */
  heroes?: string[];
}

export interface MxSync {
  nextBatch: string;
  /** m.direct account data, when it changed: user id -> their DM room ids. */
  directs?: Record<string, string[]>;
  joined: MxRoomUpdate[];
  /** Rooms the user left or was removed from. */
  left: string[];
  /** Device keys and to-device messages, for end-to-end encryption. */
  crypto?: MxCryptoSync;
}

export interface MxPage {
  /** Oldest first. */
  events: MxEvent[];
  state: MxRoomState;
  /** Token for the next older page; absent at the start of the room. */
  end?: string;
}

export interface MatrixApi {
  /** The client API base for a server URL, from /.well-known/matrix/client, else the URL itself. */
  discover(serverUrl: string): Promise<string>;
  loginFlows(baseUrl: string): Promise<MxLoginFlows>;
  login(baseUrl: string, user: string, password: string): Promise<MxSession>;
  /** Checks a token; for tokens copied from elsewhere, also learns the user and device. */
  whoami(baseUrl: string, accessToken: string): Promise<{ userId: string; deviceId?: string }>;
  /** Checks that a stored session still works (refreshing an OAuth token first when it expired). */
  check(session: MxSession): Promise<void>;
  sync(session: MxSession, since: string | undefined, timeoutMs: number): Promise<MxSync>;
  /** History before `from`, newest page first as Matrix pages it, returned oldest first. */
  messages(session: MxSession, roomId: string, from: string, limit: number): Promise<MxPage>;
  /** Asks the server, not our cache, whether a room is encrypted, and how. */
  encryption(session: MxSession, roomId: string): Promise<MxEncryption | undefined>;
  /** Joined and invited members: who gets the keys for an encrypted message. */
  members(session: MxSession, roomId: string): Promise<string[]>;
  /** Sends a room event (m.room.message unless said otherwise); returns its event id. */
  send(session: MxSession, roomId: string, content: Record<string, unknown>, type?: string): Promise<string>;
  redact(session: MxSession, roomId: string, eventId: string): Promise<void>;
  markRead(session: MxSession, roomId: string, eventId: string): Promise<void>;
  /** A small thumbnail of an mxc:// image as a data: URL. */
  thumbnail(session: MxSession, mxc: string): Promise<string | undefined>;
  /** The user's account data of a type, or undefined when there is none. */
  accountData(session: MxSession, type: string): Promise<Record<string, unknown> | undefined>;
  /**
   * Any other Client-Server call, for the crypto library's requests (keys,
   * to-device, backup). `path` is below /_matrix/client and already encoded.
   */
  request(session: MxSession, method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<Record<string, unknown>>;
  logout(session: MxSession): Promise<void>;
}

/** An error response from the homeserver, with its Matrix error code. */
export class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string,
    message: string,
    /** The server ended the session but a refreshed token may continue it (soft_logout). */
    readonly softLogout = false,
  ) {
    super(message);
    this.name = "MatrixError";
  }
}

/** The Matrix error code, e.g. M_FORBIDDEN, or undefined for other failures. */
export function matrixErrcode(error: unknown): string | undefined {
  return error instanceof MatrixError ? error.errcode : undefined;
}
