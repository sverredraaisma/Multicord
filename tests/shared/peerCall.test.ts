import { describe, expect, it } from "vitest";
import {
  iceServerHost,
  iceServers,
  isNativeAction,
  isMeshSignal,
  isVoiceSignal,
  MESH_SOURCES,
  meshSignal,
  MAX_CALL_PARTICIPANTS,
  MAX_CALL_SIGNALS,
  MAX_ICE_CANDIDATE,
  MAX_ICE_SERVERS,
  MAX_SDP,
  peerCall,
  voiceConnected,
  voiceSignal,
} from "../../src/shared/native";

const candidate = { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host", sdpMLineIndex: 0, sdpMid: "0" };

describe("voiceSignal", () => {
  it("keeps the forms simple-peer sends, with their known fields only", () => {
    expect(voiceSignal({ type: "offer", sdp: "v=0", extra: 1 })).toEqual({ type: "offer", sdp: "v=0" });
    expect(voiceSignal({ type: "answer", sdp: "v=0" })).toEqual({ type: "answer", sdp: "v=0" });
    expect(voiceSignal({ type: "candidate", candidate: { ...candidate, usernameFragment: "u" } })).toEqual({ type: "candidate", candidate });
    expect(voiceSignal({ type: "candidate", candidate: { candidate: "", sdpMLineIndex: null, sdpMid: null } })).toEqual({ type: "candidate", candidate: { candidate: "", sdpMLineIndex: null, sdpMid: null } });
    expect(voiceSignal({ type: "candidate", candidate: { candidate: "c" } })).toEqual({ type: "candidate", candidate: { candidate: "c" } });
    expect(voiceSignal({ type: "renegotiate", renegotiate: true })).toEqual({ type: "renegotiate", renegotiate: true });
    expect(voiceSignal({ type: "transceiverRequest", transceiverRequest: { kind: "video", init: { direction: "sendonly" } } })).toEqual({ type: "transceiverRequest", transceiverRequest: { kind: "video" } });
  });

  it("refuses anything else", () => {
    for (const value of [
      undefined,
      "offer",
      { type: "offer" },
      { type: "offer", sdp: "" },
      { type: "offer", sdp: "x".repeat(MAX_SDP + 1) },
      { type: "pranswer", sdp: "v=0" },
      { type: "candidate", candidate: "c" },
      { type: "candidate", candidate: { candidate: 5 } },
      { type: "candidate", candidate: { candidate: "x".repeat(MAX_ICE_CANDIDATE + 1) } },
      { type: "candidate", candidate: { candidate: "a\r\nb" } },
      { type: "candidate", candidate: { candidate: "c", sdpMLineIndex: 256 } },
      { type: "candidate", candidate: { candidate: "c", sdpMLineIndex: 1.5 } },
      { type: "candidate", candidate: { candidate: "c", sdpMid: "a b" } },
      { type: "renegotiate", renegotiate: 1 },
      { type: "transceiverRequest", transceiverRequest: { kind: "data" } },
      { type: "transceiverRequest" },
    ])
      expect(voiceSignal(value)).toBeUndefined();
    expect(voiceSignal({ type: "offer", sdp: "x".repeat(MAX_SDP) })).toBeDefined();
  });

  it("takes from the view only signals with nothing beyond their fields", () => {
    expect(isVoiceSignal({ type: "offer", sdp: "v=0" })).toBe(true);
    expect(isVoiceSignal({ type: "candidate", candidate })).toBe(true);
    expect(isVoiceSignal({ type: "renegotiate", renegotiate: true })).toBe(true);
    expect(isVoiceSignal({ type: "transceiverRequest", transceiverRequest: { kind: "audio" } })).toBe(true);
    for (const value of [
      { type: "offer", sdp: "v=0", extra: 1 },
      { type: "candidate", candidate, extra: 1 },
      { type: "candidate", candidate: { ...candidate, usernameFragment: "u" } },
      { type: "renegotiate", renegotiate: true, extra: 1 },
      { type: "transceiverRequest", transceiverRequest: { kind: "audio" }, extra: 1 },
      { type: "transceiverRequest", transceiverRequest: { kind: "audio", init: {} } },
      { type: "offer" },
      null,
    ])
      expect(isVoiceSignal(value)).toBe(false);
  });

  it("is an action only for a peer id and such a signal", () => {
    expect(isNativeAction({ type: "voiceSignal", to: "5", signal: { type: "renegotiate", renegotiate: true } })).toBe(true);
    expect(isNativeAction({ type: "voiceSignal", to: "a b", signal: { type: "renegotiate", renegotiate: true } })).toBe(false);
    expect(isNativeAction({ type: "voiceSignal", to: "5", signal: { type: "offer", sdp: "v=0", x: 1 } })).toBe(false);
  });
});

describe("ICE servers", () => {
  it("takes stun, turn and turns URLs on host names", () => {
    expect(iceServerHost("stun:stun.cloudflare.com:3478")).toBe("stun.cloudflare.com");
    expect(iceServerHost("turn:TURN.cloudflare.com:3478?transport=udp")).toBe("turn.cloudflare.com");
    expect(iceServerHost("turns:turn.cloudflare.com:5349?transport=tcp")).toBe("turn.cloudflare.com");
    expect(iceServerHost("turn:turn.example.org")).toBe("turn.example.org");
    for (const url of [5, "http://turn.example.org", "turn:localhost", "turn:192.0.2.1:3478", "turn:[::1]:3478", "turn:turn.example.org:0", "turn:turn.example.org:70000", "turn:turn.example.org?transport=sctp", "turn:user@turn.example.org"])
      expect(iceServerHost(url)).toBeUndefined();
  });

  it("keeps usable servers, their usable URLs and whole credentials", () => {
    expect(
      iceServers([
        { urls: ["stun:stun.cloudflare.com:3478", "turn:10.0.0.1:3478"], username: "u", credential: "c" },
        { urls: "turn:turn.cloudflare.com:3478", username: "u" },
        { urls: ["turn:10.0.0.1"] },
        "x",
        { urls: "turns:turn.cloudflare.com:443", username: "u", credential: "with space" },
      ]),
    ).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"], username: "u", credential: "c" }, { urls: ["turn:turn.cloudflare.com:3478"] }, { urls: ["turns:turn.cloudflare.com:443"] }]);
    expect(iceServers("x")).toEqual([]);
    expect(iceServers(Array.from({ length: MAX_ICE_SERVERS + 2 }, () => ({ urls: "turn:t.example.org" })))).toHaveLength(MAX_ICE_SERVERS);
    expect(iceServers([{ urls: Array.from({ length: MAX_ICE_SERVERS + 2 }, () => "turn:t.example.org") }])[0]!.urls).toHaveLength(MAX_ICE_SERVERS);
  });
});

describe("peerCall", () => {
  const call = {
    callId: "c1",
    self: "1",
    peers: [
      { id: "2", name: "Ana", offer: true, avatarUrl: "https://cdn.example.org/a.webp" },
      { id: "3", name: "Bo", avatarUrl: "http://x" },
    ],
    iceServers: [{ urls: "turn:turn.cloudflare.com:3478", username: "u", credential: "c" }],
    relayOnly: false,
    signals: [
      { seq: 1, from: "3", signal: { type: "offer", sdp: "v=0" } },
      { seq: 2, from: "9", signal: { type: "offer", sdp: "v=0" } },
      { seq: 3, from: "3", signal: { type: "nonsense" } },
      { seq: -1, from: "3", signal: { type: "renegotiate", renegotiate: true } },
    ],
  };

  it("keeps what the view may act on", () => {
    expect(peerCall(call)).toEqual({
      callId: "c1",
      self: "1",
      peers: [
        { id: "2", name: "Ana", offer: true, avatarUrl: "https://cdn.example.org/a.webp" },
        { id: "3", name: "Bo", offer: false },
      ],
      iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }],
      relayOnly: false,
      signals: [{ seq: 1, from: "3", signal: { type: "offer", sdp: "v=0" } }],
    });
  });

  it("relays only unless told otherwise, and drops the user, repeats and peers beyond the cap", () => {
    const many = Array.from({ length: MAX_CALL_PARTICIPANTS + 2 }, (_, i) => ({ id: String(i + 10), name: `P${i}` }));
    const result = peerCall({ callId: "c", self: "1", peers: [{ id: "1", name: "Me" }, { id: "10", name: "Dup" }, ...many, { id: "x y", name: "Bad" }], over: 3 })!;
    expect(result.relayOnly).toBe(true);
    expect(result.peers).toHaveLength(MAX_CALL_PARTICIPANTS - 1);
    expect(result.peers[0]).toEqual({ id: "10", name: "Dup", offer: false });
    expect(result.over).toBe(3);
    expect(result.iceServers).toEqual([]);
    expect(result.signals).toEqual([]);
    expect(peerCall({ callId: "c", self: "1" })).toEqual({ callId: "c", self: "1", peers: [], iceServers: [], relayOnly: true, signals: [] });
  });

  it("caps the signals", () => {
    const signals = Array.from({ length: MAX_CALL_SIGNALS + 5 }, (_, i) => ({ seq: i, from: "2", signal: { type: "renegotiate", renegotiate: true } }));
    expect(peerCall({ callId: "c", self: "1", peers: [{ id: "2", name: "Ana" }], signals })!.signals).toHaveLength(MAX_CALL_SIGNALS);
  });

  it("needs a call id and the user's id", () => {
    for (const value of [undefined, { self: "1" }, { callId: "a b", self: "1" }, { callId: "c" }, { callId: "c", self: "" }]) expect(peerCall(value)).toBeUndefined();
  });

  it("says when the user is in the call itself", () => {
    const voice = { channelId: "5", channelName: "Call", guildName: "", mute: false, deaf: false, video: false, stream: false };
    expect(voiceConnected(voice)).toBe(false);
    expect(voiceConnected({ ...voice, token: "t", url: "wss://lk.example.org" })).toBe(true);
    expect(voiceConnected({ ...voice, p2p: { callId: "c", self: "1", peers: [], iceServers: [], relayOnly: true, signals: [] } })).toBe(true);
  });
});

