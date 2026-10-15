// Calls over MatrixRTC, the way Element Call makes them: each device in a
// call says so with an org.matrix.msc3401.call.member state event naming the
// LiveKit service (focus) it uses; the service hands out access to the call's
// LiveKit room (SFU) for an OpenID token from the homeserver. The native view
// carries the audio and video over LiveKit, as it does for Fluxer.
//
// Element's newer format announces a member with a sticky room event instead
// (org.matrix.msc4143.rtc.member, MSC4143 with MSC4354), keyed by a member id
// the device makes up per call. Its transport may name the LiveKit server
// itself (MSC4195): access then comes from the homeserver
// (rtc/livekit/get_token), and the device's LiveKit identity is a hash of its
// user and member id. Multicord joins in that format when the call already
// uses it, and in the older one otherwise.
//
// In end-to-end encrypted rooms the media is encrypted too: every device
// makes its own media key, sends it to the other devices in the call as an
// Olm-encrypted to-device message (io.element.call.encryption_keys), and makes
// a new one whenever someone leaves (and, after a short grace period, when
// someone joins). The view's LiveKit E2EE worker encrypts and decrypts with
// the keys passed to it in the view state.

import type { NativeMediaKey } from "../../shared/native";
import { MatrixError, type MatrixApi, type MxLiveKitGrant, type MxSession } from "./api";
import type { DeviceRef, E2ee, SecureToDevice } from "./crypto";
import { CALL_MEMBERSHIP_EXPIRY_MS, CALL_MEMBER_TYPE, isRecord, liveKitIdentity, MAX_STICKY_MS, RTC_MEMBER_TYPE, rtcIdentity, SLOT_ID } from "./events";

export { liveKitIdentity, SLOT_ID };

/** The ring Element sends when a call starts in a DM (MSC4075), referencing the caller's membership. */
export const RTC_NOTIFICATION_TYPE = "org.matrix.msc4075.rtc.notification";
/** The to-device event carrying a device's media key (Element Call's per-participant encryption). */
export const CALL_KEYS_TYPE = "io.element.call.encryption_keys";
/** Delayed events (MSC4140), for the leave the server sends should Multicord vanish mid-call. */
export const DELAYED_EVENTS_FEATURE = "org.matrix.msc4140";
/** Element Call's timings: the server sends our leave this long after the client stops answering… */
export const DELAYED_LEAVE_MS = 18_000;
/** …which the client keeps pushing back this often. */
export const DELAYED_LEAVE_RESTART_MS = 4_000;
/** A membership is renewed this long before it would expire. */
export const RENEW_MARGIN_MS = 60_000;
const RENEW_RETRY_MS = 30_000;
/** A new media key is used this long after it was sent, so it reaches everyone first. */
export const KEY_USE_DELAY_MS = 1_000;
/** A joiner gets the current key when it is younger than this; otherwise everyone gets a new one. */
export const KEY_ROTATION_GRACE_MS = 10_000;
const KEY_RETRY_MS = 5_000;
const MAX_KEY_RETRIES = 5;
/** Media keys kept per device: enough to bridge a rotation. */
const KEYS_PER_DEVICE = 4;
/** Keys from devices whose membership has not arrived yet, kept until it does. */
const MAX_PENDING_KEYS = 50;
/** How long a sticky membership stays sticky; it is sent again shortly before (Element's duration, the most MSC4354 allows). */
export const MEMBERSHIP_STICKY_MS = MAX_STICKY_MS;
/** The sticky events feature (MSC4354), which the newer memberships need. */
export const STICKY_EVENTS_FEATURE = "org.matrix.msc4354";
/** The state event saying whether a room's call is open (MSC4143); Element rings only for an open one. */
export const RTC_SLOT_TYPE = "org.matrix.msc4143.rtc.slot";
/** How long a ring we send lasts (Element's default). */
export const RING_LIFETIME_MS = 90_000;

/** Where a device's call membership lives: one state key per user and device, as Element Call writes it. */
export function membershipStateKey(userId: string, deviceId: string): string {
  return `_${userId}_${deviceId}_m.call`;
}

