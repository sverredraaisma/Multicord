import { describe, expect, it, vi } from "vitest";
import { StoatRest, MAX_SERVER_MEMBERS } from "../../../src/modules/stoat/rest";
import { StoatState } from "../../../src/modules/stoat/state";
import { parseMember, parseRole, parseRoles, parseStatus, parseUser } from "../../../src/modules/stoat/types";
import { ALPHA, ANA_ID, BOB_ID, ME_ID, readyPayload, ulid } from "./fixtures";

describe("Stoat member parsing", () => {
  it("parses roles, keeping only plain colours", () => {
    expect(parseRoles({ [ulid(60)]: { name: "Mods", colour: "#AbCdEf", hoist: true, rank: 2 }, bad: { name: "x" }, [ulid(61)]: { name: 5 } })).toEqual([{ id: ulid(60), name: "Mods", colour: "#abcdef", hoist: true, rank: 2 }]);
    expect(parseRole(ulid(60), { name: "Grad", colour: "linear-gradient(red, blue)" })).toEqual({ id: ulid(60), name: "Grad", hoist: false, rank: 0 });
    expect(parseRole(ulid(60), "junk")).toBeUndefined();
    expect(parseRoles(["junk"])).toEqual([]);
    expect(parseRoles(undefined)).toEqual([]);
  });

  it("parses members by their compound id", () => {
    expect(parseMember({ _id: { server: ALPHA, user: ANA_ID }, nickname: "Annie", roles: [ulid(60), "bad"], avatar: { _id: "a", tag: "avatars", filename: "a.png" } })).toEqual({
      userId: ANA_ID,
      nickname: "Annie",
      avatar: expect.objectContaining({ id: "a" }),
      roles: [ulid(60)],
    });
    expect(parseMember({ _id: { server: ALPHA, user: "bad" } })).toBeUndefined();
    expect(parseMember({ _id: ANA_ID })).toBeUndefined();
    expect(parseMember(null)).toBeUndefined();
  });

  it("parses statuses and users' tags, bots and presence", () => {
    expect(parseStatus({ presence: "Busy", text: "x".repeat(200) })).toEqual({ presence: "Busy", statusText: "x".repeat(128) });
    expect(parseStatus({ presence: "Away", text: " " })).toEqual({});
    expect(parseStatus("junk")).toEqual({});
    expect(parseUser({ _id: ANA_ID, username: "ana", discriminator: "12", bot: { owner: ME_ID }, online: "yes" })).toEqual({ id: ANA_ID, username: "ana", bot: true });
  });

  it("fetches members, a group's users, one member, a user and a profile", async () => {
    const replies: Record<string, unknown> = {
      [`/servers/${ALPHA}/members?exclude_offline=false`]: { members: [{ _id: { server: ALPHA, user: ANA_ID } }, "junk"], users: [{ _id: ANA_ID, username: "ana" }] },
      [`/channels/${ulid(901)}/members`]: [{ _id: BOB_ID, username: "bob" }],
      [`/servers/${ALPHA}/members/${ANA_ID}`]: { _id: { server: ALPHA, user: ANA_ID }, roles: [] },
      [`/users/${ANA_ID}`]: { _id: ANA_ID, username: "ana" },
      [`/users/${ANA_ID}/profile`]: { content: "Hi" },
      [`/users/${BOB_ID}/profile`]: { background: {} },
    };
    const fetch = vi.fn(async (url: string) => ({ ok: true, status: 200, headers: new Headers(), json: async () => replies[url.slice("https://x.test/api".length)] }) as Response);
    const rest = new StoatRest({ api: "https://x.test/api" } as never, { fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {} });
    expect(await rest.members(ALPHA)).toEqual({ members: [{ userId: ANA_ID, roles: [] }], users: [expect.objectContaining({ id: ANA_ID })] });
    expect(await rest.members(ulid(5))).toEqual({ members: [], users: [] });
    expect(await rest.groupMembers(ulid(901))).toEqual([expect.objectContaining({ id: BOB_ID })]);
    expect(await rest.groupMembers(ulid(5))).toEqual([]);
    expect(await rest.member(ALPHA, ANA_ID)).toEqual({ userId: ANA_ID, roles: [] });
    expect(await rest.user(ANA_ID)).toEqual(expect.objectContaining({ username: "ana" }));
    expect(await rest.profile(ANA_ID)).toBe("Hi");
    expect(await rest.profile(BOB_ID)).toBeUndefined();
    expect(await rest.profile(ME_ID)).toBeUndefined();
    expect(MAX_SERVER_MEMBERS).toBeGreaterThan(200);
  });
});

