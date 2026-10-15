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
  /**
   * From sliding sync (MSC4186): a key count the server left out is
   * unchanged, where classic sync means none are left.
   */
  sliding?: boolean;
  /**
   * The server could not say which device lists changed (a new sliding sync
   * connection): every tracked user's devices are to be asked for again.
   */
  stale?: boolean;
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
  /** Set when m.room.create says the room is a space (type m.space). */
  space?: boolean;
  /** m.space.child events seen, by child room id; null for a child that was removed (no via). */
  children?: Map<string, MxSpaceChild | null>;
  /** The pinned events (m.room.pinned_events), oldest pin first; an empty list unpins all. */
  pinned?: string[];
  /** Image packs (im.ponies.room_emotes) seen, by state key; one without images was emptied. */
  packs?: Map<string, MxPack>;
}

/** One picture of an image pack (MSC2545): a custom emoji, a sticker, or both. */
export interface MxPackImage {
  /** Without the colons; no spaces, colons or angle brackets. */
  shortcode: string;
  /** mxc:// URI of the picture. */
  url: string;
  /** What it shows, in words. */
  body?: string;
  /** The ImageInfo it goes with (mimetype, w, h, size), only what checked out. */
  info: Record<string, unknown>;
  emoticon: boolean;
  sticker: boolean;
}

/** An image pack: a room's (state) or the user's own (account data). */
export interface MxPack {
  name?: string;
  images: MxPackImage[];
}

/** A room pack the user enabled everywhere (im.ponies.emote_rooms). */
export interface MxPackRef {
  roomId: string;
  stateKey: string;
}

/** One room a space lists (m.space.child), as the space orders it. */
export interface MxSpaceChild {
  /** The space's own order for it, when valid (printable ASCII, at most 50 characters). */
  order?: string;
  suggested: boolean;
  /** When the child was added (the event's origin_server_ts), the order's tie-break. */
  ts: number;
}

interface MxEventBase {
  id: string;
  sender: string;
  /** origin_server_ts, epoch ms. */
  ts: number;
}

/**
 * An encrypted attachment's file (Matrix's EncryptedFile, version 2), its
 * parts already checked for form: AES-CTR with a 256-bit key.
 */
export interface MxEncryptedFile {
  /** mxc:// URI of the ciphertext. */
  url: string;
  /** The AES key, unpadded base64url of 32 bytes (the JWK's k). */
  key: string;
  /** The initial counter block, base64 of 16 bytes. */
  iv: string;
  /** SHA-256 of the ciphertext, unpadded base64. */
  sha256: string;
}

/** Where an attachment (or its thumbnail) is: in the clear at `url`, or encrypted as `file`. */
export interface MxMediaSource {
  url?: string;
  file?: MxEncryptedFile;
  /** MIME type, as the sender said. */
  mime?: string;
  /** Bytes, as the sender said. */
  size?: number;
}

export type MxMediaKind = "image" | "video" | "audio" | "file" | "sticker";

/** An image, video, sound, file or sticker of a message, as its sender described it. */
export interface MxMedia extends MxMediaSource {
  kind: MxMediaKind;
  /** The file name, else its description. */
  name: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** A video to play silently on a loop, as bridges mark GIFs. */
  loop?: boolean;
  /** A smaller picture of it, when the sender made one. */
  thumbnail?: MxMediaSource;
  /** Why it cannot be shown, e.g. a malformed address or key. */
  problem?: string;
}

/** A message's displayable content: text, a media label, or both. */
export interface MxContent {
  msgtype: string;
  text: string;
  /** A short label for media, e.g. "📷 Image". */
  media?: string;
  /** The media itself, for messages that carry a file. */
  attachment?: MxMedia;
  /** Custom emoji its formatted_body shows as pictures (data-mx-emoticon), which its text names as ":shortcode:". */
  emotes?: MxEmote[];
}

