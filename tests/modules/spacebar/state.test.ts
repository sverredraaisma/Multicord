import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpacebarState, TYPING_MS } from "../../../src/modules/spacebar/state";
import { parseMessage } from "../../../src/modules/spacebar/types";
import { ANA, ME, message, readyPayload } from "./fixtures";

function ready(): SpacebarState {
  const state = new SpacebarState();
  state.apply("READY", readyPayload());
  return state;
}

describe("SpacebarState", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("builds the session from READY", () => {
    const state = ready();
    expect(state.me).toEqual({ id: "1", username: "me" });
    expect([...state.guilds.keys()]).toEqual(["100", "200"]);
    expect(state.guildChannels("100").map((c) => c.id)).toEqual(["113", "114", "110", "111", "112"]);
    expect(state.emojis.get("100")).toEqual([{ id: "130", name: "party", animated: false }]);
    expect(state.roles.get("100")!.map((r) => r.id)).toEqual(["100", "120", "121", "122"]);
    expect(state.ownRoles.get("100")).toEqual(["121"]);
    expect(state.ownRoles.has("200")).toBe(false);
    expect(state.privateChannels().map((c) => c.id)).toEqual(["900", "901"]);
    expect(state.isUnread(state.channels.get("111")!)).toBe(true);
    expect(state.isUnread(state.channels.get("113")!)).toBe(false);
    expect(state.isUnread(state.channels.get("112")!)).toBe(false);
    expect(state.guildUnread("100")).toBe(true);
    expect(state.guildUnread("200")).toBe(false);
    expect(state.guildMentions("100")).toBe(2);
    expect(state.users.get("2")!.globalName).toBe("Ana");
    // A bare list of read states is read too, and a channel never read counts only mentions.
    const other = new SpacebarState();
    other.apply("READY", { ...readyPayload(), read_state: [{ id: "900", mention_count: 0 }], merged_members: undefined });
    expect(other.isUnread(other.channels.get("900")!)).toBe(false);
    expect(other.isUnread(other.channels.get("111")!)).toBe(false);
    expect(other.ownRoles.size).toBe(0);
  });

  it("follows guilds, channels, roles and emoji", () => {
    const state = ready();
    const changed = vi.fn();
    state.changed.on(changed);
    state.apply("GUILD_CREATE", { id: "400", name: "Gamma", channels: [{ id: "411", type: 0 }], members: [{ user: ANA, roles: [] }, { user: ME, roles: [{ id: "401" }, "x", { id: "y" }] }], roles: [{}] });
    expect(state.roles.get("400")).toEqual([]);
    expect(state.channels.get("411")!.guildId).toBe("400");
    expect(state.ownRoles.get("400")).toEqual(["401"]);
    state.apply("GUILD_CREATE", { id: "400", name: "Gamma", channels: [{ id: "412", type: 0 }] });
    expect(state.channels.has("411")).toBe(false);
    state.apply("GUILD_UPDATE", { id: "400", name: "Gamma 2", roles: [{ id: "402", name: "R" }, {}] });
    expect(state.guilds.get("400")!.name).toBe("Gamma 2");
    expect(state.roles.get("400")!.map((r) => r.id)).toEqual(["402"]);
    state.apply("GUILD_UPDATE", { id: "x" });
    // Without channels or roles, a guild keeps those it had.
    state.apply("GUILD_UPDATE", { id: "400", name: "Gamma 3" });
    state.apply("GUILD_CREATE", { id: "400", name: "Gamma 2" });
    expect(state.roles.get("400")!.map((r) => r.id)).toEqual(["402"]);
    expect(state.channels.has("412")).toBe(true);
    state.apply("GUILD_DELETE", null);
    state.apply("GUILD_ROLE_CREATE", { guild_id: "400", role: { id: "403", name: "New" } });
    state.apply("GUILD_ROLE_UPDATE", { guild_id: "400", role: { id: "402", name: "Renamed" } });
    expect(state.roles.get("400")!.map((r) => r.name)).toEqual(["New", "Renamed"]);
    state.apply("GUILD_ROLE_CREATE", { guild_id: "500", role: { id: "1", name: "X" } });
    expect(state.roles.get("500")!.map((r) => r.name)).toEqual(["X"]);
    state.apply("GUILD_ROLE_CREATE", { guild_id: "x", role: { id: "1", name: "X" } });
    state.apply("GUILD_ROLE_DELETE", { guild_id: "400", role_id: "403" });
    state.apply("GUILD_ROLE_DELETE", { guild_id: "600", role_id: "403" });
    state.apply("GUILD_ROLE_DELETE", { role_id: "403" });
    expect(state.roles.get("400")!.map((r) => r.id)).toEqual(["402"]);
    state.apply("GUILD_MEMBER_UPDATE", { guild_id: "400", user: ME, roles: ["402", "x"] });
    state.apply("GUILD_MEMBER_UPDATE", { guild_id: "400", user: ANA, roles: ["403"] });
    expect(state.ownRoles.get("400")).toEqual(["402"]);
    state.apply("GUILD_EMOJIS_UPDATE", { guild_id: "400", emojis: [{ id: "9", name: "wave" }, {}] });
    expect(state.emojis.get("400")).toEqual([{ id: "9", name: "wave", animated: false }]);
    state.apply("GUILD_EMOJIS_UPDATE", { emojis: [] });
    state.apply("CHANNEL_CREATE", { id: "413", type: 0, guild_id: "400", name: "new" });
    state.apply("CHANNEL_UPDATE", { id: "413", type: 0, guild_id: "400", name: "renamed" });
    expect(state.channels.get("413")!.name).toBe("renamed");
    state.addHistory("413", [parseMessage(message("1000", "413"))!], false);
    state.apply("CHANNEL_DELETE", { id: "413" });
    expect(state.channels.has("413")).toBe(false);
    expect(state.messages.has("413")).toBe(false);
    state.apply("CHANNEL_DELETE", {});
    state.apply("CHANNEL_CREATE", { bad: true });
    state.apply("CHANNEL_CREATE", { id: "903", type: 1, recipients: [] });
    state.apply("CHANNEL_CREATE", { id: "904", type: 1, recipients: [] });
    expect(state.privateChannels().map((c) => c.id)).toEqual(["900", "901", "903", "904"]);
    state.addHistory("412", [parseMessage(message("1001", "412"))!], false);
    state.apply("GUILD_DELETE", { id: "400" });
    expect(state.guilds.has("400")).toBe(false);
    expect(state.channels.has("412")).toBe(false);
    expect(state.messages.has("412")).toBe(false);
    expect(state.channels.has("111")).toBe(true);
    state.apply("GUILD_DELETE", {});
    state.apply("SOMETHING_ELSE", {});
    state.apply("USER_UPDATE", { id: "1", username: "me2" });
    expect(state.me!.username).toBe("me2");
    state.apply("USER_UPDATE", { ...ANA, global_name: "Anna" });
    expect(state.me!.username).toBe("me2");
    expect(state.users.get("2")!.globalName).toBe("Anna");
    expect(changed).toHaveBeenCalled();
  });

  it("keeps messages, previews and unread counts", () => {
    const state = ready();
    const incoming = vi.fn();
    state.incoming.on(incoming);
    state.addHistory("111", [parseMessage(message("450", "111"))!], false);
    state.addHistory("111", [parseMessage(message("440", "111"))!, parseMessage(message("450", "111"))!], true);
    expect(state.messages.get("111")!.map((m) => m.id)).toEqual(["440", "450"]);
    state.apply("MESSAGE_CREATE", message("510", "111", { mentions: [ME] }));
    state.apply("MESSAGE_CREATE", message("510", "111"));
    expect(state.messages.get("111")!.map((m) => m.id)).toEqual(["440", "450", "510"]);
    expect(state.mentions("111")).toBe(3);
    expect(state.latest.get("111")!.id).toBe("510");
    expect(incoming).toHaveBeenCalledTimes(2);
    // DMs count every message; the user's own messages mark the channel read.
    state.apply("MESSAGE_CREATE", message("810", "900"));
    expect(state.mentions("900")).toBe(2);
    state.apply("MESSAGE_CREATE", message("820", "900", { author: ME }));
    expect(state.mentions("900")).toBe(0);
    expect(state.isUnread(state.channels.get("900")!)).toBe(false);
    // In guilds, only mentions count; a role the user has counts as one.
    state.apply("MESSAGE_CREATE", message("520", "113"));
    expect(state.mentions("113")).toBe(0);
    state.apply("MESSAGE_CREATE", message("530", "113", { mention_roles: ["121"] }));
    expect(state.mentions("113")).toBe(1);
    state.apply("MESSAGE_CREATE", message("540", "211", { mention_everyone: true }));
    expect(state.mentions("211")).toBe(1);
    state.apply("MESSAGE_CREATE", message("550", "211", { mention_roles: ["121"] }));
    expect(state.mentions("211")).toBe(1);
    // A channel the session does not know still gets its preview.
    state.apply("MESSAGE_CREATE", message("560", "999", { mentions: [ME] }));
    expect(state.latest.get("999")!.id).toBe("560");
    state.apply("MESSAGE_CREATE", { bad: true });
    // Edits replace cached messages and previews; partial updates are left out.
    state.apply("MESSAGE_UPDATE", message("510", "111", { content: "edited" }));
    expect(state.messages.get("111")!.at(-1)!.content).toBe("edited");
    expect(state.latest.get("111")!.content).toBe("edited");
    state.apply("MESSAGE_UPDATE", { id: "510", channel_id: "111", embeds: [] });
    expect(state.replaceMessage(parseMessage(message("1", "777"))!)).toBe(false);
    state.apply("MESSAGE_DELETE", { id: "510", channel_id: "111" });
    expect(state.messages.get("111")!.map((m) => m.id)).toEqual(["440", "450"]);
    expect(state.latest.has("111")).toBe(false);
    state.apply("MESSAGE_DELETE_BULK", { ids: ["440", "x"], channel_id: "111" });
    state.apply("MESSAGE_DELETE", { id: "1", channel_id: "777" });
    state.apply("MESSAGE_DELETE", { id: "1" });
    expect(state.messages.get("111")!.map((m) => m.id)).toEqual(["450"]);
    state.removeMessage("111", "450");
    state.removeMessage("777", "1");
    expect(state.messages.get("111")).toEqual([]);
    state.addHistory("211", [parseMessage(message("701", "211"))!], false);
    state.removeMessage("211", "701");
    expect(state.latest.has("211")).toBe(false);
    // Reads, from the server or our own.
    state.apply("MESSAGE_ACK", { channel_id: "111", message_id: "600" });
    state.apply("MESSAGE_ACK", { bad: true });
    expect(state.mentions("111")).toBe(0);
    state.markRead("113", "530");
    expect(state.isUnread(state.channels.get("113")!)).toBe(false);
  });

  it("caps cached history", () => {
    const state = ready();
    state.addHistory("111", [parseMessage(message("1000", "111"))!], false);
    for (let i = 1; i <= 205; i++) state.apply("MESSAGE_CREATE", message(String(1000 + i), "111"));
    expect(state.messages.get("111")).toHaveLength(200);
    expect(state.messages.get("111")![0]!.id).toBe("1006");
  });

  it("counts reactions, the user's own once", () => {
    const state = ready();
    state.addHistory("111", [parseMessage(message("450", "111", { reactions: [{ emoji: { name: "👍" }, count: 1, me: false }] }))!], false);
    const reactions = () => state.messages.get("111")![0]!.reactions;
    state.apply("MESSAGE_REACTION_ADD", { channel_id: "111", message_id: "450", user_id: "1", emoji: { name: "👍" } });
    state.apply("MESSAGE_REACTION_ADD", { channel_id: "111", message_id: "450", user_id: "1", emoji: { name: "👍" } });
    expect(reactions()).toEqual([{ emoji: { name: "👍" }, count: 2, me: true }]);
    state.apply("MESSAGE_REACTION_ADD", { channel_id: "111", message_id: "450", user_id: "2", emoji: { id: "130", name: "party" } });
    state.apply("MESSAGE_REACTION_ADD", { channel_id: "111", message_id: "450", user_id: "3", emoji: { id: "130", name: "party" } });
    expect(reactions()[1]).toEqual({ emoji: { id: "130", name: "party" }, count: 2, me: false });
    state.apply("MESSAGE_REACTION_REMOVE", { channel_id: "111", message_id: "450", user_id: "1", emoji: { id: "130", name: "party" } });
    state.apply("MESSAGE_REACTION_REMOVE", { channel_id: "111", message_id: "450", user_id: "1", emoji: { name: "👍" } });
    state.apply("MESSAGE_REACTION_REMOVE", { channel_id: "111", message_id: "450", user_id: "2", emoji: { name: "👍" } });
    expect(reactions()).toEqual([{ emoji: { id: "130", name: "party" }, count: 2, me: false }]);
    state.apply("MESSAGE_REACTION_REMOVE", { channel_id: "111", message_id: "450", user_id: "2", emoji: { name: "😮" } });
    state.apply("MESSAGE_REACTION_ADD", { channel_id: "111", message_id: "999", user_id: "2", emoji: { name: "😮" } });
    state.apply("MESSAGE_REACTION_ADD", { channel_id: "111", message_id: "450", user_id: "2" });
    state.apply("MESSAGE_REACTION_ADD", { channel_id: "111", message_id: "450", emoji: { name: "😮" } });
    state.apply("MESSAGE_REACTION_ADD", { channel_id: "111", message_id: "450", user_id: "2", emoji: { name: "😮" } });
    state.apply("MESSAGE_REACTION_REMOVE_EMOJI", { channel_id: "111", message_id: "450", emoji: { id: "130", name: "party" } });
    expect(reactions()).toEqual([{ emoji: { name: "😮" }, count: 1, me: false }]);
    state.apply("MESSAGE_REACTION_REMOVE_ALL", { channel_id: "111", message_id: "450" });
    state.apply("MESSAGE_REACTION_REMOVE_ALL", { channel_id: "111", message_id: "999" });
    expect(reactions()).toEqual([]);
    expect(state.findMessage("x", "450")).toBeUndefined();
  });

  it("shows who is typing for a while", () => {
    const state = ready();
    state.apply("TYPING_START", { channel_id: "111", user_id: "3", member: { user: { id: "3", username: "cy" } } });
    state.apply("TYPING_START", { channel_id: "111", user_id: "1" });
    state.apply("TYPING_START", { channel_id: "111" });
    state.apply("TYPING_START", { channel_id: "111", user_id: "2" });
    // Someone the session has not met is left out.
    state.apply("TYPING_START", { channel_id: "111", user_id: "77" });
    expect(state.typingIn("111").map((u) => u.username)).toEqual(["cy", "ana"]);
    expect(state.typingIn("111", Date.now() + TYPING_MS)).toEqual([]);
    state.apply("MESSAGE_CREATE", message("600", "111"));
    expect(state.typingIn("111").map((u) => u.username)).toEqual(["cy"]);
    expect(state.typingIn("999")).toEqual([]);
  });

  it("keeps who is in which call: READY's voice states, then each change, one call per user", () => {
    const payload = readyPayload();
    (payload.guilds[0] as Record<string, unknown>).voice_states = [{ user_id: "2", channel_id: "112", self_mute: true }, { user_id: "5", channel_id: "112" }, { bad: true }];
    const state = new SpacebarState();
    state.apply("READY", payload);
    expect(state.voiceMembers("112").map(({ user, state: v }) => [user?.id, v.userId, v.guildId, v.selfMute])).toEqual([["2", "2", "100", true], [undefined, "5", "100", false]]);
    // A change within the call keeps their place; one who joins with their member object becomes known.
    state.apply("VOICE_STATE_UPDATE", { user_id: "2", channel_id: "112", guild_id: "100", self_mute: false });
    state.apply("VOICE_STATE_UPDATE", { user_id: "6", channel_id: "112", guild_id: "100", member: { user: { id: "6", username: "six" } } });
    expect(state.voiceMembers("112").map(({ user, state: v }) => [v.userId, v.selfMute, user?.username])).toEqual([["2", false, "ana"], ["5", false, undefined], ["6", false, "six"]]);
    // A move ends where they were; a leave (no channel) ends it.
    state.apply("VOICE_STATE_UPDATE", { user_id: "2", channel_id: "900", guild_id: null });
    state.apply("VOICE_STATE_UPDATE", { user_id: "5", channel_id: null, guild_id: "100" });
    state.apply("VOICE_STATE_UPDATE", { bad: true });
    expect(state.voiceMembers("112").map(({ state: v }) => v.userId)).toEqual(["6"]);
    expect(state.voiceMembers("900").map(({ state: v }) => v.userId)).toEqual(["2"]);
    // A guild's voice states again (GUILD_CREATE) replace that guild's; a guild gone takes its calls along.
    state.apply("GUILD_CREATE", { id: "100", name: "Alpha", voice_states: [{ user_id: "7", channel_id: "112" }] });
    expect(state.voiceMembers("112").map(({ state: v }) => v.userId)).toEqual(["7"]);
    state.apply("GUILD_DELETE", { id: "100" });
    expect(state.voiceMembers("112")).toEqual([]);
    expect(state.voiceMembers("900")).toHaveLength(1);
    state.reset();
    expect(state.voiceStates.size).toBe(0);
  });
});
