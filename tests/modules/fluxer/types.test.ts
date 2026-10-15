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
} from "../../../src/modules/fluxer/types";

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
        { id: "7", filename: "a.png", contentType: "image/png", url: "https://p", width: undefined, height: undefined, size: undefined },
        { id: "8", filename: "b.txt", contentType: undefined, url: "https://b", width: undefined, height: undefined, size: undefined },
      ],
      stickers: [],
      embeds: [],
      links: [],
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

describe("Fluxer media", () => {
  it("reads attachment details, stickers and media embeds", async () => {
    const { parseMessage } = await import("../../../src/modules/fluxer/types");
    const author = { id: "1", username: "ana" };
    const message = parseMessage({
      id: "100",
      channel_id: "10",
      author,
      attachments: [{ id: "7", filename: "a.png", content_type: "image/png", url: "https://p", width: 640, height: 480, size: 1000 }],
      sticker_items: [{ id: "5", name: "Wave", format_type: 1 }, { id: "6", name: "x".repeat(150), animated: true }, { name: "no id" }],
      embeds: [
        { type: "gifv", video: { proxy_url: "https://media/g.mp4", width: 320, height: 240 }, thumbnail: { url: "https://media/g.png" } },
        { type: "video", video: { url: "http://insecure/v.mp4" } },
        { type: "image", image: { url: "https://media/i.png", width: 10, height: 0 } },
        { type: "image", thumbnail: { url: "https://media/t.png" } },
        { type: "image" },
        { type: "article", image: { url: "https://media/a.png" } },
        null,
      ],
    })!;
    expect(message.attachments[0]).toMatchObject({ width: 640, height: 480, size: 1000 });
    expect(message.stickers).toEqual([{ id: "5", name: "Wave", format: 1, animated: false }, { id: "6", name: "x".repeat(100), format: 1, animated: true }]);
    expect(message.embeds).toEqual([
      { kind: "gifv", url: "https://media/g.mp4", previewUrl: "https://media/g.png", width: 320, height: 240 },
      { kind: "image", url: "https://media/i.png", width: 10, height: undefined },
      { kind: "image", url: "https://media/t.png", width: undefined, height: undefined },
    ]);
    expect(parseMessage({ id: "1", channel_id: "2", author, stickers: [{ id: "9", name: "Old", format_type: 4 }] })!.stickers).toEqual([{ id: "9", name: "Old", format: 4, animated: false }]);
    // An article without words or a proxied picture is no card.
    expect(message.links).toEqual([]);
  });

  it("reads link previews with words, their pictures only through the media proxy", async () => {
    const { parseMessage } = await import("../../../src/modules/fluxer/types");
    const message = parseMessage({
      id: "100",
      channel_id: "10",
      author: { id: "1", username: "ana" },
      embeds: [
        {
          type: "article",
          url: "https://site/a",
          title: "T".repeat(300),
          description: "Words",
          color: 0xff8800,
          provider: { name: "Site" },
          thumbnail: { url: "https://site/t.png", proxy_url: "https://media/t.png", width: 80, height: 80 },
        },
        { type: "rich", url: "http://plain/a", title: "Bot", author: { name: "Bot author" }, color: -1, image: { url: "https://x/i.png", proxy_url: "https://media/i.png" } },
        { type: "link", description: " ", provider: "x", author: "y", color: 0x1000000, image: { url: "https://x/i.png" } },
        { type: "image", title: "media only", image: { proxy_url: "https://media/m.png" } },
      ],
    })!;
    expect(message.links).toEqual([
      { url: "https://site/a", site: "Site", title: "T".repeat(256), description: "Words", color: "#ff8800", image: { url: "https://media/t.png", width: 80, height: 80, thumbnail: true } },
      { site: "Bot author", title: "Bot", image: { url: "https://media/i.png", width: undefined, height: undefined, thumbnail: false } },
    ]);
  });
});

describe("Fluxer expressions", () => {
  it("parses guild stickers and our traits defensively", async () => {
    const { parseGuildSticker, parseTraits } = await import("../../../src/modules/fluxer/types");
    expect(parseGuildSticker({ id: "5", name: "Wave", animated: true, tags: ["hi"] })).toEqual({ id: "5", name: "Wave", animated: true });
    expect(parseGuildSticker({ id: "6", name: "y".repeat(120) })).toEqual({ id: "6", name: "y".repeat(100), animated: false });
    for (const bad of [null, { id: "x", name: "a" }, { id: "5", name: "" }, { id: "5" }]) expect(parseGuildSticker(bad)).toBeUndefined();
    expect(parseTraits({ traits: ["premium", "", 3] })).toEqual(["premium"]);
    expect(parseTraits({})).toEqual([]);
    expect(parseTraits("me")).toEqual([]);
  });

  it("parses GIF results, preferring small looping videos", async () => {
    const { parseGif } = await import("../../../src/modules/fluxer/types");
    const base = { id: "g", url: "https://klipy.com/gifs/g", title: "G" };
    const format = (src: string, extra: Record<string, unknown> = {}) => ({ src, proxy_src: "", width: 100, height: 80, ...extra });
    expect(parseGif({ ...base, media: { gif: format("https://x/g.gif"), mediummp4: format("https://x/g.mp4", { proxy_src: "https://p/g.mp4" }) } })).toEqual({
      id: "g", url: "https://klipy.com/gifs/g", preview: "https://p/g.mp4", video: true, width: 100, height: 80, title: "G",
    });
    // Insecure or malformed formats are skipped.
    expect(parseGif({ ...base, title: "", media: { tinymp4: format("http://x/g.mp4"), tinywebp: "junk", tinygif: format("https://x/g.gif", { width: 0 }) } })).toEqual({
      id: "g", url: "https://klipy.com/gifs/g", preview: "https://x/g.gif", video: false, width: undefined, height: 80, title: undefined,
    });
    // Without known formats: the server's pick, a video when its path says so.
    expect(parseGif({ ...base, proxy_src: "https://p/g.webm?x=1", width: 10, height: 10 })).toMatchObject({ preview: "https://p/g.webm?x=1", video: true, width: 10 });
    expect(parseGif({ ...base, media: null, src: "https://x/g.gif" })).toMatchObject({ preview: "https://x/g.gif", video: false });
    for (const bad of [null, { ...base, id: "" }, { ...base, url: "http://klipy.com/g" }, base]) expect(parseGif(bad)).toBeUndefined();
  });
});
