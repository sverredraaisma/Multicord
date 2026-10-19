import type { NativeSfuPeer, SfuAnswer, SfuExtension, SfuSignal } from "../shared/native";

/** The header extensions a voice server of Discord's web protocol keeps for sound (Spacebar's PionSignalingDelegate.onOffer), by URI. */
export const SFU_AUDIO_EXTENSIONS = ["urn:ietf:params:rtp-hdrext:ssrc-audio-level", "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"] as const;
const TRANSPORT_CC = SFU_AUDIO_EXTENSIONS[1];

/** One m-section of a session description: its kind, mid, and its lines. */
interface Section {
  kind: string;
  mid: string;
  lines: string[];
}

/** The local description's sections, and the lines before them. */
function sections(sdp: string): { session: string[]; media: Section[] } {
  const session: string[] = [];
  const media: Section[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) media.push({ kind: line.slice(2).split(" ")[0]!, mid: "", lines: [] });
    const section = media.at(-1);
    if (!section) session.push(line);
    else {
      section.lines.push(line);
      if (line.startsWith("a=mid:")) section.mid = line.slice(6);
    }
  }
  return { session, media };
}

/** An attribute's value in a section, or else at session level. */
const attribute = (lines: string[], session: string[], name: string): string | undefined =>
  [...lines, ...session].find((line) => line.startsWith(`a=${name}:`))?.slice(name.length + 3);

/** What the offer tells the server, read from the browser's own description (undefined if it lacks any of it). */
export function offerSignal(sdp: string): { signal: Extract<SfuSignal, { t: "offer" }>; ssrc?: number } | undefined {
  const { session, media } = sections(sdp);
  const first = media.find((s) => s.kind === "audio");
  if (!first) return undefined;
  const ufrag = attribute(first.lines, session, "ice-ufrag");
  const pwd = attribute(first.lines, session, "ice-pwd");
  const fingerprint = attribute(first.lines, session, "fingerprint");
  const opus = first.lines.map((line) => /^a=rtpmap:(\d+) opus\/48000\/2$/i.exec(line)).find(Boolean)?.[1];
  if (!ufrag || !pwd || !fingerprint || !opus) return undefined;
  const extensions: SfuExtension[] = [];
  for (const line of first.lines) {
    const match = /^a=extmap:(\d+)(?:\/\w+)? (\S+)$/.exec(line);
    if (match && (SFU_AUDIO_EXTENSIONS as readonly string[]).includes(match[2]!)) extensions.push({ id: Number(match[1]), uri: match[2]! });
  }
  const ssrc = first.lines.map((line) => /^a=ssrc:(\d+) /.exec(line)).find(Boolean)?.[1];
  const result: { signal: Extract<SfuSignal, { t: "offer" }>; ssrc?: number } = { signal: { t: "offer", ufrag, pwd, fingerprint, opus: Number(opus), extensions } };
  if (ssrc) result.ssrc = Number(ssrc);
  return result;
}

/** The direction the server's side of a section takes: it receives the microphone, sends a peer's sound where one is assigned, else nothing. */
type Role = { kind: "mic" } | { kind: "peer"; peer: string; ssrc: number } | { kind: "idle" };

/**
 * The server's answer, written as a description of the browser's offer
 * (as Discord's web client writes it): every section bundled on the
 * server's one transport (its ICE credentials, fingerprint and candidate,
 * DTLS passive), Opus at the offer's payload type, the microphone's
 * section received, and each other section sending one peer's sound under
 * the SSRC the server named for them.
 */
