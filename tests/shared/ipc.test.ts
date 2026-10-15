import { describe, expect, it } from "vitest";
import {
  MAX_DMS,
  isDiscordDm,
  isDiscordDmList,
  isTooltipRequest,
  isBridgePayload,
  isDiscordFolder,
  isLayoutEntry,
  isGuildInfo,
  MAX_GUILDS,
  isDiscordGuild,
  isDiscordState,
  isDiscordTarget,
  isHttpsUrl,
  isPickerChoice,
  isRailKey,
  isRailOrder,
  isSnowflake,
  isTitleBadge,
  isPreviewText,
  parseTitleBadge,
} from "../../src/shared/ipc";

const guild = { id: "123456789012345678", name: "Guild", unread: true, mentions: 2 };

describe("validators", () => {
  it("accepts snowflakes only", () => {
    expect(isSnowflake("123")).toBe(true);
    expect(isSnowflake("12a")).toBe(false);
    expect(isSnowflake("")).toBe(false);
    expect(isSnowflake(123)).toBe(false);
    expect(isSnowflake("1".repeat(21))).toBe(false);
  });

  it("validates title badges", () => {
    expect(isTitleBadge({ unread: false, mentions: 0 })).toBe(true);
    expect(isTitleBadge({ unread: "no", mentions: 0 })).toBe(false);
    expect(isTitleBadge({ unread: true, mentions: -1 })).toBe(false);
    expect(isTitleBadge({ unread: true, mentions: 1.5 })).toBe(false);
    expect(isTitleBadge(null)).toBe(false);
  });

  it("validates guilds", () => {
    expect(isDiscordGuild(guild)).toBe(true);
    expect(isDiscordGuild({ ...guild, iconUrl: "https://cdn.discordapp.com/icons/1/a.png" })).toBe(true);
    expect(isDiscordGuild({ ...guild, iconUrl: "javascript:alert(1)" })).toBe(false);
    expect(isDiscordGuild({ ...guild, id: "x" })).toBe(false);
    expect(isDiscordGuild({ ...guild, name: 1 })).toBe(false);
    expect(isDiscordGuild({ ...guild, unread: 1 })).toBe(false);
    expect(isDiscordGuild({ ...guild, mentions: "1" })).toBe(false);
  });

  it("validates discord state", () => {
    const badge = { unread: false, mentions: 0 };
    expect(isDiscordState({ guilds: [guild], badge })).toBe(true);
    expect(isDiscordState({ guilds: [], badge, user: { name: "Ana" } })).toBe(true);
    expect(isDiscordState({ guilds: [], badge, user: null })).toBe(true);
    expect(isDiscordState({ guilds: [], badge, user: { name: 5 } })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: [], user: { name: "x".repeat(201) } })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: [], user: null })).toBe(true);
    expect(isBridgePayload({ dms: [], guilds: [], calls: [{ channelId: "1", from: "Ana" }] })).toBe(true);
    expect(isBridgePayload({ dms: [], guilds: [], calls: [{ channelId: "x", from: "Ana" }] })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: [], calls: [{ channelId: "1", from: "x".repeat(201) }] })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: [], calls: "no" })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: [], calls: Array.from({ length: 21 }, () => ({ channelId: "1", from: "A" })) })).toBe(false);
    expect(isDiscordState({ guilds: [], badge, calls: [{ channelId: "1", from: "Ana" }] })).toBe(true);
    expect(isDiscordState({ guilds: [], badge, calls: [{}] })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: [], stores: ["ChannelStore"] })).toBe(true);
    expect(isBridgePayload({ dms: [], guilds: [], stores: ["<script>"] })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: [], stores: "ChannelStore" })).toBe(false);
    expect(isDiscordState({ guilds: [], badge, health: { guildBar: true, stores: ["UserStore"] } })).toBe(true);
    expect(isDiscordState({ guilds: [], badge, health: { guildBar: "yes" } })).toBe(false);
    expect(isDiscordState({ guilds: [], badge, health: null })).toBe(false);
    expect(isDiscordState({ guilds: "nope", badge })).toBe(false);
    expect(isDiscordState({ guilds: [{}], badge })).toBe(false);
    expect(isDiscordState({ guilds: [], badge: {} })).toBe(false);
    expect(isDiscordState({ guilds: Array(1001).fill(guild), badge })).toBe(false);
    expect(isDiscordState(undefined)).toBe(false);
  });

  it("validates navigation targets, rail keys and picker choices", () => {
    expect(isDiscordTarget("home")).toBe(true);
    expect(isDiscordTarget("42")).toBe(true);
    expect(isDiscordTarget("../evil")).toBe(false);
    expect(isRailKey("discord:home")).toBe(true);
    expect(isRailKey("")).toBe(false);
    expect(isRailKey("x".repeat(201))).toBe(false);
    expect(isRailKey(5)).toBe(false);
    expect(isPickerChoice(null)).toBe(true);
    expect(isPickerChoice({ id: "screen:1", audio: false })).toBe(true);
    expect(isPickerChoice({ id: "screen:1" })).toBe(false);
    expect(isPickerChoice({ id: 1, audio: true })).toBe(false);
    expect(isPickerChoice("x")).toBe(false);
  });

  it("accepts https URLs only", () => {
    expect(isHttpsUrl("https://example.com")).toBe(true);
    expect(isHttpsUrl("http://example.com")).toBe(false);
    expect(isHttpsUrl("not a url")).toBe(false);
    expect(isHttpsUrl(undefined)).toBe(false);
  });
});

