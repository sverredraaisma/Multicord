import { describe, expect, it } from "vitest";
import {
  isTooltipRequest,
  isHttpsUrl,
  isPickerChoice,
  isRailKey,
  isRailOrder,
  isSnowflake,
  isTitleBadge,
  isPreviewText,
  parseTitleBadge,
} from "../../src/shared/ipc";

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

  it("validates navigation targets, rail keys and picker choices", () => {
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

describe("tooltip validators", () => {
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

describe("rail order validation", () => {
  it("accepts lists of rail keys within the cap", () => {
    expect(isRailOrder(["discord:1", "fluxer:folder:2"])).toBe(true);
    expect(isRailOrder([])).toBe(true);
    expect(isRailOrder(["", "x"])).toBe(false);
    expect(isRailOrder("discord:1")).toBe(false);
    expect(isRailOrder(Array(5001).fill("a:1"))).toBe(false);
  });
});

describe("activity updates", () => {
  it("checks source, pid and activity", async () => {
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
  });
});
