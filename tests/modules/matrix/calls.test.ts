import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixError, type MatrixApi, type MxSession } from "../../../src/modules/matrix/api";
import {
  CALL_KEYS_TYPE,
  CallKeys,
  DELAYED_LEAVE_MS,
  DELAYED_LEAVE_RESTART_MS,
  HostNotAllowedError,
  KEY_ROTATION_GRACE_MS,
  KEY_USE_DELAY_MS,
  liveKitIdentity,
  MatrixCall,
  MEMBERSHIP_STICKY_MS,
  membershipContent,
  membershipStateKey,
  parseCallKey,
  RENEW_MARGIN_MS,
  ringContent,
  rtcLeaveContent,
  rtcMembershipContent,
  slotContent,
  RING_LIFETIME_MS,
  uuid,
  type CallKeysDeps,
  type MatrixCallDeps,
} from "../../../src/modules/matrix/calls";
import { CALL_MEMBERSHIP_EXPIRY_MS, CALL_MEMBER_TYPE, RTC_MEMBER_TYPE } from "../../../src/modules/matrix/events";

const ME = "@me:x.org";
const ANA = "@ana:x.org";
const ROOM = "!r:x.org";
const FOCUS = "https://jwt.call.x.org";
const SESSION: MxSession = { baseUrl: "https://hs.x.org", accessToken: "tok", userId: ME, deviceId: "D", ownDevice: true };
const KEY_A = btoa("A".repeat(16));
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => vi.useRealTimers());

describe("membership events", () => {
  it("uses Element Call's state key and content", () => {
    expect(membershipStateKey(ME, "D")).toBe("_@me:x.org_D_m.call");
    expect(liveKitIdentity(ME, "D")).toBe("@me:x.org:D");
    expect(membershipContent({ userId: ME, deviceId: "D", roomId: ROOM, focus: FOCUS, expires: 100, intent: "audio" })).toEqual({
      application: "m.call",
      call_id: "",
      scope: "m.room",
      device_id: "D",
      membershipID: "@me:x.org:D",
      expires: 100,
      "m.call.intent": "audio",
      focus_active: { type: "livekit", focus_selection: "multi_sfu" },
      foci_preferred: [{ type: "livekit", livekit_service_url: FOCUS, livekit_alias: ROOM }],
    });
    expect(membershipContent({ userId: ME, deviceId: "D", roomId: ROOM, focus: FOCUS, expires: 100, intent: "audio", createdTs: 5 }).created_ts).toBe(5);
  });

  it("rings with a reference to the membership", () => {
    expect(ringContent("$m", "audio", 7)).toEqual({
      slot_id: "m.call#ROOM",
      "m.mentions": { user_ids: [], room: true },
      notification_type: "ring",
      "m.relates_to": { event_id: "$m", rel_type: "m.reference" },
      sender_ts: 7,
      lifetime: RING_LIFETIME_MS,
      "m.call.intent": "audio",
    });
  });

  it("opens the call's slot, with per-device media keys in encrypted rooms", () => {
    expect(slotContent(false)).toEqual({ status: "open", application: { type: "m.call" } });
    expect(slotContent(true)).toEqual({ status: "open", application: { type: "m.call" }, encryption: { type: "org.matrix.msc4143.per_member" } });
  });
});

describe("received media keys", () => {
  const content = (extra: Record<string, unknown> = {}) => ({ room_id: ROOM, media_key: { index: 3, key: KEY_A }, member: { claimed_device_id: "AD" }, ...extra });

  it("reads the key for this room from the device that sent it, from either field", () => {
    expect(parseCallKey(content(), ROOM, "AD")).toEqual({ key: KEY_A, index: 3 });
    expect(parseCallKey(content({ media_key: undefined, keys: { index: 0, key: KEY_A } }), ROOM, "AD")).toEqual({ key: KEY_A, index: 0 });
    expect(parseCallKey(content({ media_key: { index: 1, key: "bad" }, keys: { index: 2, key: KEY_A } }), ROOM, "AD")).toEqual({ key: KEY_A, index: 2 });
  });

  it("refuses keys for other rooms, from other devices, or malformed", () => {
    expect(parseCallKey(content(), "!other:x.org", "AD")).toBeUndefined();
    expect(parseCallKey(content(), ROOM, "OTHER")).toBeUndefined();
    expect(parseCallKey(content({ member: "AD" }), ROOM, "AD")).toBeUndefined();
    for (const media_key of [{ index: 256, key: KEY_A }, { index: -1, key: KEY_A }, { index: 1.5, key: KEY_A }, { index: 0, key: btoa("short") }, { index: 0, key: btoa("x".repeat(65)) }, { index: 0, key: "!".repeat(20) }, { index: 0, key: "A".repeat(129) }, { index: 0, key: "AAAAAAAAAAAAAAAAA" }, { index: 0, key: 5 }, "x"]) {
      expect(parseCallKey(content({ media_key }), ROOM, "AD")).toBeUndefined();
    }
  });
});

