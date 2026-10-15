import { describe, expect, it } from "vitest";
import {
  compareIds,
  displayName,
  emojiKey,
  parseChannel,
  parseEmoji,
  parseGuild,
  parseMember,
  parseMessage,
  parseReactionEmoji,
  parseReadState,
  parseRole,
  parseUser,
  roleColor,
  timestampOf,
} from "../../../src/modules/spacebar/types";
import { ANA, message } from "./fixtures";

describe("Spacebar types", () => {
  it("reads users, keeping only well-formed pictures", () => {
    expect(parseUser(ANA)).toEqual({ id: "2", username: "ana", globalName: "Ana", avatar: "abc123" });
    expect(parseUser({ id: "3", username: "bot", avatar: "../evil", bot: true })).toEqual({ id: "3", username: "bot", bot: true });
    expect(parseUser({ id: "x", username: "a" })).toBeUndefined();
    expect(parseUser({ id: "3" })).toBeUndefined();
    expect(parseUser(null)).toBeUndefined();
    expect(displayName(parseUser(ANA)!)).toBe("Ana");
    expect(displayName(parseUser({ id: "3", username: "bob" })!)).toBe("bob");
  });

  it("reads roles, emoji and their keys", () => {
    expect(parseRole({ id: "1", name: "R", color: 0xabcdef, position: 3, hoist: true })).toEqual({ id: "1", name: "R", color: 0xabcdef, position: 3, hoist: true });
    expect(parseRole({ id: "1", name: "R", color: -1 })).toEqual({ id: "1", name: "R", color: 0, position: 0, hoist: false });
    expect(parseRole({ id: "1" })).toBeUndefined();
    expect(roleColor(parseRole({ id: "1", name: "R", color: 0x0000ff }))).toBe("#0000ff");
    expect(roleColor(parseRole({ id: "1", name: "R" }))).toBeUndefined();
    expect(roleColor(undefined)).toBeUndefined();
    expect(parseEmoji({ id: "5", name: "party", animated: true })).toEqual({ id: "5", name: "party", animated: true });
    expect(parseEmoji({ id: "5", name: "bad name" })).toBeUndefined();
    expect(parseEmoji({ name: "party" })).toBeUndefined();
    expect(parseReactionEmoji({ id: "5", name: "party" })).toEqual({ id: "5", name: "party" });
    expect(parseReactionEmoji({ id: null, name: "👍" })).toEqual({ name: "👍" });
    expect(parseReactionEmoji({ name: "" })).toBeUndefined();
    expect(parseReactionEmoji("x")).toBeUndefined();
    expect(emojiKey({ id: "5", name: "party" })).toBe("party:5");
    expect(emojiKey({ name: "👍" })).toBe("👍");
  });

  it("reads guilds and channels", () => {
    expect(parseGuild({ id: "1", name: "G", icon: "a_ff" })).toEqual({ id: "1", name: "G", icon: "a_ff" });
    expect(parseGuild({ id: "1", name: "G", icon: "no/pe" })).toEqual({ id: "1", name: "G" });
    expect(parseGuild({ id: "1", unavailable: true })).toBeUndefined();
    expect(parseGuild({ id: "1" })).toBeUndefined();
    expect(parseChannel({ id: "5", type: 0, name: "c", position: 2, parent_id: "4", last_message_id: "9", recipients: [ANA, {}] }, "1")).toEqual({
      id: "5",
      type: 0,
      guildId: "1",
      name: "c",
      position: 2,
      parentId: "4",
      lastMessageId: "9",
      recipients: [parseUser(ANA)],
    });
    expect(parseChannel({ id: "5", type: 1, guild_id: "7" })).toEqual({ id: "5", type: 1, guildId: "7", position: 0, recipients: [] });
    expect(parseChannel({ id: "5" })).toBeUndefined();
  });

  it("reads messages: mentions, files, reactions and replies", () => {
    const parsed = parseMessage(
      message("10", "5", {
        edited_timestamp: "2026-10-14T12:01:00Z",
        mentions: [{ id: "1" }, "3", { id: "x" }],
        mention_everyone: true,
        mention_roles: ["7", "x"],
        attachments: [
          { id: "20", filename: "a.png", content_type: "image/png", url: "https://cdn.sb/a.png", proxy_url: "https://cdn.sb/p/a.png", width: 4, height: 3, size: 10 },
          { id: "21", filename: "b.txt", url: "http://cdn.sb/b.txt", width: -1 },
          { id: "x", filename: "c" },
        ],
        reactions: [
          { emoji: { name: "👍" }, count: 2, me: true },
          { emoji: { id: "5", name: "party" }, count: 1 },
          { emoji: { name: "x" }, count: 0 },
          "bad",
        ],
        referenced_message: { id: "9", author: ANA, content: "orig", timestamp: "2026-10-14T11:00:00Z" },
      }),
    )!;
    expect(parsed).toMatchObject({ id: "10", channelId: "5", edited: true, mentionIds: ["1", "3"], mentionEveryone: true, roleMentionIds: ["7"], type: 0 });
    expect(parsed.attachments).toEqual([
      { id: "20", filename: "a.png", contentType: "image/png", url: "https://cdn.sb/p/a.png", width: 4, height: 3, size: 10 },
      { id: "21", filename: "b.txt", contentType: undefined, url: undefined, width: undefined, height: undefined, size: undefined },
    ]);
    expect(parsed.reactions).toEqual([
      { emoji: { name: "👍" }, count: 2, me: true },
      { emoji: { id: "5", name: "party" }, count: 1, me: false },
    ]);
    expect(parsed.replyTo).toEqual({ id: "9", author: parseUser(ANA), content: "orig", timestamp: "2026-10-14T11:00:00Z" });
    expect(parseMessage(message("10", "5", { referenced_message: null }))!.replyTo).toBeNull();
    expect(parseMessage(message("10", "5", { referenced_message: { id: "9", author: ANA, content: 3 } }))!.replyTo).toEqual({ id: "9", author: parseUser(ANA), content: "", timestamp: "" });
    const bare = parseMessage({ id: "10", channel_id: "5", author: ANA })!;
    expect(bare).toMatchObject({ content: "", timestamp: "", edited: false, type: 0, reactions: [], attachments: [] });
    expect(bare).not.toHaveProperty("replyTo");
    expect(parseMessage({ id: "10", channel_id: "5" })).toBeUndefined();
    expect(parseMessage({ id: "10" })).toBeUndefined();
  });

  it("reads read states and members", () => {
    expect(parseReadState({ id: "5", last_message_id: "9", mention_count: 2 })).toEqual({ channelId: "5", lastMessageId: "9", mentionCount: 2 });
    expect(parseReadState({ channel_id: "5", message_id: "9", mention_count: -1 })).toEqual({ channelId: "5", lastMessageId: "9", mentionCount: 0 });
    expect(parseReadState({ channel_id: "5" })).toEqual({ channelId: "5", mentionCount: 0 });
    expect(parseReadState({})).toBeUndefined();
    expect(parseReadState(1)).toBeUndefined();
    expect(parseMember({ user: ANA, nick: "Annie", roles: ["7", { id: "8" }, "x"] })).toEqual({ user: parseUser(ANA), nick: "Annie", roles: ["7", "8"] });
    expect(parseMember({ user: ANA })).toEqual({ user: parseUser(ANA), roles: [] });
    expect(parseMember({})).toBeUndefined();
    expect(parseMember("x")).toBeUndefined();
  });

  it("compares snowflakes and tells when they were made", () => {
    expect(compareIds("10", "9")).toBe(1);
    expect(compareIds("9", "10")).toBe(-1);
    expect(compareIds("9", "9")).toBe(0);
    expect(timestampOf(undefined)).toBe(0);
    expect(timestampOf(String(1000n << 22n))).toBe(1420070401000);
  });
});
