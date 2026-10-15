// One call in one MatrixRTC format between the signed-in scratch Multicord
// (its real native call view, driven over DevTools) and "Element"
// (matrix-js-sdk's MatrixRTC here in Node, livekit-client with E2EE in the
// Element Electron). Phases, each adding rows to the result table:
//   audio     both publish their microphone, encrypted; each hears the other's tone
//   video     both turn the camera on; encrypted, and frames keep arriving both ways
//   rotation  a third device joins (both rotate their key), then leaves (both rotate
//             again); the tones still get through after each
//   negative  Element sends with a key it never shared and holds a wrong key for
//             Multicord: silence both ways, and decrypt errors
import { ClientEvent, createClient, EventType, Preset, SyncState } from "matrix-js-sdk";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/index.js";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

/** Tones each side's fake microphone plays. */
export const MULTICORD_HZ = 440;
export const ELEMENT_HZ = 880;
/** Heard: louder than this (the tones arrive around -35 dBFS). */
const HEARD_DB = -50;
/** Silent: quieter than this, or no signal at all. */
const SILENT_DB = -70;
/** The analysers' bins are about 6 Hz wide. */
const HZ_TOLERANCE = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(check, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** Registers a user with Synapse's shared-secret admin API. */
export async function register(hs, sharedSecret, user, password) {
  const url = `${hs}/_synapse/admin/v1/register`;
  const { nonce } = await (await fetch(url)).json();
  const mac = createHmac("sha1", sharedSecret).update(`${nonce}\0${user}\0${password}\0notadmin`).digest("hex");
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, username: user, password, admin: false, mac }) });
  if (!r.ok) throw new Error(`register ${user}: ${r.status} ${await r.text()}`);
  return (await r.json()).user_id;
}

const b64url = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** LiveKit's RoomService (Twirp JSON), with an admin token for one room. */
async function roomService(ctx, method, body, room) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ iss: ctx.lkKey, sub: "mc-media-check", nbf: now - 5, exp: now + 300, video: { roomAdmin: true, room, roomList: true } })}`;
  const token = `${unsigned}.${createHmac("sha256", ctx.lkSecret).update(unsigned).digest("base64url")}`;
  const r = await fetch(`${ctx.livekitHttp}/twirp/livekit.RoomService/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`LiveKit ${method}: ${r.status} ${await r.text()}`);
  return r.json();
}

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

/** What Multicord's call view hears (each remote <audio>) and shows (each <video>). */
const MULTICORD_MEDIA = `(async () => {
  const ctx = (window.__mcMediaCheck ??= new AudioContext());
  await ctx.resume();
  const audio = [];
  for (const a of document.querySelectorAll(".voice-speakers audio")) {
    if (!a.srcObject) continue;
    const src = ctx.createMediaStreamSource(a.srcObject);
    const an = ctx.createAnalyser(); an.fftSize = 8192; src.connect(an);
    const t = new Float32Array(an.fftSize), f = new Float32Array(an.frequencyBinCount);
    let sum = 0, n = 0; const peaks = {};
    for (let i = 0; i < 20; i++) {
      an.getFloatTimeDomainData(t); for (const v of t) sum += v * v; n += t.length;
      an.getFloatFrequencyData(f); let best = 1; for (let b = 1; b < f.length; b++) if (f[b] > f[best]) best = b;
      const hz = Math.round(best * ctx.sampleRate / an.fftSize); peaks[hz] = (peaks[hz] ?? 0) + 1;
      await new Promise((r) => setTimeout(r, 50));
    }
    src.disconnect();
    const rms = Math.sqrt(sum / n);
    audio.push({ rmsDb: rms > 0 ? Math.round(200 * Math.log10(rms)) / 10 : null, peakHz: Number(Object.entries(peaks).sort((x, y) => y[1] - x[1])[0][0]) });
  }
  const videos = [...document.querySelectorAll(".voice-stage video")].map((v) => ({ local: Boolean(v.closest(".video-tile")?.classList.contains("local")), width: v.videoWidth, height: v.videoHeight, frames: v.getVideoPlaybackQuality().totalVideoFrames }));
  return { audio, videos };
})()`;

