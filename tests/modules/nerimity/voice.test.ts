import { describe, expect, it } from "vitest";
import { CLOUDFLARE_ICE_HOSTS, hasRelay, iceServersFrom } from "../../../src/modules/nerimity/voice";
import { parseVoiceUser } from "../../../src/modules/nerimity/types";

const HOSTS = [...CLOUDFLARE_ICE_HOSTS, "nerimity.com", "cdn.nerimity.com"];

describe("Nerimity call servers", () => {
  it("takes Cloudflare's answer as one server or a list, keeping only URLs on the allowed hosts", () => {
    // As Cloudflare's TURN service answers, which Nerimity's server passes on as `result`.
    const single = {
      urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp", "turn:turn.evil.example:3478"],
      username: "user",
      credential: "secret",
    };
    expect(iceServersFrom(single, HOSTS)).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"], username: "user", credential: "secret" },
    ]);
    expect(iceServersFrom([{ urls: "stun:stun.cloudflare.com:53" }, { urls: ["turn:relay.example.org"] }, { urls: "turn:nerimity.com:3478", username: "u", credential: "c" }], HOSTS)).toEqual([
      { urls: ["stun:stun.cloudflare.com:53"] },
      { urls: ["turn:nerimity.com:3478"], username: "u", credential: "c" },
    ]);
    expect(iceServersFrom(undefined, HOSTS)).toEqual([]);
  });

  it("tells a relay from a STUN server", () => {
    expect(hasRelay([{ urls: ["stun:stun.cloudflare.com:3478"] }])).toBe(false);
    expect(hasRelay([{ urls: ["stun:stun.cloudflare.com:3478", "turns:turn.cloudflare.com:443"] }])).toBe(true);
    expect(hasRelay([])).toBe(false);
  });

  it("reads who is in a call from the server's payloads", () => {
    expect(parseVoiceUser({ channelId: "5", userId: "2", serverId: "1", socketId: undefined })).toEqual({ channelId: "5", userId: "2" });
    for (const value of [undefined, { channelId: "5" }, { channelId: "x", userId: "2" }]) expect(parseVoiceUser(value)).toBeUndefined();
  });
});
