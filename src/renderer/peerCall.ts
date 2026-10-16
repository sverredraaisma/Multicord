import { MAX_CALL_PARTICIPANTS, MESH_SOURCES, peerCall, type MeshSignal, type MeshSource, type MeshTrack, type NativeCallPeer, type NativePeerCall, type NativeVoiceSession, type VoiceNoticeFlag, type VoiceSignal } from "../shared/native";
import { DEFAULT_SETTINGS, type VoiceSettings } from "../shared/settings";
import { avatar } from "./components/avatar";
import { el } from "./components/dom";
import { level, resolveDevice, type DeviceInfo } from "./media";

/** A sound level above this (RMS of the signal, 0 to 1) counts as speaking. */
export const SPEAKING_LEVEL = 0.03;
/** How often speaking is measured. */
export const METER_MS = 200;
export const NO_RELAY = "This call is set to go through a relay only, and the service gave no relay (TURN) server, so Multicord does not connect.";

/** How loud a track is now. */
export interface LevelMeter {
  level(): number;
  stop(): void;
}

/** RNNoise on the microphone (RnnoiseProcessor): it cleans `track` and hands out `processedTrack`. */
export interface MicProcessor {
  init(options: { kind: "audio"; track: MediaStreamTrack }): Promise<void>;
  processedTrack?: MediaStreamTrack;
  destroy(): Promise<void>;
}

/** The browser as the call uses it, so tests can stand in for it. */
export interface PeerCallEnv {
  connect(config: RTCConfiguration): RTCPeerConnection;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  devices(): Promise<DeviceInfo[]>;
  stream(tracks: MediaStreamTrack[]): MediaStream;
  meter(track: MediaStreamTrack): LevelMeter;
  /** A data channel's name: random, as simple-peer makes it. */
  label(): string;
}

