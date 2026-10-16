// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserPeerEnv, METER_MS, NO_RELAY, PeerCall, SPEAKING_LEVEL, type LevelMeter, type MicProcessor, type PeerCallEnv } from "../../src/renderer/peerCall";
import { DEFAULT_SETTINGS, type VoiceSettings } from "../../src/shared/settings";
import type { NativeCallPeer, NativeCallSignal, NativeVoiceSession, VoiceNoticeFlag, VoiceSignal } from "../../src/shared/native";

let nextId = 0;

// happy-dom takes only its own MediaStream as a source; the fakes stand in for real ones here.
Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
  configurable: true,
  get(this: { fakeSource?: unknown }) {
    return this.fakeSource;
  },
  set(this: { fakeSource?: unknown }, value: unknown) {
    this.fakeSource = value;
  },
});

class FakeTrack extends EventTarget {
  readonly id = `t${++nextId}`;
  enabled = true;
  readonly stop = vi.fn();
  constructor(readonly kind: "audio" | "video") {
    super();
  }
}

class FakeStream extends EventTarget {
  readonly id = `s${++nextId}`;
  constructor(readonly tracks: FakeTrack[]) {
    super();
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

interface FakeSender {
  track: FakeTrack | null;
  replaceTrack: ReturnType<typeof vi.fn>;
}

class FakePC {
  static all: FakePC[] = [];
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: FakeTrack; streams: FakeStream[] }) => void) | null = null;
  ondatachannel: ((event: { channel: unknown }) => void) | null = null;
  signalingState = "stable";
  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  readonly transceivers: { mid: string | null; sender: FakeSender; kind: string }[] = [];
  readonly channels: { label: string; close: ReturnType<typeof vi.fn> }[] = [];
  readonly removed: FakeSender[] = [];
  readonly candidates: unknown[] = [];
  readonly close = vi.fn();
  offers = 0;
  fail: "offer" | "remote" | "transceiver" | "noLocal" | undefined;
  constructor(readonly config: RTCConfiguration) {
    FakePC.all.push(this);
  }
  createDataChannel(label: string) {
    const channel = { label, close: vi.fn() };
    this.channels.push(channel);
    return channel;
  }
  addTrack(track: FakeTrack) {
    const sender: FakeSender = {
      track,
      replaceTrack: vi.fn(async (next: FakeTrack) => {
        sender.track = next;
      }),
    };
    this.transceivers.push({ mid: null, sender, kind: track.kind });
    return sender;
  }
  removeTrack(sender: FakeSender) {
    this.removed.push(sender);
    sender.track = null;
  }
  addTransceiver(kind: string) {
    if (this.fail === "transceiver") throw new Error("no");
    this.transceivers.push({ mid: null, sender: { track: null, replaceTrack: vi.fn() }, kind });
  }
  getTransceivers() {
    return this.transceivers;
  }
  async createOffer() {
    if (this.fail === "offer") throw new Error("no offer");
    return { type: "offer", sdp: `offer${++this.offers}` };
  }
  async createAnswer() {
    return { type: "answer", sdp: "answer" };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    if (this.fail !== "noLocal") this.localDescription = description;
    this.setSignaling(description.type === "offer" ? "have-local-offer" : "stable");
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    if (this.fail === "remote") throw new Error("bad sdp");
    this.remoteDescription = description;
    // Offered m-lines take the transceivers addTrack made for their kind.
    for (const kind of ["audio", "video"]) {
      if (!description.sdp.includes(`m=${kind}`)) continue;
      const free = this.transceivers.find((t) => t.kind === kind && t.mid === null);
      if (free) free.mid = String(this.transceivers.indexOf(free));
    }
    this.setSignaling(description.type === "offer" ? "have-remote-offer" : "stable");
  }
  async addIceCandidate(candidate: { candidate: string }) {
    if (candidate.candidate === "bad") throw new Error("bad candidate");
    this.candidates.push(candidate);
  }
  setSignaling(state: string) {
    this.signalingState = state;
    this.onsignalingstatechange?.();
  }
  setConnection(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let env: PeerCallEnv & { getUserMedia: ReturnType<typeof vi.fn>; devices: ReturnType<typeof vi.fn> };
let levels: Map<string, number>;
let meters: (LevelMeter & { track: FakeTrack; stop: ReturnType<typeof vi.fn> })[];
let mics: FakeTrack[];
let cameras: FakeTrack[];
let stage: HTMLElement;
let speakers: HTMLElement;
let roster: HTMLElement;
type OnError = (message: string, notice?: { off?: VoiceNoticeFlag }) => void;
let onError: ReturnType<typeof vi.fn<OnError>>;
let sent: [string, VoiceSignal][];
let call: PeerCall;

const peer = (id: string, offer = false, extra: Partial<NativeCallPeer> = {}): NativeCallPeer => ({ id, name: `User ${id}`, offer, ...extra });
const TURN = [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }];

