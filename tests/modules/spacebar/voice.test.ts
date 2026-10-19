import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySocket } from "../../../src/modules/spacebar/gateway";
import { offerAttributes, parseAnswer, SpacebarVoiceServer, voiceEndpoint, VoiceOp, type VoiceServerHandlers } from "../../../src/modules/spacebar/voice";
import type { SfuSignal } from "../../../src/shared/native";

const FINGERPRINT = `sha-256 ${Array.from({ length: 32 }, () => "4F").join(":")}`;
/** The answer as PionSignalingDelegate.onOffer writes it (github.com/spacebarchat/pion-webrtc, since its 2026-10-12 candidate fix). */
export const SERVER_ANSWER =
  `m=audio 6000 ICE/SDP\n` +
  `a=fingerprint:${FINGERPRINT}\n` +
  `c=IN IP4 51.210.113.110\n` +
  `a=rtcp:6000\n` +
  `a=ice-ufrag:TqfRYaWUmsdzFVZC\n` +
  `a=ice-pwd:pqKqzWpZhpmpWkWRYBeVLycsnaFHmzLh\n` +
  `a=fingerprint:${FINGERPRINT}\n` +
  `a=candidate:4150473528 1 udp 2130706431 51.210.113.110 6000 typ host\n`;
const OFFER: Extract<SfuSignal, { t: "offer" }> = { t: "offer", ufrag: "Ab12", pwd: "abcdefghijklmnopqrstuv", fingerprint: FINGERPRINT, opus: 111, extensions: [{ id: 1, uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level" }] };

class FakeSocket implements GatewaySocket {
  sent: { op: number; d: unknown }[] = [];
  closed: [number | undefined, string | undefined] | undefined;
  private listeners: Record<string, ((event: never) => void)[]> = {};
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  receive(payload: unknown): void {
    for (const l of this.listeners.message ?? []) l({ data: typeof payload === "string" ? payload : JSON.stringify(payload) } as never);
  }
  serverClose(code: number): void {
    for (const l of this.listeners.close ?? []) l({ code } as never);
  }
}

describe("voiceEndpoint", () => {
  it.each([
    ["voice.rory.server.spacebar.chat:443", "voice.rory.server.spacebar.chat", "wss://voice.rory.server.spacebar.chat/?v=7"],
    ["voice.example.com", "voice.example.com", "wss://voice.example.com/?v=7"],
    ["Voice.Example.com:3005", "voice.example.com", "wss://voice.example.com:3005/?v=7"],
    ["wss://voice.example.com/", "voice.example.com", "wss://voice.example.com/?v=7"],
  ])("takes %s", (endpoint, host, url) => expect(voiceEndpoint(endpoint)).toEqual({ host, url }));

  it.each(["127.0.0.1:3004", "1.2.3.4", "localhost:3004", "ws://voice.example.com", "voice.example.com:0", "voice.example.com:70000", "voice.example.com/path", "a b.com", `${"a".repeat(250)}.com`, "x".repeat(301), 5, undefined])("refuses %s", (endpoint) => {
    expect(voiceEndpoint(endpoint)).toBeUndefined();
  });
});

describe("parseAnswer", () => {
  it("reads the server's few lines into a checked answer", () => {
    expect(parseAnswer(SERVER_ANSWER)).toEqual({
      ip: "51.210.113.110",
      port: 6000,
      ufrag: "TqfRYaWUmsdzFVZC",
      pwd: "pqKqzWpZhpmpWkWRYBeVLycsnaFHmzLh",
      fingerprint: FINGERPRINT,
      candidate: { foundation: "4150473528", component: 1, protocol: "udp", priority: 2130706431, ip: "51.210.113.110", port: 6000 },
    });
    // Before that fix the priority was the foundation and the foundation 1: still a candidate.
    expect(parseAnswer(SERVER_ANSWER.replace("4150473528 1 udp 2130706431", "1 1 UDP 4150473528"))?.candidate).toEqual({ foundation: "1", component: 1, protocol: "udp", priority: 4150473528, ip: "51.210.113.110", port: 6000 });
  });

  it.each([
    ["no m-line", SERVER_ANSWER.replace("m=audio 6000 ICE/SDP\n", "")],
    ["no address", SERVER_ANSWER.replace("c=IN IP4 51.210.113.110\n", "")],
    ["a private address", SERVER_ANSWER.replaceAll("51.210.113.110", "192.168.1.2")],
    ["no candidate", SERVER_ANSWER.replace(/a=candidate:.*\n/, "")],
    ["a short candidate", SERVER_ANSWER.replace("typ host", "")],
    ["a candidate of another form", SERVER_ANSWER.replace("typ host", "type host")],
    ["no credentials", SERVER_ANSWER.replace(/a=ice-pwd:.*\n/, "")],
    ["too long", SERVER_ANSWER + "a=x\n".repeat(2000)],
  ])("refuses one with %s", (_, sdp) => expect(parseAnswer(sdp)).toBeUndefined());

  it("refuses what is no text", () => expect(parseAnswer(5)).toBeUndefined());
});

describe("offerAttributes", () => {
  it("writes the offer's attributes as Discord's web client sends them", () => {
    expect(offerAttributes(OFFER)).toBe(
      ["a=extmap-allow-mixed", "a=ice-ufrag:Ab12", "a=ice-pwd:abcdefghijklmnopqrstuv", "a=ice-options:trickle", `a=fingerprint:${FINGERPRINT}`, "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level", "a=rtpmap:111 opus/48000/2"].join("\n"),
    );
  });
});

describe("SpacebarVoiceServer", () => {
  let socket: FakeSocket;
  let handlers: { [K in keyof VoiceServerHandlers]: ReturnType<typeof vi.fn> };
  let server: SpacebarVoiceServer;
  const identity = { serverId: "100", userId: "1", sessionId: "s", token: "vt" };

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    handlers = { ready: vi.fn(), answer: vi.fn(), sound: vi.fn(), left: vi.fn(), closed: vi.fn() };
    server = new SpacebarVoiceServer(
      "wss://voice.sb/?v=7",
      (url) => (socket = new FakeSocket(url)),
      identity,
      handlers as unknown as VoiceServerHandlers,
    );
  });

  afterEach(() => vi.useRealTimers());

  it("identifies on Hello, offers once ready, and hands over the answer", () => {
    expect(socket.url).toBe("wss://voice.sb/?v=7");
    socket.receive({ op: VoiceOp.Hello, d: { heartbeat_interval: 30_000 } });
    expect(socket.sent).toEqual([{ op: VoiceOp.Identify, d: { server_id: "100", user_id: "1", session_id: "s", token: "vt", video: false } }]);
    // The view's offer waits for Ready.
    server.signal(OFFER);
    expect(socket.sent).toHaveLength(1);
    socket.receive({ op: VoiceOp.Ready, d: { ssrc: 2, ip: "51.210.113.110", port: 6000, modes: [] } });
    socket.receive({ op: VoiceOp.Ready, d: {} });
    expect(handlers.ready).toHaveBeenCalledOnce();
    const sdp = offerAttributes(OFFER);
    expect(socket.sent[1]).toEqual({ op: VoiceOp.SelectProtocol, d: { protocol: "webrtc", data: sdp, sdp, codecs: [{ name: "opus", type: "audio", priority: 1000, payload_type: 111 }] } });
    socket.receive({ op: VoiceOp.SessionDescription, d: { sdp: SERVER_ANSWER, video_codec: "H264", audio_codec: "opus", media_session_id: "s" } });
    expect(handlers.answer).toHaveBeenCalledWith(parseAnswer(SERVER_ANSWER));
    socket.receive({ op: VoiceOp.SessionDescription, d: 5 });
    expect(handlers.answer).toHaveBeenLastCalledWith(undefined);
  });

  it("sends an offer at once once ready, then the SSRC and speaking", () => {
    socket.receive({ op: VoiceOp.Hello, d: {} });
    socket.receive({ op: VoiceOp.Ready, d: {} });
    server.signal(OFFER);
    expect(socket.sent.at(-1)!.op).toBe(VoiceOp.SelectProtocol);
    // No SSRC yet: speaking says nothing.
    server.signal({ t: "speaking", on: true });
    expect(socket.sent).toHaveLength(2);
    server.signal({ t: "ssrc", audio: 77 });
    expect(socket.sent.at(-1)).toEqual({ op: VoiceOp.Video, d: { audio_ssrc: 77, video_ssrc: 0, rtx_ssrc: 0, streams: [] } });
    server.signal({ t: "speaking", on: true });
    server.signal({ t: "speaking", on: false });
    expect(socket.sent.slice(-2)).toEqual([
      { op: VoiceOp.Speaking, d: { speaking: 1, delay: 0, ssrc: 77 } },
      { op: VoiceOp.Speaking, d: { speaking: 0, delay: 0, ssrc: 77 } },
    ]);
  });

  it("hands over the SSRC of each one's sound and who left, and ignores what is off", () => {
    socket.receive({ op: VoiceOp.Video, d: { user_id: "2", audio_ssrc: 7, video_ssrc: 0 } });
    socket.receive({ op: VoiceOp.Video, d: { user_id: "3", audio_ssrc: 0 } });
    socket.receive({ op: VoiceOp.Video, d: { user_id: "x", audio_ssrc: 9 } });
    socket.receive({ op: VoiceOp.Video, d: { user_id: "4", audio_ssrc: 2 ** 32 } });
    socket.receive({ op: VoiceOp.Video, d: { user_id: "4", audio_ssrc: 1.5 } });
    socket.receive({ op: VoiceOp.Video, d: { user_id: "4", audio_ssrc: "5" } });
    socket.receive({ op: VoiceOp.ClientDisconnect, d: { user_id: "2" } });
    socket.receive({ op: VoiceOp.ClientDisconnect, d: { user_id: 2 } });
    socket.receive({ op: VoiceOp.ClientsConnect, d: { user_ids: ["1", "2"] } });
    socket.receive("not json");
    socket.receive([1]);
    socket.receive({ op: VoiceOp.Speaking });
    expect(handlers.sound.mock.calls).toEqual([["2", 7]]);
    expect(handlers.left.mock.calls).toEqual([["2"]]);
  });

  it("beats with a nonce, and gives up a server that stops answering", () => {
    socket.receive({ op: VoiceOp.Hello, d: { heartbeat_interval: 5000 } });
    vi.advanceTimersByTime(5000);
    expect(socket.sent.at(-1)).toEqual({ op: VoiceOp.Heartbeat, d: Date.now() });
    socket.receive({ op: VoiceOp.HeartbeatAck, d: Date.now() });
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(5000);
    expect(handlers.closed).toHaveBeenCalledWith(4009);
    expect(socket.closed).toEqual([1000, "leave"]);
  });

  it("reports a close, once, and says nothing after being closed", () => {
    socket.serverClose(4006);
    socket.serverClose(4006);
    expect(handlers.closed.mock.calls).toEqual([[4006]]);
    socket.receive({ op: VoiceOp.Ready, d: {} });
    expect(handlers.ready).not.toHaveBeenCalled();
    server.close();
    expect(socket.closed).toBeUndefined();
  });

  it("closes its socket when left, and sends nothing more", () => {
    socket.receive({ op: VoiceOp.Hello, d: { heartbeat_interval: 5000 } });
    server.close();
    server.close();
    expect(socket.closed).toEqual([1000, "leave"]);
    server.signal({ t: "ssrc", audio: 5 });
    socket.serverClose(1000);
    vi.advanceTimersByTime(20_000);
    expect(socket.sent).toHaveLength(1);
    expect(handlers.closed).not.toHaveBeenCalled();
  });
});
