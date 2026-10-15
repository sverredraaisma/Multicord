import { describe, expect, it, vi } from "vitest";
import { FluxerState } from "../../../src/modules/fluxer/state";
import { ANA, ME, readyPayload } from "./fixtures";

function ready() {
  const state = new FluxerState();
  state.apply("READY", readyPayload());
  return state;
}

describe("FluxerState", () => {
  it("builds guilds, channels, users and read state from READY", () => {
    const state = ready();
    expect(state.me).toMatchObject({ id: "1" });
    expect([...state.guilds.keys()]).toEqual(["100", "200"]);
    expect(state.users.get("2")).toMatchObject({ globalName: "Ana" });
    expect(state.guildChannels("100").map((c) => c.name)).toEqual(["lobby", "orphan", "Text", "general", "voice"]);
    expect(state.isUnread(state.channels.get("111")!)).toBe(true);
    expect(state.isUnread(state.channels.get("113")!)).toBe(false);
    expect(state.isUnread(state.channels.get("112")!)).toBe(false); // voice
    expect(state.guildUnread("100")).toBe(true);
    expect(state.guildUnread("200")).toBe(false);
    expect(state.guildMentions("100")).toBe(2);
    expect(state.privateChannels().map((c) => c.id)).toEqual(["900", "901"]);
    expect(state.isUnread(state.channels.get("901")!)).toBe(false); // no read state, no mentions
  });

  it("lays out folders first-come and appends guilds missing from the settings", () => {
    const state = ready();
    expect(state.guildLayout()).toEqual([
      { id: "5", name: "Folder", color: "#123456", guildIds: ["200"] },
      { guildIds: ["100"] },
    ]);
    state.apply("USER_SETTINGS_UPDATE", {
      guild_folders: [{ id: -1, guild_ids: ["100", "404"] }, { id: 6, guild_ids: ["100", "404"] }, { id: 7, guild_ids: ["200"] }],
    });
    expect(state.guildLayout()).toEqual([{ guildIds: ["100"] }, { id: "7", name: undefined, color: undefined, guildIds: ["200"] }]);
    state.apply("USER_SETTINGS_UPDATE", { theme: "dark" }); // no folders: keep the old ones
    expect(state.folders).toHaveLength(3);
  });

  it("tracks new messages, mentions and our own replies", () => {
    const state = ready();
    const incoming = vi.fn();
    state.incoming.on(incoming);
    state.addHistory("211", [], false);

    state.apply("MESSAGE_CREATE", { id: "710", channel_id: "211", author: ANA, content: "hey" });
    expect(state.isUnread(state.channels.get("211")!)).toBe(true);
    expect(state.mentions("211")).toBe(0);
    expect(state.messages.get("211")!.map((m) => m.id)).toEqual(["710"]);
    expect(incoming).toHaveBeenCalledOnce();

    state.apply("MESSAGE_CREATE", { id: "711", channel_id: "211", author: ANA, mentions: [{ id: "1" }] });
    state.apply("MESSAGE_CREATE", { id: "711", channel_id: "211", author: ANA }); // duplicate
    expect(state.mentions("211")).toBe(1);
    expect(state.messages.get("211")).toHaveLength(2);

    state.apply("MESSAGE_CREATE", { id: "712", channel_id: "211", author: ME });
    expect(state.isUnread(state.channels.get("211")!)).toBe(false);
    expect(state.mentions("211")).toBe(0);
    expect(incoming).toHaveBeenCalledTimes(3);

    // DMs count every message; mention_everyone counts too.
    state.apply("MESSAGE_CREATE", { id: "810", channel_id: "901", author: ANA });
    expect(state.isUnread(state.channels.get("901")!)).toBe(true);
    state.apply("MESSAGE_CREATE", { id: "520", channel_id: "113", author: ANA, mention_everyone: true });
    expect(state.mentions("113")).toBe(1);
    state.apply("MESSAGE_CREATE", { id: "1", channel_id: "77", author: ANA }); // unknown channel
    state.apply("MESSAGE_CREATE", { bad: true });
  });

  it("caps the message cache", () => {
    const state = ready();
    state.addHistory("211", [], false);
    for (let i = 1; i <= 205; i++) state.apply("MESSAGE_CREATE", { id: String(1000 + i), channel_id: "211", author: ANA });
    expect(state.messages.get("211")).toHaveLength(200);
    expect(state.messages.get("211")![0]!.id).toBe("1006");
  });

  it("applies edits, deletes and acks", () => {
    const state = ready();
    const author = { id: "2", username: "ana" };
    state.addHistory("211", [
      { id: "1", channelId: "211", author: { id: "2", username: "ana" }, content: "a", timestamp: "", edited: false, mentionIds: [], mentionEveryone: false, attachments: [], stickers: [], embeds: [] },
      { id: "2", channelId: "211", author: { id: "2", username: "ana" }, content: "b", timestamp: "", edited: false, mentionIds: [], mentionEveryone: false, attachments: [], stickers: [], embeds: [] },
      { id: "3", channelId: "211", author: { id: "2", username: "ana" }, content: "c", timestamp: "", edited: false, mentionIds: [], mentionEveryone: false, attachments: [], stickers: [], embeds: [] },
    ], false);
    state.apply("MESSAGE_UPDATE", { id: "1", channel_id: "211", author, content: "edited", edited_timestamp: "t" });
    state.apply("MESSAGE_UPDATE", { id: "9", channel_id: "211", author, content: "unknown" });
    state.apply("MESSAGE_UPDATE", { id: "9", channel_id: "404", author });
    expect(state.messages.get("211")![0]).toMatchObject({ content: "edited", edited: true });

    state.apply("MESSAGE_DELETE", { id: "2", channel_id: "211" });
    state.apply("MESSAGE_DELETE_BULK", { ids: ["3", "x"], channel_id: "211" });
    state.apply("MESSAGE_DELETE", { id: "2", channel_id: "404" });
    state.apply("MESSAGE_DELETE", { id: "2" });
    expect(state.messages.get("211")!.map((m) => m.id)).toEqual(["1"]);

    state.apply("MESSAGE_ACK", { channel_id: "111", message_id: "500", mention_count: 0 });
    expect(state.isUnread(state.channels.get("111")!)).toBe(false);
    state.markRead("900", "800");
    expect(state.mentions("900")).toBe(0);
  });

  it("prepends older history without duplicates", () => {
    const state = ready();
    const msg = (id: string) => ({ id, channelId: "211", author: { id: "2", username: "ana" }, content: id, timestamp: "", edited: false, mentionIds: [], mentionEveryone: false, attachments: [], stickers: [], embeds: [] });
    state.addHistory("211", [msg("5"), msg("6")], false);
    state.addHistory("211", [msg("3"), msg("4"), msg("5")], true);
    expect(state.messages.get("211")!.map((m) => m.id)).toEqual(["3", "4", "5", "6"]);
  });

  it("follows guild and channel lifecycle events", () => {
    const state = ready();
    const changed = vi.fn();
    state.changed.on(changed);
    state.apply("GUILD_CREATE", { id: "400", properties: { name: "New" }, channels: [{ id: "411", type: 0 }] });
    expect(state.guildChannels("400").map((c) => c.id)).toEqual(["411"]);
    state.apply("GUILD_UPDATE", { id: "400", name: "Renamed" });
    state.apply("GUILD_UPDATE", { id: "400" });
    expect(state.guilds.get("400")!.name).toBe("Renamed");
    state.apply("GUILD_CREATE", { id: "x" });

    state.apply("CHANNEL_CREATE", { id: "412", type: 0, guild_id: "400" });
    state.apply("CHANNEL_UPDATE_BULK", { guild_id: "400", channels: [{ id: "413", type: 0 }] });
    state.apply("CHANNEL_UPDATE_BULK", { channels: [{ id: "414", type: 0 }] });
    expect(state.guildChannels("400").map((c) => c.id)).toEqual(["411", "412", "413"]);
    state.addHistory("412", [], false);
    state.apply("CHANNEL_DELETE", { id: "412" });
    state.apply("CHANNEL_DELETE", {});
    expect(state.channels.has("412")).toBe(false);
    expect(state.messages.has("412")).toBe(false);

    state.addHistory("411", [], false);
    state.apply("GUILD_DELETE", { id: "400" });
    state.apply("GUILD_DELETE", {});
    expect(state.guilds.has("400")).toBe(false);
    expect(state.channels.has("411")).toBe(false);
    expect(state.messages.has("411")).toBe(false);

    state.apply("TYPING_START", {}); // ignored
    expect(changed).toHaveBeenCalledTimes(13);
  });

  it("updates the current user and other users", () => {
    const state = ready();
    state.apply("USER_UPDATE", { id: "1", username: "me2" });
    state.apply("USER_UPDATE", { id: "2", username: "ana2" });
    state.apply("USER_UPDATE", null);
    expect(state.me!.username).toBe("me2");
    expect(state.users.get("2")!.username).toBe("ana2");
  });

  it("handles a READY without a user or folders", () => {
    const state = new FluxerState();
    state.apply("READY", { guilds: "nope" });
    expect(state.me).toBeUndefined();
    expect(state.guildLayout()).toEqual([]);
    state.apply("MESSAGE_CREATE", { id: "1", channel_id: "2", author: ANA });
  });
});

