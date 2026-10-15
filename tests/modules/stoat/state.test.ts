import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoatState, TYPING_MS } from "../../../src/modules/stoat/state";
import { parseMessage } from "../../../src/modules/stoat/types";
import { ALPHA, ANA, ANA_ID, BETA, BOB_ID, CHAT, CLOSED_DM, DM, EMOJI, GENERAL, GROUP, LOBBY, ME_ID, RULES, message, readyPayload, ulid } from "./fixtures";

function ready(extra: Record<string, unknown> = {}) {
  const state = new StoatState();
  state.apply("Ready", readyPayload(extra));
  return state;
}

const msg = (n: number, channel: string, extra: Record<string, unknown> = {}) => parseMessage(message(n, channel, extra))!;

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-14T12:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("StoatState from Ready", () => {
  it("knows the user, servers, channels, emoji and unreads", () => {
    const state = ready();
    expect(state.meId).toBe(ME_ID);
    expect(state.me?.username).toBe("me");
    expect([...state.servers.keys()]).toEqual([ALPHA, BETA]);
    expect(state.channels.size).toBe(9); // Saved Notes and voice channels are kept, just not shown
    expect(state.emojis.get(EMOJI)?.name).toBe("party");
    expect(state.unreadsLoaded).toBe(true);
    expect(state.mentions(GENERAL)).toBe(2);
  });

  it("keeps the signed-in id from login when Ready does not mark it", () => {
    const state = new StoatState();
    state.meId = ME_ID;
    state.apply("Ready", { users: [ANA] });
    expect(state.meId).toBe(ME_ID);
    expect(state.unreadsLoaded).toBe(false);
    expect(state.me).toBeUndefined();
  });

  it("lists a server's text channels by category, without voice-only channels", () => {
    const state = ready();
    expect(state.serverEntries(ALPHA)).toEqual([
      { channel: expect.objectContaining({ id: LOBBY }) },
      { category: { id: "cat1", title: "Text" } },
      { channel: expect.objectContaining({ id: GENERAL }) },
      { channel: expect.objectContaining({ id: RULES }) },
    ]);
    expect(state.serverEntries("nope")).toEqual([]);
  });

  it("works out unread state and mentions", () => {
    const state = ready();
    const channel = (id: string) => state.channels.get(id)!;
    expect(state.isUnread(channel(GENERAL))).toBe(true);
    expect(state.isUnread(channel(LOBBY))).toBe(false);
    expect(state.isUnread(channel(RULES))).toBe(false); // no messages yet
    expect(state.isUnread(channel(GROUP))).toBe(false); // no read position, no mentions
    expect(state.isUnread(channel(DM))).toBe(true);
    expect(state.isUnread(channel(ulid(903)))).toBe(false); // Saved Notes are not shown
    expect(state.serverUnread(ALPHA)).toBe(true);
    expect(state.serverMentions(ALPHA)).toBe(2);
    expect(state.serverUnread(BETA)).toBe(false);
    state.unreads.set(GROUP, { channelId: GROUP, mentions: [ulid(600)] });
    expect(state.isUnread(channel(GROUP))).toBe(true);
  });

  it("lists open DMs and groups, most recent first", () => {
    const state = ready();
    expect(state.privateChannels().map((c) => c.id)).toEqual([DM, GROUP]);
    state.channels.get(CLOSED_DM)!.active = true;
    expect(state.privateChannels().map((c) => c.id)).toEqual([DM, GROUP, CLOSED_DM]);
  });
});