function session(p2p: { callId?: string; peers?: NativeCallPeer[]; signals?: NativeCallSignal[]; relayOnly?: boolean; iceServers?: unknown[]; over?: number } = {}, flags: Partial<NativeVoiceSession> = {}): NativeVoiceSession {
  return {
    channelId: "5",
    channelName: "Ana",
    guildName: "",
    mute: false,
    deaf: false,
    video: false,
    stream: false,
    ...flags,
    p2p: { callId: "c1", self: "1", peers: [], iceServers: TURN, relayOnly: true, signals: [], ...p2p } as NativeVoiceSession["p2p"],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  FakePC.all = [];
  levels = new Map();
  meters = [];
  mics = [];
  cameras = [];
  sent = [];
  document.body.innerHTML = `<div id="stage" hidden></div><div id="speakers"></div><ul id="roster" hidden></ul>`;
  stage = document.getElementById("stage")!;
  speakers = document.getElementById("speakers")!;
  roster = document.getElementById("roster")!;
  onError = vi.fn<OnError>();
  env = {
    connect: (config) => new FakePC(config) as unknown as RTCPeerConnection,
    getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio) {
        const track = new FakeTrack("audio");
        mics.push(track);
        return new FakeStream([track]) as unknown as MediaStream;
      }
      const track = new FakeTrack("video");
      cameras.push(track);
      return new FakeStream([track]) as unknown as MediaStream;
    }),
    devices: vi.fn(async () => [
      { deviceId: "mic-b", kind: "audioinput", label: "Mic B" },
      { deviceId: "spk-b", kind: "audiooutput", label: "Speaker B" },
      { deviceId: "cam-b", kind: "videoinput", label: "Cam B" },
    ]),
    stream: (tracks) => new FakeStream(tracks as unknown as FakeTrack[]) as unknown as MediaStream,
    meter: (track) => {
      const meter = { track: track as unknown as FakeTrack, level: () => levels.get(track.id) ?? 0, stop: vi.fn() };
      meters.push(meter);
      return meter;
    },
    label: () => "abc",
  };
  call = new PeerCall(stage, speakers, roster, onError, (to, signal) => sent.push([to, signal]), env);
});

afterEach(async () => {
  await call.sync(null);
  vi.useRealTimers();
});

const pc = (index = 0): FakePC => FakePC.all[index]!;
const signalsTo = (id: string) => sent.filter(([to]) => to === id).map(([, s]) => s);