export function answerDescription(offer: string, answer: SfuAnswer, opus: number, extensions: SfuExtension[], roles: Map<string, Role>, version: number): string {
  const { media } = sections(offer);
  const c = answer.candidate;
  const lines = ["v=0", `o=- 1 ${version} IN IP4 127.0.0.1`, "s=-", "t=0 0", `a=group:BUNDLE ${media.map((s) => s.mid).join(" ")}`, "a=msid-semantic: WMS *"];
  for (const section of media) {
    const role = roles.get(section.mid) ?? { kind: "idle" };
    lines.push(
      `m=audio ${answer.port} UDP/TLS/RTP/SAVPF ${opus}`,
      `c=IN IP4 ${answer.ip}`,
      `a=rtcp:${answer.port}`,
      `a=ice-ufrag:${answer.ufrag}`,
      `a=ice-pwd:${answer.pwd}`,
      `a=fingerprint:${answer.fingerprint}`,
      "a=setup:passive",
      `a=mid:${section.mid}`,
      role.kind === "mic" ? "a=recvonly" : role.kind === "peer" ? "a=sendonly" : "a=inactive",
      "a=rtcp-mux",
      `a=rtpmap:${opus} opus/48000/2`,
      `a=fmtp:${opus} minptime=10;useinbandfec=1;usedtx=1`,
    );
    if (extensions.some((e) => e.uri === TRANSPORT_CC)) lines.push(`a=rtcp-fb:${opus} transport-cc`);
    for (const e of extensions) lines.push(`a=extmap:${e.id} ${e.uri}`);
    if (role.kind === "peer") lines.push(`a=msid:p${role.ssrc} a${role.ssrc}`, `a=ssrc:${role.ssrc} cname:p${role.ssrc}`);
    lines.push(`a=candidate:${c.foundation} ${c.component} ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ host`, "a=end-of-candidates");
  }
  return `${lines.join("\r\n")}\r\n`;
}

interface SfuEvents {
  signal(signal: SfuSignal): void;
  /** A peer's sound to play, until `untrack`. */
  track(track: MediaStreamTrack, peer: string): void;
  untrack(track: MediaStreamTrack): void;
  state(state: RTCPeerConnectionState): void;
}

/** A section that plays one peer's sound, or waits for one. */
interface Slot {
  transceiver: RTCRtpTransceiver;
  peer?: string;
  ssrc?: number;
}

/**
 * The one connection of an SFU call (NativeSfuCall), negotiated as
 * Discord's web client negotiates with its voice server, which Spacebar's
 * follows: the browser offers once and the server answers with its few
 * fields, from which the description is written here; from then on the
 * browser alone renegotiates, adding a receiving section for each peer the
 * server names an SSRC for and writing the answer anew, so the server is
 * never asked again. The microphone goes out on the first section; its
 * SSRC is told the server once connected, as is whether the user speaks.
 */
export class SfuLink {
  private readonly pc: RTCPeerConnection;
  private readonly mic: RTCRtpTransceiver;
  private readonly slots: Slot[] = [];
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private answer: SfuAnswer | undefined;
  private offer: { opus: number; extensions: SfuExtension[]; ssrc?: number } | undefined;
  private version = 0;
  private connected = false;
  private ssrcSent = false;
  private speaking = false;
  /** What each slot plays now, and for whom. */
  private readonly shown = new Map<Slot, { track: MediaStreamTrack; peer: string }>();

  constructor(
    connect: () => RTCPeerConnection,
    private readonly on: SfuEvents,
  ) {
    this.pc = connect();
    this.mic = this.pc.addTransceiver("audio", { direction: "sendonly" });
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
    this.enqueue(() => this.sendOffer());
  }

  /** Sends the microphone. A camera is not sent: these calls carry sound alone. */
  addTrack(track: MediaStreamTrack, _stream?: MediaStream): void {
    if (track.kind === "audio") void this.mic.sender.replaceTrack(track).catch(() => undefined);
  }

  /** Sends another track in a track's place (a device switched). */
  replaceTrack(old: MediaStreamTrack, next: MediaStreamTrack): void {
    if (this.mic.sender.track === old) void this.mic.sender.replaceTrack(next).catch(() => undefined);
  }

  removeTrack(track: MediaStreamTrack): void {
    if (this.mic.sender.track === track) void this.mic.sender.replaceTrack(null).catch(() => undefined);
  }

  /** The server's answer; the description is written once it is here. */
  setAnswer(answer: SfuAnswer | undefined): void {
    if (!answer || JSON.stringify(answer) === JSON.stringify(this.answer)) return;
    this.answer = answer;
    this.enqueue(() => this.describe());
  }