describe("StoatState messages", () => {
  it("adds history, newest last, and older pages in front", () => {
    const state = ready();
    state.addHistory(GENERAL, [msg(10, GENERAL), msg(11, GENERAL)], [{ id: BOB_ID, username: "bobby" }], false);
    state.addHistory(GENERAL, [msg(8, GENERAL), msg(10, GENERAL)], [], true);
    expect(state.messages.get(GENERAL)!.map((m) => m.id)).toEqual([ulid(8), ulid(10), ulid(11)]);
    expect(state.latest.get(GENERAL)!.id).toBe(ulid(11));
    expect(state.users.get(BOB_ID)?.username).toBe("bobby");
    // History users carry no relationship; Ready's stays.
    state.addHistory(GENERAL, [msg(12, GENERAL, { user: { _id: ME_ID, username: "me2" }, author: ME_ID })], [], false);
    expect(state.users.get(ME_ID)).toMatchObject({ username: "me2", relationship: "User" });
  });

  it("takes in new messages: unread, mentions, typing and the cache", () => {
    const state = ready();
    const incoming = vi.fn();
    state.incoming.on(incoming);
    state.addHistory(LOBBY, [], [], false);
    state.apply("ChannelStartTyping", { id: LOBBY, user: ANA_ID });
    state.apply("Message", message(310, LOBBY, { user: ANA }));
    expect(state.typingIn(LOBBY)).toEqual([]);
    expect(state.messages.get(LOBBY)!.map((m) => m.id)).toEqual([ulid(310)]);
    expect(state.channels.get(LOBBY)!.lastMessageId).toBe(ulid(310));
    expect(state.isUnread(state.channels.get(LOBBY)!)).toBe(true);
    expect(state.mentions(LOBBY)).toBe(0);
    expect(incoming).toHaveBeenCalledOnce();

    state.apply("Message", message(311, LOBBY, { mentions: [ME_ID] }));
    state.apply("Message", message(312, LOBBY, { flags: 2 }));
    state.apply("Message", message(311, LOBBY)); // a repeat is not cached twice
    expect(state.mentions(LOBBY)).toBe(2);
    expect(state.messages.get(LOBBY)).toHaveLength(3);

    state.apply("Message", message(320, CHAT, { author: ME_ID }));
    expect(state.unreads.get(CHAT)).toEqual({ channelId: CHAT, lastId: ulid(320), mentions: [] });
    expect(incoming).toHaveBeenCalledTimes(3);

    state.apply("Message", { bad: true });
    state.apply("Message", message(330, ulid(999))); // an unknown channel still counts as latest
    expect(state.latest.get(ulid(999))?.id).toBe(ulid(330));
  });

  it("counts every DM message, reopens closed DMs and caps the cache", () => {
    const state = ready();
    state.apply("Message", message(801, DM));
    expect(state.mentions(DM)).toBe(2);
    state.apply("Message", message(905, CLOSED_DM, { author: BOB_ID }));
    expect(state.channels.get(CLOSED_DM)!.active).toBe(true);
    expect(state.mentions(CLOSED_DM)).toBe(1);

    state.addHistory(GROUP, [], [], false);
    for (let i = 0; i < 205; i++) state.apply("Message", message(1000 + i, GROUP));
    expect(state.messages.get(GROUP)).toHaveLength(200);
    expect(state.messages.get(GROUP)![0]!.id).toBe(ulid(1005));
  });

  it("applies partial message updates to the cache and the preview", () => {
    const state = ready();
    state.apply("Message", message(810, DM));
    state.addHistory(DM, [msg(805, DM)], [], false);
    state.apply("MessageUpdate", { id: ulid(810), channel: DM, data: { content: "edited", edited: "2026-10-14", reactions: { "👍": [ANA_ID] } } });
    expect(state.latest.get(DM)).toMatchObject({ content: "edited", edited: true, reactions: [{ emoji: "👍", userIds: [ANA_ID] }] });
    state.apply("MessageUpdate", { id: ulid(805), channel: DM, data: { content: "older" } });
    expect(state.messages.get(DM)!.find((m) => m.id === ulid(805))!.content).toBe("older");
    state.apply("MessageUpdate", { id: ulid(805), channel: DM });
    state.apply("MessageUpdate", { id: ulid(1), channel: "bad", data: { content: "x" } });
    expect(state.latest.get(DM)!.content).toBe("edited");
  });

  it("replaces edited messages and removes deleted ones", () => {
    const state = ready();
    state.addHistory(DM, [msg(805, DM), msg(806, DM)], [], false);
    expect(state.replaceMessage(msg(806, DM, { content: "new" }))).toBe(true);
    expect(state.latest.get(DM)!.content).toBe("new");
    expect(state.replaceMessage(msg(999, CHAT))).toBe(false);
    state.removeMessage(DM, ulid(806));
    expect(state.messages.get(DM)!.map((m) => m.id)).toEqual([ulid(805)]);
    expect(state.latest.has(DM)).toBe(false);
    state.removeMessage(CHAT, ulid(1));

    state.addHistory(GENERAL, [msg(10, GENERAL), msg(11, GENERAL), msg(12, GENERAL)], [], false);
    state.apply("MessageDelete", { id: ulid(10), channel: GENERAL });
    state.apply("BulkMessageDelete", { channel: GENERAL, ids: [ulid(11), "x"] });
    state.apply("MessageDelete", { id: "x", channel: GENERAL });
    state.apply("BulkMessageDelete", { channel: "x", ids: [ulid(12)] });
    expect(state.messages.get(GENERAL)!.map((m) => m.id)).toEqual([ulid(12)]);
  });

  it("tracks reactions as sets of users", () => {
    const state = ready();
    state.addHistory(DM, [msg(805, DM)], [], false);
    const reactions = () => state.messages.get(DM)![0]!.reactions;
    state.apply("MessageReact", { id: ulid(805), channel_id: DM, user_id: ANA_ID, emoji_id: "👍" });
    state.apply("MessageReact", { id: ulid(805), channel_id: DM, user_id: ME_ID, emoji_id: "👍" });
    state.apply("MessageReact", { id: ulid(805), channel_id: DM, user_id: ME_ID, emoji_id: "👍" });
    state.apply("MessageReact", { id: ulid(805), channel_id: DM, user_id: ANA_ID, emoji_id: EMOJI });
    expect(reactions()).toEqual([
      { emoji: "👍", userIds: [ANA_ID, ME_ID] },
      { emoji: EMOJI, userIds: [ANA_ID] },
    ]);
    state.apply("MessageUnreact", { id: ulid(805), channel_id: DM, user_id: ANA_ID, emoji_id: "👍" });
    state.apply("MessageUnreact", { id: ulid(805), channel_id: DM, user_id: ANA_ID, emoji_id: "🎉" });
    state.apply("MessageUnreact", { id: ulid(805), channel_id: DM, user_id: "x", emoji_id: "👍" });
    state.apply("MessageReact", { id: ulid(1), channel_id: DM, user_id: ANA_ID, emoji_id: "👍" });
    expect(reactions()).toEqual([
      { emoji: "👍", userIds: [ME_ID] },
      { emoji: EMOJI, userIds: [ANA_ID] },
    ]);
    state.applyReaction(DM, ulid(805), "👍", ME_ID, false);
    expect(reactions()).toEqual([{ emoji: EMOJI, userIds: [ANA_ID] }]);
    state.apply("MessageRemoveReaction", { id: ulid(805), channel_id: DM, emoji_id: EMOJI });
    state.apply("MessageRemoveReaction", { id: ulid(1), channel_id: DM, emoji_id: EMOJI });
    expect(reactions()).toEqual([]);
  });

  it("marks channels read, locally and from our other sessions", () => {
    const state = ready();
    state.markRead(GENERAL, ulid(500));
    expect(state.isUnread(state.channels.get(GENERAL)!)).toBe(false);
    expect(state.mentions(GENERAL)).toBe(0);
    state.unreads.set(DM, { channelId: DM, lastId: ulid(700), mentions: [ulid(750), ulid(800)] });
    state.apply("ChannelAck", { id: DM, user: ME_ID, message_id: ulid(760) });
    expect(state.unreads.get(DM)).toEqual({ channelId: DM, lastId: ulid(760), mentions: [ulid(800)] });
    state.apply("ChannelAck", { id: DM, user: ANA_ID, message_id: ulid(800) });
    state.apply("ChannelAck", { id: GROUP, user: ME_ID, message_id: ulid(600) });
    expect(state.unreads.get(GROUP)).toEqual({ channelId: GROUP, lastId: ulid(600), mentions: [] });
    expect(state.unreads.get(DM)!.lastId).toBe(ulid(760));
  });

  it("does not count mentions at or before the read position", () => {
    // The server can record a mention after the ack that read it.
    const state = ready({
      channel_unreads: [
        { _id: { channel: GENERAL, user: ME_ID }, last_id: ulid(450), mentions: [ulid(440), ulid(450), ulid(460)] },
        { _id: { channel: DM, user: ME_ID }, mentions: [ulid(800)] },
      ],
    });
    expect(state.unreads.get(GENERAL)!.mentions).toEqual([ulid(460)]);
    expect(state.mentions(DM)).toBe(1);
  });

  it("loads unread state fetched separately", () => {
    const state = ready({ channel_unreads: undefined });
    expect(state.unreadsLoaded).toBe(false);
    const changed = vi.fn();
    state.changed.on(changed);
    state.setUnreads([{ channelId: GENERAL, lastId: ulid(400), mentions: [ulid(450)] }]);
    expect(state.unreadsLoaded).toBe(true);
    expect(state.mentions(GENERAL)).toBe(1);
    expect(changed).toHaveBeenCalled();
  });
});