/** Our membership of a room's call; `createdTs` only once it is renewed, so the first one counts from the server's time. */
export function membershipContent(options: {
  userId: string;
  deviceId: string;
  roomId: string;
  focus: string;
  expires: number;
  intent: string;
  createdTs?: number;
}): Record<string, unknown> {
  const content: Record<string, unknown> = {
    application: "m.call",
    call_id: "",
    scope: "m.room",
    device_id: options.deviceId,
    membershipID: liveKitIdentity(options.userId, options.deviceId),
    expires: options.expires,
    "m.call.intent": options.intent,
    focus_active: { type: "livekit", focus_selection: "multi_sfu" },
    foci_preferred: [{ type: "livekit", livekit_service_url: options.focus, livekit_alias: options.roomId }],
  };
  if (options.createdTs !== undefined) content.created_ts = options.createdTs;
  return content;
}

/**
 * Our membership as an m.rtc.member event, as matrix-js-sdk's sticky
 * membership manager writes it: on a LiveKit server (MSC4195) when `sfu` is
 * set, else on the service.
 */
export function rtcMembershipContent(options: { userId: string; deviceId: string; memberId: string; focus: string; sfu?: string; intent: string }): Record<string, unknown> {
  const transport = options.sfu ? { type: "livekit", url: options.sfu } : { type: "livekit", livekit_service_url: options.focus };
  return {
    slot_id: SLOT_ID,
    application: { type: "m.call", "m.call.intent": options.intent },
    member: { user_id: options.userId, device_id: options.deviceId, id: options.memberId },
    transports: { published: [transport], can_subscribe: ["livekit"] },
    versions: [],
    msc4354_sticky_key: options.memberId,
  };
}

/** The m.rtc.member event that ends a membership: only its slot and sticky key are left. */
export function rtcLeaveContent(memberId: string): Record<string, unknown> {
  return { slot_id: SLOT_ID, msc4354_sticky_key: memberId };
}

/** A random (version 4) UUID, as Element Call makes its member ids. */
export function uuid(bytes: Uint8Array): string {
  const b = bytes.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The ring for the other side of a DM, pointing at our membership event. */
export function ringContent(membershipEventId: string, intent: string, now: number): Record<string, unknown> {
  return {
    slot_id: SLOT_ID,
    "m.mentions": { user_ids: [], room: true },
    notification_type: "ring",
    "m.relates_to": { event_id: membershipEventId, rel_type: "m.reference" },
    sender_ts: now,
    lifetime: RING_LIFETIME_MS,
    "m.call.intent": intent,
  };
}

/** The room's call slot, open; an encrypted room's call has per-device media keys, as Element Call's do. */
export function slotContent(encrypted: boolean): Record<string, unknown> {
  const content: Record<string, unknown> = { status: "open", application: { type: "m.call" } };
  if (encrypted) content.encryption = { type: "org.matrix.msc4143.per_member" };
  return content;
}

/** The LiveKit server is on a host the engine (and so the view) may not reach. */
export class HostNotAllowedError extends Error {
  constructor(readonly host: string) {
    super(`${host} is not allowed`);
    this.name = "HostNotAllowedError";
  }
}

/** Another device in the call, as the key exchange sees it: a new createdTs is a new membership. */
export interface CallParticipant extends DeviceRef {
  createdTs: number;
  /** Its identities on LiveKit, which its keys are given to the view under (by default the older user:device one). */
  identities?: string[];
}

/** Our device in a call: the member id our keys name (by default user:device), and the identities our media goes out under. */
export interface CallSelf extends DeviceRef {
  memberId?: string;
  identities?: string[];
}

const identitiesOf = (device: DeviceRef & { identities?: string[] }): string[] => device.identities ?? [liveKitIdentity(device.userId, device.deviceId)];
const deviceKey = (device: DeviceRef): string => `${device.userId}|${device.deviceId}`;

// --- Media keys -----------------------------------------------------------------------

const MAX_KEY_TEXT = 128;

/** A media key's base64, when it is one: 16 to 64 random bytes. */
function mediaKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 16 || value.length > MAX_KEY_TEXT || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  try {
    const bytes = atob(value).length;
    return bytes >= 16 && bytes <= 64 ? value : undefined;
  } catch {
    return undefined;
  }
}

const keyIndex = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined);

/** The key and index in a received io.element.call.encryption_keys content, for this room and the device that sent it. */
export function parseCallKey(content: Record<string, unknown>, roomId: string, deviceId: string): { key: string; index: number } | undefined {
  if (content.room_id !== roomId) return undefined;
  const member = isRecord(content.member) ? content.member : {};
  // The device that encrypted the message must be the one it speaks for.
  if (member.claimed_device_id !== deviceId) return undefined;
  for (const field of [content.media_key, content.keys]) {
    if (!isRecord(field)) continue;
    const key = mediaKey(field.key);
    const index = keyIndex(field.index);
    if (key !== undefined && index !== undefined) return { key, index };
  }
  return undefined;
}

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