/** Media keys with recorded sends; random bytes count up so each key differs. */
function keys(fail = false) {
  let counter = 0;
  const sent: { targets: string[]; index: number; key: string }[] = [];
  const deps = {
    send: vi.fn(async (targets: { userId: string; deviceId: string }[], content: Record<string, unknown>) => {
      if (fail) throw new Error("offline");
      const media = content.media_key as { index: number; key: string };
      sent.push({ targets: targets.map((t) => `${t.userId}|${t.deviceId}`), index: media.index, key: media.key });
    }),
    changed: vi.fn(),
    log: vi.fn(),
    now: () => Date.now(),
    random: (length: number) => new Uint8Array(length).fill(++counter),
  } satisfies CallKeysDeps;
  const manager = new CallKeys({ userId: ME, deviceId: "D" }, ROOM, deps);
  return { manager, deps, sent };
}
const ana = (createdTs = 1) => ({ userId: ANA, deviceId: "AD", createdTs });
const bo = { userId: "@bo:x.org", deviceId: "BD", createdTs: 1 };
const own = (n: number) => ({ participant: "@me:x.org:D", index: n, key: btoa(String.fromCharCode(...new Uint8Array(16).fill(n + 1))) });

describe("call keys", () => {
  it("makes a first key, used at once, and sends it to whoever is in the call", async () => {
    const { manager, sent, deps } = keys();
    await manager.update([ana(), { userId: ME, deviceId: "D", createdTs: 1 }]);
    expect(manager.keys()).toEqual([own(0)]);
    expect(sent).toEqual([{ targets: [`${ANA}|AD`], index: 0, key: own(0).key }]);
    const content = deps.send.mock.calls[0]![1];
    expect(content).toEqual({
      room_id: ROOM,
      member_id: "@me:x.org:D",
      media_key: { index: 0, key: own(0).key },
      keys: { index: 0, key: own(0).key },
      member: { claimed_device_id: "D", id: "@me:x.org:D" },
    });
    // Nothing new: nothing sent.
    await manager.update([ana()]);
    expect(sent).toHaveLength(1);
  });

  it("gives a joiner the current key while it is young, and a new one to everyone after", async () => {
    const { manager, sent } = keys();
    await manager.update([ana()]);
    await manager.update([ana(), bo]);
    expect(sent[1]).toEqual({ targets: ["@bo:x.org|BD"], index: 0, key: own(0).key });
    vi.advanceTimersByTime(KEY_ROTATION_GRACE_MS);
    const later = manager.update([ana(), bo, { userId: "@cy:x.org", deviceId: "CD", createdTs: 1 }]);
    await flush();
    expect(sent[2]).toEqual({ targets: [`${ANA}|AD`, "@bo:x.org|BD", "@cy:x.org|CD"], index: 1, key: own(1).key });
    // The new key is used once it has had time to arrive.
    expect(manager.keys()).toEqual([own(0)]);
    await vi.advanceTimersByTimeAsync(KEY_USE_DELAY_MS);
    await later;
    expect(manager.keys()).toEqual([own(0), own(1)]);
  });

  it("makes a new key when someone leaves or rejoins", async () => {
    const { manager, sent } = keys();
    await manager.update([ana(), bo]);
    const left = manager.update([bo]);
    await vi.advanceTimersByTimeAsync(KEY_USE_DELAY_MS);
    await left;
    expect(sent[1]).toEqual({ targets: ["@bo:x.org|BD"], index: 1, key: own(1).key });
    const rejoined = manager.update([{ ...bo, createdTs: 2 }]);
    await vi.advanceTimersByTimeAsync(KEY_USE_DELAY_MS);
    await rejoined;
    expect(sent[2]!.index).toBe(2);
    // Alone again: nobody to send to, but whoever was there no longer has a usable key.
    await manager.update([]);
    expect(sent).toHaveLength(3);
  });

  it("wraps key indexes at 256 and keeps the last few", async () => {
    const { manager } = keys();
    await manager.update([ana(0)]);
    for (let i = 1; i <= 257; i++) {
      const next = manager.update([ana(i)]);
      await vi.advanceTimersByTimeAsync(KEY_USE_DELAY_MS);
      await next;
    }
    const indexes = manager.keys().map((k) => k.index);
    expect(indexes).toEqual([254, 255, 0, 1]);
  });

  it("runs one rollout at a time and repeats it for changes meanwhile", async () => {
    const { manager, sent } = keys();
    const first = manager.update([ana()]);
    const second = manager.update([ana(), bo]);
    expect(second).toBe(first);
    await first;
    expect(sent.map((s) => s.targets)).toEqual([[`${ANA}|AD`], ["@bo:x.org|BD"]]);
  });

  it("does not use a rotated key once stopped, or once a newer one replaced it", async () => {
    const { manager } = keys();
    await manager.update([ana(), bo]);
    const rotated = manager.update([bo]);
    await flush();
    manager.stop();
    await vi.advanceTimersByTimeAsync(KEY_USE_DELAY_MS);
    await rotated;
    expect(manager.keys()).toEqual([own(0)]);
    await manager.update([ana()]);
    expect(manager.keys()).toEqual([own(0)]);
  });

  it("retries a failed send a few times", async () => {
    const { manager, deps } = keys(true);
    await manager.update([ana()]);
    expect(deps.log).toHaveBeenCalledWith("Call key not sent: offline");
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5000);
    expect(deps.send).toHaveBeenCalledTimes(6);
    deps.send.mockRejectedValueOnce("plain");
    manager.stop();
  });

  it("logs failures that are not errors", async () => {
    const { manager, deps } = keys();
    deps.send.mockRejectedValueOnce("plain");
    await manager.update([ana()]);
    expect(deps.log).toHaveBeenCalledWith("Call key not sent: plain");
    manager.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("keeps other devices' keys, newest last, for devices in the call", async () => {
    const { manager, deps } = keys();
    await manager.update([ana()]);
    const from = (index: number, key = KEY_A, deviceId = "AD") => ({ userId: ANA, deviceId, content: { room_id: ROOM, media_key: { index, key }, member: { claimed_device_id: deviceId } } });
    manager.receive(from(0));
    manager.receive(from(1));
    manager.receive(from(0, btoa("B".repeat(16))));
    for (let i = 2; i < 6; i++) manager.receive(from(i));
    expect(manager.keys().filter((k) => k.participant === "@ana:x.org:AD").map((k) => k.index)).toEqual([2, 3, 4, 5]);
    expect(deps.changed).toHaveBeenCalled();
    // A malformed key changes nothing.
    manager.receive({ userId: ANA, deviceId: "AD", content: { room_id: ROOM, media_key: { index: 9, key: "x" }, member: { claimed_device_id: "AD" } } });
    expect(manager.keys()).toHaveLength(5);
    // Keys of devices that left are not used.
    await manager.update([]);
    expect(manager.keys()).toEqual([own(0)]);
  });

  it("holds keys that arrive before their membership, up to a limit", async () => {
    const { manager } = keys();
    await manager.update([]);
    for (let i = 0; i < 60; i++) manager.receive({ userId: ANA, deviceId: `AD${i}`, content: { room_id: ROOM, media_key: { index: 0, key: KEY_A }, member: { claimed_device_id: `AD${i}` } } });
    expect(manager.keys()).toEqual([own(0)]);
    await manager.update([{ userId: ANA, deviceId: "AD7", createdTs: 1 }, { userId: ANA, deviceId: "AD55", createdTs: 1 }]);
    expect(manager.keys().map((k) => k.participant)).toEqual(["@me:x.org:D", "@ana:x.org:AD7"]);
    manager.stop();
    manager.receive({ userId: ANA, deviceId: "AD7", content: { room_id: ROOM, media_key: { index: 4, key: KEY_A }, member: { claimed_device_id: "AD7" } } });
    expect(manager.keys()).toHaveLength(2);
  });
});

/** A homeserver and call service stand-in for one call. */
function callApi(options: { delayed?: boolean } = {}) {
  return {
    openIdToken: vi.fn(async () => ({ access_token: "oid", token_type: "Bearer", matrix_server_name: "x.org", expires_in: 3600 })),
    liveKitGrant: vi.fn(async () => ({ url: "wss://sfu.call.x.org/", jwt: "jwt" })),
    supports: vi.fn(async () => options.delayed ?? true),
    sendDelayedState: vi.fn(async () => "delay1"),
    updateDelayed: vi.fn(async (..._args: unknown[]) => {}),
    sendState: vi.fn(async (..._args: unknown[]) => "$m1"),
  };
}

function call(api = callApi(), extra: Partial<MatrixCallDeps> = {}) {
  const deps = {
    api: api as unknown as MatrixApi,
    session: SESSION,
    roomId: ROOM,
    focus: FOCUS,
    intent: "audio",
    allowHost: vi.fn((_host: string) => true),
    changed: vi.fn(),
    failed: vi.fn(),
    log: vi.fn(),
    ...extra,
  };
  return { call: new MatrixCall(deps), deps, api };
}
const STATE_KEY = "_@me:x.org_D_m.call";

describe("joining and leaving a call", () => {
  it("gets access first, schedules the leave, then announces the membership", async () => {
    const { call: c, api, deps } = call();
    expect([c.roomId, c.focus, c.encrypted, c.keys]).toEqual([ROOM, FOCUS, false, undefined]);
    await c.join();
    expect(api.liveKitGrant).toHaveBeenCalledWith(FOCUS, ROOM, "D", expect.objectContaining({ access_token: "oid" }));
    expect(deps.allowHost).toHaveBeenCalledWith("sfu.call.x.org");
    expect(api.supports).toHaveBeenCalledWith(SESSION, "org.matrix.msc4140");
    expect(api.sendDelayedState).toHaveBeenCalledWith(SESSION, ROOM, CALL_MEMBER_TYPE, STATE_KEY, {}, DELAYED_LEAVE_MS);
    expect(api.sendState).toHaveBeenCalledWith(SESSION, ROOM, CALL_MEMBER_TYPE, STATE_KEY, expect.objectContaining({ device_id: "D", expires: CALL_MEMBERSHIP_EXPIRY_MS }));
    expect(api.sendState.mock.calls[0]![4]).not.toHaveProperty("created_ts");
    expect(c.grant).toEqual({ url: "wss://sfu.call.x.org/", jwt: "jwt" });
    expect(c.membershipEventId).toBe("$m1");
    expect(deps.changed).toHaveBeenCalled();

    // The leave keeps being pushed back.
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS * 2);
    expect(api.updateDelayed).toHaveBeenCalledWith(SESSION, "delay1", "restart");
    expect(api.updateDelayed).toHaveBeenCalledTimes(2);

    // Leaving sends the scheduled leave now.
    await c.leave();
    expect(api.updateDelayed).toHaveBeenLastCalledWith(SESSION, "delay1", "send");
    expect(api.sendState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS * 2);
    expect(api.updateDelayed).toHaveBeenCalledTimes(3);
    await c.leave(); // once is enough
    expect(api.updateDelayed).toHaveBeenCalledTimes(3);
  });

  it("refuses a LiveKit server on a host the engine may not reach, before announcing anything", async () => {
    const { call: c, api } = call(callApi(), { allowHost: () => false });
    await expect(c.join()).rejects.toThrow(HostNotAllowedError);
    await expect(c.join()).rejects.toMatchObject({ host: "sfu.call.x.org", name: "HostNotAllowedError" });
    expect(api.sendState).not.toHaveBeenCalled();
    expect(api.sendDelayedState).not.toHaveBeenCalled();
  });

  it("sends the empty state itself without delayed events, or when the scheduled leave cannot be sent", async () => {
    const plain = call(callApi({ delayed: false }));
    await plain.call.join();
    expect(plain.api.sendDelayedState).not.toHaveBeenCalled();
    await plain.call.leave();
    expect(plain.api.sendState).toHaveBeenLastCalledWith(SESSION, ROOM, CALL_MEMBER_TYPE, STATE_KEY, {});

    const failing = call();
    failing.api.supports.mockRejectedValueOnce(new Error("offline"));
    await failing.call.join();
    expect(failing.api.sendDelayedState).not.toHaveBeenCalled();

    const gone = call();
    await gone.call.join();
    gone.api.updateDelayed.mockRejectedValueOnce(new MatrixError(404, "M_NOT_FOUND", "gone"));
    await gone.call.leave();
    expect(gone.api.sendState).toHaveBeenLastCalledWith(SESSION, ROOM, CALL_MEMBER_TYPE, STATE_KEY, {});
  });

  it("carries on without a delayed leave the server refuses, and logs a membership it cannot remove", async () => {
    const { call: c, api, deps } = call();
    api.sendDelayedState.mockRejectedValueOnce(new Error("too long"));
    await c.join();
    expect(deps.log).toHaveBeenCalledWith("Delayed leave not scheduled: too long");
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    expect(api.updateDelayed).not.toHaveBeenCalled();
    api.sendState.mockRejectedValueOnce("forbidden");
    await c.leave();
    expect(deps.log).toHaveBeenCalledWith("Call membership not removed: forbidden");
  });

  it("joins again when the server already sent the leave, and gives up when that fails", async () => {
    const { call: c, api, deps } = call();
    await c.join();
    api.updateDelayed.mockRejectedValueOnce(new Error("timeout"));
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    expect(deps.log).toHaveBeenCalledWith("Delayed leave not pushed back: timeout");
    api.updateDelayed.mockRejectedValueOnce(new MatrixError(404, "M_NOT_FOUND", "gone"));
    api.sendDelayedState.mockResolvedValueOnce("delay2");
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    expect(api.sendState).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    expect(api.updateDelayed).toHaveBeenLastCalledWith(SESSION, "delay2", "restart");

    api.updateDelayed.mockRejectedValueOnce(new MatrixError(400, "M_NOT_FOUND", "gone"));
    api.sendState.mockRejectedValueOnce(new Error("forbidden"));
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    expect(deps.failed).toHaveBeenCalledWith("The call membership was lost: forbidden");
  });

  it("drops restart answers that come after leaving", async () => {
    const { call: c, api, deps } = call();
    await c.join();
    let reject: (error: unknown) => void = () => {};
    api.updateDelayed.mockImplementationOnce(() => new Promise((_resolve, no) => (reject = no)));
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    await c.leave();
    reject(new MatrixError(404, "M_NOT_FOUND", "gone"));
    await flush();
    expect(deps.log).not.toHaveBeenCalled();
    expect(api.sendDelayedState).toHaveBeenCalledTimes(1);
  });

  it("does not report a lost membership after leaving", async () => {
    const { call: c, api, deps } = call();
    await c.join();
    api.updateDelayed.mockRejectedValueOnce(new MatrixError(404, "M_NOT_FOUND", "gone"));
    let fail: (error: unknown) => void = () => {};
    api.sendState.mockImplementationOnce(() => new Promise((_resolve, no) => (fail = no)));
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    await c.leave();
    fail(new Error("late"));
    await flush();
    expect(deps.failed).not.toHaveBeenCalled();
  });

  it("takes back a membership it sent again while leaving", async () => {
    const { call: c, api } = call();
    await c.join();
    api.updateDelayed.mockRejectedValueOnce(new MatrixError(404, "M_NOT_FOUND", "gone"));
    let scheduled: (id: string) => void = () => {};
    api.sendDelayedState.mockImplementationOnce(() => new Promise((resolve) => (scheduled = resolve)));
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    await c.leave();
    scheduled("delay3");
    await flush();
    // The new scheduled leave is cancelled, and no membership is sent again.
    expect(api.updateDelayed).toHaveBeenLastCalledWith(SESSION, "delay3", "cancel");
    expect(api.sendState.mock.calls.map((call) => call[4])).toEqual([expect.objectContaining({ application: "m.call" }), {}]);

    const late = call();
    await late.call.join();
    late.api.updateDelayed.mockRejectedValueOnce(new MatrixError(404, "M_NOT_FOUND", "gone"));
    let announced: (id: string) => void = () => {};
    late.api.sendState.mockImplementationOnce(() => new Promise((resolve) => (announced = resolve)));
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    await late.call.leave();
    announced("$m2");
    await flush();
    expect(late.api.updateDelayed).toHaveBeenLastCalledWith(SESSION, "delay1", "send");
    // No interval keeps running.
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS * 3);
    expect(late.api.updateDelayed.mock.calls.filter((call) => call[2] === "restart")).toHaveLength(1);
  });

  it("does not renew after leaving, even when the server's time arrives late", async () => {
    const { call: c, api } = call(callApi({ delayed: false }));
    await c.join();
    await c.leave();
    c.ownMembership(999_000);
    await vi.advanceTimersByTimeAsync(CALL_MEMBERSHIP_EXPIRY_MS * 2);
    expect(api.sendState).toHaveBeenCalledTimes(2);
  });

  it("renews the membership before it expires, keeping its start time", async () => {
    const { call: c, api, deps } = call(callApi({ delayed: false }));
    await c.join();
    // The server's time for the membership is what others count from.
    c.ownMembership(999_000);
    c.ownMembership(5);
    await vi.advanceTimersByTimeAsync(999_000 + CALL_MEMBERSHIP_EXPIRY_MS - RENEW_MARGIN_MS - 1_000_000 - 1);
    expect(api.sendState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.sendState.mock.calls[1]![4]).toMatchObject({ created_ts: 999_000, expires: CALL_MEMBERSHIP_EXPIRY_MS * 2 });
    // A failed renewal is tried again soon.
    api.sendState.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(CALL_MEMBERSHIP_EXPIRY_MS);
    expect(deps.log).toHaveBeenCalledWith("Call membership not renewed: offline");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.sendState.mock.calls.at(-1)![4]).toMatchObject({ created_ts: 999_000, expires: CALL_MEMBERSHIP_EXPIRY_MS * 3 });
    c.abandon();
    await vi.advanceTimersByTimeAsync(CALL_MEMBERSHIP_EXPIRY_MS * 2);
    expect(api.sendState).toHaveBeenCalledTimes(4);
  });

  it("stops renewing once it left while a renewal was on its way", async () => {
    const { call: c, api } = call(callApi({ delayed: false }));
    await c.join();
    let done: (id: string) => void = () => {};
    api.sendState.mockImplementationOnce(() => new Promise((resolve) => (done = resolve)));
    await vi.advanceTimersByTimeAsync(CALL_MEMBERSHIP_EXPIRY_MS);
    const leaving = c.leave();
    done("$m2");
    await leaving;
    await vi.advanceTimersByTimeAsync(CALL_MEMBERSHIP_EXPIRY_MS * 2);
    expect(api.sendState).toHaveBeenCalledTimes(3); // join, renewal, leave
  });

  it("does not retry a renewal that failed after leaving", async () => {
    const { call: c, api, deps } = call(callApi({ delayed: false }));
    await c.join();
    let fail: (error: unknown) => void = () => {};
    api.sendState.mockImplementationOnce(() => new Promise((_resolve, no) => (fail = no)));
    await vi.advanceTimersByTimeAsync(CALL_MEMBERSHIP_EXPIRY_MS);
    const leaving = c.leave();
    fail("offline");
    await leaving;
    await flush();
    expect(deps.log).toHaveBeenCalledWith("Call membership not renewed: offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.sendState).toHaveBeenCalledTimes(3);
  });

  it("cleans up when left while joining, at every step", async () => {
    // Left while getting access: nothing is sent.
    const early = call();
    let grant: (value: { url: string; jwt: string }) => void = () => {};
    early.api.liveKitGrant.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)));
    const joining = early.call.join();
    await flush();
    await early.call.leave();
    grant({ url: "wss://sfu.call.x.org", jwt: "j" });
    await joining;
    expect(early.api.sendDelayedState).not.toHaveBeenCalled();
    expect(early.call.grant).toBeUndefined();

    // Left while scheduling the leave: the scheduled leave is cancelled.
    const middle = call();
    let scheduled: (id: string) => void = () => {};
    middle.api.sendDelayedState.mockImplementationOnce(() => new Promise((resolve) => (scheduled = resolve)));
    const joining2 = middle.call.join();
    await flush();
    await middle.call.leave();
    scheduled("delay9");
    await joining2;
    expect(middle.api.updateDelayed).toHaveBeenCalledWith(SESSION, "delay9", "cancel");
    expect(middle.api.sendState).not.toHaveBeenCalled();

    // Left while announcing: the membership is taken back at once.
    const late = call();
    let announced: (id: string) => void = () => {};
    late.api.sendState.mockImplementationOnce(() => new Promise((resolve) => (announced = resolve)));
    const joining3 = late.call.join();
    await flush();
    await late.call.leave();
    expect(late.api.updateDelayed).toHaveBeenCalledWith(SESSION, "delay1", "cancel");
    announced("$m1");
    await joining3;
    expect(late.api.sendState).toHaveBeenLastCalledWith(SESSION, ROOM, CALL_MEMBER_TYPE, STATE_KEY, {});
    expect(late.call.grant).toBeUndefined();
  });

  it("ignores a failed cancel", async () => {
    const middle = call();
    let scheduled: (id: string) => void = () => {};
    middle.api.sendDelayedState.mockImplementationOnce(() => new Promise((resolve) => (scheduled = resolve)));
    middle.api.updateDelayed.mockRejectedValueOnce(new Error("offline"));
    const joining = middle.call.join();
    await flush();
    await middle.call.leave();
    scheduled("delay9");
    await expect(joining).resolves.toBeUndefined();
  });

  it("shares media keys over Olm in encrypted rooms", async () => {
    const sendToDevices = vi.fn(async () => {});
    const { call: c, deps } = call(callApi(), { e2ee: { sendToDevices }, random: (n) => new Uint8Array(n).fill(7) });
    expect(c.encrypted).toBe(true);
    await c.join();
    await c.keys!.update([{ userId: ANA, deviceId: "AD", createdTs: 1 }]);
    expect(sendToDevices).toHaveBeenCalledWith(CALL_KEYS_TYPE, [{ userId: ANA, deviceId: "AD" }], expect.objectContaining({ room_id: ROOM }));
    expect(c.keys!.keys()).toEqual([{ participant: "@me:x.org:D", index: 0, key: btoa(String.fromCharCode(...new Uint8Array(16).fill(7))) }]);
    expect(deps.changed).toHaveBeenCalled();
    await c.leave();
    c.keys!.receive({ userId: ANA, deviceId: "AD", content: { room_id: ROOM, media_key: { index: 0, key: KEY_A }, member: { claimed_device_id: "AD" } } });
    expect(c.keys!.keys()).toHaveLength(1);
  });

  it("makes keys from real randomness by default", async () => {
    const { call: c } = call(callApi(), { e2ee: { sendToDevices: vi.fn(async () => {}) } });
    await c.keys!.update([]);
    const [first] = c.keys!.keys();
    expect(atob(first!.key)).toHaveLength(16);
  });
});