describe("StoatState servers, channels and users", () => {
  it("adds, updates and removes servers", () => {
    const state = ready();
    state.apply("ServerCreate", {
      id: ulid(300),
      server: { _id: ulid(300), name: "Gamma", channels: [ulid(311)] },
      channels: [{ _id: ulid(311), channel_type: "TextChannel", server: ulid(300), name: "hi" }],
      emojis: [{ _id: ulid(51), name: "wave" }],
    });
    expect(state.serverEntries(ulid(300))).toEqual([{ channel: expect.objectContaining({ name: "hi" }) }]);
    expect(state.emojis.has(ulid(51))).toBe(true);

    state.apply("ServerUpdate", { id: ALPHA, data: { name: "Alpha 2", icon: { _id: "ic2", tag: "icons", filename: "x" }, channels: [GENERAL], categories: [] } });
    expect(state.servers.get(ALPHA)).toMatchObject({ name: "Alpha 2", icon: { id: "ic2" }, channelIds: [GENERAL], categories: [] });
    state.apply("ServerUpdate", { id: ALPHA, data: {}, clear: ["Icon", "Categories"] });
    expect(state.servers.get(ALPHA)!.icon).toBeUndefined();
    state.apply("ServerUpdate", { id: ulid(1), data: { name: "x" } });

    state.apply("ServerMemberLeave", { id: BETA, user: ANA_ID });
    expect(state.servers.has(BETA)).toBe(true);
    state.apply("ServerMemberLeave", { id: BETA, user: ME_ID });
    expect(state.servers.has(BETA)).toBe(false);
    expect(state.channels.has(CHAT)).toBe(false);
    state.apply("ServerDelete", { id: ALPHA });
    expect(state.servers.size).toBe(1);
    state.apply("ServerDelete", { id: "x" });
    state.apply("ServerMemberLeave", { id: "x", user: ME_ID });
  });

  it("adds, updates and removes channels and group members", () => {
    const state = ready();
    state.apply("ChannelCreate", { _id: ulid(120), channel_type: "TextChannel", server: ALPHA, name: "new" });
    expect(state.channels.get(ulid(120))?.name).toBe("new");
    state.apply("ChannelUpdate", {
      id: DM,
      data: { name: "renamed", icon: { _id: "g", tag: "icons", filename: "g" }, last_message_id: ulid(850), active: false, recipients: [ME_ID, "x"] },
    });
    expect(state.channels.get(DM)).toMatchObject({ name: "renamed", icon: { id: "g" }, lastMessageId: ulid(850), active: false, recipients: [ME_ID] });
    state.apply("ChannelUpdate", { id: DM, clear: ["Icon"] });
    expect(state.channels.get(DM)!.icon).toBeUndefined();
    state.apply("ChannelUpdate", { id: "x", data: {} });

    state.apply("ChannelGroupJoin", { id: GROUP, user: ulid(4) });
    state.apply("ChannelGroupJoin", { id: GROUP, user: ulid(4) });
    expect(state.channels.get(GROUP)!.recipients).toEqual([ME_ID, ANA_ID, BOB_ID, ulid(4)]);
    state.apply("ChannelGroupLeave", { id: GROUP, user: ANA_ID });
    expect(state.channels.get(GROUP)!.recipients).toEqual([ME_ID, BOB_ID, ulid(4)]);
    state.apply("ChannelGroupLeave", { id: GROUP, user: "x" });
    state.apply("ChannelGroupLeave", { id: ulid(1), user: ME_ID });
    state.apply("ChannelGroupLeave", { id: GROUP, user: ME_ID });
    expect(state.channels.has(GROUP)).toBe(false);

    state.addHistory(GENERAL, [msg(10, GENERAL)], [], false);
    state.apply("ChannelDelete", { id: GENERAL });
    expect(state.channels.has(GENERAL)).toBe(false);
    expect(state.messages.has(GENERAL)).toBe(false);
    state.apply("ChannelDelete", { id: 5 });
  });

  it("tracks typing with an expiry, never for ourselves", () => {
    const state = ready();
    state.apply("ChannelStartTyping", { id: DM, user: ANA_ID });
    state.apply("ChannelStartTyping", { id: DM, user: ME_ID });
    state.apply("ChannelStartTyping", { id: DM, user: "x" });
    expect(state.typingIn(DM).map((u) => u.username)).toEqual(["ana"]);
    expect(state.typingIn(DM, Date.now() + TYPING_MS)).toEqual([]);
    state.apply("ChannelStartTyping", { id: DM, user: ulid(77) }); // unknown users are not shown
    expect(state.typingIn(DM)).toHaveLength(1);
    state.apply("ChannelStopTyping", { id: DM, user: ANA_ID });
    expect(state.typingIn(DM)).toEqual([]);
    expect(state.typingIn(GROUP)).toEqual([]);
  });

  it("updates users and relationships", () => {
    const state = ready();
    state.apply("UserUpdate", { id: ANA_ID, data: { username: "ana2", display_name: "Ana Two", avatar: { _id: "av2", tag: "avatars", filename: "a" } } });
    expect(state.users.get(ANA_ID)).toMatchObject({ username: "ana2", displayName: "Ana Two", avatar: { id: "av2" } });
    state.apply("UserUpdate", { id: ANA_ID, data: { display_name: "" } });
    expect(state.users.get(ANA_ID)!.displayName).toBeUndefined();
    state.apply("UserUpdate", { id: ANA_ID, data: { display_name: "A" }, clear: ["Avatar", "DisplayName"] });
    expect(state.users.get(ANA_ID)).toMatchObject({ displayName: undefined, avatar: undefined });
    state.apply("UserUpdate", { id: ulid(77), data: { username: "x" } });
    state.apply("UserRelationship", { id: ME_ID, user: { _id: ulid(77), username: "newfriend", relationship: "Friend" } });
    expect(state.users.get(ulid(77))?.username).toBe("newfriend");
  });

  it("offers a server channel its own server's emoji, and DMs every joined server's", () => {
    const state = ready();
    state.apply("EmojiCreate", { _id: ulid(53), name: "beta_wave", animated: true, parent: { type: "Server", id: BETA } });
    state.apply("EmojiCreate", { _id: ulid(54), name: "orphan", parent: { type: "Detached" } });
    state.apply("EmojiCreate", { _id: ulid(55), name: "elsewhere", parent: { type: "Server", id: ulid(999) } });
    const ids = (channelId: string) => state.usableEmoji(state.channels.get(channelId)!).map((e) => e.id);
    expect(ids(GENERAL)).toEqual([EMOJI]);
    expect(ids(CHAT)).toEqual([ulid(53)]);
    expect(ids(DM)).toEqual([EMOJI, ulid(53)]);
    expect(ids(GROUP)).toEqual([EMOJI, ulid(53)]);
    // Leaving a server stops offering its emoji, but messages keep their names.
    state.apply("ServerMemberLeave", { id: BETA, user: ME_ID });
    expect(ids(DM)).toEqual([EMOJI]);
    expect(state.emojis.get(ulid(53))?.name).toBe("beta_wave");
  });

  it("follows emoji changes and ignores unknown events", () => {
    const state = ready();
    const changed = vi.fn();
    state.changed.on(changed);
    state.apply("EmojiCreate", { _id: ulid(52), name: "cool" });
    expect(state.emojis.get(ulid(52))?.name).toBe("cool");
    state.apply("EmojiDelete", { id: ulid(52) });
    state.apply("EmojiDelete", { id: 5 });
    expect(state.emojis.has(ulid(52))).toBe(false);
    changed.mockClear();
    state.apply("Bees", {});
    state.apply("MessageReact", { id: ulid(1) });
    state.apply("MessageReact", { id: ulid(1), channel_id: DM, user_id: ANA_ID, emoji_id: 5 });
    state.apply("ChannelAck", { id: "x", user: ME_ID, message_id: ulid(1) });
    state.apply("UserSettingsUpdate", { id: ANA_ID, update: {} });
    state.apply("UserSettingsUpdate", { id: ME_ID, update: "x" });
    expect(changed).not.toHaveBeenCalled();
  });

  it("takes updates without data as no change", () => {
    const state = ready();
    state.apply("UserUpdate", { id: ANA_ID });
    state.apply("ServerUpdate", { id: ALPHA, data: "x" });
    expect(state.users.get(ANA_ID)?.displayName).toBe("Ana");
    expect(state.servers.get(ALPHA)?.name).toBe("Alpha");
  });

  it("skips channels a server lists but nobody sent", () => {
    const state = ready();
    state.apply("ServerUpdate", { id: BETA, data: { channels: [ulid(250), CHAT] } });
    expect(state.serverEntries(BETA)).toEqual([{ channel: expect.objectContaining({ id: CHAT }) }]);
  });

  it("counts no mentions before it knows who we are", () => {
    const state = new StoatState();
    state.apply("Ready", { users: [ANA], channels: [{ _id: CHAT, channel_type: "TextChannel", server: BETA, name: "chat" }] });
    state.apply("Message", message(1, CHAT, { mentions: [ME_ID] }));
    expect(state.mentions(CHAT)).toBe(0);
  });
});