describe("notification settings", () => {
  const msg = (channelId: string, extra: Record<string, unknown> = {}) => ({
    id: "9000",
    channelId,
    author: { id: "2", username: "ana" },
    content: "",
    timestamp: "",
    edited: false,
    mentionIds: [] as string[],
    mentionEveryone: false,
    attachments: [], stickers: [], embeds: [],
    ...extra,
  });

  function withSettings(settings: unknown[]) {
    const state = new FluxerState();
    state.apply("READY", { ...readyPayload(), user_guild_settings: settings });
    return state;
  }

  it("defaults to every DM message and guild mentions", () => {
    const state = withSettings([]);
    expect(state.shouldNotify(msg("900"))).toBe(true);
    expect(state.shouldNotify(msg("111"))).toBe(false);
    expect(state.shouldNotify(msg("111", { mentionIds: ["1"] }))).toBe(true);
    expect(state.shouldNotify(msg("111", { mentionEveryone: true }))).toBe(true);
    expect(state.shouldNotify(msg("111", { author: { id: "1", username: "me" }, mentionIds: ["1"] }))).toBe(false);
    expect(state.shouldNotify(msg("404"))).toBe(false);
  });

  it("follows guild levels, channel overrides and suppress_everyone", () => {
    const state = withSettings([
      {
        guild_id: "100",
        message_notifications: 0,
        suppress_everyone: true,
        channel_overrides: { "113": { message_notifications: 1 }, "114": { message_notifications: 3 }, bad: {}, "115": "x" },
      },
      { guild_id: "200", message_notifications: 2 },
      { guild_id: null, message_notifications: 1 },
      "junk",
    ]);
    expect(state.shouldNotify(msg("111"))).toBe(true); // guild: all
    expect(state.shouldNotify(msg("113"))).toBe(false); // override: mentions only
    expect(state.shouldNotify(msg("113", { mentionEveryone: true }))).toBe(false); // @everyone suppressed
    expect(state.shouldNotify(msg("113", { mentionIds: ["1"] }))).toBe(true);
    expect(state.shouldNotify(msg("114"))).toBe(true); // inherit -> guild level
    expect(state.shouldNotify(msg("211", { mentionIds: ["1"] }))).toBe(false); // nothing
    expect(state.shouldNotify(msg("900"))).toBe(false); // DMs: mentions only
  });

  it("respects mutes until they expire", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const state = withSettings([
      { guild_id: "100", muted: true, mute_config: { end_time: "2026-10-14T13:00:00Z" } },
      { guild_id: "200", channel_overrides: { "211": { muted: true, mute_config: null } } },
      { guild_id: "0", muted: true, mute_config: { end_time: "2026-10-14T11:00:00Z" } },
    ]);
    expect(state.shouldNotify(msg("111", { mentionIds: ["1"] }), now)).toBe(false);
    expect(state.shouldNotify(msg("111", { mentionIds: ["1"] }), now + 2 * 3600_000)).toBe(true);
    expect(state.shouldNotify(msg("211", { mentionIds: ["1"] }), now)).toBe(false); // open-ended
    expect(state.shouldNotify(msg("900"), now)).toBe(true); // DM mute expired
  });

  it("applies settings updates and clears them on reset", () => {
    const state = withSettings([]);
    state.apply("USER_GUILD_SETTINGS_UPDATE", { guild_id: "100", message_notifications: 0 });
    expect(state.shouldNotify(msg("111"))).toBe(true);
    state.reset();
    expect(state.notifySettings.size).toBe(0);
  });
});