interface OutboundKey {
  key: string;
  index: number;
  createdAt: number;
  /** Participants ("user|device|createdTs") that have it. */
  sharedWith: Set<string>;
}

export interface CallKeysDeps {
  /** Sends a key content to these devices (Olm-encrypted). */
  send(targets: DeviceRef[], content: Record<string, unknown>): Promise<void>;
  /** The keys the view should use changed. */
  changed(): void;
  log(message: string): void;
  now(): number;
  random(length: number): Uint8Array;
}

/**
 * The media keys of one encrypted call: our own, rotated and shared as
 * Element Call does (RTCEncryptionManager), and the other devices'.
 */
export class CallKeys {
  private outbound: OutboundKey | undefined;
  private participants: CallParticipant[] = [];
  /** Other devices' keys by "user|device"; the identities they go under come from the device's membership. */
  private readonly received = new Map<string, { index: number; key: string }[]>();
  private pending: { from: DeviceRef; key: string; index: number }[] = [];
  private own: { index: number; key: string }[] = [];
  private running: Promise<void> | undefined;
  private again = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly me: CallSelf,
    private readonly roomId: string,
    private readonly deps: CallKeysDeps,
  ) {}

  /** The other devices in the call now; whoever is new gets our key, and when anyone left everyone gets a new one. */
  update(participants: CallParticipant[]): Promise<void> {
    this.participants = participants.filter((p) => p.userId !== this.me.userId || p.deviceId !== this.me.deviceId);
    const waiting = this.pending;
    this.pending = [];
    for (const { from, key, index } of waiting) this.add(from, key, index);
    return this.distribute();
  }

  /** A key another device sent us (already Olm-authenticated as coming from `event`'s device). */
  receive(event: SecureToDevice): void {
    const parsed = parseCallKey(event.content, this.roomId, event.deviceId);
    if (!parsed || this.stopped) return;
    this.add(event, parsed.key, parsed.index);
  }

  /** What the view uses: our keys and those of the devices in the call, oldest first per device, under each LiveKit identity it has. */
  keys(): NativeMediaKey[] {
    const present = new Map(this.participants.map((p) => [deviceKey(p), identitiesOf(p)]));
    const under = (identities: string[], keys: { index: number; key: string }[]): NativeMediaKey[] => identities.flatMap((participant) => keys.map((k) => ({ participant, ...k })));
    return [...under(identitiesOf(this.me), this.own), ...[...this.received].flatMap(([device, keys]) => under(present.get(device) ?? [], keys))];
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
  }

  private add(from: DeviceRef, key: string, index: number): void {
    if (!this.participants.some((p) => p.userId === from.userId && p.deviceId === from.deviceId)) {
      // Keys can overtake the membership they belong to.
      if (this.pending.length < MAX_PENDING_KEYS) this.pending.push({ from: { userId: from.userId, deviceId: from.deviceId }, key, index });
      return;
    }
    const device = deviceKey(from);
    const keys = (this.received.get(device) ?? []).filter((k) => k.index !== index);
    keys.push({ index, key });
    this.received.set(device, keys.slice(-KEYS_PER_DEVICE));
    this.deps.changed();
  }

  private useOwn(key: OutboundKey): void {
    this.own = [...this.own.filter((k) => k.index !== key.index), { index: key.index, key: key.key }].slice(-KEYS_PER_DEVICE);
    this.deps.changed();
  }

  private newKey(index: number): OutboundKey {
    return { key: base64(this.deps.random(16)), index, createdAt: this.deps.now(), sharedWith: new Set() };
  }

  /** One rollout at a time; asking during one runs another after it. */
  private distribute(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.rollout();
        } while (this.again && !this.stopped);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async rollout(): Promise<void> {
    if (this.stopped) return;
    if (!this.outbound) {
      // The first key is used at once: nobody can have media from us yet.
      this.outbound = this.newKey(0);
      this.useOwn(this.outbound);
    }
    const current = this.participants.map((p) => ({ ref: { userId: p.userId, deviceId: p.deviceId }, id: `${p.userId}|${p.deviceId}|${p.createdTs}` }));
    const ids = new Set(current.map((c) => c.id));
    let key = this.outbound;
    const left = [...key.sharedWith].some((id) => !ids.has(id));
    const joined = current.filter((c) => !key.sharedWith.has(c.id));
    let targets = joined;
    let rotated = false;
    if (left || (joined.length > 0 && this.deps.now() - key.createdAt >= KEY_ROTATION_GRACE_MS)) {
      key = this.newKey((key.index + 1) % 256);
      this.outbound = key;
      rotated = true;
      targets = current;
    }
    if (targets.length === 0) return;
    // Receivers look our membership up by device; the member id says which of our memberships the key is for.
    const memberId = this.me.memberId ?? liveKitIdentity(this.me.userId, this.me.deviceId);
    const content = {
      room_id: this.roomId,
      member_id: memberId,
      media_key: { index: key.index, key: key.key },
      // The older field, still read by older clients.
      keys: { index: key.index, key: key.key },
      member: { claimed_device_id: this.me.deviceId, id: memberId },
    };
    try {
      await this.deps.send(
        targets.map((t) => t.ref),
        content,
      );
    } catch (error) {
      this.deps.log(`Call key not sent: ${error instanceof Error ? error.message : String(error)}`);
      // Whoever did not get it is still waiting: try again in a while, a few times.
      if (this.retries++ < MAX_KEY_RETRIES && !this.stopped) this.retryTimer = setTimeout(() => void this.distribute(), KEY_RETRY_MS);
      return;
    }
    this.retries = 0;
    for (const target of targets) key.sharedWith.add(target.id);
    if (!rotated) return;
    await new Promise((resolve) => setTimeout(resolve, KEY_USE_DELAY_MS));
    if (!this.stopped && this.outbound === key) this.useOwn(key);
  }
}

