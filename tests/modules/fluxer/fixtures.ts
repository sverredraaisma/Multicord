// Shared Fluxer payloads for state and adapter tests.

export const ME = { id: "1", username: "me" };
export const ANA = { id: "2", username: "ana", global_name: "Ana", avatar: "av" };

/** A READY payload with two guilds (one in a folder), channels, a DM and read states. */
export function readyPayload() {
  return {
    session_id: "s",
    user: ME,
    users: [ANA, { bad: true }],
    guilds: [
      {
        id: "100",
        properties: { name: "Alpha", icon: "ic" },
        channels: [
          { id: "110", type: 4, name: "Text", position: 0 },
          { id: "111", type: 0, name: "general", position: 1, parent_id: "110", last_message_id: "500" },
          { id: "112", type: 2, name: "voice", position: 2, parent_id: "110" },
          { id: "113", type: 0, name: "lobby", position: 0, last_message_id: "300" },
          { id: "114", type: 0, name: "orphan", position: 5, parent_id: "999" },
        ],
      },
      { id: "200", properties: { name: "Beta" }, channels: [{ id: "211", type: 0, name: "chat", last_message_id: "700" }] },
      { id: "300", unavailable: true },
    ],
    private_channels: [
      { id: "900", type: 1, recipients: [ANA], last_message_id: "800" },
      { id: "901", type: 3, name: "Group", recipients: [], last_message_id: "600" },
    ],
    read_states: [
      { id: "111", last_message_id: "400", mention_count: 2 },
      { id: "113", last_message_id: "300", mention_count: 0 },
      { id: "211", last_message_id: "700", mention_count: 0 },
      { id: "900", last_message_id: "700", mention_count: 1 },
    ],
    user_settings: { guild_folders: [{ id: 5, name: "Folder", color: 0x123456, guild_ids: ["200"] }] },
  };
}
