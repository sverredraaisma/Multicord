import { describe, expect, it } from "vitest";
import {
  compareIds,
  displayName,
  emojiFile,
  hexColor,
  isCdnPath,
  parseChannel,
  parseEmbed,
  parseEmoji,
  parseInbox,
  parseMember,
  parseMessage,
  parseReactionCount,
  parseRole,
  parseServer,
  parseUser,
  reactionKey,
  time,
} from "../../../src/modules/nerimity/types";
import { ANA, at, message } from "./fixtures";

describe("Nerimity link previews", () => {
  it("reads cards with words, and picture links as their picture alone", () => {
    expect(
      parseEmbed({
        type: "website",
        url: "https://example.org/a",
        siteName: "Example",
        title: "A page",
        description: "About it",
        themeColor: "#00FF00",
        imageUrl: "https://example.org/i.png",
        imageMime: "image/png",
        imageWidth: 80,
        imageHeight: 60,
        largeImage: true,
        domain: "example.org",
      }),
    ).toEqual({ url: "https://example.org/a", site: "Example", title: "A page", description: "About it", color: "#00ff00", image: { source: "https://example.org/i.png", type: "png", width: 80, height: 60, thumbnail: false } });
    // YouTube's cards name the channel; a small picture sits beside the words.
    expect(parseEmbed({ title: "T".repeat(300), channelName: "Chan", url: "http://x", imageUrl: "https://i.ytimg.com/a.jpg", imageMime: "image/jpeg" })).toEqual({
      site: "Chan",
      title: "T".repeat(256),
      image: { source: "https://i.ytimg.com/a.jpg", type: "jpeg", width: undefined, height: undefined, thumbnail: true },
    });
    expect(parseEmbed({ type: "image", imageUrl: "https://example.org/p.gif", imageMime: "image/gif", imageWidth: 4, imageHeight: 3, title: "ignored" })).toEqual({
      image: { source: "https://example.org/p.gif", type: "gif", width: 4, height: 3, thumbnail: false },
    });
    // Pictures need an https address and a picture type; cards need something to show.
    expect(parseEmbed({ description: "words", imageUrl: "http://example.org/i.png", imageMime: "image/png" })).toEqual({ description: "words" });
    expect(parseEmbed({ type: "image", imageUrl: "https://example.org/i.png", imageMime: "text/html" })).toBeUndefined();
    expect(parseEmbed({ type: "image", imageUrl: "https://example.org/i.png" })).toBeUndefined();
    expect(parseEmbed({ siteName: "Only a site", title: " " })).toBeUndefined();
    expect(parseEmbed("x")).toBeUndefined();
    expect(parseMessage(message("1", "2", { embed: { title: "T" } }))!.embed).toEqual({ title: "T" });
    expect(parseMessage(message("1", "2", { embed: null }))).not.toHaveProperty("embed");
  });
});

