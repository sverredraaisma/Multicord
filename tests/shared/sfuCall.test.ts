import { describe, expect, it } from "vitest";
import { isNativeAction, isPublicIpv4, isSfuSignal, MAX_SFU_EXTENSIONS, MAX_SFU_PEERS, sfuAnswer, sfuCall, sfuSignal, voiceConnected, type NativeVoiceSession } from "../../src/shared/native";

const fingerprint = `sha-256 ${Array.from({ length: 32 }, () => "AB").join(":")}`;
const offer = { t: "offer", ufrag: "Ab+/", pwd: "a".repeat(22), fingerprint, opus: 111, extensions: [{ id: 1, uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level" }, { id: 3, uri: "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01" }] };
const candidate = { foundation: "4150473528", component: 1, protocol: "udp", priority: 2130706431, ip: "51.210.113.110", port: 6000 };
const answer = { ip: "51.210.113.110", port: 6000, ufrag: "TqfRYaWUmsdzFVZC", pwd: "pqKqzWpZhpmpWkWRYBeVLycsnaFHmzLh", fingerprint, candidate };

describe("isPublicIpv4", () => {
  it.each(["51.210.113.110", "8.8.8.8", "100.63.0.1", "172.32.0.1", "223.255.255.255"])("takes %s", (ip) => expect(isPublicIpv4(ip)).toBe(true));
  it.each(["0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "198.18.0.1", "198.19.1.1", "224.0.0.1", "1.2.3.256", "01.2.3.4", "1.2.3", "a.b.c.d", "::1", 5])("refuses %s", (ip) => {
    expect(isPublicIpv4(ip)).toBe(false);
  });
});

describe("sfuSignal", () => {
  it("keeps the forms with their known fields only", () => {
    expect(sfuSignal({ ...offer, extra: 1, extensions: [{ id: 1, uri: "urn:x", more: 2 }] })).toEqual({ ...offer, extensions: [{ id: 1, uri: "urn:x" }] });
    expect(sfuSignal({ t: "ssrc", audio: 0xffffffff })).toEqual({ t: "ssrc", audio: 0xffffffff });
    expect(sfuSignal({ t: "speaking", on: false })).toEqual({ t: "speaking", on: false });
  });

  it.each([
    { ...offer, ufrag: "abc" },
    { ...offer, ufrag: "ab\r\nc" },
    { ...offer, pwd: "short" },
    { ...offer, pwd: 5 },
    { ...offer, fingerprint: "md5 AB:CD" },
    { ...offer, fingerprint: `${fingerprint}\na=evil` },
    { ...offer, fingerprint: 1 },
    { ...offer, opus: 95 },
    { ...offer, opus: 111.5 },
    { ...offer, extensions: "x" },
    { ...offer, extensions: Array.from({ length: MAX_SFU_EXTENSIONS + 1 }, (_, i) => ({ id: i + 1, uri: "urn:x" })) },
    { ...offer, extensions: [{ id: 0, uri: "urn:x" }] },
    { ...offer, extensions: [{ id: 256, uri: "urn:x" }] },
    { ...offer, extensions: [{ id: 1, uri: "urn:x y" }] },
    { ...offer, extensions: [{ id: 1, uri: 5 }] },
    { ...offer, extensions: [5] },
    { t: "ssrc", audio: 0 },
    { t: "ssrc", audio: 2 ** 32 },
    { t: "speaking", on: 1 },
    { t: "other" },
    null,
  ])("refuses %j", (signal) => expect(sfuSignal(signal)).toBeUndefined());

  it("takes from the view only signals with nothing else in them", () => {
    expect(isSfuSignal(offer)).toBe(true);
    expect(isSfuSignal({ t: "ssrc", audio: 5 })).toBe(true);
    expect(isSfuSignal({ t: "speaking", on: true })).toBe(true);
    expect(isSfuSignal({ ...offer, extra: 1 })).toBe(false);
    expect(isSfuSignal({ ...offer, extensions: [{ id: 1, uri: "urn:x", more: 1 }] })).toBe(false);
    expect(isSfuSignal({ t: "ssrc", audio: 5, extra: 1 })).toBe(false);
    expect(isSfuSignal({ t: "speaking", on: true, extra: 1 })).toBe(false);
    expect(isSfuSignal({ t: "ssrc" })).toBe(false);
    expect(isSfuSignal(undefined)).toBe(false);
    expect(isNativeAction({ type: "sfuSignal", signal: offer })).toBe(true);
    expect(isNativeAction({ type: "sfuSignal", signal: { ...offer, ufrag: "x" } })).toBe(false);
  });
});

describe("sfuAnswer", () => {
  it("keeps an answer whose every field is in its strict form", () => {
    expect(sfuAnswer({ ...answer, extra: 1, candidate: { ...candidate, extra: 1 } })).toEqual(answer);
    expect(sfuAnswer({ ...answer, candidate: { ...candidate, component: 2, protocol: "tcp", priority: 0 } })?.candidate).toEqual({ ...candidate, component: 2, protocol: "tcp", priority: 0 });
  });

  it.each([
    { ...answer, ip: "10.0.0.1" },
    { ...answer, port: 0 },
    { ...answer, port: 65536 },
    { ...answer, ufrag: "a b c d" },
    { ...answer, ufrag: 5 },
    { ...answer, pwd: "x" },
    { ...answer, pwd: 5 },
    { ...answer, fingerprint: "sha-256 AB" },
    { ...answer, fingerprint: 5 },
    { ...answer, candidate: undefined },
    { ...answer, candidate: { ...candidate, foundation: "a b" } },
    { ...answer, candidate: { ...candidate, foundation: 1 } },
    { ...answer, candidate: { ...candidate, component: 3 } },
    { ...answer, candidate: { ...candidate, protocol: "sctp" } },
    { ...answer, candidate: { ...candidate, priority: -1 } },
    { ...answer, candidate: { ...candidate, priority: "1" } },
    { ...answer, candidate: { ...candidate, ip: "192.168.0.2" } },
    { ...answer, candidate: { ...candidate, port: 70000 } },
  ])("refuses %j", (value) => expect(sfuAnswer(value)).toBeUndefined());
});

describe("sfuCall", () => {
  it("keeps a call with its peers, their SSRCs and the answer", () => {
    expect(
      sfuCall({
        callId: "c1",
        self: "1",
        over: 2,
        answer,
        peers: [
          { id: "2", name: "Ann", ssrc: 7, avatarUrl: "https://cdn.example/a.png", muted: true },
          { id: "2", name: "Again" },
          { id: "1", name: "Me" },
          { id: "3", name: "Bob", ssrc: 7, avatarUrl: "http://cdn.example/b.png" },
          { id: "4", name: "Cid", ssrc: 0 },
          { id: "5", name: "" },
          null,
        ],
      }),
    ).toEqual({
      callId: "c1",
      self: "1",
      over: 2,
      answer,
      peers: [
        { id: "2", name: "Ann", ssrc: 7, avatarUrl: "https://cdn.example/a.png", muted: true },
        { id: "3", name: "Bob" },
        { id: "4", name: "Cid" },
      ],
    });
  });

  it("keeps at most MAX_SFU_PEERS, and no answer that does not check out", () => {
    const peers = Array.from({ length: MAX_SFU_PEERS + 3 }, (_, i) => ({ id: String(i + 10), name: `P${i}` }));
    const call = sfuCall({ callId: "c", self: "1", peers, answer: { ...answer, ip: "127.0.0.1" } })!;
    expect(call.peers).toHaveLength(MAX_SFU_PEERS);
    expect(call.answer).toBeUndefined();
    expect(sfuCall({ callId: "c", self: "1" })).toEqual({ callId: "c", self: "1", peers: [] });
  });

  it("needs a call id and own id", () => {
    expect(sfuCall({ callId: "bad id", self: "1", peers: [] })).toBeUndefined();
    expect(sfuCall({ callId: "c", peers: [] })).toBeUndefined();
    expect(sfuCall(undefined)).toBeUndefined();
  });

  it("counts as being in the call", () => {
    const voice: NativeVoiceSession = { channelId: "1", channelName: "General", guildName: "G", mute: false, deaf: false, video: false, stream: false };
    expect(voiceConnected(voice)).toBe(false);
    expect(voiceConnected({ ...voice, sfu: { callId: "c", self: "1", peers: [] } })).toBe(true);
  });
});