// --- One call ---------------------------------------------------------------------------

/** How to join in the newer format (m.rtc.member): where to publish, and how our room events are sent. */
export interface RtcJoin {
  /**
   * The homeserver's LiveKit server to publish on, with access from the
   * homeserver (MSC4195); without it, the service (`focus`) gives access, as
   * for the older format.
   */
  sfu?: string;
  /** Encrypts a room event when the room is encrypted: memberships are room events, which Element encrypts too. */
  seal(type: string, content: Record<string, unknown>): Promise<{ type: string; content: Record<string, unknown> }>;
}

export interface MatrixCallDeps {
  api: MatrixApi;
  session: MxSession;
  roomId: string;
  focus: string;
  intent: string;
  /** Set to join with a sticky m.rtc.member event (MSC4143, MSC4354) instead of the state event. */
  rtc?: RtcJoin;
  /** Set for encrypted rooms: sends our media key over Olm. */
  e2ee?: Pick<E2ee, "sendToDevices">;
  /** Whether the view may reach this host (the engine's host lock). */
  allowHost(host: string): boolean;
  /** Something the view shows changed (the grant, the keys). */
  changed(): void;
  /** The call broke for good (e.g. the membership could not be kept): leave with this message. */
  failed(message: string): void;
  log(message: string): void;
  now?(): number;
  random?(length: number): Uint8Array;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const notFound = (error: unknown): boolean => error instanceof MatrixError && (error.status === 404 || error.errcode === "M_NOT_FOUND");

/**
 * Our device in one room's call: gets access to the call's LiveKit room,
 * announces the membership (with a delayed leave where the homeserver has
 * delayed events, so a crash does not leave a ghost), renews it before it
 * expires, shares media keys in encrypted rooms, and leaves again. The
 * membership is a state event, or with `rtc` a sticky m.rtc.member event.
 */
export class MatrixCall {
  grant: MxLiveKitGrant | undefined;
  readonly keys: CallKeys | undefined;
  /** Our member id: user:device for the older format, a new UUID per call for the newer one. */
  readonly memberId: string;
  /** Our identity on LiveKit, which our media keys go under. */
  readonly identity: string;
  private readonly stateKey: string;
  private membershipId: string | undefined;
  private createdTs: number | undefined;
  /** Whether createdTs is still our local guess, before the server's time for the membership is known. */
  private guessed = true;
  private renewals = 0;
  private delayId: string | undefined;
  private restartTimer: ReturnType<typeof setInterval> | undefined;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private left = false;
  private readonly now: () => number;