describe("PeerCall: connecting", () => {
  it("waits for an earlier joiner's offer, answers it, and adds candidates once the offer is set", async () => {
    await call.sync(session({ peers: [peer("2")] }, { mute: true }));
    expect(FakePC.all).toHaveLength(0);
    expect(roster.hidden).toBe(false);
    expect(roster.textContent).toContain("User 2");
    expect(roster.textContent).toContain("Connecting…");
    await call.sync(
      session(
        {
          peers: [peer("2")],
          signals: [
            { seq: 1, from: "2", signal: { type: "candidate", candidate: { candidate: "c1", sdpMLineIndex: 0, sdpMid: "0" } } },
            { seq: 2, from: "2", signal: { type: "offer", sdp: "offer-from-2" } },
          ],
        },
        { mute: true },
      ),
    );
    await flush();
    const link = pc();
    expect(link.config).toEqual({ iceServers: TURN, iceTransportPolicy: "relay" });
    expect(link.channels).toHaveLength(0);
    expect(link.ondatachannel).not.toBeNull();
    link.ondatachannel!({ channel: { close: vi.fn() } });
    expect(link.remoteDescription).toEqual({ type: "offer", sdp: "offer-from-2" });
    expect(link.candidates).toEqual([{ candidate: "c1", sdpMLineIndex: 0, sdpMid: "0" }]);
    expect(signalsTo("2")).toEqual([{ type: "answer", sdp: "answer" }]);
    // The same signals again (a re-render) are not acted on twice.
    await call.sync(session({ peers: [peer("2")], signals: [{ seq: 2, from: "2", signal: { type: "offer", sdp: "offer-from-2" } }] }, { mute: true }));
    await flush();
    expect(signalsTo("2")).toHaveLength(1);
    // Later candidates go straight in; one the browser refuses is left out.
    await call.sync(
      session(
        {
          peers: [peer("2")],
          signals: [
            { seq: 3, from: "2", signal: { type: "candidate", candidate: { candidate: "c2" } } },
            { seq: 4, from: "2", signal: { type: "candidate", candidate: { candidate: "bad" } } },
          ],
        },
        { mute: true },
      ),
    );
    await flush();
    expect(link.candidates).toEqual([{ candidate: "c1", sdpMLineIndex: 0, sdpMid: "0" }, { candidate: "c2" }]);
    // Its own candidates go to the peer.
    link.onicecandidate!({ candidate: { candidate: "mine", sdpMLineIndex: 0, sdpMid: "0" } });
    link.onicecandidate!({ candidate: null });
    expect(signalsTo("2").at(-1)).toEqual({ type: "candidate", candidate: { candidate: "mine", sdpMLineIndex: 0, sdpMid: "0" } });
    // It never offers itself and ignores what only an initiator acts on.
    await call.sync(
      session(
        {
          peers: [peer("2")],
          signals: [
            { seq: 5, from: "2", signal: { type: "renegotiate", renegotiate: true } },
            { seq: 6, from: "2", signal: { type: "transceiverRequest", transceiverRequest: { kind: "video" } } },
          ],
        },
        { mute: true },
      ),
    );
    await flush();
    expect(link.offers).toBe(0);
    expect(link.transceivers).toHaveLength(0);
  });

  it("offers to someone who joined later, with a data channel and the microphone, and follows their requests", async () => {
    await call.sync(session({ peers: [peer("2", true)], relayOnly: false }));
    await flush();
    const link = pc();
    expect(link.config).toEqual({ iceServers: TURN, iceTransportPolicy: "all" });
    expect(link.channels.map((c) => c.label)).toEqual(["abc"]);
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    expect(link.transceivers.map((t) => t.sender.track)).toEqual([mics[0]]);
    expect(signalsTo("2")).toEqual([{ type: "offer", sdp: "offer1" }]);
    // Their candidate waits for the answer.
    await call.sync(session({ peers: [peer("2", true)], relayOnly: false, signals: [{ seq: 1, from: "2", signal: { type: "candidate", candidate: { candidate: "c" } } }] }));
    expect(link.candidates).toEqual([]);
    await call.sync(session({ peers: [peer("2", true)], relayOnly: false, signals: [{ seq: 2, from: "2", signal: { type: "answer", sdp: "m=audio" } }] }));
    await flush();
    expect(link.candidates).toEqual([{ candidate: "c" }]);
    expect(link.signalingState).toBe("stable");
    // They ask for a renegotiation, then for a transceiver for their camera.
    await call.sync(session({ peers: [peer("2", true)], relayOnly: false, signals: [{ seq: 3, from: "2", signal: { type: "renegotiate", renegotiate: true } }] }));
    await flush();
    expect(signalsTo("2").at(-1)).toEqual({ type: "offer", sdp: "offer2" });
    await call.sync(session({ peers: [peer("2", true)], relayOnly: false, signals: [{ seq: 4, from: "2", signal: { type: "transceiverRequest", transceiverRequest: { kind: "video" } } }] }));
    await flush();
    expect(link.transceivers.at(-1)!.kind).toBe("video");
    // Still negotiating the last: the next waits until it is stable.
    expect(signalsTo("2").filter((s) => s.type === "offer")).toHaveLength(2);
    await call.sync(session({ peers: [peer("2", true)], relayOnly: false, signals: [{ seq: 5, from: "2", signal: { type: "answer", sdp: "a" } }] }));
    await flush();
    expect(signalsTo("2").at(-1)).toEqual({ type: "offer", sdp: "offer3" });
  });

  it("asks the initiator for a transceiver the offer had no place for, once", async () => {
    await call.sync(session({ peers: [peer("2")], signals: [{ seq: 1, from: "2", signal: { type: "offer", sdp: "no media yet" } }] }));
    await flush();
    expect(signalsTo("2")).toEqual([{ type: "answer", sdp: "answer" }, { type: "transceiverRequest", transceiverRequest: { kind: "audio" } }]);
    await call.sync(session({ peers: [peer("2")], signals: [{ seq: 2, from: "2", signal: { type: "offer", sdp: "still none" } }] }));
    await flush();
    expect(signalsTo("2").filter((s) => s.type === "transceiverRequest")).toHaveLength(1);
  });

  it("asks the initiator to renegotiate for a camera turned on later, once per change", async () => {
    await call.sync(session({ peers: [peer("2")], signals: [{ seq: 1, from: "2", signal: { type: "offer", sdp: "m=audio" } }] }));
    await flush();
    sent = [];
    await call.sync(session({ peers: [peer("2")] }, { video: true }));
    await flush();
    expect(signalsTo("2")).toEqual([{ type: "renegotiate", renegotiate: true }]);
    // Turned off again before the initiator answered: asked again once it has.
    await call.sync(session({ peers: [peer("2")] }, { video: false }));
    await flush();
    expect(signalsTo("2")).toHaveLength(1);
    await call.sync(session({ peers: [peer("2")], signals: [{ seq: 2, from: "2", signal: { type: "offer", sdp: "m=audio m=video" } }] }));
    await flush();
    expect(signalsTo("2").filter((s) => s.type === "renegotiate")).toHaveLength(2);
    expect(pc().removed).toHaveLength(1);
  });

  it("leaves peers who left, and starts afresh with a new call", async () => {
    await call.sync(session({ peers: [peer("2", true), peer("3", true)] }));
    await flush();
    expect(FakePC.all).toHaveLength(2);
    pc(0).ontrack!({ track: new FakeTrack("audio"), streams: [] });
    expect(speakers.querySelectorAll("audio")).toHaveLength(1);
    await call.sync(session({ peers: [peer("3", true)] }));
    expect(pc(0).close).toHaveBeenCalled();
    expect(pc(0).channels[0]!.close).toHaveBeenCalled();
    expect(speakers.querySelectorAll("audio")).toHaveLength(0);
    // Whatever the old connection still says is not passed on.
    pc(0).onicecandidate?.({ candidate: { candidate: "late" } });
    expect(signalsTo("2")).toHaveLength(1);
    await call.sync(session({ callId: "c2", peers: [peer("3")], signals: [{ seq: 1, from: "3", signal: { type: "offer", sdp: "o" } }] }));
    await flush();
    expect(pc(1).close).toHaveBeenCalled();
    expect(mics[0]!.stop).toHaveBeenCalled();
    expect(FakePC.all).toHaveLength(3);
    expect(pc(2).remoteDescription).toEqual({ type: "offer", sdp: "o" });
  });

  it("refuses a relay-only call without a relay, and connects nothing", async () => {
    await call.sync(session({ peers: [peer("2", true)], iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] }));
    expect(onError).toHaveBeenCalledWith(NO_RELAY);
    expect(FakePC.all).toHaveLength(0);
    expect(roster.hidden).toBe(true);
  });

  it("leaves when the session goes or is no peer-to-peer call", async () => {
    await call.sync(session({ peers: [peer("2", true)] }, { video: true }));
    await flush();
    expect(stage.hidden).toBe(false);
    await call.sync({ ...session(), p2p: undefined });
    expect(pc().close).toHaveBeenCalled();
    expect(cameras[0]!.stop).toHaveBeenCalled();
    expect(stage.hidden).toBe(true);
    expect(roster.hidden).toBe(true);
  });

  it("gives up a connection whose negotiation fails, and says so", async () => {
    await call.sync(session({ peers: [peer("2")] }, { mute: true }));
    FakePC.all = [];
    const connect = env.connect;
    env.connect = (config) => {
      const link = connect(config) as unknown as FakePC;
      link.fail = "remote";
      return link as unknown as RTCPeerConnection;
    };
    await call.sync(session({ peers: [peer("2")], signals: [{ seq: 1, from: "2", signal: { type: "offer", sdp: "o" } }] }, { mute: true }));
    await flush();
    expect(pc().close).toHaveBeenCalled();
    expect(roster.textContent).toContain("Could not connect");
    // A closed connection takes no more signals.
    await call.sync(session({ peers: [peer("2")], signals: [{ seq: 2, from: "2", signal: { type: "offer", sdp: "o" } }] }, { mute: true }));
    await flush();
    expect(FakePC.all).toHaveLength(1);
  });

  it("gives up when an offer cannot be made or a transceiver added", async () => {
    const connect = env.connect;
    let fail: FakePC["fail"] = "offer";
    env.connect = (config) => {
      const link = connect(config) as unknown as FakePC;
      link.fail = fail;
      return link as unknown as RTCPeerConnection;
    };
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true }));
    await flush();
    expect(pc(0).close).toHaveBeenCalled();
    fail = "transceiver";
    await call.sync(session({ peers: [peer("3", true)] }, { mute: true }));
    await flush();
    await call.sync(session({ peers: [peer("3", true)], signals: [{ seq: 1, from: "3", signal: { type: "transceiverRequest", transceiverRequest: { kind: "audio" } } }] }, { mute: true }));
    await flush();
    expect(pc(1).close).toHaveBeenCalled();
    fail = "noLocal";
    await call.sync(session({ peers: [peer("4", true)] }, { mute: true }));
    await flush();
    expect(signalsTo("4")).toEqual([]);
  });

  it("shows how each connection stands, and who is beyond the cap", async () => {
    await call.sync(session({ peers: [peer("2", true, { avatarUrl: "https://cdn.example.org/a.webp" })], over: 2 }, { mute: true }));
    await flush();
    const rows = () => [...roster.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows()).toEqual(["YYouMuted", "User 2Connecting…", "2 more in the call, not connected: calls here connect at most 8 people."]);
    expect(roster.querySelector("img")!.getAttribute("src")).toBe("https://cdn.example.org/a.webp");
    pc().setConnection("connected");
    expect(rows()[1]).toBe("User 2");
    pc().setConnection("disconnected");
    expect(rows()[1]).toBe("User 2Connection lost");
  });
});

