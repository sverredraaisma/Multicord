import { describe, expect, it } from "vitest";
import {
  compareIds,
  displayName,
  emojiKey,
  parseEmoji,
  isId,
  parseChannel,
  parseFolders,
  parseGuild,
  parseMessage,
  parseReadState,
  parseUser,
} from "../../../src/main/fluxer/types";

const user = { id: "1", username: "ana", global_name: "Ana", avatar: "abc" };

describe("Fluxer parsers", () => {
  it("compares snowflakes numerically", () => {
    expect(compareIds("9", "10")).toBe(-1);
    expect(compareIds("10", "9")).toBe(1);
    expect(compareIds("5", "5")).toBe(0);
    expect(isId("123")).toBe(true);
    expect(isId("x")).toBe(false);
  });

  it("parses users", () => {
    expect(parseUser(user)).toEqual({ id: "1", username: "ana", globalName: "Ana", avatar: "abc" });
    expect(parseUser({ id: "1", username: "bo", global_name: "", avatar: null })).toEqual({
      id: "1",
      username: "bo",
      globalName: undefined,
      avatar: undefined,
    });
    expect(parseUser({ id: "x", username: "a" })).toBeUndefined();
    expect(parseUser({ id: "1" })).toBeUndefined();
    expect(parseUser([])).toBeUndefined();
    expect(displayName({ id: "1", username: "bo" })).toBe("bo");
    expect(displayName(parseUser(user)!)).toBe("Ana");
  });

  it("parses plain and READY-style guilds", () => {
    expect(parseGuild({ id: "5", name: "G", icon: "h" })).toEqual({ id: "5", name: "G", icon: "h" });
    expect(parseGuild({ id: "5", properties: { name: "Nested", icon: null } })).toEqual({ id: "5", name: "Nested", icon: undefined });
    expect(parseGuild({ id: "5", unavailable: true })).toBeUndefined();
    expect(parseGuild({ id: "5" })).toBeUndefined();
    expect(parseGuild({ id: "bad", name: "G" })).toBeUndefined();
  });

  it("parses channels", () => {
    expect(
      parseChannel({
        id: "10",
        type: 0,
        guild_id: "5",
        name: "general",
        position: 2,
        parent_id: "9",
        last_message_id: "99",
        recipients: [user, { bad: true }],
        icon: "i",
      }),
    ).toEqual({
      id: "10",
      type: 0,
      guildId: "5",
      name: "general",
      position: 2,
      parentId: "9",
      lastMessageId: "99",
      recipients: [{ id: "1", username: "ana", globalName: "Ana", avatar: "abc" }],
      icon: "i",
    });
    expect(parseChannel({ id: "11", type: 1 }, "5")).toMatchObject({ guildId: "5", position: 0, recipients: [] });
    expect(parseChannel({ id: "11" })).toBeUndefined();
  });

  it("parses messages, dropping malformed parts", () => {
    expect(
      parseMessage({
        id: "100",
        channel_id: "10",
        author: user,
        content: "hi <@1>",
        timestamp: "2026-10-14T12:00:00Z",
        edited_timestamp: "2026-10-14T12:01:00Z",
        mentions: [{ id: "1" }, { id: "x" }],
        mention_everyone: true,
        attachments: [
          { id: "7", filename: "a.png", content_type: "image/png", url: "https://u", proxy_url: "https://p" },
          { id: "8", filename: "b.txt", url: "https://b" },
          { id: "9" },
        ],
      }),
    ).toEqual({
      id: "100",
      channelId: "10",
      author: { id: "1", username: "ana", globalName: "Ana", avatar: "abc" },
      content: "hi <@1>",
      timestamp: "2026-10-14T12:00:00Z",
      edited: true,
      mentionIds: ["1"],
      mentionEveryone: true,
      attachments: [
        { id: "7", filename: "a.png", contentType: "image/png", url: "https://p" },
        { id: "8", filename: "b.txt", contentType: undefined, url: "https://b" },
      ],
      type: undefined,
      replyTo: undefined,
      reactions: [],
    });
    expect(parseMessage({ id: "1", channel_id: "2", author: user })).toMatchObject({ content: "", timestamp: "", edited: false });
    expect(parseMessage({ id: "1", channel_id: "2", author: {} })).toBeUndefined();
    expect(parseMessage({ id: "1" })).toBeUndefined();
  });

  it("parses read states from READY and MESSAGE_ACK shapes", () => {
    expect(parseReadState({ id: "10", last_message_id: "99", mention_count: 2 })).toEqual({
      channelId: "10",
      lastMessageId: "99",
      mentionCount: 2,
    });
    expect(parseReadState({ channel_id: "10", message_id: "98", mention_count: -1 })).toEqual({
      channelId: "10",
      lastMessageId: "98",
      mentionCount: 0,
    });
    expect(parseReadState({ id: "10" })).toEqual({ channelId: "10", lastMessageId: undefined, mentionCount: 0 });
    expect(parseReadState({})).toBeUndefined();
    expect(parseReadState(null)).toBeUndefined();
  });

  it("parses guild folders from user settings", () => {
    expect(
      parseFolders({
        guild_folders: [
          { id: -1, guild_ids: ["1"] },
          { id: 42, name: "Games", color: 0xff8800, guild_ids: ["2", "x", "3"] },
          { id: "77", name: "", color: -5, guild_ids: "nope" },
          null,
        ],
      }),
    ).toEqual([
      { id: undefined, name: undefined, color: undefined, guildIds: ["1"] },
      { id: "42", name: "Games", color: "#ff8800", guildIds: ["2", "3"] },
      { id: "77", name: undefined, color: undefined, guildIds: [] },
    ]);
    expect(parseFolders({})).toBeUndefined();
    expect(parseFolders(null)).toBeUndefined();
  });
});

describe("replies and reactions", () => {
  const author = { id: "2", username: "ana" };

  it("parses reply previews, keeping deleted originals apart from non-replies", () => {
    expect(parseMessage({ id: "1", channel_id: "2", author, type: 19, referenced_message: { id: "9", author, content: "orig" } })).toMatchObject({
      type: 19,
      replyTo: { id: "9", author: { id: "2" }, content: "orig" },
    });
    expect(parseMessage({ id: "1", channel_id: "2", author, referenced_message: { id: "9", author } })!.replyTo).toMatchObject({ content: "" });
    expect(parseMessage({ id: "1", channel_id: "2", author, referenced_message: null })!.replyTo).toBeNull();
    expect(parseMessage({ id: "1", channel_id: "2", author, referenced_message: { id: "9" } })!.replyTo).toBeNull();
    expect(parseMessage({ id: "1", channel_id: "2", author })!.replyTo).toBeUndefined();
  });

  it("parses reactions with unicode and custom emoji", () => {
    const parsed = parseMessage({
      id: "1",
      channel_id: "2",
      author,
      reactions: [
        { emoji: { name: "👍" }, count: 3, me: true },
        { emoji: { id: "55", name: "party", animated: true }, count: 1 },
        { emoji: { name: "" }, count: 1 },
        { emoji: { name: "x" }, count: 0 },
        "junk",
      ],
    });
    expect(parsed!.reactions).toEqual([
      { emoji: { name: "👍" }, count: 3, me: true },
      { emoji: { id: "55", name: "party" }, count: 1, me: false },
    ]);
    expect(emojiKey({ name: "👍" })).toBe("👍");
    expect(emojiKey({ id: "55", name: "party" })).toBe("party:55");
    expect(parseEmoji(null)).toBeUndefined();
  });
});