describe("parseTitleBadge", () => {
  it.each([
    ["Discord | #general", { unread: false, mentions: 0 }],
    ["(3) Discord | #general", { unread: true, mentions: 3 }],
    ["• Discord | #general", { unread: true, mentions: 0 }],
    ["Element [12]", { unread: true, mentions: 12 }],
    ["Element *", { unread: true, mentions: 0 }],
    ["Element", { unread: false, mentions: 0 }],
  ])("parses %j", (title, expected) => {
    expect(parseTitleBadge(title)).toEqual(expected);
  });
});

describe("preview text from Discord's page", () => {
  it("refuses control, line-separator and bidirectional characters", () => {
    expect(isPreviewText("Ana: hi")).toBe(true);
    for (const bad of ["\u0000", "\n", "\t", "\u007f", "\u0085", "\u061c", "\u200e", "\u200f", "\u2028", "\u2029", "\u202a", "\u202e", "\u2066", "\u2069"]) {
      expect(isPreviewText(`a${bad}b`), JSON.stringify(bad)).toBe(false);
    }
    expect(isPreviewText(undefined)).toBe(false);
  });
});

describe("DM and tooltip validators", () => {
  const dm = { id: "9", title: "Ana", unread: true, mentions: 1, lastActivity: 5 };

  it("validates DMs and DM lists", () => {
    expect(isDiscordDm(dm)).toBe(true);
    expect(isDiscordDm({ ...dm, avatarUrl: "https://cdn/a.png" })).toBe(true);
    expect(isDiscordDm({ ...dm, avatarUrl: "http://cdn/a.png" })).toBe(false);
    expect(isDiscordDm({ ...dm, id: "x" })).toBe(false);
    expect(isDiscordDm({ ...dm, title: 5 })).toBe(false);
    expect(isDiscordDm({ ...dm, title: "x".repeat(201) })).toBe(false);
    expect(isDiscordDm({ ...dm, unread: "yes" })).toBe(false);
    expect(isDiscordDm({ ...dm, mentions: -1 })).toBe(false);
    expect(isDiscordDm({ ...dm, lastActivity: 1.5 })).toBe(false);
    expect(isDiscordDm(null)).toBe(false);
    expect(isDiscordDm({ ...dm, preview: "Ana: see you at eight 📎" })).toBe(true);
    expect(isDiscordDm({ ...dm, preview: "x".repeat(200) })).toBe(true);
    expect(isDiscordDm({ ...dm, preview: "x".repeat(201) })).toBe(false);
    expect(isDiscordDm({ ...dm, preview: "" })).toBe(false);
    expect(isDiscordDm({ ...dm, preview: 5 })).toBe(false);
    expect(isDiscordDmList([dm])).toBe(true);
    expect(isDiscordDmList(Array(MAX_DMS + 1).fill(dm))).toBe(false);
    expect(isDiscordDmList("x")).toBe(false);
  });

  it("accepts optional DMs on discord state", () => {
    const base = { guilds: [], badge: { unread: false, mentions: 0 } };
    expect(isDiscordState({ ...base, dms: [dm] })).toBe(true);
    expect(isDiscordState({ ...base, dms: [{}] })).toBe(false);
  });

  it("accepts DM navigation targets", () => {
    expect(isDiscordTarget("dm:123")).toBe(true);
    expect(isDiscordTarget("dm:abc")).toBe(false);
    expect(isDiscordTarget("dm:")).toBe(false);
  });

  it("validates tooltip requests", () => {
    expect(isTooltipRequest(null)).toBe(true);
    expect(isTooltipRequest({ text: "Server", y: 10.5 })).toBe(true);
    expect(isTooltipRequest({ text: "", y: 1 })).toBe(false);
    expect(isTooltipRequest({ text: "x".repeat(201), y: 1 })).toBe(false);
    expect(isTooltipRequest({ text: "x", y: Number.NaN })).toBe(false);
    expect(isTooltipRequest({ text: "x", y: "1" })).toBe(false);
    expect(isTooltipRequest({ text: 1, y: 1 })).toBe(false);
    expect(isTooltipRequest("x")).toBe(false);
  });
});