describe("PeerCall: media", () => {
  it("opens the microphone on unmuting and sends it on every connection", async () => {
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true }));
    await flush();
    await call.sync(session({ peers: [peer("2", true)], signals: [{ seq: 1, from: "2", signal: { type: "answer", sdp: "a" } }] }, { mute: true }));
    await flush();
    await call.sync(session({ peers: [peer("2", true)] }));
    await flush();
    expect(pc().transceivers.map((t) => t.sender.track)).toEqual([mics[0]]);
    expect(signalsTo("2").filter((s) => s.type === "offer")).toEqual([{ type: "offer", sdp: "offer1" }, { type: "offer", sdp: "offer2" }]);
  });

  it("answers an offer even where it made the first one", async () => {
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true }));
    await flush();
    await call.sync(session({ peers: [peer("2", true)], signals: [{ seq: 1, from: "2", signal: { type: "offer", sdp: "theirs" } }] }, { mute: true }));
    await flush();
    expect(signalsTo("2").at(-1)).toEqual({ type: "answer", sdp: "answer" });
  });

  it("sends nothing on a connection given up, and takes its tracks back quietly", async () => {
    const connect = env.connect;
    env.connect = (config) => {
      const link = connect(config) as unknown as FakePC;
      link.fail = "offer";
      return link as unknown as RTCPeerConnection;
    };
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true, video: true }));
    await flush();
    expect(pc().close).toHaveBeenCalled();
    await call.sync(session({ peers: [peer("2", true)] }, { mute: false, video: false }));
    await call.sync(session({ peers: [peer("2", true)] }, { mute: false, video: true }));
    await call.sync(session({ peers: [peer("2", true)] }, { mute: false, video: false }));
    await call.configure({ ...DEFAULT_SETTINGS.voice, echoCancellation: false });
    expect(pc().transceivers.map((t) => t.sender.track)).toEqual([cameras[0]]);
    expect(pc().removed).toEqual([]);
    expect(signalsTo("2")).toEqual([]);
  });

  it("mutes by turning the microphone's track off, without renegotiating", async () => {
    await call.sync(session({ peers: [peer("2", true)] }));
    await flush();
    expect(mics[0]!.enabled).toBe(true);
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true }));
    await flush();
    expect(mics[0]!.enabled).toBe(false);
    expect(env.getUserMedia).toHaveBeenCalledTimes(1);
    expect(pc().offers).toBe(1);
    expect(roster.textContent).toContain("Muted");
  });

  it("opens no microphone while muted, and asks again after a failure only once it is turned off and on", async () => {
    await call.sync(session({}, { mute: true }));
    expect(env.getUserMedia).not.toHaveBeenCalled();
    env.getUserMedia.mockRejectedValueOnce(new Error("Permission denied"));
    await call.sync(session());
    expect(onError).toHaveBeenCalledWith("The microphone could not start: Permission denied", {});
    await call.sync(session());
    expect(env.getUserMedia).toHaveBeenCalledTimes(1);
    await call.sync(session({}, { mute: true }));
    env.getUserMedia.mockResolvedValueOnce(new FakeStream([]) as unknown as MediaStream);
    await call.sync(session());
    expect(onError).toHaveBeenCalledWith("The microphone could not start: no microphone was given", {});
  });

  it("deafens: plays nothing and sends nothing", async () => {
    await call.sync(session({ peers: [peer("2", true)] }));
    await flush();
    pc().ontrack!({ track: new FakeTrack("audio"), streams: [] });
    await call.sync(session({ peers: [peer("2", true)] }, { deaf: true }));
    expect(speakers.querySelector("audio")!.muted).toBe(true);
    expect(mics[0]!.enabled).toBe(false);
    pc().ontrack!({ track: new FakeTrack("audio"), streams: [] });
    expect(speakers.querySelectorAll("audio")[1]!.muted).toBe(true);
  });

  it("shows the camera, sends it to everyone, and stops it", async () => {
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true, video: true }));
    await flush();
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: false, video: true });
    expect(stage.querySelector(".video-tile.local figcaption")!.textContent).toBe("You");
    expect(pc().transceivers.map((t) => t.sender.track)).toEqual([cameras[0]]);
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true, video: false }));
    expect(cameras[0]!.stop).toHaveBeenCalled();
    expect(pc().removed).toHaveLength(1);
    expect(stage.hidden).toBe(true);
  });

  it("says when the camera cannot start or stops, and turns video off", async () => {
    env.getUserMedia.mockRejectedValueOnce(new Error("busy"));
    await call.sync(session({}, { mute: true, video: true }));
    expect(onError).toHaveBeenCalledWith("The camera could not start: busy", { off: "video" });
    await call.sync(session({}, { mute: true, video: true }));
    expect(env.getUserMedia).toHaveBeenCalledTimes(1);
    await call.sync(session({}, { mute: true }));
    env.getUserMedia.mockResolvedValueOnce(new FakeStream([]) as unknown as MediaStream);
    await call.sync(session({}, { mute: true, video: true }));
    expect(onError).toHaveBeenCalledWith("The camera could not start: no camera was given", { off: "video" });
    await call.sync(session({}, { mute: true }));
    await call.sync(session({}, { mute: true, video: true }));
    cameras.at(-1)!.dispatchEvent(new Event("ended"));
    expect(onError).toHaveBeenLastCalledWith("The camera stopped.", { off: "video" });
  });

  it("plays and shows what peers send until they stop", async () => {
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true }));
    await flush();
    const audio = new FakeTrack("audio");
    const video = new FakeTrack("video");
    const stream = new FakeStream([audio, video]);
    pc().ontrack!({ track: audio, streams: [stream] });
    pc().ontrack!({ track: audio, streams: [stream] });
    pc().ontrack!({ track: video, streams: [stream] });
    expect(speakers.querySelectorAll("audio")).toHaveLength(1);
    expect(stage.querySelector(".video-tile figcaption")!.textContent).toBe("User 2");
    expect(stage.hidden).toBe(false);
    const removed = Object.assign(new Event("removetrack"), { track: video });
    stream.dispatchEvent(Object.assign(new Event("removetrack"), { track: new FakeTrack("video") }));
    expect(stage.querySelector(".video-tile")).not.toBeNull();
    stream.dispatchEvent(removed);
    expect(stage.querySelector(".video-tile")).toBeNull();
    expect(stage.hidden).toBe(true);
    audio.dispatchEvent(new Event("ended"));
    expect(speakers.querySelector("audio")).toBeNull();
    expect(meters.find((m) => m.track === audio)!.stop).toHaveBeenCalled();
  });

  it("drops only what the peer who left was sending", async () => {
    await call.sync(session({ peers: [peer("2", true), peer("3", true)] }, { mute: true }));
    await flush();
    const theirs = new FakeTrack("audio");
    pc(0).ontrack!({ track: theirs, streams: [] });
    pc(1).ontrack!({ track: new FakeTrack("audio"), streams: [] });
    await call.sync(session({ peers: [peer("3", true)] }, { mute: true }));
    expect(speakers.querySelectorAll("audio")).toHaveLength(1);
    theirs.dispatchEvent(new Event("ended"));
    expect(speakers.querySelectorAll("audio")).toHaveLength(1);
  });

  it("leaves a camera that ended after it was turned off alone", async () => {
    await call.sync(session({}, { mute: true, video: true }));
    await call.sync(session({}, { mute: true }));
    cameras[0]!.dispatchEvent(new Event("ended"));
    expect(onError).not.toHaveBeenCalled();
  });

  it("marks who is speaking", async () => {
    await call.sync(session({ peers: [peer("2", true)] }));
    await flush();
    const audio = new FakeTrack("audio");
    pc().ontrack!({ track: audio, streams: [] });
    pc().ontrack!({ track: new FakeTrack("video"), streams: [] });
    levels.set(audio.id, SPEAKING_LEVEL * 2);
    vi.advanceTimersByTime(METER_MS);
    const speaking = () => [...document.querySelectorAll(".speaking")].map((e) => (e as HTMLElement).dataset.peer);
    expect(speaking()).toEqual(["2", "2"]);
    levels.set(mics[0]!.id, SPEAKING_LEVEL * 2);
    vi.advanceTimersByTime(METER_MS);
    expect(speaking()).toContain("1");
    vi.advanceTimersByTime(METER_MS); // nothing changed
    // Muted, the user is not speaking whatever the microphone hears.
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true }));
    vi.advanceTimersByTime(METER_MS);
    expect(speaking()).not.toContain("1");
    // The roster keeps the marks when it is drawn again.
    await call.sync(session({ peers: [peer("2", true)] }, { mute: true }));
    expect(roster.querySelector(".speaking")!.textContent).toContain("User 2");
  });

  it("plays and speaks without speaking marks where sound cannot be measured", async () => {
    env.meter = () => {
      throw new Error("no audio context");
    };
    await call.sync(session({ peers: [peer("2", true)] }));
    await flush();
    pc().ontrack!({ track: new FakeTrack("audio"), streams: [] });
    vi.advanceTimersByTime(METER_MS);
    expect(document.querySelector(".speaking")).toBeNull();
    expect(speakers.querySelectorAll("audio")).toHaveLength(1);
  });
});