describe("StoatState notifications", () => {
  it("notifies for DMs and groups, and for mentions in servers", () => {
    const state = ready();
    expect(state.shouldNotify(msg(900, DM))).toBe(true);
    expect(state.shouldNotify(msg(900, GROUP))).toBe(true);
    expect(state.shouldNotify(msg(900, GENERAL))).toBe(false);
    expect(state.shouldNotify(msg(900, GENERAL, { mentions: [ME_ID] }))).toBe(true);
    expect(state.shouldNotify(msg(900, GENERAL, { flags: 4 }))).toBe(true);
    expect(state.shouldNotify(msg(900, DM, { author: ME_ID }))).toBe(false);
    expect(state.shouldNotify(msg(900, DM, { flags: 1 }))).toBe(false);
    expect(state.shouldNotify(msg(900, ulid(999)))).toBe(false);
    state.meId = undefined;
    expect(state.shouldNotify(msg(900, DM))).toBe(false);
  });

  it("follows the synced notification settings, channel before server", () => {
    const state = ready();
    const settings = (value: object) => [1, JSON.stringify(value)];
    state.setNotifySettings(settings({ server: { [ALPHA]: "all", [BETA]: "muted" }, channel: { [RULES]: "none", [DM]: "muted" } }));
    expect(state.shouldNotify(msg(900, GENERAL))).toBe(true);
    expect(state.shouldNotify(msg(900, RULES, { mentions: [ME_ID] }))).toBe(false);
    expect(state.shouldNotify(msg(900, CHAT, { mentions: [ME_ID] }))).toBe(false);
    expect(state.shouldNotify(msg(900, DM))).toBe(false);
    state.setNotifySettings("bad");
    expect(state.shouldNotify(msg(900, DM))).toBe(false);

    state.apply("UserSettingsUpdate", { id: ME_ID, update: { notifications: settings({ channel: { [DM]: "mention" } }) } });
    expect(state.shouldNotify(msg(900, DM))).toBe(false);
    expect(state.shouldNotify(msg(900, DM, { mentions: [ME_ID] }))).toBe(true);
    expect(state.shouldNotify(msg(900, GENERAL))).toBe(false);
    state.apply("UserSettingsUpdate", { id: ME_ID, update: { other: 1 } });
    expect(state.shouldNotify(msg(900, DM, { mentions: [ME_ID] }))).toBe(true);
  });
});