describe("Stoat member state", () => {
  function state() {
    const s = new StoatState();
    const payload = readyPayload();
    (payload.servers[0] as Record<string, unknown>).roles = { [ulid(60)]: { name: "Mods", colour: "#ff0000", hoist: true, rank: 1 } };
    s.apply("Ready", payload);
    s.setMembers(ALPHA, [{ userId: ANA_ID, nickname: "Annie", roles: [ulid(60)] }], []);
    return s;
  }

  it("follows member updates for lists it keeps", () => {
    const s = state();
    const ana = () => s.members.get(ALPHA)!.get(ANA_ID)!;
    s.apply("ServerMemberUpdate", { id: { server: ALPHA, user: ANA_ID }, data: { nickname: "A", roles: [ulid(61)], avatar: { _id: "b", tag: "avatars", filename: "b.png" } } });
    expect(ana()).toMatchObject({ nickname: "A", roles: [ulid(61)], avatar: expect.objectContaining({ id: "b" }) });
    s.apply("ServerMemberUpdate", { id: { server: ALPHA, user: ANA_ID }, data: {}, clear: ["Avatar", "Roles"] });
    expect(ana()).toEqual({ userId: ANA_ID, nickname: "A", roles: [], avatar: undefined });
    s.apply("ServerMemberUpdate", { id: { server: ALPHA, user: ANA_ID }, data: { roles: "junk" } });
    expect(ana().roles).toEqual([]);
    // Members of lists not kept, and malformed updates, change nothing.
    s.apply("ServerMemberUpdate", { id: { server: ulid(200), user: ANA_ID }, data: { nickname: "x" } });
    s.apply("ServerMemberUpdate", { id: ANA_ID, data: { nickname: "x" } });
    s.apply("ServerMemberJoin", { id: ulid(200), user: BOB_ID });
    s.apply("ServerMemberJoin", { id: ALPHA, user: BOB_ID });
    expect(s.members.get(ALPHA)!.get(BOB_ID)).toEqual({ userId: BOB_ID, roles: [] });
    s.apply("ServerMemberLeave", { id: ALPHA, user: BOB_ID });
    expect(s.members.get(ALPHA)!.has(BOB_ID)).toBe(false);
    s.apply("ServerMemberLeave", { id: ALPHA, user: ME_ID });
    expect(s.members.has(ALPHA)).toBe(false);
  });

  it("follows role changes", () => {
    const s = state();
    const roles = () => s.servers.get(ALPHA)!.roles;
    s.apply("ServerRoleUpdate", { id: ALPHA, role_id: ulid(60), data: { rank: 3 }, clear: ["Colour"] });
    expect(roles()).toEqual([{ id: ulid(60), name: "Mods", hoist: true, rank: 3 }]);
    s.apply("ServerRoleUpdate", { id: ALPHA, role_id: ulid(61), data: { name: "New", colour: "#00ff00" } });
    s.apply("ServerRoleUpdate", { id: ALPHA, role_id: ulid(62), data: "junk" });
    expect(roles().map((r) => r.name)).toEqual(["Mods", "New"]);
    s.apply("ServerRoleDelete", { id: ALPHA, role_id: ulid(60) });
    s.apply("ServerRoleDelete", { id: ALPHA, role_id: "bad" });
    s.apply("ServerRoleDelete", { id: ulid(5), role_id: ulid(61) });
    expect(roles().map((r) => r.name)).toEqual(["New"]);
  });

  it("follows presence and status changes", () => {
    const s = state();
    const ana = () => s.users.get(ANA_ID)!;
    s.apply("UserUpdate", { id: ANA_ID, data: { online: false, status: { presence: "Idle", text: "away" } } });
    expect(ana()).toMatchObject({ online: false, presence: "Idle", statusText: "away" });
    s.apply("UserUpdate", { id: ANA_ID, data: {}, clear: ["StatusText", "StatusPresence"] });
    expect(ana().presence).toBeUndefined();
    expect(ana().statusText).toBeUndefined();
    s.apply("UserUpdate", { id: ANA_ID, data: { status: { text: "back" } } });
    expect(ana()).toMatchObject({ statusText: "back" });
  });
});
