import { describe, expect, it, vi } from "vitest";
import { FluxerRest } from "../../../src/modules/fluxer/rest";
import { FluxerState, MEMBER_LIST_POSITIONS } from "../../../src/modules/fluxer/state";
import { parseMember, parseMemberListUpdate, parsePresence, parseProfile, parseRole, roleColor } from "../../../src/modules/fluxer/types";
import { readyPayload } from "./fixtures";

describe("Fluxer member parsing", () => {
  it("parses roles and their colours", () => {
    expect(parseRole({ id: "5", name: "Mods", color: 0x00ff00, position: 2 })).toEqual({ id: "5", name: "Mods", color: 0x00ff00, position: 2 });
    expect(parseRole({ id: "5", name: "Odd", color: 0x1000000 })).toEqual({ id: "5", name: "Odd", color: 0, position: 0 });
    expect(parseRole({ id: "5" })).toBeUndefined();
    expect(roleColor({ id: "5", name: "x", color: 0xff, position: 0 })).toBe("#0000ff");
    expect(roleColor({ id: "5", name: "x", color: 0, position: 0 })).toBeUndefined();
    expect(roleColor(undefined)).toBeUndefined();
  });

  it("parses presences, invisible and unknown ones as offline without their status text", () => {
    expect(parsePresence({ user: { id: "2" }, status: "dnd", custom_status: { text: "busy" } })).toEqual({ userId: "2", status: "dnd", text: "busy" });
    expect(parsePresence({ user_id: "2", status: "idle", custom_status: { text: "x".repeat(200) } })!.text).toHaveLength(128);
    expect(parsePresence({ user_id: "2", status: "invisible", custom_status: { text: "secret" } })).toEqual({ userId: "2", status: "offline" });
    expect(parsePresence({ user_id: "2", status: 3, custom_status: "no" })).toEqual({ userId: "2", status: "offline" });
    expect(parsePresence({ user_id: "2", status: "online", custom_status: null })).toEqual({ userId: "2", status: "online" });
    expect(parsePresence({ user: { id: "x" } })).toBeUndefined();
    expect(parsePresence("junk")).toBeUndefined();
  });

  it("parses members, with their own id on their presence", () => {
    expect(parseMember({ user: { id: "2", username: "ana" }, nick: "A", roles: ["5", "bad"], presence: { user: { id: "9" }, status: "online" } })).toEqual({
      user: { id: "2", username: "ana" },
      nick: "A",
      roles: ["5"],
      presence: { userId: "2", status: "online" },
    });
    expect(parseMember({ user: { id: "2", username: "ana" }, presence: "junk" })!.presence).toEqual({ userId: "2", status: "offline" });
    expect(parseMember({ nick: "nobody" })).toBeUndefined();
    expect(parseMember(null)).toBeUndefined();
  });

  it("parses member list updates, keeping only usable SYNC operations, groups and items", () => {
    const update = parseMemberListUpdate({
      guild_id: "1",
      id: "2",
      member_count: -4,
      groups: [{ id: "online", count: 3 }, { id: "nope", count: 1 }, { id: "5" }, "junk"],
      ops: [
        { op: "SYNC", range: [0, 2], items: [{ group: { id: "offline", count: 1 } }, { member: { user: { id: "3", username: "c" } } }, { member: {} }, "junk"] },
        { op: "INSERT", range: [0, 0], items: [] },
        { op: "SYNC", range: [5, 4] },
        { op: "SYNC", range: [-1, 4] },
        { op: "SYNC", range: ["0", 4] },
        { op: "SYNC" },
        "junk",
      ],
    });
    expect(update).toEqual({
      guildId: "1",
      channelId: "2",
      memberCount: 0,
      groups: [{ id: "online", count: 3 }, { id: "5", count: 0 }],
      ops: [{ start: 0, end: 2, items: [{ group: { id: "offline", count: 1 } }, { member: expect.objectContaining({ user: { id: "3", username: "c" } }) }] }],
    });
    expect(parseMemberListUpdate({ guild_id: "1", id: "online" })).toBeUndefined();
    expect(parseMemberListUpdate({ guild_id: "1", id: "2" })).toEqual({ guildId: "1", channelId: "2", memberCount: 0, groups: [], ops: [] });
  });

  it("parses profiles, the guild's part only when there is one", () => {
    expect(
      parseProfile({
        user: { id: "2", username: "ana", discriminator: "0007" },
        user_profile: { bio: "own bio", pronouns: "she/her" },
        guild_member_profile: { bio: "guild bio" },
        guild_member: { nick: "", roles: ["5", 6] },
      }),
    ).toEqual({ user: { id: "2", username: "ana" }, discriminator: "0007", bio: "guild bio", pronouns: "she/her", roles: ["5"] });
    expect(parseProfile({ user: { id: "2", username: "ana", discriminator: "0" }, user_profile: "junk" })).toEqual({ user: { id: "2", username: "ana" } });
    expect(parseProfile({ user: { id: "2", username: "ana", discriminator: 12 } })).toEqual({ user: { id: "2", username: "ana" } });
    expect(parseProfile({})).toBeUndefined();
    expect(parseProfile(null)).toBeUndefined();
  });

  it("fetches a profile with or without a guild", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ user: { id: "2", username: "ana" } }) }) as Response);
    const rest = new FluxerRest("https://api.fx/v1", { fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {} });
    expect(await rest.profile("2", "100")).toEqual({ user: { id: "2", username: "ana" } });
    await rest.profile("2");
    expect((fetch.mock.calls as unknown as [string][]).map((c) => c[0])).toEqual(["https://api.fx/v1/users/2/profile?guild_id=100", "https://api.fx/v1/users/2/profile"]);
  });
});

