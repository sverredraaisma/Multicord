import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../../src/main/adapters/discordAdapter";
import { GenericWebAdapter } from "../../src/main/adapters/genericWebAdapter";
import { flattenServers, MAX_DM_BUBBLES, PlatformRegistry, railKey, splitRailKey } from "../../src/main/registry";
import type { PlatformAdapter } from "../../src/shared/adapter";

async function setup() {
  const navigate = vi.fn();
  const discord = new DiscordAdapter(navigate);
  const element = new GenericWebAdapter({
    id: "element",
    name: "Element",
    url: "https://app.element.io",
    partition: "persist:element",
    kind: "web",
  });
  const registry = new PlatformRegistry();
  await registry.add(discord, "Discord");
  await registry.add(element, "Element");
  return { registry, discord, element, navigate };
}

describe("rail keys", () => {
  it("round-trips and rejects malformed keys", () => {
    expect(splitRailKey(railKey("discord", "1"))).toEqual({ platform: "discord", local: "1" });
    expect(splitRailKey("matrix:!room:server")).toEqual({ platform: "matrix", local: "!room:server" });
    expect(splitRailKey("nocolon")).toBeUndefined();
    expect(splitRailKey(":x")).toBeUndefined();
    expect(splitRailKey("x:")).toBeUndefined();
  });
});