describe("PeerCall: settings", () => {
  const chosen: VoiceSettings = { ...DEFAULT_SETTINGS.voice, input: { id: "x", label: "Mic B" }, output: { id: "x", label: "Speaker B" }, camera: { id: "x", label: "Cam B" } };

  it("opens the chosen devices and plays on the chosen speakers", async () => {
    await call.configure(chosen);
    await call.sync(session({ peers: [peer("2", true)] }, { video: true }));
    await flush();
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: "mic-b" } }, video: false });
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: false, video: { deviceId: { exact: "cam-b" } } });
    const setSinkId = vi.fn(async () => undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { value: setSinkId, configurable: true });
    pc().ontrack!({ track: new FakeTrack("audio"), streams: [] });
    expect(setSinkId).toHaveBeenCalledWith("spk-b");
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
  });

  it("switches an open microphone and camera in place, and leaves them be when nothing they use changed", async () => {
    await call.sync(session({ peers: [peer("2", true)] }, { video: true }));
    await flush();
    const senders = pc().transceivers.map((t) => t.sender);
    for (const sender of senders) sender.replaceTrack.mockRejectedValueOnce(new Error("ended"));
    pc().ontrack!({ track: new FakeTrack("audio"), streams: [] });
    const setSinkId = vi.fn(async () => {
      throw new Error("no such device");
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { value: setSinkId, configurable: true });
    await call.configure({ ...DEFAULT_SETTINGS.voice, pushToTalk: "F13" });
    expect(env.getUserMedia).toHaveBeenCalledTimes(2);
    await call.configure(chosen);
    await flush();
    expect(env.getUserMedia).toHaveBeenCalledTimes(4);
    expect(mics[0]!.stop).toHaveBeenCalled();
    expect(cameras[0]!.stop).toHaveBeenCalled();
    expect(setSinkId).toHaveBeenCalledWith("spk-b");
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    expect(senders.map((s) => s.replaceTrack.mock.calls[0]![0])).toEqual([mics[1], cameras[1]]);
    expect(pc().offers).toBe(1);
  });

  it("keeps a muted microphone muted when it switches", async () => {
    await call.sync(session({}));
    await call.sync(session({}, { mute: true }));
    await call.configure({ ...DEFAULT_SETTINGS.voice, echoCancellation: false });
    expect(mics[1]!.enabled).toBe(false);
  });

  it("goes on with the devices it had when a switch fails", async () => {
    await call.sync(session({}));
    env.getUserMedia.mockRejectedValueOnce(new Error("gone"));
    await call.configure(chosen);
    expect(onError).toHaveBeenCalledWith("Could not switch devices: gone", {});
    await call.configure(DEFAULT_SETTINGS.voice);
  });

  it("does nothing with settings outside a call", async () => {
    await call.configure(chosen);
    expect(env.devices).not.toHaveBeenCalled();
  });

  it("sends the microphone through RNNoise when that is on, and the plain one when it cannot start", async () => {
    const cleaned = new FakeTrack("audio");
    const processor: MicProcessor & { init: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } = {
      init: vi.fn(async () => {
        processor.processedTrack = cleaned as unknown as MediaStreamTrack;
      }),
      destroy: vi.fn(async () => undefined),
    };
    call = new PeerCall(stage, speakers, roster, onError, (to, signal) => sent.push([to, signal]), env, () => processor);
    await call.configure({ ...DEFAULT_SETTINGS.voice, enhancedNoiseSuppression: true });
    await call.sync(session({ peers: [peer("2", true)] }));
    await flush();
    expect(processor.init).toHaveBeenCalledWith({ kind: "audio", track: mics[0] });
    expect(pc().transceivers[0]!.sender.track).toBe(cleaned);
    await call.sync(null);
    expect(processor.destroy).toHaveBeenCalled();
    expect(cleaned.stop).toHaveBeenCalled();

    processor.init.mockImplementationOnce(async () => {
      processor.processedTrack = undefined;
    });
    processor.destroy.mockRejectedValueOnce(new Error("already gone"));
    await call.sync(session({ callId: "c2", peers: [peer("3", true)] }));
    await flush();
    expect(onError).toHaveBeenCalledWith("Enhanced noise suppression could not start: it gave no sound", {});
    expect(pc(1).transceivers[0]!.sender.track).toBe(mics[1]);
    // One that started is stopped on leaving, whatever it says then.
    await call.sync(null);
    processor.destroy.mockRejectedValueOnce(new Error("already gone"));
    await call.sync(session({ callId: "c3" }));
    await call.sync(null);
    expect(processor.destroy).toHaveBeenCalledTimes(3);
  });
});

