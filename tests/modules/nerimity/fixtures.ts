// Shared Nerimity payloads for state and adapter tests, shaped as Nerimity's server sends them.

export const ME = { id: "1", username: "me", tag: "0001", hexColor: "#fff", badges: 0 };
export const ANA = { id: "2", username: "ana", tag: "4242", avatar: "avatars/2/9.webp", hexColor: "#abc", badges: 0 };
export const BOB = { id: "3", username: "bob", tag: "7777", bot: true };

const T = Date.parse("2026-10-16T11:00:00Z");
/** Epoch ms, n minutes after a fixed morning. */
export const at = (minutes: number): number => T + minutes * 60_000;

/**
 * A user:authenticated payload: two servers (one with a category, a hidden
 * admin channel, roles and emoji), a DM, read times, mentions and presence.
 */
export function authenticatedPayload() {
  const perm = (roleId: string, permissions: number) => ({ roleId, permissions });
  return {
    user: { ...ME, orderedServerIds: ["200", "100"], email: "me@x" },
    servers: [
      { id: "100", name: "Alpha", avatar: "avatars/100/5.webp", defaultRoleId: "101", createdById: "2", customEmojis: [{ id: "130", name: "party", gif: false, webp: true }, { id: "131", name: "old", gif: true, webp: false }, { id: "x" }] },
      { id: "200", name: "Beta", defaultRoleId: "201", createdById: "1", customEmojis: [] },
      { id: "bad" },
    ],
    serverRoles: [
      { id: "101", name: "Member", serverId: "100", order: 0, permissions: 2 },
      { id: "120", name: "Admins", serverId: "100", order: 3, hexColor: "#FF0000", permissions: 1 },
      { id: "121", name: "Helpers", serverId: "100", order: 2, hexColor: "#00ff00", permissions: 0, hideRole: true },
      { id: "122", name: "Mods", serverId: "100", order: 1, permissions: 0 },
      { id: "999", name: "Stray", serverId: "999", order: 1, permissions: 0 },
      null,
    ],
    channels: [
      { id: "110", serverId: "100", type: 2, name: "Text", order: 1 },
      { id: "111", serverId: "100", type: 1, name: "general", order: 2, categoryId: "110", lastMessagedAt: at(30), permissions: [perm("101", 3)] },
      { id: "112", serverId: "100", type: 1, name: "staff", order: 3, categoryId: "110", lastMessagedAt: at(40), permissions: [perm("120", 3)] },
      { id: "113", serverId: "100", type: 1, name: "lobby", order: 0, lastMessagedAt: at(10), permissions: [perm("101", 3)] },
      { id: "114", serverId: "100", type: 1, name: "orphan", order: 5, categoryId: "998", permissions: [perm("101", 1)] },
      { id: "115", serverId: "100", type: 2, name: "Empty", order: 6 },
      { id: "211", serverId: "200", type: 1, name: "chat", lastMessagedAt: at(50), permissions: [] },
      { id: "900", type: 0, lastMessagedAt: at(60), createdAt: at(-100) },
      { id: "777", serverId: "777", type: 1, name: "elsewhere" },
    ],
    serverMembers: [
      { serverId: "100", user: ME, roleIds: ["122"] },
      { serverId: "100", user: ANA, roleIds: ["120", "121"], nickname: "Anna" },
      { serverId: "100", user: BOB, roleIds: [] },
      { serverId: "200", user: ME, roleIds: [] },
      { serverId: "777", user: BOB, roleIds: [] },
    ],
    inbox: [{ id: "i1", channelId: "900", createdById: "1", recipient: ANA, closed: false, lastSeen: at(20) }, { channelId: "901" }],
    lastSeenServerChannelIds: { "111": at(20), "113": at(10), bad: at(1) },
    messageMentions: [
      { channelId: "111", count: 2, serverId: "100" },
      { channelId: "900", count: 1 },
      { channelId: "900", count: 0 },
      { channelId: "nope" },
    ],
    presences: [{ userId: "2", status: 1 }, { userId: "3", status: 4 }, { userId: "x" }],
    friends: [],
    sessionId: "s1",
  };
}

export function message(id: string, channelId: string, extra: Record<string, unknown> = {}) {
  return { id, channelId, createdBy: ANA, content: `m${id}`, type: 0, createdAt: at(Number(id) % 1000), reactions: [], quotedMessages: [], replyMessages: [], mentions: [], roleMentions: [], attachments: [], ...extra };
}