describe("bridge payload validators", () => {
  const guild = { id: "1", name: "Gaming Club" };

  it("validates guild info", () => {
    expect(isGuildInfo(guild)).toBe(true);
    expect(isGuildInfo({ ...guild, iconUrl: "https://cdn/i.png" })).toBe(true);
    expect(isGuildInfo({ ...guild, iconUrl: "http://cdn/i.png" })).toBe(false);
    expect(isGuildInfo({ ...guild, id: "x" })).toBe(false);
    expect(isGuildInfo({ ...guild, name: 1 })).toBe(false);
    expect(isGuildInfo({ ...guild, name: "x".repeat(201) })).toBe(false);
    expect(isGuildInfo(null)).toBe(false);
  });

  it("validates the whole payload", () => {
    expect(isBridgePayload({ dms: [], guilds: [guild] })).toBe(true);
    expect(isBridgePayload({ dms: [], guilds: [{}] })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: Array(MAX_GUILDS + 1).fill(guild) })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: "x" })).toBe(false);
    expect(isBridgePayload({ dms: "x", guilds: [] })).toBe(false);
    expect(isBridgePayload([])).toBe(false);
  });
});

describe("folder validators", () => {
  const folder = { id: "5", name: "Games", expanded: false, unread: true, mentions: 2, iconUrls: ["https://cdn/a.png"], index: 0 };

  it("validates folders", () => {
    expect(isDiscordFolder(folder)).toBe(true);
    expect(isDiscordFolder({ ...folder, color: "#aabbcc" })).toBe(true);
    expect(isDiscordFolder({ ...folder, color: "red" })).toBe(false);
    expect(isDiscordFolder({ ...folder, id: "x" })).toBe(false);
    expect(isDiscordFolder({ ...folder, name: 1 })).toBe(false);
    expect(isDiscordFolder({ ...folder, name: "x".repeat(201) })).toBe(false);
    expect(isDiscordFolder({ ...folder, expanded: "no" })).toBe(false);
    expect(isDiscordFolder({ ...folder, unread: 0 })).toBe(false);
    expect(isDiscordFolder({ ...folder, mentions: -2 })).toBe(false);
    expect(isDiscordFolder({ ...folder, iconUrls: "x" })).toBe(false);
    expect(isDiscordFolder({ ...folder, iconUrls: Array(5).fill("https://cdn/a.png") })).toBe(false);
    expect(isDiscordFolder({ ...folder, iconUrls: ["javascript:x"] })).toBe(false);
    expect(isDiscordFolder({ ...folder, index: -1 })).toBe(false);
    expect(isDiscordFolder(null)).toBe(false);
  });

  it("validates guild folder ids and folders on state", () => {
    const base = { badge: { unread: false, mentions: 0 } };
    const guild = { id: "1", name: "G", unread: false, mentions: 0 };
    expect(isDiscordState({ ...base, guilds: [{ ...guild, folderId: "5" }], folders: [folder] })).toBe(true);
    expect(isDiscordState({ ...base, guilds: [{ ...guild, folderId: "x" }] })).toBe(false);
    expect(isDiscordState({ ...base, guilds: [], folders: [{}] })).toBe(false);
    expect(isDiscordState({ ...base, guilds: [], folders: "x" })).toBe(false);
  });

  it("validates layout entries and guild read state from the bridge", () => {
    const entry = { folderId: "5", name: "Games", color: "#112233", expanded: true, guildIds: ["1", "2"] };
    expect(isLayoutEntry(entry)).toBe(true);
    expect(isLayoutEntry({ guildIds: ["1"] })).toBe(true);
    expect(isLayoutEntry({ ...entry, folderId: "x" })).toBe(false);
    expect(isLayoutEntry({ ...entry, name: 1 })).toBe(false);
    expect(isLayoutEntry({ ...entry, name: "x".repeat(201) })).toBe(false);
    expect(isLayoutEntry({ ...entry, color: "#12" })).toBe(false);
    expect(isLayoutEntry({ ...entry, expanded: 1 })).toBe(false);
    expect(isLayoutEntry({ ...entry, guildIds: ["x"] })).toBe(false);
    expect(isLayoutEntry({ ...entry, guildIds: Array(201).fill("1") })).toBe(false);
    expect(isLayoutEntry(null)).toBe(false);

    expect(isBridgePayload({ dms: [], guilds: [], layout: [entry] })).toBe(true);
    expect(isBridgePayload({ dms: [], guilds: [], layout: [{}] })).toBe(false);
    expect(isBridgePayload({ dms: [], guilds: [], layout: "x" })).toBe(false);
    expect(isGuildInfo({ id: "1", name: "G", unread: true, mentions: 3 })).toBe(true);
    expect(isGuildInfo({ id: "1", name: "G", unread: "yes" })).toBe(false);
    expect(isGuildInfo({ id: "1", name: "G", mentions: -1 })).toBe(false);
  });

  it("accepts folder toggle targets", () => {
    expect(isDiscordTarget("folder:123")).toBe(true);
    expect(isDiscordTarget("folder:abc")).toBe(false);
    expect(isDiscordTarget(42)).toBe(false);
  });
});