describe("meshSignal (Fluxer's peer-to-peer calls)", () => {
  const sid = "TR_b7f3c2a94e1d4c0f_microphone";
  const c = { candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "a1B+/" };

  it("keeps the forms Fluxer's own client sends, with their known fields only", () => {
    expect(meshSignal({ t: "offer", g: 1760000000000, sdp: "v=0", type: "offer" })).toEqual({ t: "offer", g: 1760000000000, sdp: "v=0" });
    expect(meshSignal({ t: "answer", g: 0, sdp: "v=0" })).toEqual({ t: "answer", g: 0, sdp: "v=0" });
    expect(meshSignal({ t: "ice", g: 3, c: { ...c, extra: 1 } })).toEqual({ t: "ice", g: 3, c });
    expect(meshSignal({ t: "ice", g: 3, c: { candidate: "c", usernameFragment: null } })).toEqual({ t: "ice", g: 3, c: { candidate: "c", usernameFragment: null } });
    expect(meshSignal({ t: "ice", g: 3, c: { candidate: "c" } })).toEqual({ t: "ice", g: 3, c: { candidate: "c" } });
    expect(meshSignal({ t: "ice", g: 3, c: null })).toEqual({ t: "ice", g: 3, c: null });
    expect(meshSignal({ t: "need-offer", g: 0 })).toEqual({ t: "need-offer", g: 0 });
    expect(meshSignal({ t: "need-offer", g: 4, restart: true })).toEqual({ t: "need-offer", g: 4, restart: true });
    expect(meshSignal({ t: "tracks", v: 9, tracks: [{ src: "microphone", sid, m: false, x: 1 }, { src: "camera", sid: "TR_x_camera", m: true, w: 1280, h: 720 }] })).toEqual({
      t: "tracks",
      v: 9,
      tracks: [
        { src: "microphone", sid, m: false },
        { src: "camera", sid: "TR_x_camera", m: true, w: 1280, h: 720 },
      ],
    });
    expect(meshSignal({ t: "tracks", v: 9, tracks: [] })).toEqual({ t: "tracks", v: 9, tracks: [] });
    expect(meshSignal({ t: "want", v: 10, sids: [sid] })).toEqual({ t: "want", v: 10, sids: [sid] });
  });

  it("refuses anything else", () => {
    const five = MESH_SOURCES.map((src) => ({ src, sid: `TR_x_${src}`, m: false }));
    for (const value of [
      undefined,
      { type: "offer", sdp: "v=0" },
      { t: "offer", sdp: "v=0" },
      { t: "offer", g: -1, sdp: "v=0" },
      { t: "offer", g: 1.5, sdp: "v=0" },
      { t: "offer", g: 1, sdp: "" },
      { t: "answer", g: 1, sdp: "x".repeat(MAX_SDP + 1) },
      { t: "ice", g: 1 },
      { t: "ice", g: 1, c: "c" },
      { t: "ice", g: 1, c: { candidate: "c", usernameFragment: "a b" } },
      { t: "ice", g: 1, c: { candidate: "c", usernameFragment: 5 } },
      { t: "ice", g: 1, c: { candidate: "a\nb" } },
      { t: "ice", c: null },
      { t: "need-offer" },
      { t: "need-offer", g: 1, restart: false },
      { t: "tracks", v: 1 },
      { t: "tracks", v: 1, tracks: [...five, five[0]] },
      { t: "tracks", v: 1, tracks: [five[0], five[0]] },
      { t: "tracks", v: 1, tracks: [{ src: "data", sid: "s", m: false }] },
      { t: "tracks", v: 1, tracks: [{ src: "camera", sid: "a b", m: false }] },
      { t: "tracks", v: 1, tracks: [{ src: "camera", sid: "s", m: "no" }] },
      { t: "tracks", v: 1, tracks: [{ src: "camera", sid: "s", m: false, w: -1 }] },
      { t: "tracks", v: 1, tracks: [{ src: "camera", sid: "s", m: false, h: 70000 }] },
      { t: "tracks", v: "1", tracks: [] },
      { t: "want", v: 1 },
      { t: "want", v: 1, sids: [1] },
      { t: "want", v: 1, sids: ["a", "b", "c", "d", "e"] },
      { t: "want", sids: [] },
      { t: "bye" },
    ]) {
      expect(meshSignal(value)).toBeUndefined();
      expect(isMeshSignal(value)).toBe(false);
    }
  });

  it("takes from the view only signals with nothing beyond their fields", () => {
    for (const value of [
      { t: "offer", g: 1, sdp: "v=0" },
      { t: "ice", g: 1, c },
      { t: "ice", g: 1, c: null },
      { t: "need-offer", g: 1, restart: true },
      { t: "tracks", v: 1, tracks: [{ src: "microphone", sid, m: true, w: 0, h: 0 }] },
      { t: "want", v: 1, sids: [] },
    ]) {
      expect(isMeshSignal(value)).toBe(true);
      expect(isNativeAction({ type: "voiceSignal", to: "b7f3c2a94e1d4c0f", signal: value })).toBe(true);
    }
    for (const value of [
      { t: "offer", g: 1, sdp: "v=0", x: 1 },
      { t: "ice", g: 1, c: { ...c, x: 1 } },
      { t: "need-offer", g: 1, x: 1 },
      { t: "tracks", v: 1, tracks: [{ src: "microphone", sid, m: true, x: 1 }] },
      { t: "want", v: 1, sids: [], x: 1 },
    ]) {
      expect(isMeshSignal(value)).toBe(false);
      expect(isNativeAction({ type: "voiceSignal", to: "b7f3c2a94e1d4c0f", signal: value })).toBe(false);
    }
    // A simple-peer signal is no mesh signal, nor the other way round.
    expect(isMeshSignal({ type: "offer", sdp: "v=0" })).toBe(false);
    expect(isVoiceSignal({ t: "offer", g: 1, sdp: "v=0" })).toBe(false);
  });

  it("is what a fluxer-mesh call carries, with each peer's server mute", () => {
    const result = peerCall({
      callId: "c1",
      self: "a1",
      protocol: "fluxer-mesh",
      peers: [
        { id: "b2", name: "Ana", offer: true, muted: true },
        { id: "c3", name: "Bo", muted: "yes" },
      ],
      signals: [
        { seq: 1, from: "b2", signal: { t: "need-offer", g: 0 } },
        { seq: 2, from: "b2", signal: { type: "offer", sdp: "v=0" } },
      ],
    })!;
    expect(result).toEqual({
      callId: "c1",
      self: "a1",
      protocol: "fluxer-mesh",
      peers: [
        { id: "b2", name: "Ana", offer: true, muted: true },
        { id: "c3", name: "Bo", offer: false },
      ],
      iceServers: [],
      relayOnly: true,
      signals: [{ seq: 1, from: "b2", signal: { t: "need-offer", g: 0 } }],
    });
    // Without the protocol, mesh signals are not simple-peer's.
    expect(peerCall({ callId: "c1", self: "a1", protocol: "other", peers: [{ id: "b2", name: "Ana" }], signals: [{ seq: 1, from: "b2", signal: { t: "need-offer", g: 0 } }] })).toEqual({
      callId: "c1",
      self: "a1",
      peers: [{ id: "b2", name: "Ana", offer: false }],
      iceServers: [],
      relayOnly: true,
      signals: [],
    });
  });
});
