// Spacebar's voice server (src/webrtc in github.com/spacebarchat/server), as
// Discord's web client speaks to it: a JSON WebSocket of its own (opcodes in
// src/webrtc/util/Constants.ts), WebRTC only (SelectProtocol.ts closes any
// other with 4000), its media through the SFU library the instance loads
// (github.com/spacebarchat/pion-webrtc's PionSignalingDelegate). The view
// runs the connection (SfuLink); this side reads and writes the server's
// strings, so nothing but the checked fields of NativeSfuCall reaches it.
import { sfuAnswer, type SfuAnswer, type SfuSignal } from "../../shared/native";
import type { GatewaySocket, SocketFactory } from "./gateway";
import { isId, isRecord } from "./types";

export const VoiceOp = { Identify: 0, SelectProtocol: 1, Ready: 2, Heartbeat: 3, SessionDescription: 4, Speaking: 5, HeartbeatAck: 6, Hello: 8, ClientsConnect: 11, Video: 12, ClientDisconnect: 13 } as const;

/** Longest session description the server's answer may be. */
const MAX_ANSWER = 4096;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?=[a-z0-9-]*[a-z-])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Where VOICE_SERVER_UPDATE says the voice server is: a host name with an
 * optional port (as Spacebar's regions configure it, "host:port"), or a
 * wss: address of one. Undefined for an IP address, a name without a dot,
 * or anything else, as the shell lets an engine add only a DNS name.
 */
export function voiceEndpoint(value: unknown): { host: string; url: string } | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  const match = /^(?:wss:\/\/)?([^/:?#\s]+)(?::(\d{1,5}))?\/?$/i.exec(value.trim());
  const host = match?.[1]!.toLowerCase();
  if (!host || host.length > 253 || !HOST.test(host)) return undefined;
  const port = match![2] === undefined ? 443 : Number(match![2]);
  if (port < 1 || port > 65535) return undefined;
  // Spacebar reads the version from the query (Connection.ts); Discord's web client asks for 7.
  return { host, url: `wss://${host}${port === 443 ? "" : `:${port}`}/?v=7` };
}

/**
 * The few lines the server's answer is (PionSignalingDelegate.onOffer:
 * "m=audio <port> ICE/SDP", c=, a=rtcp, ICE credentials, fingerprint and one
 * host candidate), read into an SfuAnswer and checked as the view would
 * check it (sfuAnswer()); undefined when anything is missing or off.
 */
export function parseAnswer(sdp: unknown): SfuAnswer | undefined {
  if (typeof sdp !== "string" || sdp.length > MAX_ANSWER) return undefined;
  const lines = sdp.split(/\r?\n/);
  const value = (prefix: string): string | undefined => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
  const port = /^(\d{1,5}) /.exec(value("m=audio ") ?? "")?.[1];
  const ip = /^IN IP4 (\S+)$/.exec(value("c=") ?? "")?.[1];
  const candidate = value("a=candidate:")?.split(" ");
  if (!port || !ip || !candidate || candidate.length < 8 || candidate[6] !== "typ") return undefined;
  return sfuAnswer({
    ip,
    port: Number(port),
    ufrag: value("a=ice-ufrag:"),
    pwd: value("a=ice-pwd:"),
    fingerprint: value("a=fingerprint:"),
    candidate: { foundation: candidate[0], component: Number(candidate[1]), protocol: candidate[2]!.toLowerCase(), priority: Number(candidate[3]), ip: candidate[4], port: Number(candidate[5]) },
  });
}

/**
 * What Select Protocol carries as its SDP: the offer's attributes alone,
 * one a line, as Discord's web client sends them (Spacebar prefixes
 * "m=audio" and reads ICE, DTLS and header extensions from it).
 */
export function offerAttributes(offer: Extract<SfuSignal, { t: "offer" }>): string {
  return [
    "a=extmap-allow-mixed",
    `a=ice-ufrag:${offer.ufrag}`,
    `a=ice-pwd:${offer.pwd}`,
    "a=ice-options:trickle",
    `a=fingerprint:${offer.fingerprint}`,
    ...offer.extensions.map((e) => `a=extmap:${e.id} ${e.uri}`),
    `a=rtpmap:${offer.opus} opus/48000/2`,
  ].join("\n");
}

export interface VoiceServerHandlers {
  /** The server took the identify (op 2 Ready): the view may offer. */
  ready(): void;
  /** Its answer to the offer, checked. */
  answer(answer: SfuAnswer | undefined): void;
  /** Someone's sound comes in under this SSRC (op 12 Video). */
  sound(userId: string, ssrc: number): void;
  /** Someone left the server's room (op 13). */
  left(userId: string): void;
  /** The socket closed or stopped answering, with its close code. */
  closed(code: number): void;
}

/** What identifies the user to the voice server: the guild (a DM's channel for its call), who, the gateway session and the grant's token. */
export interface VoiceIdentity {
  serverId: string;
  userId: string;
  sessionId: string;
  token: string;
}

/**
 * One connection to a voice server (src/webrtc in Spacebar's server):
 * identify on Hello, heartbeats with a nonce the server echoes, then the
 * view's offer as Select Protocol, its SSRC as Video and its speaking, and
 * from the server its answer and the SSRC each other person's sound comes
 * in under. Nothing is resumed: a dropped connection ends the call.
 */
export class SpacebarVoiceServer {
  private readonly socket: GatewaySocket;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private acked = true;
  private closed = false;
  private isReady = false;
  /** The view's offer, held until the server is ready for it. */
  private offer: Extract<SfuSignal, { t: "offer" }> | undefined;
  private ssrc: number | undefined;

  constructor(
    url: string,
    createSocket: SocketFactory,
    private readonly identity: VoiceIdentity,
    private readonly handlers: VoiceServerHandlers,
  ) {
    this.socket = createSocket(url);
    this.socket.addEventListener("message", (event) => this.onMessage(event.data));
    this.socket.addEventListener("close", (event) => this.end(event.code));
  }

  /** Passes on one of the view's signals. */
  signal(signal: SfuSignal): void {
    switch (signal.t) {
      case "offer":
        this.offer = signal;
        if (this.isReady) this.selectProtocol();
        return;
      case "ssrc":
        this.ssrc = signal.audio;
        // No camera: video 0 and no streams, as Video.ts reads a client that sends sound alone.
        return this.send(VoiceOp.Video, { audio_ssrc: signal.audio, video_ssrc: 0, rtx_ssrc: 0, streams: [] });
      default:
        if (this.ssrc !== undefined) this.send(VoiceOp.Speaking, { speaking: signal.on ? 1 : 0, delay: 0, ssrc: this.ssrc });
    }
  }

  /** Closes the connection; the handlers hear nothing more. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.socket.close(1000, "leave");
  }

  private selectProtocol(): void {
    const sdp = offerAttributes(this.offer!);
    this.send(VoiceOp.SelectProtocol, { protocol: "webrtc", data: sdp, sdp, codecs: [{ name: "opus", type: "audio", priority: 1000, payload_type: this.offer!.opus }] });
  }

  private send(op: number, d: unknown): void {
    if (!this.closed) this.socket.send(JSON.stringify({ op, d }));
  }

  private onMessage(raw: unknown): void {
    if (this.closed) return;
    let payload: unknown;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isRecord(payload)) return;
    const d = isRecord(payload.d) ? payload.d : {};
    switch (payload.op) {
      case VoiceOp.Hello: {
        const interval = typeof d.heartbeat_interval === "number" && d.heartbeat_interval >= 1000 ? d.heartbeat_interval : 30_000;
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.beat(), interval);
        const { serverId, userId, sessionId, token } = this.identity;
        return this.send(VoiceOp.Identify, { server_id: serverId, user_id: userId, session_id: sessionId, token, video: false });
      }
      case VoiceOp.Ready:
        if (this.isReady) return;
        this.isReady = true;
        if (this.offer) this.selectProtocol();
        return this.handlers.ready();
      case VoiceOp.HeartbeatAck:
        this.acked = true;
        return;
      case VoiceOp.SessionDescription:
        return this.handlers.answer(parseAnswer(d.sdp));
      case VoiceOp.Video:
        // The server never sends 0 for sound (Video.ts): a number in range, or nothing.
        if (isId(d.user_id) && typeof d.audio_ssrc === "number" && Number.isInteger(d.audio_ssrc) && d.audio_ssrc > 0 && d.audio_ssrc <= 0xffffffff) this.handlers.sound(d.user_id, d.audio_ssrc);
        return;
      case VoiceOp.ClientDisconnect:
        if (isId(d.user_id)) this.handlers.left(d.user_id);
        return;
    }
  }

  /** A heartbeat with a nonce (Heartbeat.ts closes on anything but a number); none acknowledged since the last means the server is gone. */
  private beat(): void {
    if (!this.acked) {
      this.close();
      return this.handlers.closed(4009);
    }
    this.acked = false;
    this.send(VoiceOp.Heartbeat, Date.now());
  }

  private end(code: number): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.handlers.closed(code);
  }
}