describe("Nerimity payload parsers", () => {
  it("reads users, keeping CDN paths only when they stay on the CDN", () => {
    expect(parseUser(ANA)).toEqual({ id: "2", username: "ana", tag: "4242", avatar: "avatars/2/9.webp" });
    expect(displayName(parseUser(ANA)!)).toBe("ana");
    expect(parseUser({ id: "5", username: "bot", bot: true, avatar: "../etc/passwd" })).toEqual({ id: "5", username: "bot", tag: "", bot: true });
    // A webhook's override id.
    expect(parseUser({ id: "5-2", username: "hook" })?.id).toBe("5-2");
    for (const bad of [null, { id: "a", username: "x" }, { id: "1", username: "" }, { id: "1" }]) expect(parseUser(bad)).toBeUndefined();
    expect(isCdnPath("attachments/1/2/a%20b.png")).toBe(true);
    for (const bad of ["/abs", "a/../b", "a/./b", "a/..", "a b", 5, "x".repeat(301)]) expect(isCdnPath(bad)).toBe(false);
  });

  it("reads dates as numbers or ISO strings, and compares ids by value", () => {
    expect(time(5)).toBe(5);
    expect(time("2026-10-16T11:00:00Z")).toBe(at(0));
    for (const bad of [0, -1, "never", null, Infinity]) expect(time(bad)).toBeUndefined();
    expect(compareIds("9", "10")).toBe(-1);
    expect(compareIds("10", "9")).toBe(1);
    expect(compareIds("7", "7")).toBe(0);
  });

  it("reads servers, channels, roles, emoji and members", () => {
    expect(parseServer({ id: "1", name: "S", avatar: "avatars/1/2.webp", defaultRoleId: "3", createdById: "4" })).toEqual({ id: "1", name: "S", avatar: "avatars/1/2.webp", defaultRoleId: "3", createdById: "4" });
    expect(parseServer({ id: "1", name: "S" })).toEqual({ id: "1", name: "S" });
    expect(parseServer({ id: "1" })).toBeUndefined();
    expect(parseChannel({ id: "5", type: 1, name: "c", serverId: "1", categoryId: "4", order: 2, lastMessagedAt: 9, permissions: [{ roleId: "3", permissions: 1 }, { roleId: "x" }] })).toEqual({
      id: "5",
      type: 1,
      name: "c",
      serverId: "1",
      categoryId: "4",
      order: 2,
      lastMessagedAt: 9,
      permissions: [{ roleId: "3", permissions: 1 }],
    });
    expect(parseChannel({ id: "5", type: 0, name: "" })).toEqual({ id: "5", type: 0, order: 0, permissions: [] });
    expect(parseChannel({ id: "5" })).toBeUndefined();
    expect(parseRole({ id: "3", name: "R", hexColor: "ABCDEF", order: 4, hideRole: true, permissions: 1 })).toEqual({ id: "3", name: "R", color: "#abcdef", order: 4, hidden: true, permissions: 1 });
    expect(parseRole({ id: "3", name: "R", hexColor: "red" })).toEqual({ id: "3", name: "R", order: 0, hidden: false, permissions: 0 });
    expect(parseRole({ id: "3" })).toBeUndefined();
    expect(hexColor("#123456")).toBe("#123456");
    expect(hexColor(undefined)).toBeUndefined();
    expect(parseEmoji({ id: "7", name: "cat", gif: true })).toEqual({ id: "7", name: "cat", gif: true, webp: false });
    expect(parseEmoji({ id: "7", name: "c a t" })).toBeUndefined();
    expect(emojiFile({ id: "7", gif: true })).toBe("7.gif");
    expect(emojiFile({ id: "7", gif: true, webp: true })).toBe("7.webp");
    expect(emojiFile({ id: "7" })).toBe("7.webp");
    expect(parseMember({ serverId: "1", user: ANA, roleIds: ["3", 4], nickname: "A" })).toEqual({ serverId: "1", user: parseUser(ANA), roleIds: ["3"], nickname: "A" });
    expect(parseMember({ user: ANA }, "9")).toEqual({ serverId: "9", user: parseUser(ANA), roleIds: [] });
    expect(parseMember({ user: ANA })).toBeUndefined();
    expect(parseMember({ serverId: "1" })).toBeUndefined();
    expect(parseMember(null)).toBeUndefined();
  });

  it("reads messages with their attachments, reactions, replies and quotes", () => {
    const parsed = parseMessage(
      message("5", "9", {
        editedAt: at(1),
        mentions: [{ id: "1" }, "2"],
        roleMentions: [{ id: "3" }, null],
        mentionReplies: true,
        attachments: [
          { id: "40", path: "attachments/9/40/cat.png", mime: "image/png", width: 10, height: 20, filesize: 30, provider: "local" },
          { id: "41", provider: "google_drive", fileId: "g", mime: "not a mime" },
          { id: "x" },
        ],
        reactions: [{ name: "👍", count: 2, reacted: true }, { name: "party", emojiId: "130", webp: true, count: 1 }, { name: "gone", count: 0 }, { name: "" }],
        replyMessages: [null, {}, { replyToMessage: { id: "4", content: "earlier", createdBy: { id: "1", username: "me" }, createdAt: at(0) } }],
        quotedMessages: [{ id: "3", content: "quoted" }, { id: "bad" }],
      }),
    );
    expect(parsed).toEqual({
      id: "5",
      channelId: "9",
      author: parseUser(ANA),
      content: "m5",
      type: 0,
      createdAt: at(5),
      edited: true,
      mentionIds: ["1"],
      roleMentionIds: ["3"],
      mentionReplies: true,
      attachments: [
        { id: "40", path: "attachments/9/40/cat.png", provider: "local", mime: "image/png", width: 10, height: 20, size: 30 },
        { id: "41", provider: "google_drive" },
      ],
      reactions: [
        { name: "👍", gif: false, webp: false, count: 2, reacted: true },
        { name: "party", emojiId: "130", gif: false, webp: true, count: 1, reacted: false },
      ],
      replyTo: { id: "4", content: "earlier", author: { id: "1", username: "me", tag: "" }, createdAt: at(0) },
      quotes: [{ id: "3", content: "quoted" }],
    });
    // A message whose author is gone, with what is missing filled in.
    expect(parseMessage({ id: "6", channelId: "9", createdBy: null, attachments: [{ id: "1" }] })).toEqual({
      id: "6",
      channelId: "9",
      content: "",
      type: 0,
      createdAt: 0,
      edited: false,
      mentionIds: [],
      roleMentionIds: [],
      mentionReplies: false,
      attachments: [{ id: "1", provider: "local" }],
      reactions: [],
      quotes: [],
    });
    expect(parseMessage({ id: "6" })).toBeUndefined();
    expect(parseReactionCount({ name: "x", count: -1 })).toEqual({ name: "x", gif: false, webp: false, count: 0, reacted: false });
    expect(reactionKey({ name: "party", emojiId: "130" })).toBe("party:130");
    expect(reactionKey({ name: "👍" })).toBe("👍");
  });

  it("reads inbox entries, with or without their channel", () => {
    expect(parseInbox({ channelId: "900", recipient: ANA, lastSeen: at(1) })).toEqual({ inbox: { channelId: "900", recipient: parseUser(ANA), lastSeen: at(1) } });
    expect(parseInbox({ recipient: ANA, channel: { id: "901", type: 0 } })).toEqual({ inbox: { channelId: "901", recipient: parseUser(ANA) }, channel: { id: "901", type: 0, order: 0, permissions: [] } });
    expect(parseInbox({ channelId: "900" })).toBeUndefined();
    expect(parseInbox({ recipient: ANA })).toBeUndefined();
    expect(parseInbox("x")).toBeUndefined();
  });
});