describe("PlatformRegistry", () => {
  it("builds one rail from every adapter, with a home entry where supported", async () => {
    const { registry, discord } = await setup();
    const onChange = vi.fn();
    registry.onChange(onChange);
    discord.update({ guilds: [{ id: "1", name: "One", unread: true, mentions: 1 }], badge: { unread: true, mentions: 3 } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(registry.state()).toEqual({
      activeKey: null,
      entries: [
        { key: "discord:home", platform: "discord", kind: "home", name: "Discord direct messages", unread: true, mentions: 2 },
        { key: "discord:1", platform: "discord", kind: "server", name: "One", iconUrl: undefined, unread: true, mentions: 1 },
        { key: "element:app", platform: "element", kind: "server", name: "Element", iconUrl: undefined, unread: false, mentions: 0 },
      ],
    });
    expect(registry.totals()).toEqual({ unread: true, mentions: 3 });
  });

  it("routes opens to the right adapter and tracks the active entry", async () => {
    const { registry, navigate } = await setup();
    expect(await registry.open("discord:home")).toBe("discord");
    expect(await registry.open("discord:42")).toBe("discord");
    expect(navigate.mock.calls).toEqual([["home"], ["42"]]);
    expect(await registry.open("element:app")).toBe("element");
    expect(registry.state().activeKey).toBe("element:app");
    expect(await registry.open("matrix:x")).toBeUndefined();
    expect(await registry.open("garbage")).toBeUndefined();
  });

  it("shows unread DMs as bubbles after home, newest first", async () => {
    const { registry, discord, navigate } = await setup();
    const dm = (id: string, lastActivity: number, unread: boolean, mentions = 0) => ({
      id,
      title: `User ${id}`,
      unread,
      mentions,
      lastActivity,
    });
    discord.update({
      guilds: [{ id: "1", name: "One", unread: false, mentions: 0 }],
      badge: { unread: true, mentions: 3 },
      dms: [dm("10", 100, true, 1), dm("11", 300, true, 2), dm("12", 200, false)],
    });
    const entries = registry.state().entries;
    expect(entries.map((e) => [e.key, e.kind])).toEqual([
      ["discord:home", "home"],
      ["discord:dm:11", "dm"],
      ["discord:dm:10", "dm"],
      ["discord:1", "server"],
      ["element:app", "server"],
    ]);
    expect(entries[0]).toMatchObject({ unread: false, mentions: 0 });
    expect(entries[1]).toMatchObject({ name: "User 11", mentions: 2 });
    expect(registry.totals().mentions).toBe(3);

    expect(await registry.open("discord:dm:11")).toBe("discord");
    expect(navigate).toHaveBeenLastCalledWith("dm:11");
    expect(registry.state().activeKey).toBe("discord:dm:11");
  });

  it("folds unread DMs beyond the bubble limit into the home badge", async () => {
    const { registry, discord } = await setup();
    const dms = Array.from({ length: MAX_DM_BUBBLES + 2 }, (_, i) => ({
      id: String(100 + i),
      title: `User ${i}`,
      unread: true,
      mentions: 1,
      lastActivity: 1000 - i,
    }));
    discord.update({ guilds: [], badge: { unread: true, mentions: dms.length }, dms });
    const entries = registry.state().entries;
    expect(entries.filter((e) => e.kind === "dm")).toHaveLength(MAX_DM_BUBBLES);
    expect(entries[0]).toMatchObject({ kind: "home", unread: true, mentions: 2 });
    expect(registry.totals().mentions).toBe(dms.length);
  });

  it("handles adapters without a home and without a home badge", async () => {
    const registry = new PlatformRegistry();
    const adapter = {
      platform: "custom",
      listServers: async () => [],
      listDirectConversations: async () => [],
      onServersChanged: () => () => {},
      onDirectsChanged: () => () => {},
      openHome: vi.fn(async () => {}),
      openServer: vi.fn(async () => {}),
    } as unknown as PlatformAdapter;
    await registry.add(adapter, "Custom");
    expect(registry.state().entries).toEqual([
      { key: "custom:home", platform: "custom", kind: "home", name: "Custom direct messages", unread: false, mentions: 0 },
    ]);
    await registry.open("custom:home");
    expect(adapter.openHome).toHaveBeenCalled();
  });
});

describe("groups", () => {
  const account = { platform: "discord", instance: "discord.com", accountId: "default" };
  const server = (key: string, mentions = 0) => ({ key, account, name: key, unread: mentions > 0, mentions });

  it("flattens expanded groups with their children and hides collapsed groups' children", () => {
    const entries = flattenServers("discord", [
      server("1"),
      { ...server("folder:50", 3), kind: "group", expanded: true, color: "#ff0000", children: [server("2", 3)] },
      { ...server("folder:60", 2), kind: "group", expanded: false, previewIconUrls: ["https://cdn/a.png"], children: [server("3", 2)] },
      { ...server("folder:70"), kind: "group" },
    ]);
    expect(entries).toEqual([
      { key: "discord:1", platform: "discord", kind: "server", name: "1", iconUrl: undefined, unread: false, mentions: 0 },
      {
        key: "discord:folder:50",
        platform: "discord",
        kind: "group",
        name: "folder:50",
        color: "#ff0000",
        expanded: true,
        previewIconUrls: [],
        unread: false,
        mentions: 0,
      },
      {
        key: "discord:2",
        platform: "discord",
        kind: "server",
        name: "2",
        iconUrl: undefined,
        unread: true,
        mentions: 3,
        parentKey: "discord:folder:50",
      },
      {
        key: "discord:folder:60",
        platform: "discord",
        kind: "group",
        name: "folder:60",
        color: undefined,
        expanded: false,
        previewIconUrls: ["https://cdn/a.png"],
        unread: true,
        mentions: 2,
      },
      {
        key: "discord:folder:70",
        platform: "discord",
        kind: "group",
        name: "folder:70",
        color: undefined,
        expanded: false,
        previewIconUrls: [],
        unread: false,
        mentions: 0,
      },
    ]);
  });

  it("toggles groups on open without switching views", async () => {
    const { registry, discord, navigate } = await setup();
    discord.update({
      guilds: [{ id: "2", name: "G", unread: false, mentions: 0, folderId: "50" }],
      folders: [{ id: "50", name: "F", expanded: true, unread: false, mentions: 0, iconUrls: [], index: 0 }],
      badge: { unread: false, mentions: 0 },
    });
    expect(await registry.open("discord:folder:50")).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith("folder:50");
    expect(registry.state().activeKey).toBeNull();

    expect(await registry.open("discord:2")).toBe("discord");
    expect(registry.state().activeKey).toBe("discord:2");
  });
});

describe("openNotification", () => {
  it("opens the conversation and highlights its rail entry", async () => {
    const { registry, discord } = await setup();
    const open = vi.spyOn(discord, "openConversation").mockResolvedValue();
    expect(await registry.openNotification("discord", { title: "t", body: "b", target: "77", railKey: "dm:77" })).toBe("discord");
    expect(open).toHaveBeenCalledWith("77");
    expect(registry.state().activeKey).toBe("discord:dm:77");
    expect(await registry.openNotification("discord", { title: "t", body: "b", target: "78" })).toBe("discord");
    expect(registry.state().activeKey).toBe("discord:dm:77");
    expect(await registry.openNotification("nope", { title: "t", body: "b", target: "1" })).toBeUndefined();
  });
});
