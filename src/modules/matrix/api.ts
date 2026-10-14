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
   */
  ownDevice: boolean;
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
    })
  | (MxEventBase & { kind: "encrypted" })
  | (MxEventBase & { kind: "redaction"; redacts: string })
  /** An event whose content was removed; it is dropped from view. */
  | (MxEventBase & { kind: "redacted" });

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
  sync(session: MxSession, since: string | undefined, timeoutMs: number): Promise<MxSync>;
  /** History before `from`, newest page first as Matrix pages it, returned oldest first. */
  messages(session: MxSession, roomId: string, from: string, limit: number): Promise<MxPage>;
  /** Asks the server, not our cache, whether a room is encrypted. */
  encrypted(session: MxSession, roomId: string): Promise<boolean>;
  /** Sends an m.room.message; returns its event id. */
  send(session: MxSession, roomId: string, content: Record<string, unknown>): Promise<string>;
  redact(session: MxSession, roomId: string, eventId: string): Promise<void>;
  markRead(session: MxSession, roomId: string, eventId: string): Promise<void>;
  /** A small thumbnail of an mxc:// image as a data: URL. */
  thumbnail(session: MxSession, mxc: string): Promise<string | undefined>;
  logout(session: MxSession): Promise<void>;
}

/** An error response from the homeserver, with its Matrix error code. */
export class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string,
    message: string,
  ) {
    super(message);
    this.name = "MatrixError";
  }
}

/** The Matrix error code, e.g. M_FORBIDDEN, or undefined for other failures. */
export function matrixErrcode(error: unknown): string | undefined {
  return error instanceof MatrixError ? error.errcode : undefined;
}
