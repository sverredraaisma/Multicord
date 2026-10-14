import { describe, expect, it } from "vitest";
import {
  MAX_DMS,
  isDiscordDm,
  isDiscordDmList,
  isTooltipRequest,
  isDiscordGuild,
  isDiscordState,
  isDiscordTarget,
  isHttpsUrl,
  isPickerChoice,
  isRailKey,
  isSnowflake,
  isTitleBadge,
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
