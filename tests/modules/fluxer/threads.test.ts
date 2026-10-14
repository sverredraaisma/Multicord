import { describe, expect, it, vi } from "vitest";
import { FluxerRest } from "../../../src/modules/fluxer/rest";
import { FluxerState } from "../../../src/modules/fluxer/state";
import { parseChannel } from "../../../src/modules/fluxer/types";
import { readyPayload } from "./fixtures";

/** READY with a forum (120) holding two posts, a thread under #general and an archived thread. */
function threadedReady() {
  const ready = readyPayload();
  const alpha = ready.guilds[0]!;
  alpha.channels!.push({ id: "120", type: 15, name: "ideas", position: 3, parent_id: "110" } as never);
  (alpha as Record<string, unknown>).threads = [
    { id: "130", type: 11, name: "release plan", parent_id: "111", last_message_id: "600" },
    { id: "131", type: 11, name: "old", parent_id: "111", thread_metadata: { archived: true } },
    { id: "140", type: 11, name: "Dark mode", parent_id: "120", last_message_id: "900", message_count: 4 },
    { id: "141", type: 11, name: "Bigger emoji", parent_id: "120", last_message_id: "950" },
  ];
  ready.read_states.push({ id: "140", last_message_id: "800", mention_count: 1 } as never);
  return ready;
}

function state() {
  const s = new FluxerState();
  s.apply("READY", threadedReady());
  return s;
}

describe("thread and forum state", () => {
  it("parses thread metadata", () => {
    expect(parseChannel({ id: "1", type: 11, thread_metadata: { archived: true }, message_count: 3 })).toMatchObject({
      archived: true,
      messageCount: 3,
    });
    expect(parseChannel({ id: "1", type: 0 })).toMatchObject({ archived: undefined, messageCount: undefined });
  });

  it("lists open threads under their channel and keeps forum posts out of the sidebar", () => {
    const s = state();
    expect(s.guildChannels("100").map((c) => c.name)).toEqual(["lobby", "orphan", "Text", "general", "release plan", "voice", "ideas"]);
    expect(s.forumPosts("120").map((c) => c.name)).toEqual(["Bigger emoji", "Dark mode"]);
  });

  it("counts unread posts and threads towards the guild", () => {
    const s = state();
    s.apply("MESSAGE_ACK", { channel_id: "111", message_id: "500", mention_count: 0 });
    expect(s.guildMentions("100")).toBe(1); // the forum post's mention
    expect(s.guildUnread("100")).toBe(true);
  });

  it("follows thread events and replaces the list on guild sync", () => {
    const s = state();
    s.apply("THREAD_CREATE", { id: "132", type: 11, guild_id: "100", name: "new", parent_id: "111" });
    s.apply("THREAD_UPDATE", { id: "130", type: 11, guild_id: "100", name: "release plan", parent_id: "111", thread_metadata: { archived: true } });
    expect(s.guildChannels("100").filter((c) => c.type === 11).map((c) => c.name)).toEqual(["new"]);
    s.apply("THREAD_DELETE", { id: "132", guild_id: "100", parent_id: "111", type: 11 });
    s.apply("THREAD_LIST_SYNC", { guild_id: "100", threads: [{ id: "133", type: 11, name: "synced", parent_id: "113" }] });
    s.apply("THREAD_LIST_SYNC", { threads: [{ id: "134", type: 11, name: "no guild" }] });
    expect(s.channels.get("133")!.guildId).toBe("100");

    s.apply("GUILD_CREATE", { id: "100", properties: { name: "Alpha" }, channels: [], threads: [{ id: "135", type: 11, name: "only", parent_id: "113" }] });
    expect([...s.channels.values()].filter((c) => c.guildId === "100" && c.type === 11).map((c) => c.id)).toEqual(["135"]);
    s.apply("GUILD_CREATE", { id: "100", properties: { name: "Alpha" }, channels: [] }); // no threads list: keep them
    expect(s.channels.has("135")).toBe(true);
  });

  it("adds channels we created", () => {
    const s = state();
    const changed = vi.fn();
    s.changed.on(changed);
    s.upsertChannel({ id: "142", type: 11, guildId: "100", parentId: "120", name: "mine", position: 0, recipients: [] });
    expect(s.forumPosts("120").map((p) => p.id)).toContain("142");
    expect(changed).toHaveBeenCalled();
  });
});

describe("FluxerRest.createPost", () => {
  it("creates a forum post with its first message", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ id: "150", type: 11, parent_id: "120", name: "Hi" }) } as Response;
    });
    const rest = new FluxerRest("https://api.fx/v1", { fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {} });
    expect(await rest.createPost("120", "Hi", "first")).toMatchObject({ id: "150", parentId: "120" });
    expect(calls[0]!.url).toBe("https://api.fx/v1/channels/120/threads");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "Hi", message: { content: "first" } });
  });
});