/** The call stage's layout and each video's state, for failure reports. */
const VIEW_LAYOUT = `(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(","); };
  const stage = document.querySelector(".voice-stage");
  return {
    window: innerWidth + "x" + innerHeight, visibility: document.visibilityState,
    stage: stage ? { hidden: stage.hidden, rect: r(stage), scrollTop: stage.scrollTop, clientHeight: stage.clientHeight, scrollHeight: stage.scrollHeight } : null,
    videos: [...document.querySelectorAll(".voice-stage video")].map((v) => {
      const t = v.srcObject?.getVideoTracks?.()[0];
      return { local: Boolean(v.closest(".video-tile")?.classList.contains("local")), rect: r(v), readyState: v.readyState, paused: v.paused, track: t ? t.readyState + (t.muted ? ",muted" : "") + (t.enabled ? "" : ",disabled") : "none" };
    }),
  };
})()`;

/**
 * Keeps each RTCPeerConnection the page makes from now on (window.__mcPCs), so
 * the video's WebRTC statistics can be read when a check fails. Idempotent.
 */
const PC_HOOK = `(() => {
  if (window.__mcPCs) return true;
  window.__mcPCs = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) { const pc = new Native(...args); window.__mcPCs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = Native.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Native);
  return true;
})()`;

/**
 * Video statistics of the open peer connections (inbound: is the SFU sending,
 * does it decode; outbound: does the camera encode and send), the local
 * camera track, the video inputs and any banner, for failure reports.
 */
const VIDEO_DIAG = `(async () => {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  const pcs = (window.__mcPCs ?? []).filter((pc) => pc.connectionState !== "closed");
  const rtc = [];
  for (const pc of pcs) {
    const stats = await pc.getStats();
    stats.forEach((s) => {
      if (s.kind !== "video") return;
      if (s.type === "inbound-rtp") rtc.push({ in: pick(s, ["packetsReceived", "bytesReceived", "framesReceived", "framesDecoded", "keyFramesDecoded", "framesDropped", "frameWidth", "frameHeight", "pliCount", "firCount", "nackCount", "packetsLost", "decoderImplementation"]) });
      if (s.type === "outbound-rtp") rtc.push({ out: pick(s, ["rid", "active", "bytesSent", "framesEncoded", "framesSent", "keyFramesEncoded", "frameWidth", "frameHeight", "qualityLimitationReason", "pliCount", "encoderImplementation"]) });
      if (s.type === "media-source") rtc.push({ source: pick(s, ["width", "height", "frames", "framesPerSecond"]) });
    });
    for (const t of pc.getTransceivers()) if (t.receiver.track?.kind === "video" || t.sender.track?.kind === "video")
      rtc.push({ transceiver: t.mid + " " + t.currentDirection + " recv:" + (t.receiver.track ? t.receiver.track.readyState + (t.receiver.track.muted ? ",muted" : "") : "-") + " send:" + (t.sender.track ? t.sender.track.readyState + (t.sender.track.muted ? ",muted" : "") + (t.sender.track.enabled ? "" : ",disabled") : "-") });
  }
  const tracks = [...document.querySelectorAll(".voice-stage video")].map((v) => {
    const t = v.srcObject?.getVideoTracks?.()[0];
    const s = t?.getSettings?.() ?? {};
    return { local: Boolean(v.closest(".video-tile")?.classList.contains("local")), size: v.clientWidth + "x" + v.clientHeight, video: v.videoWidth + "x" + v.videoHeight, frames: v.getVideoPlaybackQuality().totalVideoFrames, paused: v.paused, track: t ? { label: t.label, readyState: t.readyState, muted: t.muted, enabled: t.enabled, settings: pick(s, ["deviceId", "width", "height", "frameRate"]) } : null };
  });
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput").map((d) => d.label || d.deviceId.slice(0, 8));
  const banner = document.querySelector(".banner")?.textContent || "";
  const voice = document.querySelector(".voice-panel")?.innerText.replace(/\\s+/g, " ").slice(0, 200) || "";
  return { pcs: pcs.length, rtc, tracks, devices, banner, voice, visibility: document.visibilityState, focus: document.hasFocus(), window: innerWidth + "x" + innerHeight };
})()`;