describe("custom emoji", () => {
  it("tracks each guild's emoji from guild objects and updates", () => {
    const state = new FluxerState();
    state.apply("GUILD_CREATE", { id: "100", properties: { name: "A" }, emojis: [{ id: "55", name: "party", animated: true }, { id: "x" }] });
    expect(state.emojis.get("100")).toEqual([{ id: "55", name: "party", animated: true }]);
    state.apply("GUILD_EMOJIS_UPDATE", { guild_id: "100", emojis: [{ id: "56", name: "wave" }] });
    expect(state.emojis.get("100")).toEqual([{ id: "56", name: "wave", animated: false }]);
    state.apply("GUILD_EMOJIS_UPDATE", { emojis: [] });
    state.reset();
    expect(state.emojis.size).toBe(0);
  });

  it("tracks each guild's stickers from guild objects and updates", () => {
    const state = new FluxerState();
    state.apply("GUILD_CREATE", { id: "100", properties: { name: "A" }, stickers: [{ id: "70", name: "Wave", animated: true }, { id: "x" }] });
    expect(state.stickers.get("100")).toEqual([{ id: "70", name: "Wave", animated: true }]);
    state.apply("GUILD_STICKERS_UPDATE", { guild_id: "100", stickers: "junk" });
    expect(state.stickers.get("100")).toEqual([]);
    state.apply("GUILD_STICKERS_UPDATE", { stickers: [{ id: "71", name: "Spin" }] }); // no guild
    expect(state.stickers.size).toBe(1);
    state.reset();
    expect(state.stickers.size).toBe(0);
  });
});