describe("rail order validation", () => {
  it("accepts lists of rail keys within the cap", () => {
    expect(isRailOrder(["discord:1", "fluxer:folder:2"])).toBe(true);
    expect(isRailOrder([])).toBe(true);
    expect(isRailOrder(["", "x"])).toBe(false);
    expect(isRailOrder("discord:1")).toBe(false);
    expect(isRailOrder(Array(5001).fill("a:1"))).toBe(false);
  });
});

describe("channel targets", () => {
  it("accepts a guild and channel pair only", () => {
    expect(isDiscordTarget("channel:1/2")).toBe(true);
    for (const bad of ["channel:1", "channel:1/x", "channel:1/2/3", "channel:/2", "channel:"]) expect(isDiscordTarget(bad)).toBe(false);
  });
});

describe("relayed notifications", () => {
  it("checks id, title and body", async () => {
    const { isActivityUpdate } = await import("../../src/shared/ipc");
    const activity = { application_id: "42", type: 0, flags: 0 };
    expect(isActivityUpdate({ source: "rpc-1", activity })).toBe(true);
    expect(isActivityUpdate({ source: "rpc-1", pid: 9, activity: null })).toBe(true);
    for (const bad of [
      null,
      "x",
      { source: "x", activity: null },
      { source: 1, activity: null },
      { source: "rpc-1", pid: -1, activity: null },
      { source: "rpc-1", activity: "x" },
      { source: "rpc-1", activity: { application_id: "abc" } },
      { source: "rpc-1", activity: { ...activity, details: "y".repeat(9000) } },
    ]) {
      expect(isActivityUpdate(bad)).toBe(false);
    }
    const { isRelayedNotification } = await import("../../src/shared/ipc");
    expect(isRelayedNotification({ id: "1", title: "A", body: "" })).toBe(true);
    for (const bad of [null, "x", { id: "a", title: "A", body: "" }, { id: "1", title: 1, body: "" }, { id: "1", title: "A".repeat(201), body: "" }, { id: "1", title: "A", body: "b".repeat(2001) }, { id: "1", title: "A" }]) {
      expect(isRelayedNotification(bad)).toBe(false);
    }
  });
});

describe("isDiscordPage", () => {
  it("accepts Discord's own https pages only", async () => {
    const { isDiscordPage } = await import("../../src/shared/ipc");
    expect(isDiscordPage("https://discord.com/channels/@me")).toBe(true);
    expect(isDiscordPage("https://ptb.discord.com/app")).toBe(true);
    for (const url of ["http://discord.com/", "https://evildiscord.com/", "https://discord.com.evil.example/", "about:blank", "nonsense", undefined]) {
      expect(isDiscordPage(url)).toBe(false);
    }
  });
});