describe("browserPeerEnv", () => {
  it("uses the window's peer connections, devices and streams, and measures sound on one audio context", async () => {
    const analyser = { fftSize: 0, getByteTimeDomainData: (samples: Uint8Array) => samples.fill(128 + 64) };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const contexts: unknown[] = [];
    const win = {
      RTCPeerConnection: vi.fn(function (this: { config: unknown }, config: unknown) {
        this.config = config;
      }),
      MediaStream: vi.fn(function (this: { tracks: unknown }, tracks: unknown) {
        this.tracks = tracks;
      }),
      AudioContext: vi.fn(function (this: object) {
        contexts.push(this);
        Object.assign(this, { createAnalyser: () => analyser, createMediaStreamSource: () => source });
      }),
      navigator: { mediaDevices: { getUserMedia: vi.fn(async () => "stream"), enumerateDevices: vi.fn(async () => [{ deviceId: "d", kind: "audioinput", label: "Mic" }]) } },
      crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(171) },
    } as unknown as Window & typeof globalThis;
    const browser = browserPeerEnv(win);
    expect((browser.connect({ iceServers: [] }) as unknown as { config: unknown }).config).toEqual({ iceServers: [] });
    expect(await browser.getUserMedia({ audio: true })).toBe("stream");
    expect(await browser.devices()).toHaveLength(1);
    expect((browser.stream([]) as unknown as { tracks: unknown }).tracks).toEqual([]);
    expect(browser.label()).toBe("ab".repeat(20));
    const meter = browser.meter({} as MediaStreamTrack);
    browser.meter({} as MediaStreamTrack);
    expect(contexts).toHaveLength(1);
    expect(analyser.fftSize).toBe(512);
    expect(meter.level()).toBeCloseTo(0.5);
    meter.stop();
    expect(source.disconnect).toHaveBeenCalled();
    const bare = browserPeerEnv({ navigator: {} } as unknown as Window & typeof globalThis);
    expect(await bare.devices()).toEqual([]);
  });
});