/** A custom emoji in a message: its shortcode (without colons) and picture. */
export interface MxEmote {
  shortcode: string;
  /** mxc:// URI of the picture. */
  url: string;
}

/** Downloaded media: its bytes, and the type the server gave. */
export interface MxDownload {
  bytes: Uint8Array<ArrayBuffer>;
  type?: string;
}

export type MxEvent =
  | (MxEventBase & {
      kind: "message";
      content: MxContent;
      /** Who the message mentions, from m.mentions (undefined when the sender did not say). */
      mentions?: string[];
      /** It mentions the whole room (m.mentions.room). */
      mentionsRoom?: boolean;
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
      /** Set when it is an encrypted reaction: the event it reacts to (the relation stays unencrypted). */
      annotates?: string;
      /** Why it could not be decrypted, once that was tried. */
      problem?: string;
    })
  | (MxEventBase & { kind: "redaction"; redacts: string })
  /**
   * A reaction (m.reaction, an m.annotation relation): `key`, usually an
   * emoji, on the event `target`; taken back by redacting it. A custom
   * emoji's key is its mxc:// URI, with its `shortcode` alongside.
   */
  | (MxEventBase & { kind: "reaction"; target: string; key: string; shortcode?: string })
  /** An event whose content was removed; it is dropped from view. */
  | (MxEventBase & { kind: "redacted" })
  /** A call membership as a sticky m.rtc.member event (MSC4143 with MSC4354); never shown, it changes the room's call. */
  | (MxEventBase & {
      kind: "rtc";
      /** Its sender and sticky key: a later event with the same key replaces it. */
      key: string;
      /** When it stops being sticky (and so counting), epoch ms. */
      expiresAt: number;
      /** Null when the device left, or the event is no membership of the room's call. */
      member: MxCallMember | null;
    });

export type MxEncryptedEvent = Extract<MxEvent, { kind: "encrypted" }>;

/**
 * One device's membership of a room's call (MatrixRTC: the
 * org.matrix.msc3401.call.member state events Element Call sends, or the
 * newer sticky org.matrix.msc4143.rtc.member events), checked and reduced to
 * what the adapter needs.
 */
export interface MxCallMember {
  /** The event's sender: whose membership it is, whatever the state key says. */
  user: string;
  deviceId: string;
  /** When the membership started (created_ts, else the event's own time), epoch ms. */
  createdTs: number;
  /** When it stops counting unless its device renews it, epoch ms. */
  expiresAt: number;
  /** The LiveKit service (focus) the device publishes on; absent when it named none we can use. */
  focus?: string;
  /** The LiveKit server it publishes on, for transports that name one (MSC4195, m.rtc.member only). */
  sfu?: string;
  /** "audio" or "video", as the caller said (m.call.intent). */
  intent?: string;
  /** Its participant identities on LiveKit, as matrix-js-sdk computes them; media keys go under these. */
  identities: string[];
  /** Set for m.rtc.member memberships: the member id the device chose (its sticky key). */
  memberId?: string;
}

/** A MatrixRTC transport with LiveKit: its service (lk-jwt-service), its LiveKit server (MSC4195), or both. */
export interface MxRtcTransport {
  service?: string;
  /** The LiveKit server's wss address, for which the homeserver hands out access (rtc/livekit/get_token). */
  sfu?: string;
}

/** Who asks the homeserver for access to a LiveKit server (MSC4195 get_token): the membership it is for. */
export interface MxLiveKitTokenRequest {
  sfu: string;
  roomId: string;
  slotId: string;
  memberId: string;
  deviceId: string;
}

/** An OpenID token from the homeserver, which a LiveKit service checks before granting access to a call. */
export interface MxOpenIdToken {
  access_token: string;
  token_type: string;
  matrix_server_name: string;
  expires_in: number;
}

/** What a LiveKit service (lk-jwt-service) grants for a call: the SFU and an access token for it. */
export interface MxLiveKitGrant {
  url: string;
  jwt: string;
}

