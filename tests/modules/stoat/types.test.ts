import { describe, expect, it } from "vitest";
import {
  compareIds,
  displayName,
  idTime,
  isEmojiKey,
  isId,
  parseCategories,
  parseChannel,
  parseEmoji,
  parseFile,
  parseMessage,
  parseNotifySettings,
  parseReactions,
  parseServer,
  parseUnread,
  parseUser,
} from "../../../src/modules/stoat/types";
import { ANA, ANA_ID, ME_ID, ulid } from "./fixtures";

const image = { _id: "f1", tag: "attachments", filename: "cat.png", content_type: "image/png", size: 5, metadata: { type: "Image", width: 1, height: 1 } };

describe("Stoat ids", () => {
  it("accepts ULIDs only and reads their time", () => {
    expect(isId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isId("01arz3ndektsv4rrffq69g5fav")).toBe(false);
    expect(isId("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBe(false); // I is not Crockford
    expect(isId("123")).toBe(false);
    expect(isId(5)).toBe(false);
    expect(idTime("01ARYZ6S41TSV4RRFFQ69G5FAV")).toBe(1469918176385); // the ULID spec example
    expect(idTime(undefined)).toBe(0);
    expect(idTime("bad")).toBe(0);
    expect(compareIds(ulid(1), ulid(2))).toBe(-1);
    expect(compareIds(ulid(2), ulid(1))).toBe(1);
    expect(compareIds(ulid(2), ulid(2))).toBe(0);
  });
});

describe("Stoat parsers", () => {
  it("parses files from known buckets and tells images apart", () => {
    expect(parseFile(image)).toEqual({ id: "f1", tag: "attachments", filename: "cat.png", contentType: "image/png", image: true });
    expect(parseFile({ ...image, metadata: { type: "File" } })).toMatchObject({ image: false });
    expect(parseFile({ ...image, metadata: undefined })).toMatchObject({ image: true });
    expect(parseFile({ ...image, metadata: undefined, content_type: undefined, filename: "" })).toEqual({ id: "f1", tag: "attachments", filename: "file", contentType: undefined, image: false });
    expect(parseFile({ ...image, tag: "secret" })).toBeUndefined();
    expect(parseFile({ ...image, tag: 5 })).toBeUndefined();
    expect(parseFile({ ...image, _id: "../x" })).toBeUndefined();
    expect(parseFile(null)).toBeUndefined();
  });

  it("parses users, clamping names", () => {
    expect(parseUser(ANA)).toEqual({ id: ANA_ID, username: "ana", displayName: "Ana", avatar: expect.objectContaining({ id: "av1", tag: "avatars" }), relationship: "Friend" });
    expect(parseUser({ _id: ANA_ID, username: "x".repeat(500), display_name: " " })).toEqual({
      id: ANA_ID,
      username: "x".repeat(100),
      displayName: undefined,
      avatar: undefined,
      relationship: undefined,
    });
    expect(parseUser({ _id: "1", username: "a" })).toBeUndefined();
    expect(parseUser({ _id: ANA_ID })).toBeUndefined();
    expect(displayName({ id: ANA_ID, username: "ana" })).toBe("ana");
    expect(displayName({ id: ANA_ID, username: "ana", displayName: "Ana" })).toBe("Ana");
  });

  it("parses servers with their channel order and categories", () => {
    const server = parseServer({
      _id: ulid(100),
      name: "Alpha",
      channels: [ulid(1), "bad", ulid(2)],
      categories: [{ id: "c1", title: "Text", channels: [ulid(2)] }, { id: "bad id!", title: "x", channels: [] }, { id: "c2" }, "nope"],
    });
    expect(server).toEqual({ id: ulid(100), name: "Alpha", icon: undefined, channelIds: [ulid(1), ulid(2)], categories: [{ id: "c1", title: "Text", channelIds: [ulid(2)] }] });
    expect(parseServer({ _id: ulid(100) })).toBeUndefined();
    expect(parseCategories("x")).toEqual([]);
  });

  it("parses channels and rejects server channels without a server", () => {
    expect(parseChannel({ _id: ulid(5), channel_type: "TextChannel", server: ulid(100), name: "general", last_message_id: ulid(9) })).toEqual({
      id: ulid(5),
      type: "TextChannel",
      serverId: ulid(100),
      name: "general",
      recipients: [],
      lastMessageId: ulid(9),
      icon: undefined,
      active: true,
    });
    expect(parseChannel({ _id: ulid(5), channel_type: "TextChannel" })).toBeUndefined();
    expect(parseChannel({ _id: ulid(5), channel_type: "VoiceChannel" })).toBeUndefined();
    expect(parseChannel({ _id: ulid(5), channel_type: "Forum" })).toBeUndefined();
    expect(parseChannel({ _id: ulid(5) })).toBeUndefined();
    expect(parseChannel({ _id: ulid(5), channel_type: "DirectMessage", active: false, recipients: [ME_ID, ANA_ID, 5] })).toMatchObject({
      active: false,
      recipients: [ME_ID, ANA_ID],
    });
    expect(parseChannel({ _id: ulid(5), channel_type: "Group", name: "G", recipients: "x" })).toMatchObject({ active: true, recipients: [] });
  });

  it("parses messages, keeping only the author's own user object", () => {
    const parsed = parseMessage({
      _id: ulid(10),
      channel: ulid(5),
      author: ANA_ID,
      user: ANA,
      content: "hi <@" + ME_ID + ">",
      edited: "2026-10-14T12:00:00Z",
      mentions: [ME_ID, "x"],
      flags: 2,
      attachments: [image, { bad: true }],
      replies: [ulid(9)],
      reactions: { "👍": [ME_ID, ANA_ID], [ulid(50)]: [ANA_ID], abc: [ANA_ID], "🎉": [] },
      masquerade: { name: "Bridge" },
    });
    expect(parsed).toEqual({
      id: ulid(10),
      channelId: ulid(5),
      authorId: ANA_ID,
      author: expect.objectContaining({ id: ANA_ID }),
      masquerade: "Bridge",
      content: `hi <@${ME_ID}>`,
      system: undefined,
      edited: true,
      mentionIds: [ME_ID],
      flags: 2,
      attachments: [expect.objectContaining({ id: "f1" })],
      replies: [ulid(9)],
      reactions: [
        { emoji: "👍", userIds: [ME_ID, ANA_ID] },
        { emoji: ulid(50), userIds: [ANA_ID] },
      ],
    });
    const plain = parseMessage({ _id: ulid(10), channel: ulid(5), author: ANA_ID, user: { _id: ME_ID, username: "me" }, flags: -1, masquerade: "x" })!;
    expect(plain).toMatchObject({ author: undefined, content: "", edited: false, flags: 0, masquerade: undefined, reactions: [] });
    expect(parseMessage({ _id: ulid(10), channel: ulid(5) })).toBeUndefined();
    expect(parseMessage("x")).toBeUndefined();
  });

  it("turns system messages into text with mentions", () => {
    const system = (s: unknown) => parseMessage({ _id: ulid(10), channel: ulid(5), author: "00000000000000000000000000", system: s })!.system;
    const a = `<@${ANA_ID}>`;
    const m = `<@${ME_ID}>`;
    expect(system({ type: "text", content: "Hello" })).toBe("Hello");
    expect(system({ type: "text" })).toBe("");
    expect(system({ type: "user_added", id: ANA_ID, by: ME_ID })).toBe(`${a} was added by ${m}`);
    expect(system({ type: "user_remove", id: ANA_ID, by: ME_ID })).toBe(`${a} was removed by ${m}`);
    expect(system({ type: "user_joined", id: ANA_ID })).toBe(`${a} joined`);
    expect(system({ type: "user_left", id: "bad" })).toBe("Someone left");
    expect(system({ type: "user_kicked", id: ANA_ID })).toBe(`${a} was kicked`);
    expect(system({ type: "user_banned", id: ANA_ID })).toBe(`${a} was banned`);
    expect(system({ type: "channel_renamed", by: ANA_ID, name: "news" })).toBe(`${a} renamed the channel to news`);
    expect(system({ type: "channel_renamed", by: ANA_ID })).toBe(`${a} renamed the channel to …`);
    expect(system({ type: "channel_description_changed", by: ANA_ID })).toBe(`${a} changed the channel description`);
    expect(system({ type: "channel_icon_changed", by: ANA_ID })).toBe(`${a} changed the channel icon`);
    expect(system({ type: "channel_ownership_changed", from: ANA_ID, to: ME_ID })).toBe(`${a} gave the group to ${m}`);
    expect(system({ type: "message_pinned", by: ANA_ID })).toBe(`${a} pinned a message`);
    expect(system({ type: "message_unpinned", by: ANA_ID })).toBe(`${a} unpinned a message`);
    expect(system({ type: "call_started", by: ANA_ID })).toBe(`${a} started a call`);
    expect(system({ type: "future_thing" })).toBe("System message");
    expect(system({ content: "no type" })).toBeUndefined();
  });

  it("accepts Unicode and custom emoji as reaction keys only", () => {
    for (const key of ["👍", "👨‍👩‍👧", "1️⃣", "#️⃣", "❤️", ulid(50)]) expect(isEmojiKey(key), key).toBe(true);
    for (const key of ["", "abc", "<b>", "1", "👍x", "👍".repeat(20)]) expect(isEmojiKey(key), key).toBe(false);
    expect(parseReactions(null)).toEqual([]);
  });

  it("parses unread state, emoji and notification settings", () => {
    expect(parseUnread({ _id: { channel: ulid(5), user: ME_ID }, last_id: ulid(9), mentions: [ulid(8), "x"] })).toEqual({ channelId: ulid(5), lastId: ulid(9), mentions: [ulid(8)] });
    expect(parseUnread({ _id: { channel: ulid(5) } })).toEqual({ channelId: ulid(5), lastId: undefined, mentions: [] });
    expect(parseUnread({ _id: ulid(5) })).toBeUndefined();
    expect(parseUnread(null)).toBeUndefined();

    expect(parseEmoji({ _id: ulid(50), name: "party", parent: { type: "Server", id: ulid(100) } })).toEqual({ id: ulid(50), name: "party", serverId: ulid(100) });
    expect(parseEmoji({ _id: ulid(50), name: "party", parent: { type: "Detached" } })).toEqual({ id: ulid(50), name: "party", serverId: undefined });
    expect(parseEmoji({ _id: ulid(50), name: "<script>" })).toBeUndefined();
    expect(parseEmoji({ _id: ulid(50) })).toBeUndefined();

    const settings = parseNotifySettings([1, JSON.stringify({ server: { [ulid(100)]: "muted", bad: "all", [ulid(101)]: "loud" }, channel: { [ulid(5)]: "all" } })]);
    expect(settings).toEqual({ servers: new Map([[ulid(100), "muted"]]), channels: new Map([[ulid(5), "all"]]) });
    expect(parseNotifySettings([1, "{}"])).toEqual({ servers: new Map(), channels: new Map() });
    expect(parseNotifySettings([1, "not json"])).toBeUndefined();
    expect(parseNotifySettings([1, "[]"])).toBeUndefined();
    expect(parseNotifySettings([1, "x".repeat(100_001)])).toBeUndefined();
    expect(parseNotifySettings("{}")).toBeUndefined();
  });
});
