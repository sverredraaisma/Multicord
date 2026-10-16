import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NerimityState, TYPING_MS } from "../../../src/modules/nerimity/state";
import { parseMessage } from "../../../src/modules/nerimity/types";
import { ANA, BOB, ME, at, authenticatedPayload, message } from "./fixtures";

function signedIn() {
  const state = new NerimityState();
  state.apply("user:authenticated", authenticatedPayload());
  return state;
}

const ids = (list: { id: string }[]) => list.map((c) => c.id);

beforeEach(() => {
  vi.useFakeTimers({ now: at(100) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NerimityState from user:authenticated", () => {
  it("keeps servers in the user's order, their channels, roles, emoji and members", () => {
    const state = signedIn();
    expect(state.me).toEqual({ id: "1", username: "me", tag: "0001" });
    expect(ids(state.orderedServers())).toEqual(["200", "100"]);
    expect(state.roles.get("100")!.map((r) => r.name)).toEqual(["Member", "Admins", "Helpers", "Mods"]);
    expect(state.roles.has("999")).toBe(false);
    expect(state.emojis.get("100")!.map((e) => e.name)).toEqual(["party", "old"]);
    expect([...state.members.get("100")!.keys()]).toEqual(["1", "2", "3"]);
    expect(state.members.has("777")).toBe(false);
    expect(state.channels.has("777")).toBe(false);
    expect(state.presence.get("3")).toBe(4);
    // The hidden staff channel is left out; the empty category stays out too unless it has a visible child.
    expect(ids(state.serverChannels("100"))).toEqual(["113", "114", "110", "111"]);
    expect(state.canSee(state.channels.get("112")!)).toBe(false);
    // The owner sees every channel.
    expect(ids(state.serverChannels("200"))).toEqual(["211"]);
    expect(state.dms().map((d) => d.inbox.recipient.username)).toEqual(["ana"]);
  });

  it("works out unread state and mentions", () => {
    const state = signedIn();
    const channel = (id: string) => state.channels.get(id)!;
    expect(state.isUnread(channel("111"))).toBe(true);
    expect(state.isUnread(channel("113"))).toBe(false);
    // Never opened counts as unread, as in Nerimity's client; no messages never does.
    expect(state.isUnread(channel("211"))).toBe(true);
    expect(state.isUnread(channel("114"))).toBe(false);
    expect(state.isUnread(channel("112"))).toBe(false);
    expect(state.isUnread(channel("110"))).toBe(false);
    expect(state.isUnread(channel("900"))).toBe(true);
    expect(state.mentions("111")).toBe(2);
    expect(state.mentions("900")).toBe(2);
    expect(state.serverUnread("100")).toBe(true);
    expect(state.serverMentions("100")).toBe(2);
    expect(state.serverUnread("200")).toBe(true);
    state.markRead("111");
    expect(state.isUnread(channel("111"))).toBe(false);
    expect(state.mentions("111")).toBe(0);
    expect(state.serverUnread("100")).toBe(false);
    // A read without a channel keeps the clock's time.
    state.markRead("555");
    expect(state.lastSeen.get("555")).toBe(at(100));
  });

  it("starts over on a new sign-in, and copes with an empty one", () => {
    const state = signedIn();
    state.apply("user:authenticated", {});
    expect(state.me).toBeUndefined();
    expect(state.servers.size).toBe(0);
    expect(state.orderedServers()).toEqual([]);
    expect(state.mentionsMe(parseMessage(message("5", "111"))!)).toBe(false);
    // Without a user, a server's channels follow its default role only.
    state.apply("server:joined", { server: { id: "5", name: "S", defaultRoleId: "6" }, channels: [{ id: "7", serverId: "5", type: 1, permissions: [{ roleId: "6", permissions: 1 }] }] });
    expect(state.canSee(state.channels.get("7")!)).toBe(true);
    state.apply("server:joined", { server: { id: "8", name: "T" }, channels: [{ id: "9", serverId: "8", type: 1 }] });
    expect(state.canSee(state.channels.get("9")!)).toBe(false);
    expect(state.canManageChannels("5")).toBe(false);
  });
});

describe("NerimityState events", () => {
  it("takes new messages: previews, unread, mentions, typing, cache", () => {
    const state = signedIn();
    const incoming = vi.fn();
    state.incoming.on(incoming);
    state.addHistory("111", [parseMessage(message("50", "111"))!], false);
    state.apply("channel:typing", { channelId: "111", userId: "2" });
    state.apply("channel:typing", { channelId: "111", userId: "1" });
    state.apply("channel:typing", { channelId: "x" });
    expect(state.typingIn("111").map((u) => u.username)).toEqual(["ana"]);
    expect(state.typingIn("111", Date.now() + TYPING_MS)).toEqual([]);
    state.apply("message:created", { message: message("60", "111", { createdAt: at(90) }) });
    expect(state.typingIn("111")).toEqual([]);
    expect(ids(state.messages.get("111")!)).toEqual(["50", "60"]);
    expect(state.latest.get("111")!.id).toBe("60");
    expect(state.channels.get("111")!.lastMessagedAt).toBe(at(90));
    expect(incoming).toHaveBeenCalledTimes(1);
    // No mention in a server channel; every DM message counts.
    expect(state.mentions("111")).toBe(2);
    state.apply("message:created", { message: message("61", "900", { createdAt: at(91) }) });
    expect(state.mentions("900")).toBe(3);
    // The same message twice is kept once; an older one does not take the preview; a later time keeps the channel's.
    state.apply("message:created", { message: message("60", "111") });
    state.apply("message:created", { message: message("55", "111", { createdAt: at(1) }) });
    expect(ids(state.messages.get("111")!)).toEqual(["50", "60", "55"]);
    expect(state.latest.get("111")!.id).toBe("60");
    expect(state.channels.get("111")!.lastMessagedAt).toBe(at(90));
    // The user's own message marks the channel read.
    state.apply("message:created", { message: message("62", "113", { createdBy: ME, createdAt: at(95) }) });
    expect(state.isUnread(state.channels.get("113")!)).toBe(false);
    expect(incoming).toHaveBeenCalledTimes(4);
    // A message for an unknown channel, or one without an author, still counts where it can.
    state.apply("message:created", { message: message("63", "555", { createdBy: null }) });
    expect(state.latest.get("555")!.id).toBe("63");
    state.apply("message:created", { message: { bad: true } });
    expect(incoming).toHaveBeenCalledTimes(5);
  });

  it("caps a channel's cached messages", () => {
    const state = signedIn();
    state.addHistory("111", [], false);
    for (let i = 1; i <= 205; i++) state.apply("message:created", { message: message(String(1000 + i), "111") });
    expect(state.messages.get("111")).toHaveLength(200);
    expect(state.messages.get("111")![0]!.id).toBe("1006");
  });

  it("knows which messages mention the user", () => {
    const state = signedIn();
    const mentions = (extra: Record<string, unknown>, channel = "111") => state.mentionsMe(parseMessage(message("5", channel, extra))!);
    expect(mentions({})).toBe(false);
    expect(mentions({ mentions: [{ id: "1" }] })).toBe(true);
    expect(mentions({ content: "hey [@:e]" })).toBe(true);
    expect(mentions({ content: "hey [@:e]" }, "900")).toBe(false);
    expect(mentions({ roleMentions: [{ id: "122" }] })).toBe(true);
    // The default role is everyone's, and does not count.
    expect(mentions({ roleMentions: [{ id: "101" }] })).toBe(false);
    expect(mentions({ mentionReplies: true, replyMessages: [{ replyToMessage: { id: "4", createdBy: ME } }] })).toBe(true);
    expect(mentions({ mentionReplies: false, replyMessages: [{ replyToMessage: { id: "4", createdBy: ME } }] })).toBe(false);
    expect(mentions({ quotedMessages: [{ id: "4", createdBy: ME }] })).toBe(true);
  });

  it("applies edits, deletions and reactions to cached messages", () => {
    const state = signedIn();
    state.addHistory("111", [parseMessage(message("50", "111", { reactions: [{ name: "👍", count: 1, reacted: false }] }))!, parseMessage(message("51", "111"))!], false);
    state.apply("message:updated", { channelId: "111", messageId: "51", updated: { content: "edited", editedAt: at(2), mentions: [{ id: "1" }] } });
    expect(state.latest.get("111")).toMatchObject({ content: "edited", edited: true, mentionIds: ["1"] });
    state.apply("message:updated", { channelId: "111", messageId: "50", updated: { pinned: true } });
    expect(state.findMessage("111", "50")).toMatchObject({ content: "m50", edited: false });
    const changed = vi.fn();
    state.changed.on(changed);
    state.apply("message:updated", { channelId: "111", messageId: "99", updated: {} });
    state.apply("message:updated", { channelId: "111", messageId: "50", updated: "x" });
    expect(changed).not.toHaveBeenCalled();
    // Reactions carry the new total; the user's own say whether they have it.
    state.apply("message:reaction_added", { channelId: "111", messageId: "50", name: "👍", count: 2, reactedByUserId: "1" });
    state.apply("message:reaction_added", { channelId: "111", messageId: "50", name: "party", emojiId: "130", webp: true, count: 1, reactedByUserId: "2" });
    expect(state.findMessage("111", "50")!.reactions).toEqual([
      { name: "👍", gif: false, webp: false, count: 2, reacted: true },
      { name: "party", emojiId: "130", gif: false, webp: true, count: 1, reacted: false },
    ]);
    state.apply("message:reaction_removed", { channelId: "111", messageId: "50", name: "👍", count: 1, reactionRemovedByUserId: "1" });
    state.apply("message:reaction_removed", { channelId: "111", messageId: "50", name: "party", emojiId: "130", count: 0, reactionRemovedByUserId: "2" });
    state.apply("message:reaction_removed", { channelId: "111", messageId: "50", name: "never", count: 0 });
    expect(state.findMessage("111", "50")!.reactions).toEqual([{ name: "👍", gif: false, webp: false, count: 1, reacted: false }]);
    for (const bad of [{ channelId: "111", messageId: "99", name: "x", count: 1 }, { channelId: "111", messageId: "50", count: 1 }, { channelId: "111", messageId: "50", name: "x", count: -1 }, { channelId: "111", messageId: "50", name: "x" }])
      state.apply("message:reaction_added", bad);
    expect(state.findMessage("111", "50")!.reactions).toHaveLength(1);
    expect(state.findMessage("x", "50")).toBeUndefined();
    // Deletions, single and in a batch across a server's channels.
    state.apply("message:deleted", { channelId: "111", messageId: "51" });
    expect(ids(state.messages.get("111")!)).toEqual(["50"]);
    expect(state.latest.has("111")).toBe(false);
    state.apply("message:deleted", { channelId: "111" });
    state.addHistory("113", [parseMessage(message("52", "113", { createdAt: at(50) }))!, parseMessage(message("53", "113", { createdAt: at(1) }))!, parseMessage(message("54", "113", { createdBy: BOB, createdAt: at(50) }))!], false);
    state.apply("message:deleted_batch", { userId: "2", serverId: "100", fromTime: at(60), toTime: at(40) });
    expect(ids(state.messages.get("113")!)).toEqual(["53", "54"]);
    state.apply("message:deleted_batch", { userId: "2" });
    state.apply("message:deleted_batch", { userId: "2", serverId: "100" });
    expect(ids(state.messages.get("113")!)).toEqual(["53", "54"]);
    state.removeMessage("113", "54");
    expect(state.latest.has("113")).toBe(false);
    state.removeMessage("404", "1");
    // Replacing a message that is not cached changes nothing; the preview follows an edit.
    expect(state.replaceMessage(parseMessage(message("404", "113"))!)).toBe(false);
    state.apply("message:created", { message: message("56", "113", { createdBy: BOB }) });
    expect(state.replaceMessage(parseMessage(message("56", "113", { content: "new" }))!)).toBe(true);
    expect(state.latest.get("113")!.content).toBe("new");
    expect(state.findMessage("113", "56")!.content).toBe("new");
    // Older history goes before, known messages are not added twice.
    state.addHistory("113", [parseMessage(message("40", "113", { createdBy: BOB }))!, parseMessage(message("53", "113"))!], true);
    expect(ids(state.messages.get("113")!)).toEqual(["40", "53", "56"]);
  });

  it("follows reads, unread marks, and DMs opening and closing", () => {
    const state = signedIn();
    state.apply("notification:dismissed", { channelId: "900" });
    expect(state.isUnread(state.channels.get("900")!)).toBe(false);
    expect(state.mentions("900")).toBe(0);
    state.apply("message:mark_unread", { channelId: "900", at: at(10) });
    expect(state.isUnread(state.channels.get("900")!)).toBe(true);
    state.apply("message:mark_unread", { channelId: "900" });
    state.apply("notification:dismissed", {});
    state.apply("inbox:opened", { channelId: "902", recipient: BOB, channel: { id: "902", type: 0, lastMessagedAt: at(70) } });
    state.apply("inbox:opened", { channelId: "903", recipient: BOB });
    state.apply("inbox:opened", { channelId: "904" });
    expect(state.dms().map((d) => d.channel.id)).toEqual(["902", "900"]);
    state.apply("inbox:closed", { channelId: "902" });
    state.apply("inbox:closed", {});
    expect(state.dms().map((d) => d.channel.id)).toEqual(["900"]);
  });

  it("follows servers joining, leaving and changing", () => {
    const state = signedIn();
    state.apply("server:joined", {
      server: { id: "300", name: "Gamma", defaultRoleId: "301", customEmojis: [{ id: "330", name: "wave" }] },
      channels: [{ id: "311", serverId: "300", type: 1, permissions: [{ roleId: "301", permissions: 1 }] }, { id: "312", serverId: "200", type: 1 }],
      roles: [{ id: "301", name: "Member" }],
      members: [{ user: ME, roleIds: [] }, { serverId: "200", user: BOB }],
    });
    expect(state.members.get("200")!.has("3")).toBe(false);
    state.apply("server:joined", { server: { bad: true } });
    expect(ids(state.orderedServers())).toEqual(["200", "100", "300"]);
    expect(ids(state.serverChannels("300"))).toEqual(["311"]);
    expect(state.channels.has("312")).toBe(false);
    state.apply("server:order_updated", { serverIds: ["300", "100", "x"] });
    expect(ids(state.orderedServers())).toEqual(["300", "100", "200"]);
    state.apply("server:updated", { serverId: "300", updated: { name: "G", avatar: "avatars/300/1.webp" } });
    expect(state.servers.get("300")).toMatchObject({ name: "G", avatar: "avatars/300/1.webp" });
    state.apply("server:updated", { serverId: "300", updated: { avatar: null, name: "" } });
    expect(state.servers.get("300")).toEqual({ id: "300", name: "G", defaultRoleId: "301" });
    state.apply("server:updated", { serverId: "300", updated: { avatar: "../x" } });
    state.apply("server:updated", { serverId: "404", updated: {} });
    state.addHistory("311", [], false);
    state.apply("server:left", { serverId: "300" });
    state.apply("server:left", {});
    expect(state.servers.has("300")).toBe(false);
    expect(state.channels.has("311")).toBe(false);
    expect(state.messages.has("311")).toBe(false);
    expect(state.serverOrder).toEqual(["100"]);
  });

  it("follows channels being created, changed, reordered and deleted", () => {
    const state = signedIn();
    state.apply("server:channel_created", { serverId: "200", channel: { id: "212", serverId: "200", type: 1, name: "new", order: 9 } });
    state.apply("server:channel_created", { channel: { id: "213", serverId: "404", type: 1 } });
    state.apply("server:channel_created", { channel: { id: "214", type: 1 } });
    expect(ids(state.serverChannels("200"))).toEqual(["211", "212"]);
    state.apply("server:channel_updated", { serverId: "200", channelId: "212", updated: { name: "renamed", categoryId: "215", permissions: [] } });
    expect(state.channels.get("212")).toMatchObject({ name: "renamed", categoryId: "215", permissions: [] });
    state.apply("server:channel_updated", { serverId: "200", channelId: "212", updated: { categoryId: null, name: "" } });
    expect(state.channels.get("212")).toMatchObject({ name: "renamed" });
    expect(state.channels.get("212")!.categoryId).toBeUndefined();
    state.apply("server:channel_updated", { channelId: "212", updated: { name: 5 } });
    state.apply("server:channel_updated", { channelId: "404", updated: {} });
    state.apply("server:channel_order_updated", { serverId: "200", orderedChannelIds: ["212", "211", "404"] });
    expect(ids(state.serverChannels("200"))).toEqual(["212", "211"]);
    state.apply("server:channel_order_updated", { serverId: "100", categoryId: "110", orderedChannelIds: ["114"] });
    expect(state.channels.get("114")).toMatchObject({ categoryId: "110", order: 1 });
    state.apply("server:channel_order_updated", { serverId: "100", categoryId: null, orderedChannelIds: ["114"] });
    expect(state.channels.get("114")!.categoryId).toBeUndefined();
    state.apply("server:channel_order_updated", { serverId: "100", categoryId: 5, orderedChannelIds: ["114"] });
    // Opening the staff channel to everyone shows it.
    state.apply("server:channel_permissions_updated", { serverId: "100", channelId: "112", roleId: "101", permissions: 1 });
    expect(state.canSee(state.channels.get("112")!)).toBe(true);
    state.apply("server:channel_permissions_updated", { channelId: "112", roleId: "101" });
    state.apply("server:channel_permissions_updated", { channelId: "404", roleId: "101", permissions: 1 });
    state.addHistory("212", [], false);
    state.apply("server:channel_deleted", { serverId: "200", channelId: "212" });
    state.apply("server:channel_deleted", {});
    expect(state.channels.has("212")).toBe(false);
    expect(state.messages.has("212")).toBe(false);
  });

  it("follows roles, members and emoji", () => {
    const state = signedIn();
    state.apply("server:role_created", { id: "123", name: "New", serverId: "100", order: 9 });
    state.apply("server:role_created", { id: "124", name: "Lost", serverId: "404" });
    state.apply("server:role_created", { id: "x" });
    state.apply("server:role_created", { id: "125", name: "First", serverId: "200" });
    expect(state.roles.get("100")!.map((r) => r.id)).toEqual(["101", "120", "121", "122", "123"]);
    expect(state.roles.get("200")!.map((r) => r.id)).toEqual(["125"]);
    state.apply("server:role_updated", { serverId: "100", roleId: "123", updated: { name: "Newer", hexColor: "#00ff00", hideRole: true, permissions: 1 } });
    expect(state.roles.get("100")!.at(-1)).toEqual({ id: "123", name: "Newer", color: "#00ff00", order: 9, hidden: true, permissions: 1 });
    state.apply("server:role_updated", { serverId: "100", roleId: "123", updated: { hexColor: null, name: "" } });
    expect(state.roles.get("100")!.at(-1)!.color).toBeUndefined();
    state.apply("server:role_updated", { serverId: "100", roleId: "123", updated: { name: "Last" } });
    expect(state.roles.get("100")!.at(-1)!.name).toBe("Last");
    state.apply("server:role_updated", { serverId: "100", roleId: "404", updated: {} });
    state.apply("server:role_updated", { serverId: "100", roleId: "123" });
    state.apply("server:role_order_updated", { serverId: "100", roleIds: ["122", "120"] });
    expect(state.roles.get("100")!.find((r) => r.id === "122")!.order).toBe(2);
    expect(state.roles.get("100")!.find((r) => r.id === "121")!.order).toBe(2);
    state.apply("server:role_order_updated", { serverId: "404", roleIds: [] });
    state.apply("server:role_deleted", { serverId: "100", roleId: "123" });
    state.apply("server:role_deleted", { serverId: "404", roleId: "123" });
    expect(state.roles.get("100")!.map((r) => r.id)).toEqual(["101", "120", "121", "122"]);
    // Members.
    state.apply("server:member_joined", { serverId: "200", member: { user: ANA, roleIds: [] } });
    state.apply("server:member_joined", { serverId: "404", member: { user: ANA } });
    expect([...state.members.get("200")!.keys()]).toEqual(["1", "2"]);
    state.apply("server:member_updated", { serverId: "200", userId: "2", updated: { roleIds: ["125"], nickname: "A" } });
    expect(state.members.get("200")!.get("2")).toMatchObject({ roleIds: ["125"], nickname: "A" });
    state.apply("server:member_updated", { serverId: "200", userId: "2", updated: { nickname: null } });
    expect(state.members.get("200")!.get("2")!.nickname).toBeUndefined();
    state.apply("server:member_updated", { serverId: "200", userId: "2", updated: {} });
    state.apply("server:member_updated", { serverId: "200", userId: "404", updated: {} });
    state.apply("server:member_left", { serverId: "200", userId: "2" });
    state.apply("server:member_left", { serverId: "404", userId: "2" });
    state.apply("server:member_left", {});
    expect([...state.members.get("200")!.keys()]).toEqual(["1"]);
    // Emoji.
    state.apply("server:emoji_add", { serverId: "200", emoji: { id: "230", name: "hi" } });
    state.apply("server:emoji_add", { serverId: "200", emoji: { id: "x" } });
    state.apply("server:emoji_add", { serverId: "404", emoji: { id: "231", name: "lost" } });
    state.apply("server:emoji_update", { serverId: "200", emojiId: "230", name: "hello" });
    state.apply("server:emoji_update", { serverId: "200", emojiId: "230", name: "no way" });
    state.apply("server:emoji_update", { serverId: "200", emojiId: "404", name: "x" });
    expect(state.emojis.get("200")).toEqual([{ id: "230", name: "hello", gif: false, webp: false }]);
    state.apply("server:emoji_remove", { serverId: "200", emojiId: "230" });
    state.apply("server:emoji_remove", { serverId: "505", emojiId: "230" });
    expect(state.emojis.get("200")).toEqual([]);
  });

  it("ignores events whose ids are not ids", () => {
    const state = signedIn();
    const changed = vi.fn();
    state.changed.on(changed);
    const bad = { serverId: 5, channelId: 5, userId: 5, roleId: 5, emojiId: 5, messageId: 5, updated: {}, member: {}, emoji: { id: "1", name: "a" }, name: "a" };
    for (const event of [
      "server:updated",
      "server:channel_updated",
      "server:channel_permissions_updated",
      "server:role_updated",
      "server:role_order_updated",
      "server:role_deleted",
      "server:member_joined",
      "server:member_updated",
      "server:emoji_add",
      "server:emoji_update",
      "server:emoji_remove",
      "user:updated",
    ])
      state.apply(event, bad);
    expect(changed).not.toHaveBeenCalled();
    // A member event may name its server inside the member instead.
    state.apply("server:member_joined", { member: { serverId: "200", user: ANA } });
    expect(state.members.get("200")!.has("2")).toBe(true);
    // Before sign-in there is no self to update.
    const fresh = new NerimityState();
    fresh.apply("user:updatedSelf", { username: "x" });
    expect(fresh.me).toBeUndefined();
  });

  it("orders and fills in what payloads leave out", () => {
    const state = signedIn();
    // Same order: by id; a server where the user's own membership is unknown; roles that do not parse.
    state.apply("server:channel_created", { channel: { id: "209", serverId: "200", type: 1 } });
    expect(ids(state.serverChannels("200"))).toEqual(["209", "211"]);
    state.apply("server:joined", { server: { id: "400", name: "D", defaultRoleId: "401", createdById: "2" }, channels: [{ id: "411", serverId: "400", type: 1 }], roles: [{ id: "401", name: "M", permissions: 1 }, { bad: 1 }], members: [] });
    expect(state.roles.get("400")).toHaveLength(1);
    // The default role is an admin role here.
    expect(state.canSee(state.channels.get("411")!)).toBe(true);
    // A DM without a last message sorts last; typing by someone unknown shows no one.
    state.apply("inbox:opened", { channelId: "905", recipient: BOB, channel: { id: "905", type: 0 } });
    expect(state.dms().map((d) => d.channel.id)).toEqual(["900", "905"]);
    state.apply("inbox:opened", { channelId: "906", recipient: BOB, channel: { id: "906", type: 0 } });
    expect(state.dms()).toHaveLength(3);
    state.apply("channel:typing", { channelId: "905", userId: "99" });
    expect(state.typingIn("905")).toEqual([]);
    expect(state.typingIn("404")).toEqual([]);
    // A first message in a channel that had none.
    state.apply("message:created", { message: message("70", "114", { createdAt: at(99) }) });
    expect(state.channels.get("114")!.lastMessagedAt).toBe(at(99));
    // Mentions in an edit that are not users are left out; emoji added twice are kept once.
    state.addHistory("114", [], false);
    state.apply("message:created", { message: message("71", "114") });
    state.apply("message:updated", { channelId: "114", messageId: "71", updated: { mentions: [{ id: "1" }, "x"] } });
    expect(state.findMessage("114", "71")!.mentionIds).toEqual(["1"]);
    expect(state.replaceMessage(parseMessage(message("1", "404"))!)).toBe(false);
    state.apply("server:emoji_add", { serverId: "100", emoji: { id: "130", name: "party2" } });
    expect(state.emojis.get("100")!.map((e) => e.name)).toEqual(["old", "party2"]);
  });

  it("follows users renaming and presence", () => {
    const state = signedIn();
    state.apply("user:updated", { userId: "2", updated: { username: "anna", tag: "1", avatar: null } });
    expect(state.users.get("2")).toEqual({ id: "2", username: "anna", tag: "1" });
    expect(state.members.get("100")!.get("2")!.user.username).toBe("anna");
    expect(state.inbox.get("900")!.recipient.username).toBe("anna");
    state.apply("user:updatedSelf", { username: "me2", avatar: "avatars/1/2.webp" });
    expect(state.me).toMatchObject({ username: "me2", avatar: "avatars/1/2.webp" });
    state.apply("user:updated", { userId: "404", updated: {} });
    state.apply("user:updated", { userId: "2", updated: { username: "" } });
    state.apply("user:updated", { userId: "2" });
    expect(state.users.get("2")!.username).toBe("anna");
    state.apply("user:presence_update", { userId: "2", status: 3 });
    state.apply("user:presence_update", { userId: "2" });
    expect(state.presence.get("2")).toBe(3);
    // Unknown events change nothing.
    const changed = vi.fn();
    state.changed.on(changed);
    state.apply("voice:user_joined", {});
    state.apply("message:created", "nonsense");
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("NerimityState calls", () => {
  it("knows who is in which call, in the order they joined, one call per person", () => {
    const state = new NerimityState();
    state.apply("user:authenticated", {
      ...authenticatedPayload(),
      voiceChannelUsers: [{ channelId: "900", userId: "2" }, { channelId: "111", userId: "3", serverId: "100" }, { channelId: "x", userId: "2" }, null],
    });
    expect(state.inCall("900")).toEqual(["2"]);
    expect(state.inCall("111")).toEqual(["3"]);
    expect(state.inCall("113")).toEqual([]);
    state.apply("voice:user_joined", { channelId: "900", userId: "1" });
    expect(state.inCall("900")).toEqual(["2", "1"]);
    // Joining another call leaves the first; joining again goes last.
    state.apply("voice:user_joined", { channelId: "111", userId: "2", serverId: "100" });
    expect(state.inCall("900")).toEqual(["1"]);
    expect(state.inCall("111")).toEqual(["3", "2"]);
    state.apply("voice:user_joined", { channelId: "111", userId: "3" });
    expect(state.inCall("111")).toEqual(["2", "3"]);
    const changed = vi.fn();
    state.changed.on(changed);
    for (const left of [{ channelId: "111", userId: "9" }, { channelId: "999", userId: "2" }, { channelId: "111", userId: "x" }, { channelId: "x", userId: "2" }]) state.apply("voice:user_left", left);
    state.apply("voice:user_joined", { channelId: "111" });
    expect(changed).not.toHaveBeenCalled();
    state.apply("voice:user_left", { channelId: "111", userId: "2" });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(state.inCall("111")).toEqual(["3"]);
    state.apply("voice:user_left", { channelId: "111", userId: "3" });
    expect(state.voiceUsers.has("111")).toBe(false);
  });

  it("forgets calls with their channels, DMs and servers, and learns those of servers joined", () => {
    const state = new NerimityState();
    state.apply("user:authenticated", {
      ...authenticatedPayload(),
      voiceChannelUsers: ["111", "113", "211", "900"].map((channelId, i) => ({ channelId, userId: String(10 + i) })),
    });
    state.apply("server:channel_deleted", { channelId: "113" });
    state.apply("inbox:closed", { channelId: "900" });
    state.apply("server:left", { serverId: "100" });
    expect([...state.voiceUsers.keys()]).toEqual(["211"]);
    state.apply("server:joined", { server: { id: "300", name: "Gamma" }, channels: [{ id: "311", serverId: "300", type: 1, name: "talk" }], voiceChannelUsers: [{ channelId: "311", userId: "2" }] });
    expect(state.inCall("311")).toEqual(["2"]);
    state.reset();
    expect(state.voiceUsers.size).toBe(0);
  });

  it("lets the user join calls where Nerimity's server would", () => {
    const state = signedIn();
    const channel = (id: string) => state.channels.get(id)!;
    expect(state.canJoinVoice(channel("900"))).toBe(true);
    expect(state.canJoinVoice(channel("211"))).toBe(true); // the server's owner
    expect(state.canJoinVoice(channel("111"))).toBe(false);
    state.apply("server:channel_permissions_updated", { channelId: "111", roleId: "101", permissions: 7 });
    expect(state.canJoinVoice(channel("111"))).toBe(true);
    expect(state.canJoinVoice(channel("112"))).toBe(false);
    state.apply("server:member_updated", { serverId: "100", userId: "1", updated: { roleIds: ["120"] } });
    expect(state.canJoinVoice(channel("112"))).toBe(true); // an admin
    expect(state.canJoinVoice({ id: "5", type: 1, serverId: "404", order: 0, permissions: [] })).toBe(false);
    // A server whose roles the session has none of.
    state.apply("server:joined", { server: { id: "300", name: "Gamma", createdById: "2" }, channels: [{ id: "311", serverId: "300", type: 1, name: "talk" }] });
    expect(state.canJoinVoice(channel("311"))).toBe(false);
  });
});