const heard = (h, hz) => h && h.rmsDb !== null && h.rmsDb > HEARD_DB && Math.abs(h.peakHz - hz) <= HZ_TOLERANCE;
const silent = (h) => Boolean(h) && (h.rmsDb === null || h.rmsDb < SILENT_DB);
const fmt = (h) => (h ? `${h.rmsDb ?? "-inf"} dBFS @ ${h.peakHz} Hz` : "no track");
const loudest = (list) => [...list].sort((a, b) => (b.rmsDb ?? -999) - (a.rmsDb ?? -999))[0];

/**
 * @param {object} ctx  hs, focus, livekitHttp, livekitWs, lkInternal, lkPublic, focusPublic,
 *   sharedSecret, lkKey, lkSecret, serverName, mcUser, mcPassword, mc(expr), el(expr), out(line),
 *   captureCrashes() (per side, how often its log says Chromium's video capture service crashed)
 * @param {"legacy" | "sticky"} format
 * @param {(phase: string, name: string, ok: boolean, detail: string) => void} check
 */
export async function runFormat(ctx, format, check) {
  const { mc, el, out } = ctx;
  const sticky = format === "sticky";
  const run = `${format}-${Date.now().toString(36)}`;
  const password = `pw-${randomBytes(9).toString("base64url")}`;
  const roomName = `Media ${run}`;
  const cleanups = [];

  try {
    // A fresh media page (a new LiveKit Room) for this call.
    await el(`setTimeout(() => location.reload(), 10), 1`);
    await sleep(1000);
    await until(() => el(`document.title === "element-ready"`), "Element's media page");

    // Element: matrix-js-sdk with Rust crypto.
    const bobName = `el-${run}`;
    await register(ctx.hs, ctx.sharedSecret, bobName, password);
    const bob = await signedInClient(ctx, bobName, password);
    cleanups.push(() => bob.stopClient());
    const bobLogin = { userId: bob.getUserId(), deviceId: bob.getDeviceId(), accessToken: bob.getAccessToken() };

    const mcId = `@${ctx.mcUser}:${ctx.serverName}`;
    const { room_id: room } = await bob.createRoom({
      name: roomName,
      preset: Preset.PrivateChat,
      invite: [mcId],
      initial_state: [{ type: EventType.RoomEncryption, state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
      power_level_content_override: { events: { "org.matrix.msc3401.call.member": 0 } },
    });
    // Multicord's user joins from a throwaway device of its own, logged out again.
    await joinAs(ctx, ctx.mcUser, ctx.mcPassword, room);
    await until(async () => bob.getRoom(room)?.getJoinedMemberCount() === 2, "Multicord's user to join the room");
    out(`  room ${room}`);

    // Element's call session; its media keys go to the page as they come.
    const rtc = bob.matrixRTC.getRoomSession(bob.getRoom(room));
    const keys = [];
    let pageJoined = false;
    const pushKey = async (identity, index, b64) => {
      keys.push({ identity, index, key: b64 });
      if (pageJoined) await el(`el.setKey(${JSON.stringify(identity)}, ${index}, ${JSON.stringify(b64)})`);
    };
    rtc.on(MatrixRTCSessionEvent.EncryptionKeyChanged, (key, index, _membership, identity) =>
      void pushKey(identity, index, Buffer.from(key).toString("base64")).catch((e) => out(`  setKey failed: ${e.message}`)));
    const latest = (identity) => keys.filter((k) => k.identity === identity).at(-1)?.index ?? -1;
    const transports = sticky ? [{ type: "livekit", url: ctx.lkPublic }] : [{ type: "livekit", livekit_service_url: ctx.focusPublic, livekit_alias: room }];

    const elementJoin = async () => {
      const memberId = sticky ? randomUUID() : `${bobLogin.userId}:${bobLogin.deviceId}`;
      rtc.join({ userId: bobLogin.userId, deviceId: bobLogin.deviceId, memberId }, transports,
        sticky ? { manageMediaKeys: true, unstableSendStickyEvents: true, callIntent: "video" } : { manageMediaKeys: true });
      cleanups.push(() => rtc.leave(3000));
      const jwt = sticky ? await stickyToken(ctx, bobLogin.accessToken, room, memberId) : await legacyToken(ctx, bob, room);
      pageJoined = true;
      for (const k of keys) await el(`el.setKey(${JSON.stringify(k.identity)}, ${k.index}, ${JSON.stringify(k.key)})`);
      const identity = await el(`el.join(${JSON.stringify(ctx.livekitWs)}, ${JSON.stringify(jwt)})`);
      cleanups.push(() => el(`el.leave()`));
      return { identity, lkRoom: claims(jwt).video.room };
    };

    const multicordJoin = async () => {
      await mc(PC_HOOK);
      await mc(`(() => { document.querySelector(".voice-panel button.leave")?.click(); return true; })()`);
      await until(() => mc(`(() => { const b = [...document.querySelectorAll(".sidebar button.channel:not(.voice)")].find((b) => b.textContent.includes(${JSON.stringify(roomName)})); b?.click(); return Boolean(b); })()`), "the room in Multicord's sidebar", 60_000);
      // A call in progress is listed by room name; a room without one offers "Start a call in".
      const entry = sticky ? roomName : `Start a call in ${roomName}`;
      await until(() => mc(`(() => { const b = [...document.querySelectorAll(".sidebar button.channel.voice")].find((b) => b.textContent.includes(${JSON.stringify(entry)})); b?.click(); return Boolean(b); })()`), `"${entry}" in Multicord's sidebar`, 60_000);
      cleanups.push(() => mc(`(() => { document.querySelector(".voice-panel button.leave")?.click(); return true; })()`));
      await until(async () => (await mc(`document.querySelector(".voice-status")?.textContent`)) === "Voice connected", "Multicord's call to connect", 60_000).catch(async (e) => {
        throw new Error(`${e.message}; the view shows: ${String(await mc(`document.body.innerText.slice(0, 400)`)).replace(/\s+/g, " ")}`);
      });
    };

    // In the sticky format Element starts the call, so Multicord joins in Element's format.
    let lk;
    if (sticky) {
      lk = await elementJoin();
      await multicordJoin();
    } else {
      await multicordJoin();
      lk = await elementJoin();
    }
    out(`  both in the call (LiveKit room ${lk.lkRoom})`);

    const participants = () => roomService(ctx, "ListParticipants", { room: lk.lkRoom }, lk.lkRoom).then((r) => r.participants ?? []);
    const tracksOf = (p, source) => (p.tracks ?? []).filter((t) => t.source === source);
    const describe = (list, source) => list.map((p) => `${p.identity.slice(0, 10)}…: ${tracksOf(p, source).map((t) => `${t.encryption ?? "NONE"}${t.muted ? " muted" : ""}`).join(",") || "none"}`).join("; ");
    const encryptedBoth = (list, source) => list.length === 2 && list.every((p) => tracksOf(p, source).some((t) => t.encryption === "GCM" && !t.muted));

    // --- audio ---
    const withMic = await until(async () => {
      const list = await participants();
      return list.length === 2 && list.every((p) => tracksOf(p, "MICROPHONE").length > 0) ? list : undefined;
    }, "both to publish a microphone on LiveKit", 30_000).catch(async () => participants());
    check("audio", "LiveKit: both publish MICROPHONE, GCM", encryptedBoth(withMic, "MICROPHONE"), describe(withMic, "MICROPHONE"));
    const mcIdentity = withMic.find((p) => p.identity !== lk.identity)?.identity ?? "";
    // Legacy memberships use "@user:server:DEVICE" as the LiveKit identity; sticky ones a hash.
    check("audio", `Multicord joined in the ${format} format`, sticky ? !mcIdentity.startsWith("@") : mcIdentity.startsWith("@"), `LiveKit identity ${mcIdentity.slice(0, 24)}`);

    const listen = async (phase) => {
      await sleep(2500);
      const elementHears = await until(async () => {
        const h = await el(`el.hear()`);
        return h[mcIdentity] ? h : undefined;
      }, "Element's page to receive Multicord's audio", 20_000).catch(() => ({}));
      const multicord = await mc(MULTICORD_MEDIA);
      const e = elementHears[mcIdentity];
      const m = loudest(multicord.audio);
      check(phase, `Element hears Multicord (${MULTICORD_HZ} Hz)`, Boolean(heard(e, MULTICORD_HZ)), fmt(e));
      check(phase, `Multicord hears Element (${ELEMENT_HZ} Hz)`, Boolean(heard(m, ELEMENT_HZ)), fmt(m));
    };
    await listen("audio");

    // --- video ---
    // Failure details: a crash of Chromium's video capture service since the
    // cameras went on (it ends that side's camera), and what both sides see.
    const crashesBefore = ctx.captureCrashes();
    const why = async () => {
      const now = ctx.captureCrashes();
      const crashed = ["multicord", "element"].filter((side) => now[side] > crashesBefore[side]);
      const note = crashed.length ? `; Chromium's video capture service crashed in the scratch ${crashed.join(" and ")} (a test-device fault, see README)` : "";
      return `${note}; Multicord ${JSON.stringify(await mc(VIDEO_DIAG))}; Element ${JSON.stringify(await el(`el.diag()`))}`;
    };
    await el(`el.camera(true)`);
    await mc(`(() => { const b = [...document.querySelectorAll(".voice-controls button")].find((b) => b.textContent === "Camera"); b?.click(); return Boolean(b); })()`);
    const withCamera = await until(async () => {
      const list = await participants();
      return encryptedBoth(list, "CAMERA") ? list : undefined;
    }, "both cameras on LiveKit", 30_000).catch(async () => participants());
    const camerasOk = encryptedBoth(withCamera, "CAMERA");
    check("video", "LiveKit: both publish CAMERA, GCM, unmuted", camerasOk, `${describe(withCamera, "CAMERA")}${camerasOk ? "" : await why()}`);
    await sleep(3000);
    const frames = async () => ({
      element: (await el(`el.videos()`)).find((v) => v.identity === mcIdentity)?.frames ?? 0,
      multicord: (await mc(MULTICORD_MEDIA)).videos.find((v) => !v.local)?.frames ?? 0,
    });
    const first = await frames();
    const second = await until(async () => {
      const now = await frames();
      return now.element > first.element && now.multicord > first.multicord ? now : undefined;
    }, "frames both ways", 15_000).catch(() => frames());
    check("video", "Element decodes Multicord's video", second.element > first.element, `frames ${first.element} -> ${second.element}${second.element > first.element ? "" : await why()}`);
    let diagnosis = "";
    if (!(second.multicord > first.multicord)) {
      // Where the remote tile is and what its track does; then whether scrolling it into view helps (adaptiveStream).
      const layout = await mc(VIEW_LAYOUT);
      const before = await why();
      await mc(`(() => { const v = [...document.querySelectorAll(".voice-stage video")].find((v) => !v.closest(".video-tile")?.classList.contains("local")); v?.scrollIntoView(); return Boolean(v); })()`);
      await sleep(5000);
      const scrolled = await frames();
      diagnosis = `${before}; view ${JSON.stringify(layout)}; after scrolling the remote tile into view: frames ${second.multicord} -> ${scrolled.multicord}`;
    }
    check("video", "Multicord decodes Element's video", second.multicord > first.multicord, `frames ${first.multicord} -> ${second.multicord}${diagnosis}`);
    await listen("video");

    // --- rotation: a third device joins, then leaves ---
    const carolName = `carol-${run}`;
    await register(ctx.hs, ctx.sharedSecret, carolName, password);
    const carol = await signedInClient(ctx, carolName, password);
    cleanups.push(() => carol.stopClient());
    await bob.invite(room, carol.getUserId());
    await carol.joinRoom(room);
    await until(async () => carol.getRoom(room) && (await carol.getCrypto().isEncryptionEnabledInRoom(room)), "the third device's room to be encrypted");
    // Both current keys older than MatrixRTC's grace period, so a joiner causes new ones.
    await sleep(12_000);
    const carolRtc = carol.matrixRTC.getRoomSession(carol.getRoom(room));
    const before = { element: latest(lk.identity), multicord: latest(mcIdentity) };
    const carolMember = sticky ? randomUUID() : `${carol.getUserId()}:${carol.getDeviceId()}`;
    carolRtc.join({ userId: carol.getUserId(), deviceId: carol.getDeviceId(), memberId: carolMember }, transports,
      sticky ? { manageMediaKeys: true, unstableSendStickyEvents: true } : { manageMediaKeys: true });
    cleanups.push(() => carolRtc.leave(3000));
    const rotated = (from) => latest(lk.identity) > from.element && latest(mcIdentity) > from.multicord;
    const afterJoin = await until(async () => (rotated(before) ? { element: latest(lk.identity), multicord: latest(mcIdentity) } : undefined), "both to rotate their key", 60_000).catch(() => undefined);
    check("rotation", "Both rotate when a device joins", Boolean(afterJoin), `key index Element ${before.element} -> ${latest(lk.identity)}, Multicord ${before.multicord} -> ${latest(mcIdentity)}`);
    await sleep(3000);
    await listen("rotation (join)");
    if (afterJoin) {
      await carolRtc.leave(3000);
      carol.stopClient();
      const afterLeave = await until(async () => rotated(afterJoin), "both to rotate again", 60_000).catch(() => false);
      check("rotation", "Both rotate when it leaves", afterLeave, `key index Element ${afterJoin.element} -> ${latest(lk.identity)}, Multicord ${afterJoin.multicord} -> ${latest(mcIdentity)}`);
      await sleep(3000);
      await listen("rotation (leave)");
    }

    // --- negative control: wrong keys ---
    const own = keys.filter((k) => k.identity === lk.identity).at(-1);
    const theirs = keys.filter((k) => k.identity === mcIdentity).at(-1);
    const errorsBefore = (await el(`el.errors()`)).count;
    const bogus = () => randomBytes(16).toString("base64");
    // Element sends under a key index Multicord never got, and decrypts Multicord with a wrong key.
    await el(`el.setKey(${JSON.stringify(lk.identity)}, ${((own?.index ?? 0) + 1) % 256}, ${JSON.stringify(bogus())})`);
    await el(`el.setKey(${JSON.stringify(mcIdentity)}, ${theirs?.index ?? 0}, ${JSON.stringify(bogus())})`);
    await sleep(2500);
    const e = (await el(`el.hear()`))[mcIdentity];
    const m = loudest((await mc(MULTICORD_MEDIA)).audio);
    const errorsAfter = await el(`el.errors()`);
    check("negative", "Element hears silence from Multicord", silent(e), fmt(e));
    check("negative", "Multicord hears silence from Element", silent(m), fmt(m));
    check("negative", "Element reports decrypt errors", errorsAfter.count > errorsBefore, `${errorsBefore} -> ${errorsAfter.count}${errorsAfter.first[0] ? ` (${errorsAfter.first.at(-1)})` : ""}`);
  } finally {
    for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => undefined);
  }
}

async function signedInClient(ctx, user, password) {
  const login = await createClient({ baseUrl: ctx.hs }).loginRequest({ type: "m.login.password", identifier: { type: "m.id.user", user }, password });
  const client = createClient({ baseUrl: ctx.hs, userId: login.user_id, deviceId: login.device_id, accessToken: login.access_token });
  await client.initRustCrypto({ useIndexedDB: false });
  const prepared = new Promise((resolve) => client.on(ClientEvent.Sync, (s) => s === SyncState.Prepared && resolve()));
  await client.startClient({ initialSyncLimit: 5 });
  await prepared;
  return client;
}

/** Joins a room as a user from a throwaway device (logged out again). */
async function joinAs(ctx, user, password, room) {
  const r = await fetch(`${ctx.hs}/_matrix/client/v3/login`, { method: "POST", body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user }, password }) });
  if (!r.ok) throw new Error(`login ${user}: ${r.status} ${await r.text()}`);
  const { access_token: token } = await r.json();
  const call = async (path) => {
    const res = await fetch(`${ctx.hs}/_matrix/client/v3${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  };
  await call(`/join/${encodeURIComponent(room)}`);
  await call("/logout");
}

/** Legacy format: an OpenID token to lk-jwt-service's /sfu/get. */
async function legacyToken(ctx, client, room) {
  const openid = await client.getOpenIdToken();
  const r = await fetch(`${ctx.focus}/sfu/get`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room, openid_token: openid, device_id: client.getDeviceId() }) });
  if (!r.ok) throw new Error(`sfu/get: ${r.status} ${await r.text()}`);
  return (await r.json()).jwt;
}

/** Sticky format: the homeserver's own grant (MSC4195), for this membership. */
async function stickyToken(ctx, accessToken, room, memberId) {
  const r = await fetch(`${ctx.hs}/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: ctx.lkInternal, room_id: room, slot_id: "m.call#ROOM", member_id: memberId }),
  });
  if (!r.ok) throw new Error(`get_token: ${r.status} ${await r.text()}`);
  return (await r.json()).jwt;
}