export interface MxRoomUpdate {
  roomId: string;
  state: MxRoomState;
  /** Call memberships that changed, by state key; null when one ended (or is no call of the room's). */
  calls?: Map<string, MxCallMember | null>;
  /**
   * Sticky events the sync carried outside the timeline (MSC4354, after a gap
   * or on joining): call memberships, or encrypted events that may be some.
   */
  sticky?: MxEvent[];
  /** Timeline events, oldest first, without state events. */
  timeline: MxEvent[];
  /** Events were left out between the previous sync and this timeline. */
  limited: boolean;
  /** Token for /messages to fetch what came before this timeline. */
  prevBatch?: string;
  /** Unread counts as the server computes them (absent when unchanged, and from sliding sync, which leaves them to the client). */
  unread?: { notifications: number; highlights: number };
  /** Our latest read receipt in the room, when the sync says (sliding sync): the event, and when we read it (epoch ms; 0 when unknown). */
  read?: { id: string; ts: number };
  /** m.heroes: members the server picked to name an unnamed room. */
  heroes?: string[];
  /** Who is typing (m.typing), when that changed: always the whole list. */
  typing?: string[];
  /**
   * The room came in full rather than as what changed (sliding sync sends a
   * room in full the first time a connection names it, and classic sync
   * after starting over): its events are not news, and `limited` is set, so
   * they replace what was known.
   */
  initial?: boolean;
}

/**
 * How to sync: "classic" is /v3/sync; "auto" uses simplified sliding sync
 * (MSC4186) when the homeserver offers it, else classic; "sliding" uses
 * sliding sync only (for tests against a server that has it).
 */
export type MxSyncMode = "auto" | "classic" | "sliding";