describe("Fluxer member state", () => {
  function state() {
    const s = new FluxerState();
    const ready = readyPayload();
    (ready.guilds[0] as Record<string, unknown>).roles = [{ id: "50", name: "Mods", position: 1 }, "junk"];
    (ready as Record<string, unknown>).presences = [{ user: { id: "2" }, status: "online" }];
    s.apply("READY", ready);
    return s;
  }

  it("keeps guild roles up to date", () => {
    const s = state();
    expect(s.roles.get("100")).toEqual([{ id: "50", name: "Mods", color: 0, position: 1 }]);
    s.apply("GUILD_ROLE_CREATE", { guild_id: "100", role: { id: "51", name: "New", color: 5 } });
    s.apply("GUILD_ROLE_UPDATE", { guild_id: "100", role: { id: "50", name: "Admins", position: 3 } });
    expect(s.roles.get("100")!.map((r) => r.name)).toEqual(["New", "Admins"]);
    s.apply("GUILD_ROLE_DELETE", { guild_id: "100", role_id: "51" });
    expect(s.roles.get("100")!.map((r) => r.id)).toEqual(["50"]);
    // Guilds whose roles are not known, and malformed events, change nothing.
    s.apply("GUILD_ROLE_CREATE", { guild_id: "200", role: { id: "52", name: "x" } });
    s.apply("GUILD_ROLE_CREATE", { guild_id: "100", role: {} });
    s.apply("GUILD_ROLE_DELETE", { guild_id: "bad", role_id: "50" });
    s.apply("GUILD_ROLE_DELETE", { guild_id: "200", role_id: "50" });
    expect(s.roles.has("200")).toBe(false);
    expect(s.roles.get("100")).toHaveLength(1);
    s.apply("GUILD_DELETE", { id: "100" });
    expect(s.roles.has("100")).toBe(false);
  });

  it("keeps presences from READY and updates", () => {
    const s = state();
    expect(s.presences.get("2")!.status).toBe("online");
    s.apply("PRESENCE_UPDATE", { user: { id: "2" }, status: "offline" });
    s.apply("PRESENCE_UPDATE", { status: "online" });
    s.apply("PRESENCE_UPDATE_BULK", {});
    expect(s.presences.get("2")!.status).toBe("offline");
  });

  it("keeps only member lists asked for, within their bound", () => {
    const s = state();
    const member = (id: string) => ({ member: { user: { id, username: `u${id}` }, roles: [] } });
    s.apply("GUILD_MEMBER_LIST_UPDATE", { guild_id: "100", id: "113", groups: [], ops: [{ op: "SYNC", range: [0, 0], items: [member("7")] }] });
    expect(s.memberLists.size).toBe(0);
    expect(s.users.has("7")).toBe(false);
    s.watchMembers("113", "100");
    s.apply("GUILD_MEMBER_LIST_UPDATE", { guild_id: "200", id: "113", groups: [], ops: [] });
    s.apply("GUILD_MEMBER_LIST_UPDATE", "junk");
    expect(s.memberLists.get("113")!.synced).toBe(false);
    s.apply("GUILD_MEMBER_LIST_UPDATE", {
      guild_id: "100",
      id: "113",
      member_count: 500,
      groups: [{ id: "online", count: 500 }],
      ops: [
        { op: "SYNC", range: [0, 1], items: [{ group: { id: "online", count: 500 } }, member("7")] },
        { op: "SYNC", range: [190, 400], items: Array.from({ length: 211 }, (_, i) => member(String(1000 + i))) },
        { op: "SYNC", range: [300, 399], items: [member("8")] },
      ],
    });
    const list = s.memberLists.get("113")!;
    expect(list).toMatchObject({ synced: true, memberCount: 500, positions: 501, reach: MEMBER_LIST_POSITIONS });
    expect(list.items).toHaveLength(MEMBER_LIST_POSITIONS);
    expect(s.users.has("7") && s.users.has("1009") && !s.users.has("1010") && !s.users.has("8")).toBe(true);
    s.apply("READY", readyPayload());
    expect(s.memberLists.size).toBe(0);
  });
});
