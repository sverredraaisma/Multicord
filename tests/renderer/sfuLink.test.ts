// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeerCall, SPEAKING_LEVEL, METER_MS, type LevelMeter, type PeerCallEnv } from "../../src/renderer/peerCall";
import { answerDescription, offerSignal, SfuLink } from "../../src/renderer/sfuLink";
import type { NativeSfuPeer, NativeVoiceSession, SfuAnswer, SfuSignal } from "../../src/shared/native";

let nextId = 0;

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

const FINGERPRINT = `sha-256 ${Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(":")}`;

interface FakeTransceiver {
  mid: string | null;
  direction: string;
  sender: { track: FakeTrack | null; replaceTrack: ReturnType<typeof vi.fn> };
  receiver: { track: FakeTrack };
}

/** A peer connection whose offers look like Chromium's: one bundled audio section per transceiver, with Opus, RED and the usual header extensions. */
class FakePC {
  static all: FakePC[] = [];
  onconnectionstatechange: (() => void) | null = null;
  signalingState = "stable";
  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  readonly remotes: string[] = [];
  readonly transceivers: FakeTransceiver[] = [];
  readonly close = vi.fn();
  fail: "offer" | "remote" | undefined;
  /** What the offer leaves out. */
  omit: string[] = [];
  /** Transceivers the last offer had. */
  private offered = 0;
  constructor(readonly config: RTCConfiguration) {
    FakePC.all.push(this);
  }
  addTransceiver(_kind: string, init: { direction: string }) {
    const sender = {
      track: null as FakeTrack | null,
      replaceTrack: vi.fn(async (next: FakeTrack | null) => {
        sender.track = next;
      }),
    };
    const transceiver: FakeTransceiver = { mid: null, direction: init.direction, sender, receiver: { track: new FakeTrack("audio") } };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  async createOffer() {
    if (this.fail === "offer") throw new Error("no offer");
    this.offered = this.transceivers.length;
    const mids = this.transceivers.map((t, i) => t.mid ?? String(i));
    const lines = ["v=0", "o=- 42 2 IN IP4 127.0.0.1", "s=-", "t=0 0", `a=group:BUNDLE ${mids.join(" ")}`];
    this.transceivers.forEach((t, i) => {
      lines.push(
        "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
        "c=IN IP4 0.0.0.0",
        "a=ice-ufrag:Ab12",
        "a=ice-pwd:abcdefghijklmnopqrstuv",
        `a=fingerprint:${FINGERPRINT}`,
        "a=setup:actpass",
        `a=mid:${mids[i]}`,
        "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
        "a=extmap:3/sendrecv http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
        "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
        `a=${t.direction}`,
        "a=rtpmap:111 opus/48000/2",
        "a=rtpmap:63 red/48000/2",
      );
      if (t.direction === "sendonly") lines.push("a=ssrc:3735928559 cname:abc");
    });
    let sdp = `${lines.join("\r\n")}\r\n`;
    for (const omitted of this.omit) sdp = sdp.split("\r\n").filter((line) => !line.startsWith(omitted)).join("\r\n");
    return { type: "offer", sdp };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
    this.transceivers.slice(0, this.offered).forEach((t, i) => (t.mid ??= String(i)));
    this.signalingState = "have-local-offer";
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    if (this.fail === "remote") throw new Error("bad sdp");
    this.remoteDescription = description;
    this.remotes.push(description.sdp);
    this.signalingState = "stable";
  }
  setConnection(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer: SfuAnswer = {
  ip: "51.210.113.110",
  port: 6000,
  ufrag: "TqfRYaWUmsdzFVZC",
  pwd: "pqKqzWpZhpmpWkWRYBeVLycsnaFHmzLh",
  fingerprint: FINGERPRINT,
  candidate: { foundation: "4150473528", component: 1, protocol: "udp", priority: 2130706431, ip: "51.210.113.110", port: 6000 },
};
const pc = (index = 0): FakePC => FakePC.all[index]!;
/** The section of a description for a mid. */
const section = (sdp: string, mid: string): string => sdp.split("m=").find((part) => part.includes(`a=mid:${mid}\r\n`)) ?? "";

let signals: SfuSignal[];
let tracks: [string, string][];
let untracked: string[];
let states: string[];
let link: SfuLink;

function makeLink(): SfuLink {
  return new SfuLink(() => new FakePC({}) as unknown as RTCPeerConnection, {
    signal: (signal) => signals.push(signal),
    track: (track, peer) => tracks.push([track.id, peer]),
    untrack: (track) => untracked.push(track.id),
    state: (state) => states.push(state),
  });
}

beforeEach(() => {
  FakePC.all = [];
  signals = [];
  tracks = [];
  untracked = [];
  states = [];
});

describe("offerSignal", () => {
  it("reads what the server needs from the browser's offer, the microphone's SSRC with it", async () => {
    const fake = new FakePC({});
    fake.addTransceiver("audio", { direction: "sendonly" });
    const { sdp } = await fake.createOffer();
    expect(offerSignal(sdp)).toEqual({
      signal: {
        t: "offer",
        ufrag: "Ab12",
        pwd: "abcdefghijklmnopqrstuv",
        fingerprint: FINGERPRINT,
        opus: 111,
        extensions: [
          { id: 1, uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level" },
          { id: 3, uri: "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01" },
        ],
      },
      ssrc: 3735928559,
    });
  });

  it("takes credentials at session level, and goes without an SSRC", () => {
    const sdp = ["v=0", "a=ice-ufrag:Ab12", "a=ice-pwd:abcdefghijklmnopqrstuv", `a=fingerprint:${FINGERPRINT}`, "m=audio 9 UDP/TLS/RTP/SAVPF 109", "a=mid:0", "a=rtpmap:109 opus/48000/2"].join("\n");
    expect(offerSignal(sdp)).toEqual({ signal: { t: "offer", ufrag: "Ab12", pwd: "abcdefghijklmnopqrstuv", fingerprint: FINGERPRINT, opus: 109, extensions: [] } });
  });

  it("is undefined without sound or any of its parts", () => {
    expect(offerSignal("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n")).toBeUndefined();
    expect(offerSignal("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000\r\na=ice-ufrag:Ab12\r\na=ice-pwd:x\r\na=fingerprint:y\r\n")).toBeUndefined();
    expect(offerSignal("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n")).toBeUndefined();
  });
});

describe("answerDescription", () => {
  it("leaves out transport-wide feedback where the offer named no such extension", () => {
    const sdp = answerDescription("v=0\r\nm=audio 9 X 111\r\na=mid:0\r\n", answer, 111, [{ id: 1, uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level" }], new Map(), 3);
    expect(sdp).toContain("o=- 1 3 IN IP4 127.0.0.1");
    expect(sdp).toContain("a=inactive");
    expect(sdp).not.toContain("transport-cc");
  });
});

describe("SfuLink", () => {
  afterEach(() => link.close());

  it("offers once with the microphone's section, and writes the server's answer as the description", async () => {
    link = makeLink();
    await flush();
    expect(pc().transceivers[0]!.direction).toBe("sendonly");
    expect(signals).toEqual([expect.objectContaining({ t: "offer", ufrag: "Ab12", opus: 111 })]);
    link.setAnswer(undefined);
    link.setAnswer(answer);
    await flush();
    const sdp = pc().remoteDescription!.sdp;
    expect(pc().remoteDescription!.type).toBe("answer");
    expect(sdp).toContain("a=group:BUNDLE 0");
    expect(sdp).toContain("m=audio 6000 UDP/TLS/RTP/SAVPF 111");
    expect(sdp).toContain("c=IN IP4 51.210.113.110");
    expect(sdp).toContain("a=ice-ufrag:TqfRYaWUmsdzFVZC");
    expect(sdp).toContain(`a=fingerprint:${FINGERPRINT}`);
    expect(sdp).toContain("a=setup:passive");
    expect(sdp).toContain("a=recvonly");
    expect(sdp).toContain("a=rtcp-fb:111 transport-cc");
    expect(sdp).toContain("a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01");
    expect(sdp).toContain("a=candidate:4150473528 1 udp 2130706431 51.210.113.110 6000 typ host");
    // The same answer again changes nothing.
    link.setAnswer({ ...answer });
    await flush();
    expect(pc().remotes).toHaveLength(1);
  });

  it("adds a receiving section for each peer the server names an SSRC for, and reuses it once they go", async () => {
    link = makeLink();
    link.setAnswer(answer);
    await flush();
    const peers: NativeSfuPeer[] = [{ id: "2", name: "Ann", ssrc: 7 }, { id: "3", name: "Bob" }, { id: "4", name: "Cid", ssrc: 9, muted: true }];
    link.setPeers(peers);
    await flush();
    expect(pc().transceivers).toHaveLength(2);
    expect(pc().transceivers[1]!.direction).toBe("recvonly");
    let sdp = pc().remoteDescription!.sdp;
    expect(sdp).toContain("a=group:BUNDLE 0 1");
    expect(section(sdp, "1")).toContain("a=sendonly");
    expect(section(sdp, "1")).toContain("a=ssrc:7 cname:p7");
    expect(sdp).not.toContain("a=ssrc:9");
    expect(tracks).toEqual([[pc().transceivers[1]!.receiver.track.id, "2"]]);
    // Nothing changed: nothing is negotiated.
    link.setPeers(peers);
    await flush();
    expect(pc().remotes).toHaveLength(2);
    // Ann goes, Bob starts sending: the section is his now.
    link.setPeers([{ id: "3", name: "Bob", ssrc: 11 }]);
    await flush();
    expect(pc().transceivers).toHaveLength(2);
    sdp = pc().remoteDescription!.sdp;
    expect(section(sdp, "1")).toContain("a=ssrc:11 cname:p11");
    const track = pc().transceivers[1]!.receiver.track.id;
    expect(untracked).toEqual([track]);
    expect(tracks.at(-1)).toEqual([track, "3"]);
    // Everyone gone: the section waits, sending nothing.
    link.setPeers([]);
    await flush();
    expect(section(pc().remoteDescription!.sdp, "1")).toContain("a=inactive");
    expect(untracked).toEqual([track, track]);
  });

  it("waits for the answer before describing, and offers a section that missed the first offer", async () => {
    link = makeLink();
    await flush();
    link.setPeers([{ id: "2", name: "Ann", ssrc: 7 }]);
    await flush();
    expect(pc().remotes).toHaveLength(0);
    link.setAnswer(answer);
    await flush();
    // The first answer was written for the microphone alone; then the browser offered again, with Ann's section.
    expect(pc().remotes).toHaveLength(2);
    expect(section(pc().remoteDescription!.sdp, "1")).toContain("a=ssrc:7");
    expect(tracks).toHaveLength(1);
  });

  it("tells the server the microphone's SSRC once connected, and whether the user speaks from then on", async () => {
    link = makeLink();
    await flush();
    link.setSpeaking(true);
    link.setSpeaking(true);
    pc().setConnection("connecting");
    pc().setConnection("connected");
    pc().setConnection("connected");
    link.setSpeaking(false);
    expect(states).toEqual(["connecting", "connected", "connected"]);
    expect(signals.slice(1)).toEqual([{ t: "ssrc", audio: 3735928559 }, { t: "speaking", on: true }, { t: "speaking", on: false }]);
  });

  it("sends no SSRC the offer did not have", async () => {
    FakePC.all = [];
    link = new SfuLink(
      () => {
        const fake = new FakePC({});
        fake.omit = ["a=ssrc:"];
        return fake as unknown as RTCPeerConnection;
      },
      { signal: (s) => signals.push(s), track: vi.fn(), untrack: vi.fn(), state: vi.fn() },
    );
    await flush();
    pc().setConnection("connected");
    expect(signals.map((s) => s.t)).toEqual(["offer"]);
  });

  it("sends the microphone on its section, and never a camera", async () => {
    link = makeLink();
    const mic = new FakeTrack("audio");
    const next = new FakeTrack("audio");
    const sender = pc().transceivers[0]!.sender;
    link.addTrack(new FakeTrack("video") as unknown as MediaStreamTrack);
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    link.addTrack(mic as unknown as MediaStreamTrack);
    await flush();
    expect(sender.track).toBe(mic);
    link.replaceTrack(next as unknown as MediaStreamTrack, mic as unknown as MediaStreamTrack);
    link.replaceTrack(mic as unknown as MediaStreamTrack, next as unknown as MediaStreamTrack);
    await flush();
    expect(sender.track).toBe(next);
    link.removeTrack(mic as unknown as MediaStreamTrack);
    link.removeTrack(next as unknown as MediaStreamTrack);
    await flush();
    expect(sender.track).toBeNull();
    // A sender that refuses changes nothing.
    sender.replaceTrack.mockRejectedValue(new Error("gone"));
    link.addTrack(mic as unknown as MediaStreamTrack);
    sender.track = mic;
    link.replaceTrack(mic as unknown as MediaStreamTrack, next as unknown as MediaStreamTrack);
    link.removeTrack(mic as unknown as MediaStreamTrack);
    await flush();
    expect(sender.track).toBe(mic);
  });

  it("gives the connection up when the browser cannot offer, or the offer lacks what the server needs", async () => {
    link = new SfuLink(
      () => {
        const fake = new FakePC({});
        fake.fail = "offer";
        return fake as unknown as RTCPeerConnection;
      },
      { signal: (s) => signals.push(s), track: vi.fn(), untrack: vi.fn(), state: (s) => states.push(s) },
    );
    await flush();
    expect(states).toEqual(["failed"]);
    expect(pc().close).toHaveBeenCalledOnce();
    link.close();
    expect(pc().close).toHaveBeenCalledOnce();
    link = new SfuLink(
      () => {
        const fake = new FakePC({});
        fake.omit = ["a=rtpmap:111"];
        return fake as unknown as RTCPeerConnection;
      },
      { signal: (s) => signals.push(s), track: vi.fn(), untrack: vi.fn(), state: (s) => states.push(s) },
    );
    await flush();
    expect(states).toEqual(["failed", "failed"]);
    expect(signals).toEqual([]);
    // Nothing more happens once given up.
    link.setAnswer(answer);
    link.setSpeaking(true);
    await flush();
    expect(pc(1).remotes).toHaveLength(0);
  });

  it("says nothing once closed, not even of a step that fails after", async () => {
    let reject!: (error: Error) => void;
    link = new SfuLink(
      () => {
        const fake = new FakePC({});
        fake.createOffer = () => new Promise((_, no) => (reject = no));
        return fake as unknown as RTCPeerConnection;
      },
      { signal: (s) => signals.push(s), track: vi.fn(), untrack: vi.fn(), state: (s) => states.push(s) },
    );
    await flush();
    link.close();
    reject(new Error("late"));
    await flush();
    expect(states).toEqual([]);
    const other = makeLink();
    await flush();
    pc(1).setConnection("connected");
    other.close();
    other.setSpeaking(true);
    expect(signals.filter((s) => s.t === "speaking")).toEqual([]);
  });

  it("stops playing what it played when closed, and says nothing after", async () => {
    link = makeLink();
    link.setAnswer(answer);
    link.setPeers([{ id: "2", name: "Ann", ssrc: 7 }]);
    await flush();
    pc().fail = "remote";
    link.setPeers([{ id: "2", name: "Ann", ssrc: 8 }]);
    await flush();
    expect(states).toEqual(["failed"]);
    expect(untracked).toHaveLength(1);
  });
});

describe("PeerCall with an SFU call", () => {
  let call: PeerCall;
  let sfuSent: SfuSignal[];
  let levels: Map<string, number>;
  let env: PeerCallEnv;
  let roster: HTMLElement;
  let speakers: HTMLElement;
  let onError: (message: string) => void;

  const session = (sfu: Partial<NonNullable<NativeVoiceSession["sfu"]>> = {}, flags: Partial<NativeVoiceSession> = {}): NativeVoiceSession => ({
    channelId: "5",
    channelName: "General",
    guildName: "Guild",
    mute: false,
    deaf: false,
    video: false,
    stream: false,
    ...flags,
    sfu: { callId: "c1", self: "1", peers: [], ...sfu },
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    sfuSent = [];
    levels = new Map();
    document.body.innerHTML = `<div id="stage" hidden></div><div id="speakers"></div><ul id="roster" hidden></ul>`;
    roster = document.getElementById("roster")!;
    speakers = document.getElementById("speakers")!;
    onError = vi.fn();
    env = {
      connect: (config) => new FakePC(config) as unknown as RTCPeerConnection,
      getUserMedia: vi.fn(async () => new FakeStream([new FakeTrack("audio")]) as unknown as MediaStream),
      devices: vi.fn(async () => []),
      stream: (t) => new FakeStream(t as unknown as FakeTrack[]) as unknown as MediaStream,
      meter: (track): LevelMeter => ({ level: () => levels.get(track.id) ?? 0, stop: vi.fn() }),
      label: () => "abc",
    };
    call = new PeerCall(document.getElementById("stage")!, speakers, roster, onError, vi.fn(), env, undefined, (signal) => sfuSent.push(signal));
  });

  afterEach(async () => {
    await call.sync(null);
    vi.useRealTimers();
  });

  it("connects to the voice server alone, plays each peer it names an SSRC for, and lists everyone", async () => {
    await call.sync(session({ peers: [{ id: "2", name: "Ann", ssrc: 7 }, { id: "3", name: "Bob" }], over: 2 }, { video: true }));
    await flush();
    expect(FakePC.all).toHaveLength(1);
    expect(pc().config).toEqual({ bundlePolicy: "max-bundle", rtcpMuxPolicy: "require", iceServers: [] });
    // Sound alone: no camera, whatever the flags say.
    expect(env.getUserMedia).toHaveBeenCalledTimes(1);
    expect(env.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: false }));
    expect(pc().transceivers[0]!.sender.track).not.toBeNull();
    expect(sfuSent).toEqual([expect.objectContaining({ t: "offer" })]);
    expect(roster.textContent).toContain("Ann");
    expect(roster.textContent).toContain("Connecting…");
    expect(roster.textContent).toContain("2 more in the call, not played: calls here play at most 64 others.");
    await call.sync(session({ peers: [{ id: "2", name: "Ann", ssrc: 7 }, { id: "3", name: "Bob" }], answer }));
    await flush();
    expect(speakers.querySelectorAll("audio")).toHaveLength(1);
    pc().setConnection("connected");
    expect(roster.textContent).not.toContain("Connecting…");
    expect(sfuSent.at(-1)).toEqual({ t: "ssrc", audio: 3735928559 });
    // Speaking goes to the server.
    const mic = (await (env.getUserMedia as ReturnType<typeof vi.fn>).mock.results[0]!.value) as FakeStream;
    levels.set(mic.tracks[0]!.id, SPEAKING_LEVEL * 2);
    vi.advanceTimersByTime(METER_MS);
    expect(sfuSent.at(-1)).toEqual({ t: "speaking", on: true });
    // A device switch sends the new microphone in place.
    await call.configure({ ...(await import("../../src/shared/settings")).DEFAULT_SETTINGS.voice, echoCancellation: false });
    expect(env.getUserMedia).toHaveBeenCalledTimes(2);
    // A new call starts afresh; leaving closes the connection.
    await call.sync(session({ callId: "c2" }));
    await flush();
    expect(pc().close).toHaveBeenCalled();
    expect(FakePC.all).toHaveLength(2);
    await call.sync(null);
    expect(pc(1).close).toHaveBeenCalled();
    expect(roster.hidden).toBe(true);
  });

  it("sends its signals nowhere when given no way to send them", async () => {
    const quiet = new PeerCall(document.getElementById("stage")!, speakers, roster, onError, vi.fn(), env);
    await quiet.sync(session({}, { mute: true }));
    await flush();
    expect(FakePC.all).toHaveLength(1);
    await quiet.sync(null);
  });

  it("lists who is muted, and opens the microphone into a link made while muted when unmuted", async () => {
    await call.sync(session({ peers: [{ id: "2", name: "Ann", ssrc: 7, muted: true, avatarUrl: "https://cdn.example/a.png" }] }, { mute: true }));
    await flush();
    expect(pc().transceivers[0]!.sender.track).toBeNull();
    expect(roster.textContent).toContain("Muted");
    await call.sync(session({ peers: [] }, { mute: false }));
    await flush();
    expect(pc().transceivers[0]!.sender.track).not.toBeNull();
  });
});