  constructor(private readonly deps: MatrixCallDeps) {
    this.now = deps.now ?? Date.now;
    const random = deps.random ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
    const { userId, deviceId } = deps.session;
    this.stateKey = membershipStateKey(userId, deviceId);
    this.memberId = deps.rtc ? uuid(random(16)) : liveKitIdentity(userId, deviceId);
    // On a LiveKit server the homeserver grants access to, the identity is the hashed one (MSC4195); through a service, user:device.
    this.identity = deps.rtc?.sfu ? rtcIdentity(userId, this.memberId) : liveKitIdentity(userId, deviceId);
    const e2ee = deps.e2ee;
    if (e2ee) {
      this.keys = new CallKeys({ userId, deviceId, memberId: this.memberId, identities: [this.identity] }, deps.roomId, {
        send: (targets, content) => e2ee.sendToDevices(CALL_KEYS_TYPE, targets, content),
        changed: () => deps.changed(),
        log: deps.log,
        now: this.now,
        random,
      });
    }
  }

  get roomId(): string {
    return this.deps.roomId;
  }

  get focus(): string {
    return this.deps.focus;
  }

  /** The LiveKit server we publish on, when the homeserver granted access to it (newer format). */
  get sfu(): string | undefined {
    return this.deps.rtc?.sfu;
  }

  /** Whether we joined with an m.rtc.member event. */
  get sticky(): boolean {
    return this.deps.rtc !== undefined;
  }

  get encrypted(): boolean {
    return this.keys !== undefined;
  }

  /** The membership event we sent, for the ring that points at it. */
  get membershipEventId(): string | undefined {
    return this.membershipId;
  }

  /** Gets access to the LiveKit room, then joins. Throws when that fails; leave() then cleans up. */
  async join(): Promise<void> {
    const grant = await this.access();
    const host = new URL(grant.url).hostname.toLowerCase();
    if (!this.deps.allowHost(host)) throw new HostNotAllowedError(host);
    if (this.left) return;
    await this.scheduleLeave();
    if (this.left) return this.cancelLeave();
    this.membershipId = await this.announce();
    this.createdTs = this.now();
    if (this.left) return this.removeMembership();
    this.grant = grant;
    this.scheduleRenewal();
    this.deps.changed();
  }

  /** Our membership as the server stamped it: its time is the one others count from (state events only; a sticky one counts from each sending). */
  ownMembership(createdTs: number): void {
    if (this.guessed && this.renewals === 0 && this.createdTs !== undefined && !this.left && !this.deps.rtc) {
      this.createdTs = createdTs;
      this.guessed = false;
      this.scheduleRenewal();
    }
  }

  /** Ends the membership (best effort) and stops everything. */
  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;
    this.stopTimers();
    this.keys?.stop();
    if (this.membershipId) await this.removeMembership();
    else await this.cancelLeave();
  }

  /** Stops without telling the server, which no longer accepts us (signed out elsewhere). */
  abandon(): void {
    this.left = true;
    this.stopTimers();
    this.keys?.stop();
  }

  private stopTimers(): void {
    clearInterval(this.restartTimer);
    clearTimeout(this.renewTimer);
    this.restartTimer = undefined;
  }

  /** Access to the LiveKit room: from the homeserver for its own LiveKit server (newer format), else from the service with an OpenID token. */
  private async access(): Promise<MxLiveKitGrant> {
    const { api, session, roomId, focus, rtc } = this.deps;
    if (rtc?.sfu) return api.liveKitToken(session, { sfu: rtc.sfu, roomId, slotId: SLOT_ID, memberId: this.memberId, deviceId: session.deviceId });
    const token = await api.openIdToken(session);
    return api.liveKitGrant(focus, roomId, session.deviceId, token);
  }

  private content(): Record<string, unknown> {
    const { userId, deviceId } = this.deps.session;
    const options = { userId, deviceId, roomId: this.deps.roomId, focus: this.deps.focus, intent: this.deps.intent, expires: CALL_MEMBERSHIP_EXPIRY_MS * (this.renewals + 1) };
    // Renewals keep the start time and extend `expires`, as Element Call does.
    return membershipContent(this.renewals > 0 ? { ...options, createdTs: this.createdTs } : options);
  }

  /** Sends our membership: the state event, or the sticky m.rtc.member event (encrypted in encrypted rooms). */
  private async announce(): Promise<string> {
    const { api, session, roomId, rtc } = this.deps;
    if (!rtc) return api.sendState(session, roomId, CALL_MEMBER_TYPE, this.stateKey, this.content());
    const { userId, deviceId } = session;
    const sealed = await rtc.seal(RTC_MEMBER_TYPE, rtcMembershipContent({ userId, deviceId, memberId: this.memberId, focus: this.deps.focus, sfu: rtc.sfu, intent: this.deps.intent }));
    return api.sendSticky(session, roomId, sealed.type, sealed.content, MEMBERSHIP_STICKY_MS);
  }

