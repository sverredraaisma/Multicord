import { describe, expect, it } from "vitest";
import { liveKitUrl } from "../../../src/main/adapters/fluxerAdapter";
import { FluxerState } from "../../../src/main/fluxer/state";
import { parseVoiceState } from "../../../src/main/fluxer/types";
import { ANA, readyPayload } from "./fixtures";

describe("voice state", () => {
  it("parses voice states, defaulting the connection id to the user", () => {
    expect(parseVoiceState({ user_id: "2", channel_id: "112", connection_id: "c1", self_mute: true, self_video: true }, "100")).toEqual({
      guildId: "100",
      channelId: "112",
      userId: "2",
      connectionId: "c1",
      selfMute: true,
      selfDeaf: false,
      selfVideo: true,
      selfStream: false,
    });
    expect(parseVoiceState({ user_id: "2", guild_id: "200" })).toMatchObject({ guildId: "200", channelId: undefined, connectionId: "2" });
    expect(parseVoiceState({ channel_id: "1" })).toBeUndefined();
  });

  it("tracks who is in which voice channel", () => {
    const state = new FluxerState();
    const ready = readyPayload();
    (ready.guilds[0] as Record<string, unknown>).voice_states = [{ user_id: "2", channel_id: "112", connection_id: "a" }];
    state.apply("READY", ready);
    expect(state.voiceMembers("112").map((m) => m.user.id)).toEqual(["2"]);

    state.apply("VOICE_STATE_UPDATE", { guild_id: "100", user_id: "9", channel_id: "112", connection_id: "b", self_deaf: true });
    expect(state.voiceMembers("112").map((m) => [m.user.username, m.state.selfDeaf])).toEqual([
      ["ana", false],
      ["Unknown user", true],
    ]);
    state.apply("VOICE_STATE_UPDATE", { guild_id: "100", user_id: "2", channel_id: null, connection_id: "a" });
    state.apply("VOICE_STATE_UPDATE", null);
    expect(state.voiceMembers("112").map((m) => m.user.id)).toEqual(["9"]);

    // A guild sync replaces the guild's voice states.
    state.apply("GUILD_CREATE", { id: "100", properties: { name: "Alpha" }, voice_states: [{ user_id: ANA.id, channel_id: "112" }] });
    expect(state.voiceMembers("112").map((m) => m.state.connectionId)).toEqual(["2"]);
    state.reset();
    expect(state.voiceStates.size).toBe(0);
  });

  it("normalises LiveKit endpoints", () => {
    expect(liveKitUrl("voice.fluxer.app")).toBe("wss://voice.fluxer.app");
    expect(liveKitUrl("wss://voice.fluxer.app/rtc")).toBe("wss://voice.fluxer.app/rtc");
    expect(liveKitUrl("https://voice.example")).toBe("https://voice.example");
  });
});
