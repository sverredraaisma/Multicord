// Shared Stoat payloads for state and adapter tests.

/** A valid ULID; larger n sorts later. */
export const ulid = (n: number): string => `01HZ${String(n).padStart(22, "0")}`;

export const ME_ID = ulid(1);
export const ANA_ID = ulid(2);
export const BOB_ID = ulid(3);
export const ALPHA = ulid(100);
export const BETA = ulid(200);
export const GENERAL = ulid(111);
export const LOBBY = ulid(113);
export const RULES = ulid(114);
export const CHAT = ulid(211);
export const DM = ulid(900);
export const GROUP = ulid(901);
export const CLOSED_DM = ulid(902);
export const EMOJI = ulid(50);

export const ME = { _id: ME_ID, username: "me", discriminator: "0001", relationship: "User", online: true };
export const ANA = { _id: ANA_ID, username: "ana", display_name: "Ana", discriminator: "0002", relationship: "Friend", online: true, avatar: { _id: "av1", tag: "avatars", filename: "a.png", content_type: "image/png", size: 1, metadata: { type: "Image", width: 1, height: 1 } } };
export const BOB = { _id: BOB_ID, username: "bob", discriminator: "0003", relationship: "None", online: false };

/** A Ready payload with two servers (one with categories), channels, DMs, emoji and unreads. */
export function readyPayload(extra: Record<string, unknown> = {}) {
  return {
    type: "Ready",
    users: [ME, ANA, BOB, { bad: true }],
    servers: [
      {
        _id: ALPHA,
        name: "Alpha",
        owner: ANA_ID,
        icon: { _id: "ic1", tag: "icons", filename: "i.png", content_type: "image/png", size: 1, metadata: { type: "Image", width: 1, height: 1 } },
        channels: [LOBBY, GENERAL, RULES, ulid(112)],
        categories: [{ id: "cat1", title: "Text", channels: [GENERAL, RULES, ulid(112)] }],
      },
      { _id: BETA, name: "Beta", owner: ME_ID, channels: [CHAT] },
      { _id: "nope", name: "Broken" },
    ],
    channels: [
      { _id: GENERAL, channel_type: "TextChannel", server: ALPHA, name: "general", last_message_id: ulid(500) },
      { _id: LOBBY, channel_type: "TextChannel", server: ALPHA, name: "lobby", last_message_id: ulid(300) },
      { _id: RULES, channel_type: "TextChannel", server: ALPHA, name: "rules" },
      { _id: ulid(112), channel_type: "VoiceChannel", server: ALPHA, name: "voice" },
      { _id: CHAT, channel_type: "TextChannel", server: BETA, name: "chat", last_message_id: ulid(700) },
      { _id: DM, channel_type: "DirectMessage", active: true, recipients: [ME_ID, ANA_ID], last_message_id: ulid(800) },
      { _id: GROUP, channel_type: "Group", name: "Group", owner: ME_ID, recipients: [ME_ID, ANA_ID, BOB_ID], last_message_id: ulid(600) },
      { _id: CLOSED_DM, channel_type: "DirectMessage", active: false, recipients: [ME_ID, BOB_ID] },
      { _id: ulid(903), channel_type: "SavedMessages", user: ME_ID },
    ],
    emojis: [{ _id: EMOJI, name: "party", parent: { type: "Server", id: ALPHA } }],
    channel_unreads: [
      { _id: { channel: GENERAL, user: ME_ID }, last_id: ulid(400), mentions: [ulid(450), ulid(460)] },
      { _id: { channel: LOBBY, user: ME_ID }, last_id: ulid(300) },
      { _id: { channel: CHAT, user: ME_ID }, last_id: ulid(700) },
      { _id: { channel: DM, user: ME_ID }, last_id: ulid(700), mentions: [ulid(800)] },
    ],
    ...extra,
  };
}

/** A message payload as Bonfire and the REST API send it. */
export function message(n: number, channel: string, extra: Record<string, unknown> = {}) {
  return { _id: ulid(n), channel, author: ANA_ID, content: `m${n}`, ...extra };
}