describe("the newer membership (m.rtc.member)", () => {
  const MEMBER_ID = "00000000-0000-4000-8000-000000000000";
  /** rtcIdentity("@me:x.org", MEMBER_ID) */
  const HASHED = "BOLGDBSIKQ/l9bTRZpoXQimMRT8j1HxGCYwfPabNEec";
  const SFU = "wss://lk.x.org";

  it("writes the membership and its leave as matrix-js-sdk's sticky membership manager does", () => {
    expect(rtcMembershipContent({ userId: ME, deviceId: "D", memberId: "m1", focus: FOCUS, sfu: SFU, intent: "audio" })).toEqual({
      slot_id: "m.call#ROOM",
      application: { type: "m.call", "m.call.intent": "audio" },
      member: { user_id: ME, device_id: "D", id: "m1" },
      transports: { published: [{ type: "livekit", url: SFU }], can_subscribe: ["livekit"] },
      versions: [],
      msc4354_sticky_key: "m1",
    });
    expect(rtcMembershipContent({ userId: ME, deviceId: "D", memberId: "m1", focus: FOCUS, intent: "audio" }).transports).toEqual({ published: [{ type: "livekit", livekit_service_url: FOCUS }], can_subscribe: ["livekit"] });
    expect(rtcLeaveContent("m1")).toEqual({ slot_id: "m.call#ROOM", msc4354_sticky_key: "m1" });
    expect(uuid(new Uint8Array(16).fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  /** A call in the newer format; `seal` stands in for the room's encryption. */
  function rtcCall(options: { sfu?: string; delayed?: boolean } = {}) {
    const api = {
      ...callApi({ delayed: options.delayed }),
      liveKitToken: vi.fn(async (_s: MxSession, request: { sfu: string }) => ({ url: request.sfu, jwt: "hs-jwt" })),
      sendSticky: vi.fn(async (..._args: unknown[]) => "$r1"),
      sendDelayedSticky: vi.fn(async (..._args: unknown[]) => "delay-s"),
    };
    const seal = vi.fn(async (type: string, content: Record<string, unknown>) => ({ type: "m.room.encrypted", content: { sealed: type, ...content } }));
    const sendToDevices = vi.fn(async () => {});
    const made = call(api as unknown as ReturnType<typeof callApi>, { rtc: { ...(options.sfu ? { sfu: options.sfu } : {}), seal }, e2ee: { sendToDevices }, random: (n) => new Uint8Array(n) });
    return { ...made, api, seal, sendToDevices };
  }

  it("gets access from the homeserver for its LiveKit server, and joins under the hashed identity with a sticky membership", async () => {
    const { call: c, api, seal, deps, sendToDevices } = rtcCall({ sfu: SFU });
    expect([c.memberId, c.identity, c.sfu, c.sticky]).toEqual([MEMBER_ID, HASHED, SFU, true]);
    await c.join();
    expect(api.liveKitToken).toHaveBeenCalledWith(SESSION, { sfu: SFU, roomId: ROOM, slotId: "m.call#ROOM", memberId: MEMBER_ID, deviceId: "D" });
    expect(api.openIdToken).not.toHaveBeenCalled();
    expect(deps.allowHost).toHaveBeenCalledWith("lk.x.org");
    expect(c.grant).toEqual({ url: SFU, jwt: "hs-jwt" });
    // The leave is scheduled first, then the membership: both sealed, both sticky.
    expect(seal.mock.calls.map(([type, content]) => [type, content.transports === undefined ? "leave" : "join"])).toEqual([
      [RTC_MEMBER_TYPE, "leave"],
      [RTC_MEMBER_TYPE, "join"],
    ]);
    expect(api.sendDelayedSticky).toHaveBeenCalledWith(SESSION, ROOM, "m.room.encrypted", { sealed: RTC_MEMBER_TYPE, ...rtcLeaveContent(MEMBER_ID) }, DELAYED_LEAVE_MS, MEMBERSHIP_STICKY_MS);
    expect(api.sendSticky).toHaveBeenCalledWith(SESSION, ROOM, "m.room.encrypted", expect.objectContaining({ member: { user_id: ME, device_id: "D", id: MEMBER_ID } }), MEMBERSHIP_STICKY_MS);
    expect(api.sendState).not.toHaveBeenCalled();
    expect(c.membershipEventId).toBe("$r1");
    // Our keys go out naming our member id, and the view gets ours under the hashed identity.
    await c.keys!.update([{ userId: ANA, deviceId: "AD", createdTs: 1, identities: ["ana-hash"] }]);
    expect(sendToDevices).toHaveBeenCalledWith(CALL_KEYS_TYPE, [{ userId: ANA, deviceId: "AD" }], expect.objectContaining({ member_id: MEMBER_ID, member: { claimed_device_id: "D", id: MEMBER_ID } }));
    expect(c.keys!.keys().map((k) => k.participant)).toEqual([HASHED]);
    // The server's time of a sticky membership changes nothing: it is new with each sending.
    c.ownMembership(5);
    // Keep-alive, then leaving sends the scheduled leave now.
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    expect(api.updateDelayed).toHaveBeenCalledWith(SESSION, "delay-s", "restart");
    await c.leave();
    expect(api.updateDelayed).toHaveBeenLastCalledWith(SESSION, "delay-s", "send");
    expect(api.sendSticky).toHaveBeenCalledTimes(1);
  });

  it("joins through the service, as user:device, where the homeserver names no LiveKit server", async () => {
    const { call: c, api } = rtcCall();
    expect([c.identity, c.sfu]).toEqual(["@me:x.org:D", undefined]);
    await c.join();
    expect(api.liveKitGrant).toHaveBeenCalledWith(FOCUS, ROOM, "D", expect.objectContaining({ access_token: "oid" }));
    expect(api.liveKitToken).not.toHaveBeenCalled();
    expect(api.sendSticky.mock.calls[0]![3]).toMatchObject({ transports: { published: [{ type: "livekit", livekit_service_url: FOCUS }] } });
  });

  it("sends the leave itself without delayed events, and logs one it cannot send", async () => {
    const { call: c, api } = rtcCall({ sfu: SFU, delayed: false });
    await c.join();
    expect(api.sendDelayedSticky).not.toHaveBeenCalled();
    await c.leave();
    expect(api.sendSticky).toHaveBeenLastCalledWith(SESSION, ROOM, "m.room.encrypted", { sealed: RTC_MEMBER_TYPE, ...rtcLeaveContent(MEMBER_ID) }, MEMBERSHIP_STICKY_MS);

    const failing = rtcCall({ sfu: SFU, delayed: false });
    await failing.call.join();
    failing.seal.mockRejectedValueOnce(new Error("no room key"));
    await failing.call.leave();
    expect(failing.deps.log).toHaveBeenCalledWith("Call membership not removed: no room key");
  });

  it("carries on without a delayed leave it could not seal or schedule", async () => {
    const { call: c, api, seal, deps } = rtcCall({ sfu: SFU });
    seal.mockRejectedValueOnce(new Error("no room key"));
    await c.join();
    expect(deps.log).toHaveBeenCalledWith("Delayed leave not scheduled: no room key");
    expect(api.sendSticky).toHaveBeenCalledTimes(1);
  });

  it("sends the membership again before it stops being sticky, and after the server sent the leave", async () => {
    const { call: c, api } = rtcCall({ sfu: SFU, delayed: false });
    await c.join();
    await vi.advanceTimersByTimeAsync(MEMBERSHIP_STICKY_MS - RENEW_MARGIN_MS - 1);
    expect(api.sendSticky).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.sendSticky).toHaveBeenCalledTimes(2);
    expect(api.sendSticky.mock.calls[1]![3]).toEqual(api.sendSticky.mock.calls[0]![3]);
    // Counted from the new sending.
    await vi.advanceTimersByTimeAsync(MEMBERSHIP_STICKY_MS - RENEW_MARGIN_MS);
    expect(api.sendSticky).toHaveBeenCalledTimes(3);
    c.abandon();

    const gone = rtcCall({ sfu: SFU });
    await gone.call.join();
    gone.api.updateDelayed.mockRejectedValueOnce(new MatrixError(404, "M_NOT_FOUND", "gone"));
    await vi.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    expect(gone.api.sendDelayedSticky).toHaveBeenCalledTimes(2);
    expect(gone.api.sendSticky).toHaveBeenCalledTimes(2);
    gone.call.abandon();
  });

  it("reports a failed join for the homeserver's refusal", async () => {
    const { call: c, api } = rtcCall({ sfu: SFU });
    api.liveKitToken.mockRejectedValueOnce(new MatrixError(403, "M_FORBIDDEN", "not joined"));
    await expect(c.join()).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });
    expect(api.sendSticky).not.toHaveBeenCalled();
  });
});

describe("call keys under LiveKit identities", () => {
  it("gives each device's keys under every identity its membership has, and ours under ours", async () => {
    const { manager } = keys();
    const own2 = new CallKeys({ userId: ME, deviceId: "D", memberId: "m", identities: ["mine-hash", "@me:x.org:D"] }, ROOM, { send: vi.fn(async () => {}), changed: vi.fn(), log: vi.fn(), now: () => Date.now(), random: (n) => new Uint8Array(n).fill(1) });
    await own2.update([{ userId: ANA, deviceId: "AD", createdTs: 1, identities: ["ana-hash", "@ana:x.org:AD"] }]);
    own2.receive({ userId: ANA, deviceId: "AD", content: { room_id: ROOM, media_key: { index: 2, key: KEY_A }, member: { claimed_device_id: "AD", id: "uuid-a" } } });
    expect(own2.keys().map((k) => [k.participant, k.index])).toEqual([
      ["mine-hash", 0],
      ["@me:x.org:D", 0],
      ["ana-hash", 2],
      ["@ana:x.org:AD", 2],
    ]);
    // A new membership with other transports moves the keys to its identities.
    await own2.update([{ userId: ANA, deviceId: "AD", createdTs: 1, identities: ["ana-hash"] }]);
    expect(own2.keys().filter((k) => k.participant.startsWith("ana") || k.participant.startsWith("@ana")).map((k) => k.participant)).toEqual(["ana-hash"]);
    // A device whose transports name none gets none.
    await own2.update([{ userId: ANA, deviceId: "AD", createdTs: 1, identities: [] }]);
    expect(own2.keys()).toHaveLength(2);
    expect(manager.keys()).toEqual([]);
  });
});