/** The browser's own: peer connections, devices, and level meters on one shared audio context. */
export function browserPeerEnv(win: Window & typeof globalThis): PeerCallEnv {
  let context: AudioContext | undefined;
  return {
    connect: (config) => new win.RTCPeerConnection(config),
    getUserMedia: (constraints) => win.navigator.mediaDevices.getUserMedia(constraints),
    devices: async () => (await win.navigator.mediaDevices?.enumerateDevices?.()) ?? [],
    stream: (tracks) => new win.MediaStream(tracks),
    meter: (track) => {
      context ??= new win.AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      const source = context.createMediaStreamSource(new win.MediaStream([track]));
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      return {
        level: () => {
          analyser.getByteTimeDomainData(samples);
          return level(samples);
        },
        stop: () => source.disconnect(),
      };
    },
    label: () => Array.from(win.crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

interface LinkEvents {
  signal(signal: VoiceSignal): void;
  track(track: MediaStreamTrack, stream: MediaStream | undefined): void;
  state(state: RTCPeerConnectionState): void;
}

/**
 * One connection to one peer, negotiated the way simple-peer (Nerimity's
 * own client) negotiates, so the two understand each other: only the
 * initiator makes offers, the other side asks it to renegotiate or for a
 * transceiver; changes made at once are negotiated once; ICE candidates
 * trickle and wait for the remote description. The initiator opens a data
 * channel, which simple-peer needs before it calls a peer connected.
 */
export class PeerLink {
  private negotiating = false;
  private queued = false;
  private batched = false;
  private first = true;
  private closed = false;
  private readonly pending: RTCIceCandidateInit[] = [];
  private readonly senders = new Map<MediaStreamTrack, RTCRtpSender>();
  private readonly requested = new WeakSet<RTCRtpTransceiver>();
  private channel: RTCDataChannel | undefined;

  constructor(
    private readonly pc: RTCPeerConnection,
    readonly initiator: boolean,
    label: string,
    private readonly on: LinkEvents,
  ) {
    pc.onicecandidate = (event) => {
      const c = event.candidate;
      if (c) this.emit({ type: "candidate", candidate: { candidate: c.candidate, sdpMLineIndex: c.sdpMLineIndex, sdpMid: c.sdpMid } });
    };
    pc.onsignalingstatechange = () => this.onSignalingState();
    pc.onconnectionstatechange = () => this.on.state(pc.connectionState);
    pc.ontrack = (event) => this.on.track(event.track, event.streams[0]);
    if (initiator) this.channel = pc.createDataChannel(label);
    else pc.ondatachannel = (event) => (this.channel = event.channel);
    this.needsNegotiation();
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    if (this.closed || this.senders.has(track)) return;
    this.senders.set(track, this.pc.addTrack(track, stream));
    this.needsNegotiation();
  }

  /** Sends another track in a track's place (a device switched), with no negotiation. */
  replaceTrack(old: MediaStreamTrack, next: MediaStreamTrack): void {
    const sender = this.senders.get(old);
    if (!sender) return;
    this.senders.delete(old);
    this.senders.set(next, sender);
    void sender.replaceTrack(next).catch(() => undefined);
  }

  removeTrack(track: MediaStreamTrack): void {
    const sender = this.senders.get(track);
    if (!sender) return;
    this.senders.delete(track);
    if (this.closed) return;
    this.pc.removeTrack(sender);
    this.needsNegotiation();
  }

  /** A signal from the peer. */
  signal(signal: VoiceSignal): void {
    if (this.closed) return;
    switch (signal.type) {
      case "renegotiate":
        if (this.initiator) this.needsNegotiation();
        return;
      case "transceiverRequest":
        if (!this.initiator) return;
        try {
          this.pc.addTransceiver(signal.transceiverRequest.kind);
        } catch {
          return this.fail();
        }
        this.needsNegotiation();
        return;
      case "candidate":
        if (this.pc.remoteDescription?.type) void this.addCandidate(signal.candidate);
        else this.pending.push(signal.candidate);
        return;
      default:
        void this.describe(signal);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.onicecandidate = null;
    this.pc.onsignalingstatechange = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ontrack = null;
    this.pc.ondatachannel = null;
    this.channel?.close();
    this.pc.close();
  }

  /** Changes made in one go are negotiated once; the other side's very first one waits for the initiator's offer. */
  private needsNegotiation(): void {
    if (this.batched) return;
    this.batched = true;
    queueMicrotask(() => {
      this.batched = false;
      if (this.initiator || !this.first) this.negotiate();
      this.first = false;
    });
  }

  private negotiate(): void {
    if (this.closed) return;
    if (this.negotiating) {
      this.queued = true;
      return;
    }
    this.negotiating = true;
    if (this.initiator) void this.offer();
    else this.emit({ type: "renegotiate", renegotiate: true });
  }

  private onSignalingState(): void {
    if (this.pc.signalingState !== "stable") return;
    this.negotiating = false;
    if (!this.queued) return;
    this.queued = false;
    this.needsNegotiation();
  }

  private async offer(): Promise<void> {
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this.sendDescription();
    } catch {
      this.fail();
    }
  }

  private async describe(signal: { type: "offer" | "answer"; sdp: string }): Promise<void> {
    try {
      await this.pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
      if (this.closed) return;
      for (const candidate of this.pending.splice(0)) void this.addCandidate(candidate);
      if (this.pc.remoteDescription?.type !== "offer") return;
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      this.sendDescription();
      if (!this.initiator) this.requestMissing();
    } catch {
      this.fail();
    }
  }

  /** A candidate the browser cannot use is left out, as simple-peer leaves it. */
  private async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private sendDescription(): void {
    const description = this.pc.localDescription;
    if (description) this.emit({ type: description.type as "offer" | "answer", sdp: description.sdp });
  }

  /** A closed connection says nothing more. */
  private emit(signal: VoiceSignal): void {
    if (!this.closed) this.on.signal(signal);
  }

  /** Tracks the offer had no place for: the initiator is asked for a transceiver of their kind, once each. */
  private requestMissing(): void {
    for (const transceiver of this.pc.getTransceivers()) {
      const track = transceiver.sender.track;
      if (transceiver.mid || !track || this.requested.has(transceiver)) continue;
      this.requested.add(transceiver);
      this.emit({ type: "transceiverRequest", transceiverRequest: { kind: track.kind as "audio" | "video" } });
    }
  }

  private fail(): void {
    if (this.closed) return;
    this.close();
    this.on.state("failed");
  }
}

interface MeshEvents {
  signal(signal: MeshSignal): void;
  /** A track of the peer's to play or show, until `untrack`. */
  track(track: MediaStreamTrack): void;
  untrack(track: MediaStreamTrack): void;
  state(state: RTCPeerConnectionState): void;
}

/** What kind of track each source of a Fluxer call carries. */
const MESH_KINDS: Record<MeshSource, "audio" | "video"> = { microphone: "audio", camera: "video", screen_share: "video", screen_share_audio: "audio" };

/**
 * One connection to one peer of a Fluxer call, negotiated as Fluxer's own
 * client negotiates (VoiceMeshPeer in fluxer_app/src/features/voice/engine/
 * mesh/), so the two understand each other. The side whose connection id
 * sorts first offers; the other asks for an offer (need-offer). Each offer
 * starts a generation (`g`): a new connection carrying four transceivers in
 * a fixed order (MESH_SOURCES), sending both ways, so tracks come and go
 * by replacing what a transceiver sends, never by renegotiating. Each side
 * says which tracks it has (`tracks`) and which of the other's it wants
 * (`want`), and sends only what is wanted. A failed connection gets one ICE
 * restart within its generation.
 */
export class MeshLink {
  private pc: RTCPeerConnection | undefined;
  private transceivers: RTCRtpTransceiver[] = [];
  private generation = 0;
  private answered = false;
  private restarting = false;
  private closed = false;
  private started = false;
  private queue: Promise<void> = Promise.resolve();
  /** What the user sends, by source. */
  private readonly local = new Map<MeshSource, MediaStreamTrack>();
  private micMuted = true;
  /** Counts up for each tracks or want message, as Fluxer's client counts (from the time). */
  private version = Date.now();
  private tracks: { v: number; tracks: MeshTrack[] } = { v: this.version, tracks: [] };
  private remoteTracks: MeshTrack[] = [];
  private remoteTracksVersion = 0;
  private remoteWant = new Set<string>();
  private remoteWantVersion = 0;
  private localWant: { v: number; sids: string[] } | undefined;
  /** The peer's tracks played or shown, by source. */
  private readonly shown = new Map<MeshSource, MediaStreamTrack>();

  constructor(
    private readonly connect: () => RTCPeerConnection,
    readonly offerer: boolean,
    /** The user's own connection id, which names the tracks they send. */
    private readonly self: string,
    /** The peer's connection id, which names theirs. */
    private readonly peer: string,
    /** The peer is server-muted: their microphone is not wanted. */
    private peerMuted: boolean,
    private readonly on: MeshEvents,
  ) {}

  /** Starts the first generation: the offerer offers, the other asks for an offer (and is told what the user has). */
  start(): void {
    this.started = true;
    if (this.offerer) return void this.enqueue(() => this.startGeneration());
    this.send({ t: "need-offer", g: 0 });
    this.send({ t: "tracks", ...this.tracks });
  }

  /** Sends a track (the microphone, or the camera) where the peer wants it. */
  addTrack(track: MediaStreamTrack, _stream?: MediaStream): void {
    this.local.set(track.kind === "audio" ? "microphone" : "camera", track);
    this.publish();
  }

  /** Sends another track in a track's place (a device switched). */
  replaceTrack(old: MediaStreamTrack, next: MediaStreamTrack): void {
    for (const [src, track] of this.local) if (track === old) this.local.set(src, next);
    this.syncSenders();
  }

  removeTrack(track: MediaStreamTrack): void {
    for (const [src, sent] of this.local) if (sent === track) this.local.delete(src);
    this.publish();
  }

  /** The user muted or unmuted; the peer is told with the tracks. */
  setMuted(muted: boolean): void {
    this.micMuted = muted;
    this.publish();
  }

  /** The peer was server-muted or no longer is: their microphone is wanted only when not. */
  setPeerMuted(muted: boolean): void {
    if (this.peerMuted === muted) return;
    this.peerMuted = muted;
    this.updateWant();
  }

  /** A signal from the peer. */
  signal(signal: MeshSignal): void {
    if (this.closed) return;
    switch (signal.t) {
      case "tracks":
        return this.receiveTracks(signal.v, signal.tracks);
      case "want":
        if (signal.v <= this.remoteWantVersion) return;
        this.remoteWantVersion = signal.v;
        this.remoteWant = new Set(signal.sids);
        return this.syncSenders();
      default:
        void this.enqueue(() => this.negotiate(signal));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resetTransport();
  }

  private sid(src: MeshSource, connection: string): string {
    return `TR_${connection}_${src}`;
  }

  /** Tells the peer what the user sends now, if that changed, and sends it where wanted. */
  private publish(): void {
    const tracks = MESH_SOURCES.filter((src) => this.local.has(src)).map((src) => ({ src, sid: this.sid(src, this.self), m: src === "microphone" && this.micMuted }));
    if (JSON.stringify(tracks) !== JSON.stringify(this.tracks.tracks)) {
      this.tracks = { v: ++this.version, tracks };
      // Before the start, the first messages carry them.
      if (this.started) this.send({ t: "tracks", ...this.tracks });
    }
    this.syncSenders();
  }

  private receiveTracks(v: number, tracks: MeshTrack[]): void {
    // Each is the peer's own, named as Fluxer's client names them.
    if (v <= this.remoteTracksVersion || tracks.some((t) => t.sid !== this.sid(t.src, this.peer))) return;
    this.remoteTracksVersion = v;
    this.remoteTracks = tracks;
    this.updateWant();
  }

  /** Wants all the peer has, but a server-muted peer's microphone; tells them when that changes. */
  private updateWant(): void {
    const sids = this.remoteTracks.filter((t) => !(t.src === "microphone" && this.peerMuted)).map((t) => t.sid).sort();
    if (JSON.stringify(sids) !== JSON.stringify(this.localWant?.sids ?? [])) {
      this.localWant = { v: ++this.version, sids };
      this.send({ t: "want", ...this.localWant });
    }
    this.syncReceivers();
  }

  /** Each transceiver sends the user's track for its source where the peer wants it, else nothing. */
  private syncSenders(): void {
    MESH_SOURCES.forEach((src, index) => {
      const sender = this.transceivers[index]?.sender;
      if (!sender) return;
      const track = this.local.get(src);
      const wanted = track && this.remoteWant.has(this.sid(src, this.self)) ? track : null;
      if (sender.track !== wanted) void sender.replaceTrack(wanted).catch(() => undefined);
    });
  }

  /** Plays or shows what the peer sends and is wanted; stops what no longer is. */
  private syncReceivers(): void {
    MESH_SOURCES.forEach((src, index) => {
      const info = this.remoteTracks.find((t) => t.src === src);
      const receiver = info && this.localWant?.sids.includes(info.sid) ? this.transceivers[index]?.receiver.track : undefined;
      const shown = this.shown.get(src);
      if (shown === receiver) return;
      if (shown) this.on.untrack(shown);
      this.shown.delete(src);
      if (!receiver) return;
      this.shown.set(src, receiver);
      this.on.track(receiver);
    });
  }

  private async negotiate(signal: Exclude<MeshSignal, { t: "tracks" } | { t: "want" }>): Promise<void> {
    const pc = this.pc;
    switch (signal.t) {
      case "offer":
        if (this.offerer || signal.g < this.generation) return;
        if (signal.g > this.generation) return this.acceptGeneration(signal.g, signal.sdp);
        // The same generation: an ICE restart.
        if (!pc) return;
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        if (!this.isStale(pc, signal.g)) await this.sendAnswer(pc, signal.g);
        return;
      case "answer":
        if (!this.offerer || !pc || signal.g !== this.generation || pc.signalingState !== "have-local-offer") return;
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        if (!this.isStale(pc, signal.g)) this.answered = true;
        return;
      case "ice":
        if (!pc || signal.g !== this.generation) return;
        // A candidate the browser cannot use is left out, as Fluxer's client leaves it.
        await pc.addIceCandidate(signal.c).catch(() => undefined);
        return;
      default:
        if (!this.offerer) return;
        if (signal.restart) {
          if (signal.g === this.generation) await this.recover();
          return;
        }
        if (signal.g === this.generation && this.answered) return;
        return this.startGeneration();
    }
  }

  private async startGeneration(): Promise<void> {
    const g = this.generation === 0 ? Date.now() : this.generation + 1;
    const pc = this.begin(g);
    this.transceivers = MESH_SOURCES.map((src) => pc.addTransceiver(MESH_KINDS[src], { direction: "sendrecv" }));
    this.transportReady();
    const offer = await pc.createOffer();
    if (this.isStale(pc, g)) return;
    await pc.setLocalDescription(offer);
    if (!this.isStale(pc, g)) this.send({ t: "offer", g, sdp: offer.sdp ?? "" });
  }

  private async acceptGeneration(g: number, sdp: string): Promise<void> {
    const pc = this.begin(g);
    await pc.setRemoteDescription({ type: "offer", sdp });
    if (this.isStale(pc, g)) return;
    const transceivers = pc.getTransceivers();
    // Fluxer's offers carry its four transceivers in their order; anything else is not one.
    if (transceivers.length !== MESH_SOURCES.length || MESH_SOURCES.some((src, i) => transceivers[i]!.receiver.track.kind !== MESH_KINDS[src])) return this.fail();
    for (const transceiver of transceivers) transceiver.direction = "sendrecv";
    this.transceivers = transceivers;
    this.transportReady();
    await this.sendAnswer(pc, g);
  }

  private async sendAnswer(pc: RTCPeerConnection, g: number): Promise<void> {
    const answer = await pc.createAnswer();
    if (this.isStale(pc, g)) return;
    await pc.setLocalDescription(answer);
    if (!this.isStale(pc, g)) this.send({ t: "answer", g, sdp: answer.sdp ?? "" });
  }

  /** An ICE restart in this generation: the offerer offers again, the other asks it to. */
  private async recover(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    this.restarting = true;
    if (!this.offerer) return this.send({ t: "need-offer", g: this.generation, restart: true });
    const offer = await pc.createOffer({ iceRestart: true });
    if (this.isStale(pc, this.generation)) return;
    await pc.setLocalDescription(offer);
    if (!this.isStale(pc, this.generation)) this.send({ t: "offer", g: this.generation, sdp: offer.sdp ?? "" });
  }

  /** A new generation: a new connection in place of the old. */
  private begin(g: number): RTCPeerConnection {
    this.resetTransport();
    this.generation = g;
    this.answered = false;
    this.restarting = false;
    const pc = this.connect();
    pc.onicecandidate = (event) => {
      const c = event.candidate;
      if (this.pc === pc) this.send({ t: "ice", g, c: c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment } : null });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc) this.onState(pc.connectionState);
    };
    this.pc = pc;
    this.on.state("connecting");
    return pc;
  }

  /** The transceivers are there: send and show what is wanted, and tell the peer what the user has and wants. */
  private transportReady(): void {
    this.syncSenders();
    this.syncReceivers();
    this.send({ t: "tracks", ...this.tracks });
    if (this.localWant) this.send({ t: "want", ...this.localWant });
  }

  private onState(state: RTCPeerConnectionState): void {
    if (state === "connected") this.restarting = false;
    if (state !== "failed") return this.on.state(state);
    // Failed: one ICE restart, then given up.
    if (this.restarting) return this.fail();
    void this.enqueue(() => this.recover());
  }

  private isStale(pc: RTCPeerConnection, g: number): boolean {
    return this.closed || this.pc !== pc || this.generation !== g;
  }

  private send(signal: MeshSignal): void {
    if (!this.closed) this.on.signal(signal);
  }

  private resetTransport(): void {
    for (const track of this.shown.values()) this.on.untrack(track);
    this.shown.clear();
    const pc = this.pc;
    this.pc = undefined;
    this.transceivers = [];
    if (!pc) return;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
  }

  private fail(): void {
    if (this.closed) return;
    this.resetTransport();
    this.on.state("failed");
  }

  /** Negotiation steps run one at a time; one that fails gives the connection up. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(() => (this.closed ? undefined : task())).catch(() => this.fail());
    return this.queue;
  }
}

type Flags = Pick<NativeVoiceSession, "mute" | "deaf" | "video">;

interface Mic {
  /** What the connections send: the microphone's own stream, or the cleaned track's. */
  stream: MediaStream;
  raw: MediaStreamTrack;
  sent: MediaStreamTrack;
  processor?: MicProcessor;
  meter?: LevelMeter;
  /** The device and processing it was opened with. */
  key: string;
}

interface Camera {
  stream: MediaStream;
  track: MediaStreamTrack;
  key: string;
  tile: HTMLElement;
}

interface Remote {
  peer: string;
  element: HTMLElement;
  meter?: LevelMeter;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const STATE_TEXT: Partial<Record<RTCPeerConnectionState, string>> = {
  new: "Connecting…",
  connecting: "Connecting…",
  disconnected: "Connection lost",
  failed: "Could not connect",
  closed: "Could not connect",
};

const hasRelay = (call: NativePeerCall): boolean => call.iceServers.some((server) => server.urls.some((url) => url.startsWith("turn")));

/**
 * A peer-to-peer call (NativePeerCall): one connection per other person,
 * the user's microphone (through RNNoise where that setting is on) and
 * camera sent on each, their sound played and their cameras shown, and who
 * is speaking marked in the list of who is in the call. Signals go out
 * through `onSignal` and come in with the session, never straight to the
 * platform. Only the session's own ICE servers are used, and with
 * `relayOnly` only their relays, so peers never learn the user's address.
 * Updates are serialised, as the view state can change faster than devices
 * open.
 */
export class PeerCall {
  private call: NativePeerCall | undefined;
  private flags: Flags = { mute: true, deaf: false, video: false };
  /** The last signal acted on, within this call. */
  private lastSeq = -1;
  private readonly links = new Map<string, PeerLink | MeshLink>();
  private readonly states = new Map<string, RTCPeerConnectionState>();
  /** Remote sound and video, by track id. */
  private readonly remote = new Map<string, Remote>();
  private mic: Mic | undefined;
  private camera: Camera | undefined;
  /** The microphone or camera would not open: not asked again until turned off and on. */
  private micFailed = false;
  private cameraFailed = false;
  private output: string | undefined;
  private speaking = new Set<string>();
  private ticker: ReturnType<typeof setInterval> | undefined;
  private settings: VoiceSettings = DEFAULT_SETTINGS.voice;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly stage: HTMLElement,
    private readonly speakers: HTMLElement,
    /** The list of who is in the call, kept here. */
    private readonly roster: HTMLElement,
    /** Reports a problem. With a notice the call goes on (`off` names a flag that could not be turned on); without one the call is lost. */
    private readonly onError: (message: string, notice?: { off?: VoiceNoticeFlag }) => void,
    /** Sends a signal to one peer, through the engine. */
    private readonly onSignal: (to: string, signal: VoiceSignal | MeshSignal) => void,
    private readonly env: PeerCallEnv = browserPeerEnv(globalThis as Window & typeof globalThis),
    /** Makes the enhanced noise suppression processor; absent where it cannot run. */
    private readonly denoiser?: () => MicProcessor,
  ) {}

  /**
   * Uses these devices and this processing from now on: the speakers at
   * once, a microphone or camera already open by opening it again and
   * sending the new track in its place.
   */
  configure(settings: VoiceSettings): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        this.settings = settings;
        if (!this.call) return;
        const ids = await this.deviceIds();
        this.output = ids.output;
        for (const audio of this.speakers.querySelectorAll("audio")) this.sink(audio);
        if (this.mic && this.mic.key !== this.micKey(ids.input)) await this.restartMic();
        if (this.camera && this.camera.key !== (ids.camera ?? "")) await this.restartCamera();
      })
      // The call goes on with the devices it had.
      .catch((error: unknown) => this.onError(`Could not switch devices: ${message(error)}`, {}));
    return this.queue;
  }

  /** Brings the call in line with the session; null (or a session without a peer-to-peer call) leaves. Resolves once applied. */
  sync(session: NativeVoiceSession | null): Promise<void> {
    this.queue = this.queue.then(() => this.apply(session)).catch((error: unknown) => this.onError(message(error)));
    return this.queue;
  }

  private async apply(session: NativeVoiceSession | null): Promise<void> {
    const call = session ? peerCall(session.p2p) : undefined;
    if (!session || !call) return this.leave();
    if (call.callId !== this.call?.callId) {
      this.leave();
      // Relay only, with no relay to go through: nothing could connect, and nothing goes another way.
      if (call.relayOnly && !hasRelay(call)) throw new Error(NO_RELAY);
      this.call = call;
      this.output = (await this.deviceIds()).output;
      this.ticker = setInterval(() => this.measure(), METER_MS);
    }
    this.call = call;
    for (const id of [...this.links.keys()]) if (!call.peers.some((p) => p.id === id)) this.dropPeer(id);
    await this.setFlags(session);
    // In Fluxer's calls both sides start at once: the one who does not offer asks for an offer.
    const mesh = call.protocol === "fluxer-mesh";
    for (const peer of call.peers) if ((peer.offer || mesh) && !this.links.has(peer.id)) this.open(peer, peer.offer);
    for (const peer of call.peers) {
      const link = this.links.get(peer.id);
      if (link instanceof MeshLink) link.setPeerMuted(peer.muted === true);
    }
    for (const { seq, from, signal } of call.signals) {
      if (seq <= this.lastSeq) continue;
      this.lastSeq = seq;
      // Someone who joined before the user offers first; their offer opens the connection.
      const link = this.links.get(from) ?? this.open(call.peers.find((p) => p.id === from)!, false);
      // peerCall() kept only the signals of the call's own protocol.
      if (link instanceof MeshLink) link.signal(signal as MeshSignal);
      else link.signal(signal as VoiceSignal);
    }
    this.renderRoster();
  }

  private async setFlags(flags: Flags): Promise<void> {
    const micOn = !flags.mute && !flags.deaf;
    if (!micOn) this.micFailed = false;
    if (!flags.video) this.cameraFailed = false;
    if (micOn && !this.mic) await this.startMic();
    // Muted: the track stays, silent, so unmuting (push to talk) needs no negotiation.
    if (this.mic) this.mic.raw.enabled = this.mic.sent.enabled = micOn;
    // Fluxer's peers are told (the microphone's track info), as Fluxer's client tells them.
    for (const link of this.links.values()) if (link instanceof MeshLink) link.setMuted(!micOn);
    for (const audio of this.speakers.querySelectorAll("audio")) audio.muted = flags.deaf;
    if (flags.video && !this.camera) await this.startCamera();
    else if (!flags.video && this.camera) this.stopCamera();
    this.flags = { mute: flags.mute, deaf: flags.deaf, video: flags.video };
  }

  private async deviceIds(): Promise<{ input?: string; output?: string; camera?: string }> {
    const { input, output, camera } = this.settings;
    if (!input && !output && !camera) return {};
    const devices = await this.env.devices();
    return {
      input: resolveDevice(devices, "audioinput", input),
      output: resolveDevice(devices, "audiooutput", output),
      camera: resolveDevice(devices, "videoinput", camera),
    };
  }

  private micKey(input: string | undefined): string {
    const { echoCancellation, noiseSuppression, autoGainControl, enhancedNoiseSuppression } = this.settings;
    return JSON.stringify([input ?? "", echoCancellation, noiseSuppression, autoGainControl, enhancedNoiseSuppression && this.denoiser !== undefined]);
  }

  private meter(track: MediaStreamTrack): LevelMeter | undefined {
    try {
      return this.env.meter(track);
    } catch {
      return undefined; // No speaking marks for it; the sound plays all the same.
    }
  }

  private async startMic(): Promise<void> {
    if (this.micFailed) return;
    try {
      this.mic = await this.openMic();
    } catch (error) {
      this.micFailed = true;
      this.onError(`The microphone could not start: ${message(error)}`, {});
      return;
    }
    for (const link of this.links.values()) link.addTrack(this.mic.sent, this.mic.stream);
  }

  private async openMic(): Promise<Mic> {
    const ids = await this.deviceIds();
    const { echoCancellation, noiseSuppression, autoGainControl, enhancedNoiseSuppression } = this.settings;
    const audio: MediaTrackConstraints = { echoCancellation, noiseSuppression, autoGainControl };
    if (ids.input) audio.deviceId = { exact: ids.input };
    const stream = await this.env.getUserMedia({ audio, video: false });
    const raw = stream.getAudioTracks()[0];
    if (!raw) throw new Error("no microphone was given");
    const mic: Mic = { stream, raw, sent: raw, key: this.micKey(ids.input) };
    if (enhancedNoiseSuppression && this.denoiser) {
      const processor = this.denoiser();
      try {
        await processor.init({ kind: "audio", track: raw });
        if (!processor.processedTrack) throw new Error("it gave no sound");
        mic.processor = processor;
        mic.sent = processor.processedTrack;
        mic.stream = this.env.stream([mic.sent]);
      } catch (error) {
        await processor.destroy().catch(() => undefined);
        this.onError(`Enhanced noise suppression could not start: ${message(error)}`, {});
      }
    }
    mic.meter = this.meter(mic.sent);
    return mic;
  }

  private closeMic(mic: Mic): void {
    mic.meter?.stop();
    void mic.processor?.destroy().catch(() => undefined);
    mic.raw.stop();
    if (mic.sent !== mic.raw) mic.sent.stop();
  }

  private async restartMic(): Promise<void> {
    const old = this.mic!;
    const next = await this.openMic();
    next.raw.enabled = next.sent.enabled = old.sent.enabled;
    this.mic = next;
    for (const link of this.links.values()) link.replaceTrack(old.sent, next.sent);
    this.closeMic(old);
  }

  private async startCamera(): Promise<void> {
    if (this.cameraFailed) return;
    try {
      this.camera = await this.openCamera();
    } catch (error) {
      this.cameraFailed = true;
      this.onError(`The camera could not start: ${message(error)}`, { off: "video" });
      return;
    }
    for (const link of this.links.values()) link.addTrack(this.camera.track, this.camera.stream);
  }

  private async openCamera(): Promise<Camera> {
    const ids = await this.deviceIds();
    const stream = await this.env.getUserMedia({ audio: false, video: ids.camera ? { deviceId: { exact: ids.camera } } : true });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("no camera was given");
    const camera: Camera = { stream, track, key: ids.camera ?? "", tile: this.tile(stream, "You", this.call!.self, true) };
    // Unplugged or taken by the system: the camera goes off for everyone.
    track.addEventListener("ended", () => {
      if (this.camera === camera) this.onError("The camera stopped.", { off: "video" });
    });
    return camera;
  }

  private stopCamera(): void {
    const camera = this.camera!;
    this.camera = undefined;
    for (const link of this.links.values()) link.removeTrack(camera.track);
    camera.track.stop();
    camera.tile.remove();
    this.updateStage();
  }

  private async restartCamera(): Promise<void> {
    const old = this.camera!;
    const next = await this.openCamera();
    this.camera = next;
    for (const link of this.links.values()) link.replaceTrack(old.track, next.track);
    old.track.stop();
    old.tile.remove();
  }

  /** A connection to a peer, sending what the user sends now. */
  private open(peer: NativeCallPeer, initiator: boolean): PeerLink | MeshLink {
    const call = this.call!;
    const config: RTCConfiguration = { iceServers: call.iceServers, iceTransportPolicy: call.relayOnly ? "relay" : "all" };
    const state = (state: RTCPeerConnectionState): void => {
      this.states.set(peer.id, state);
      this.renderRoster();
    };
    // A connection given up (dropPeer, or its own failure) says nothing more, so these are always the current one's.
    const link =
      call.protocol === "fluxer-mesh"
        ? new MeshLink(() => this.env.connect({ ...config, bundlePolicy: "max-bundle" }), initiator, call.self, peer.id, peer.muted === true, {
            signal: (signal) => this.onSignal(peer.id, signal),
            track: (track) => this.addRemote(peer, track, undefined),
            untrack: (track) => this.removeRemote(track.id),
            state,
          })
        : new PeerLink(this.env.connect(config), initiator, this.env.label(), {
            signal: (signal) => this.onSignal(peer.id, signal),
            track: (track, stream) => this.addRemote(peer, track, stream),
            state,
          });
    this.links.set(peer.id, link);
    this.states.set(peer.id, "new");
    if (this.mic) link.addTrack(this.mic.sent, this.mic.stream);
    if (this.camera) link.addTrack(this.camera.track, this.camera.stream);
    if (link instanceof MeshLink) {
      link.setMuted(this.flags.mute || this.flags.deaf);
      link.start();
    }
    return link;
  }

  private dropPeer(id: string): void {
    this.links.get(id)!.close();
    this.links.delete(id);
    this.states.delete(id);
    for (const [trackId, entry] of this.remote) if (entry.peer === id) this.removeRemote(trackId);
  }

  private addRemote(peer: NativeCallPeer, track: MediaStreamTrack, stream: MediaStream | undefined): void {
    if (this.remote.has(track.id)) return;
    const doc = this.speakers.ownerDocument;
    let entry: Remote;
    if (track.kind === "audio") {
      const audio = el(doc, "audio");
      audio.autoplay = true;
      audio.srcObject = this.env.stream([track]);
      audio.muted = this.flags.deaf;
      this.sink(audio);
      this.speakers.append(audio);
      entry = { peer: peer.id, element: audio, meter: this.meter(track) };
    } else {
      entry = { peer: peer.id, element: this.tile(this.env.stream([track]), peer.name, peer.id, false) };
    }
    this.remote.set(track.id, entry);
    const drop = (): void => this.removeRemote(track.id);
    track.addEventListener("ended", drop);
    // The peer stopped sending it (a camera turned off): its stream says so.
    stream?.addEventListener("removetrack", (event) => {
      if ((event as MediaStreamTrackEvent).track === track) drop();
    });
  }

  private removeRemote(trackId: string): void {
    const entry = this.remote.get(trackId);
    if (!entry) return;
    this.remote.delete(trackId);
    entry.meter?.stop();
    entry.element.remove();
    this.updateStage();
  }

  private tile(stream: MediaStream, label: string, peer: string, local: boolean): HTMLElement {
    const doc = this.stage.ownerDocument;
    const tile = el(doc, "figure", local ? "video-tile local" : "video-tile");
    tile.dataset.peer = peer;
    const video = el(doc, "video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    tile.append(video, el(doc, "figcaption", undefined, label));
    this.stage.append(tile);
    this.stage.hidden = false;
    return tile;
  }

  private updateStage(): void {
    this.stage.hidden = this.stage.children.length === 0;
  }

  private sink(audio: HTMLAudioElement): void {
    const media = audio as HTMLAudioElement & { setSinkId?(id: string): Promise<void> };
    if (this.output && media.setSinkId) void media.setSinkId(this.output).catch(() => undefined);
  }

  /** Who is speaking now: the user while the microphone is on, and each peer by their sound. */
  private measure(): void {
    const call = this.call!;
    const now = new Set<string>();
    if (this.mic?.meter && !this.flags.mute && !this.flags.deaf && this.mic.meter.level() > SPEAKING_LEVEL) now.add(call.self);
    for (const entry of this.remote.values()) if (entry.meter && entry.meter.level() > SPEAKING_LEVEL) now.add(entry.peer);
    if (now.size === this.speaking.size && [...now].every((id) => this.speaking.has(id))) return;
    this.speaking = now;
    for (const item of [...this.roster.querySelectorAll<HTMLElement>("[data-peer]"), ...this.stage.querySelectorAll<HTMLElement>("[data-peer]")]) {
      item.classList.toggle("speaking", now.has(item.dataset.peer!));
    }
  }

  /** The list of who is in the call: the user, then each peer with how their connection stands. */
  private renderRoster(): void {
    const call = this.call;
    this.roster.hidden = !call;
    if (!call) {
      this.roster.replaceChildren();
      return;
    }
    const doc = this.roster.ownerDocument;
    const row = (id: string, name: string, avatarUrl: string | undefined, note: string | undefined): HTMLElement => {
      const item = el(doc, "li", "roster-member");
      item.dataset.peer = id;
      item.classList.toggle("speaking", this.speaking.has(id));
      item.append(avatar(doc, avatarUrl, name), el(doc, "span", "name", name));
      if (note) item.append(el(doc, "span", "roster-note", note));
      return item;
    };
    const rows = [row(call.self, "You", undefined, this.flags.mute || this.flags.deaf ? "Muted" : undefined), ...call.peers.map((p) => row(p.id, p.name, p.avatarUrl, STATE_TEXT[this.states.get(p.id) ?? "new"]))];
    if (call.over) rows.push(el(doc, "li", "roster-over", `${call.over} more in the call, not connected: calls here connect at most ${MAX_CALL_PARTICIPANTS} people.`));
    this.roster.replaceChildren(...rows);
  }

  private leave(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
    for (const id of [...this.links.keys()]) this.dropPeer(id);
    if (this.mic) this.closeMic(this.mic);
    this.camera?.track.stop();
    this.mic = undefined;
    this.camera = undefined;
    this.call = undefined;
    this.lastSeq = -1;
    this.micFailed = false;
    this.cameraFailed = false;
    this.speaking = new Set();
    this.flags = { mute: true, deaf: false, video: false };
    this.stage.replaceChildren();
    this.stage.hidden = true;
    this.speakers.replaceChildren();
    this.renderRoster();
  }
}