  /** Sends the end of our membership now. */
  private async sendLeave(): Promise<void> {
    const { api, session, roomId, rtc } = this.deps;
    if (!rtc) {
      await api.sendState(session, roomId, CALL_MEMBER_TYPE, this.stateKey, {});
      return;
    }
    const sealed = await rtc.seal(RTC_MEMBER_TYPE, rtcLeaveContent(this.memberId));
    await api.sendSticky(session, roomId, sealed.type, sealed.content, MEMBERSHIP_STICKY_MS);
  }

  /** Has the server send our leave should we stop pushing it back (Multicord quit or crashed). */
  private async scheduleLeave(): Promise<void> {
    const { api, session, roomId, rtc } = this.deps;
    // Without delayed events the server would send the leave at once: ask first.
    if (!(await api.supports(session, DELAYED_EVENTS_FEATURE).catch(() => false))) return;
    let delayId: string;
    try {
      if (rtc) {
        const sealed = await rtc.seal(RTC_MEMBER_TYPE, rtcLeaveContent(this.memberId));
        delayId = await api.sendDelayedSticky(session, roomId, sealed.type, sealed.content, DELAYED_LEAVE_MS, MEMBERSHIP_STICKY_MS);
      } else {
        delayId = await api.sendDelayedState(session, roomId, CALL_MEMBER_TYPE, this.stateKey, {}, DELAYED_LEAVE_MS);
      }
    } catch (error) {
      this.deps.log(`Delayed leave not scheduled: ${messageOf(error)}`);
      return;
    }
    this.delayId = delayId;
    // Left meanwhile: the caller cancels it.
    if (!this.left) this.restartTimer = setInterval(() => void this.restartLeave(delayId), DELAYED_LEAVE_RESTART_MS);
  }

  private async restartLeave(delayId: string): Promise<void> {
    try {
      await this.deps.api.updateDelayed(this.deps.session, delayId, "restart");
    } catch (error) {
      if (this.left || delayId !== this.delayId) return;
      if (!notFound(error)) return this.deps.log(`Delayed leave not pushed back: ${messageOf(error)}`);
      // The server already sent our leave (e.g. the computer slept): join again.
      this.delayId = undefined;
      clearInterval(this.restartTimer);
      try {
        await this.scheduleLeave();
        if (this.left) return await this.cancelLeave();
        this.membershipId = await this.announce();
        if (this.left) await this.removeMembership();
      } catch (again) {
        if (!this.left) this.deps.failed(`The call membership was lost: ${messageOf(again)}`);
      }
    }
  }

  private async cancelLeave(): Promise<void> {
    const delayId = this.delayId;
    this.delayId = undefined;
    if (delayId) await this.deps.api.updateDelayed(this.deps.session, delayId, "cancel").catch(() => undefined);
  }

  private async removeMembership(): Promise<void> {
    const { api, session } = this.deps;
    const delayId = this.delayId;
    this.delayId = undefined;
    // Sending the scheduled leave now is the same leave; without one, it is sent directly.
    if (delayId && (await api.updateDelayed(session, delayId, "send").then(() => true, () => false))) return;
    await this.sendLeave().catch((error: unknown) => this.deps.log(`Call membership not removed: ${messageOf(error)}`));
  }

  /** A state membership is renewed before it expires; a sticky one before it stops being sticky. */
  private scheduleRenewal(delay?: number): void {
    clearTimeout(this.renewTimer);
    const lifetime = this.deps.rtc ? MEMBERSHIP_STICKY_MS : CALL_MEMBERSHIP_EXPIRY_MS * (this.renewals + 1);
    const due = this.createdTs! + lifetime - RENEW_MARGIN_MS;
    this.renewTimer = setTimeout(() => void this.renew(), delay ?? Math.max(0, due - this.now()));
  }

  private async renew(): Promise<void> {
    this.renewals++;
    try {
      this.membershipId = await this.announce();
    } catch (error) {
      this.renewals--;
      this.deps.log(`Call membership not renewed: ${messageOf(error)}`);
      if (!this.left) this.scheduleRenewal(RENEW_RETRY_MS);
      return;
    }
    // A sticky membership is new each time it is sent.
    if (this.deps.rtc) this.createdTs = this.now();
    if (!this.left) this.scheduleRenewal();
  }
}
