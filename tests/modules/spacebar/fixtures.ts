// Shared Spacebar payloads for state and adapter tests, shaped as Spacebar's server sends them.

export const ME = { id: "1", username: "me" };
export const ANA = { id: "2", username: "ana", global_name: "Ana", avatar: "abc123" };

export const DISCOVERY = {
  api: { baseUrl: "https://api.sb:443", apiVersions: { default: "9", active: ["9"] } },
  cdn: { baseUrl: "https://cdn.sb" },
  gateway: { baseUrl: "wss://gw.sb:443" },
};

/** A READY payload: one guild with a category, text and voice channels, roles and emoji; a DM and a group; read states. */
export function readyPayload() {
  return {
    v: 9,
    session_id: "s",
    user: ME,
    users: [ANA, { bad: true }],
    guilds: [
      {
        id: "100",
        name: "Alpha",
        icon: "1c0",
        channels: [
          { id: "110", type: 4, name: "Text", position: 0, guild_id: "100" },
          { id: "111", type: 0, name: "general", position: 1, parent_id: "110", last_message_id: "500", guild_id: "100" },
          { id: "112", type: 2, name: "voice", position: 2, parent_id: "110" },
          { id: "113", type: 0, name: "lobby", position: 0, last_message_id: "300" },
          { id: "114", type: 0, name: "orphan", position: 5, parent_id: "999" },
        ],
        roles: [
          { id: "100", name: "@everyone", position: 0 },
          { id: "120", name: "Admins", color: 0xff0000, position: 2, hoist: true },
          { id: "121", name: "Helpers", color: 0x00ff00, position: 1 },
          { id: "122", name: "Mods", position: 3, hoist: true },
        ],
        emojis: [{ id: "130", name: "party", animated: false }, { id: "x" }],
      },
      { id: "200", name: "Beta", channels: [{ id: "211", type: 0, name: "chat", last_message_id: "700" }] },
      { id: "300", unavailable: true },
    ],
    merged_members: [[{ id: "1", user_id: "1", roles: ["121"] }], []],
    private_channels: [
      { id: "900", type: 1, recipients: [ANA], last_message_id: "800" },
      { id: "901", type: 3, name: "Group", recipients: [], last_message_id: "600" },
    ],
    read_state: {
      entries: [
        { id: "111", last_message_id: "400", mention_count: 2 },
        { id: "113", last_message_id: "300", mention_count: 0 },
        { id: "211", last_message_id: "700", mention_count: 0 },
        { id: "900", last_message_id: "700", mention_count: 1 },
      ],
      partial: false,
      version: 0,
    },
  };
}

export function message(id: string, channelId: string, extra: Record<string, unknown> = {}) {
  return { id, channel_id: channelId, author: ANA, content: `m${id}`, timestamp: "2026-10-14T12:00:00Z", type: 0, ...extra };
}