export interface MxSync {
  nextBatch: string;
  /** m.direct account data, when it changed: user id -> their DM room ids. */
  directs?: Record<string, string[]>;
  /** The user's own image pack (im.ponies.user_emotes), when it changed. */
  userPack?: MxPack;
  /** Room packs the user enabled everywhere (im.ponies.emote_rooms), when that changed. */
  packRooms?: MxPackRef[];
  /** Rooms the user muted (m.push_rules), when the push rules changed. */
  mutedRooms?: string[];
  joined: MxRoomUpdate[];
  /** Rooms the user left or was removed from. */
  left: string[];
  /** Device keys and to-device messages, for end-to-end encryption. */
  crypto?: MxCryptoSync;
  /**
   * The server leaves unread counts to the client (sliding sync: Synapse
   * sends zeros): count them from the events and our read receipts.
   */
  countUnread?: boolean;
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
  /**
   * The next sync after `since` (undefined for the first; "classic" unless
   * `mode` says otherwise). Pass the returned token as the next `since` only
   * once the sync was handled: it acknowledges the to-device messages, which
   * the server then deletes. A token from the other kind of sync starts over,
   * every room `initial`.
   */
  sync(session: MxSession, since: string | undefined, timeoutMs: number, mode?: MxSyncMode): Promise<MxSync>;
  /** History before `from`, newest page first as Matrix pages it, returned oldest first. */
  messages(session: MxSession, roomId: string, from: string, limit: number): Promise<MxPage>;
  /** Asks the server, not our cache, whether a room is encrypted, and how. */
  encryption(session: MxSession, roomId: string): Promise<MxEncryption | undefined>;
  /** Joined and invited members: who gets the keys for an encrypted message. */
  members(session: MxSession, roomId: string): Promise<string[]>;
  /** Sends a room event (m.room.message unless said otherwise); returns its event id. */
  send(session: MxSession, roomId: string, content: Record<string, unknown>, type?: string): Promise<string>;
  redact(session: MxSession, roomId: string, eventId: string): Promise<void>;
  /** Says we are typing in a room, for `timeoutMs` unless renewed, or that we stopped. */
  typing(session: MxSession, roomId: string, typing: boolean, timeoutMs: number): Promise<void>;
  markRead(session: MxSession, roomId: string, eventId: string): Promise<void>;
  /** A small thumbnail of an mxc:// image as a data: URL. */
  thumbnail(session: MxSession, mxc: string): Promise<string | undefined>;
  /** An mxc:// file, through authenticated media; undefined when it is larger than `maxBytes`. */
  download(session: MxSession, mxc: string, maxBytes: number): Promise<MxDownload | undefined>;
  /** The largest upload the homeserver takes (m.upload.size), in bytes; undefined when it does not say. */
  uploadLimit(session: MxSession): Promise<number | undefined>;
  /** Uploads a file to the homeserver's media repository; returns its mxc:// URI. */
  upload(session: MxSession, bytes: Uint8Array<ArrayBuffer>, contentType: string, filename?: string): Promise<string>;
  /** The user's account data of a type, or undefined when there is none. */
  accountData(session: MxSession, type: string): Promise<Record<string, unknown> | undefined>;
  /** Mutes a room (a push rule of its own that does not notify, as Element's "Mute"), or unmutes it by removing that rule. */
  muteRoom(session: MxSession, roomId: string, mute: boolean): Promise<void>;
  /**
   * Any other Client-Server call, for the crypto library's requests (keys,
   * to-device, backup). `path` is below /_matrix/client and already encoded.
   */
  request(session: MxSession, method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<Record<string, unknown>>;
  logout(session: MxSession): Promise<void>;

  // --- Calls (MatrixRTC) ---
  /** The LiveKit services a server's /.well-known/matrix/client names (org.matrix.msc4143.rtc_foci); [] when none. */
  rtcFoci(serverUrl: string): Promise<string[]>;
  /** The LiveKit transports the homeserver names (MSC4143 rtc/transports); [] when it has none or no such endpoint. */
  rtcTransports(session: MxSession): Promise<MxRtcTransport[]>;
  /** Whether the homeserver says it has an unstable feature, e.g. org.matrix.msc4140 (delayed events). */
  supports(session: MxSession, feature: string): Promise<boolean>;
  openIdToken(session: MxSession): Promise<MxOpenIdToken>;
  /** Sets a state event; returns its event id. */
  sendState(session: MxSession, roomId: string, type: string, stateKey: string, content: Record<string, unknown>): Promise<string>;
  /** Schedules a state event for `delayMs` from now (MSC4140); returns its delay id. */
  sendDelayedState(session: MxSession, roomId: string, type: string, stateKey: string, content: Record<string, unknown>, delayMs: number): Promise<string>;
  /** Sends a room event that stays sticky for `stickyMs` (MSC4354); returns its event id. */
  sendSticky(session: MxSession, roomId: string, type: string, content: Record<string, unknown>, stickyMs: number): Promise<string>;
  /** Schedules a sticky room event for `delayMs` from now (MSC4140 and MSC4354); returns its delay id. */
  sendDelayedSticky(session: MxSession, roomId: string, type: string, content: Record<string, unknown>, delayMs: number, stickyMs: number): Promise<string>;
  /** Restarts the countdown of a delayed event, sends it now, or cancels it. */
  updateDelayed(session: MxSession, delayId: string, action: "restart" | "send" | "cancel"): Promise<void>;
  /** Asks a LiveKit service for access to a room's call, with an OpenID token proving who asks (lk-jwt-service's /sfu/get). */
  liveKitGrant(serviceUrl: string, roomId: string, deviceId: string, token: MxOpenIdToken): Promise<MxLiveKitGrant>;
  /** Asks the homeserver for access to one of its LiveKit servers, for an m.rtc.member membership (MSC4195 rtc/livekit/get_token). */
  liveKitToken(session: MxSession, request: MxLiveKitTokenRequest): Promise<MxLiveKitGrant>;
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