  /** Who is in the call, with the SSRC of their sound: each one not muted gets a section of their own. */
  setPeers(peers: NativeSfuPeer[]): void {
    const wanted = new Map(peers.filter((p) => p.ssrc !== undefined && !p.muted).map((p) => [p.id, p.ssrc!]));
    let changed = false;
    for (const slot of this.slots) {
      if (slot.peer !== undefined && wanted.get(slot.peer) !== slot.ssrc) {
        slot.peer = slot.ssrc = undefined;
        changed = true;
      }
    }
    for (const [peer, ssrc] of wanted) {
      if (this.slots.some((s) => s.peer === peer)) continue;
      let slot = this.slots.find((s) => s.peer === undefined);
      if (!slot) {
        slot = { transceiver: this.pc.addTransceiver("audio", { direction: "recvonly" }) };
        this.slots.push(slot);
      }
      slot.peer = peer;
      slot.ssrc = ssrc;
      changed = true;
    }
    if (changed) this.enqueue(() => this.describe());
  }

  /** Whether the user speaks now; the server is told when it changes, once connected. */
  setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    if (this.connected) this.emit({ t: "speaking", on: speaking });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { track } of this.shown.values()) this.on.untrack(track);
    this.shown.clear();
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }

  private async sendOffer(): Promise<void> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    const read = offerSignal(this.pc.localDescription!.sdp);
    if (!read) throw new Error("The browser's offer lacks what the voice server needs");
    this.offer = { opus: read.signal.opus, extensions: read.signal.extensions };
    if (read.ssrc !== undefined) this.offer.ssrc = read.ssrc;
    this.emit(read.signal);
  }

  /** Writes the server's side anew for the sections there are now: a new offer of the browser's own first, unless the first one waits for its answer. */
  private async describe(): Promise<void> {
    if (!this.answer || !this.offer) return;
    if (this.pc.signalingState === "stable") await this.pc.setLocalDescription(await this.pc.createOffer());
    const roles = new Map<string, Role>();
    // The first offer gave the microphone's section its mid.
    roles.set(this.mic.mid!, { kind: "mic" });
    for (const slot of this.slots) if (slot.peer !== undefined && slot.transceiver.mid) roles.set(slot.transceiver.mid, { kind: "peer", peer: slot.peer, ssrc: slot.ssrc! });
    await this.pc.setRemoteDescription({ type: "answer", sdp: answerDescription(this.pc.localDescription!.sdp, this.answer, this.offer.opus, this.offer.extensions, roles, ++this.version) });
    // A section added while the first offer waited for its answer was in neither: offered now.
    if (this.slots.some((slot) => slot.peer !== undefined && !slot.transceiver.mid)) return this.describe();
    this.syncReceivers();
  }

  /** Plays what each slot receives for its peer; stops what no longer is. */
  private syncReceivers(): void {
    for (const slot of this.slots) {
      const shown = this.shown.get(slot);
      if (shown?.peer === slot.peer) continue;
      if (shown) {
        this.on.untrack(shown.track);
        this.shown.delete(slot);
      }
      if (slot.peer === undefined) continue;
      const track = slot.transceiver.receiver.track;
      this.shown.set(slot, { track, peer: slot.peer });
      this.on.track(track, slot.peer);
    }
  }

  private onState(state: RTCPeerConnectionState): void {
    this.on.state(state);
    if (state !== "connected" || this.connected) return;
    this.connected = true;
    // The server takes the microphone's SSRC only once the connection is up.
    if (this.offer?.ssrc !== undefined && !this.ssrcSent) {
      this.ssrcSent = true;
      this.emit({ t: "ssrc", audio: this.offer.ssrc });
    }
    if (this.speaking) this.emit({ t: "speaking", on: true });
  }

  private emit(signal: SfuSignal): void {
    if (!this.closed) this.on.signal(signal);
  }

  /** Steps run one at a time; one that fails gives the connection up. */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(() => (this.closed ? undefined : task()))
      .catch(() => {
        if (this.closed) return;
        this.close();
        this.on.state("failed");
      });
  }

}
