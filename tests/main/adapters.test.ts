import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../../src/main/adapters/discordAdapter";
import { Emitter } from "../../src/shared/emitter";
import { APP_KEY, GenericWebAdapter } from "../../src/main/adapters/genericWebAdapter";
import type { PlatformDef } from "../../src/main/platforms";

const element: PlatformDef = {
  id: "element",
  name: "Element",
  url: "https://app.element.io",
  partition: "persist:element",
  module: "web",
};

describe("Emitter", () => {
  it("emits to listeners until they unsubscribe", () => {
    const emitter = new Emitter<number>();
    const listener = vi.fn();
    const off = emitter.on(listener);
    emitter.emit(1);
    off();
    emitter.emit(2);
    expect(listener.mock.calls).toEqual([[1]]);
  });
});

describe("DiscordAdapter", () => {
  it("maps preload state to rail servers and a DM badge", async () => {
    const adapter = new DiscordAdapter(vi.fn());
    const changed = vi.fn();
    adapter.onServersChanged(changed);
    adapter.update({
      guilds: [{ id: "1", name: "One", unread: true, mentions: 2 }],
      badge: { unread: true, mentions: 5 },
    });
    const servers = await adapter.listServers();
    expect(servers).toEqual([
      {
        key: "1",
        account: { platform: "discord", instance: "discord.com", accountId: "default" },
        name: "One",
        iconUrl: undefined,
        unread: true,
        mentions: 2,
      },
    ]);
    expect(changed).toHaveBeenCalledWith(servers);
    expect(adapter.homeBadge()).toEqual({ unread: true, mentions: 3 });

    adapter.update({ guilds: [{ id: "1", name: "One", unread: true, mentions: 9 }], badge: { unread: true, mentions: 5 } });
    expect(adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
  });

  it("reports the signed-in user once the store bridge knows it", () => {
    const adapter = new DiscordAdapter(vi.fn(), "discord-2");
    expect(adapter.platform).toBe("discord-2");
    expect(adapter.accountStatus()).toEqual({ state: "unknown" });
    const badge = { unread: false, mentions: 0 };
    adapter.update({ guilds: [], badge, user: { name: "Ana" } });
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: "Ana" });
    adapter.update({ guilds: [], badge }); // DOM-only update: keeps what the bridge said
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: "Ana" });
    adapter.update({ guilds: [], badge, user: null });
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("reports which of Discord's hooks work", () => {
    const adapter = new DiscordAdapter(vi.fn());
    expect(adapter.health()).toEqual([expect.objectContaining({ ok: false, name: "Discord's page has loaded" })]);
    const badge = { unread: false, mentions: 0 };
    adapter.update({ guilds: [], badge, health: { guildBar: true } });
    const before = adapter.health();
    expect(before.find((c) => c.name.startsWith("Server list"))!.ok).toBe(true);
    expect(before.find((c) => c.name === "Store bridge")!.ok).toBe(false);
    adapter.update({ guilds: [], badge, health: { guildBar: false, stores: ["ChannelStore", "ReadStateStore", "UserStore", "CallStore"] } });
    const after = adapter.health();
    expect(after.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "Server list (hidden guild bar)",
      "Server names (GuildStore)",
      "Server folders (SortedGuildStore)",
      "Server unread state (GuildReadStateStore)",
      "Message previews (MessageStore)",
      "Discord's streamer mode (StreamerModeStore)",
    ]);
    adapter.update({ guilds: [], badge, health: { guildBar: true, stores: ["ChannelStore", "MessageStore", "StreamerModeStore"] } });
    expect(adapter.health().find((c) => c.name === "Message previews (MessageStore)")).toMatchObject({ ok: true, detail: "The last message of each DM in the Messages list" });
    expect(adapter.health().find((c) => c.name === "Discord's streamer mode (StreamerModeStore)")!.ok).toBe(true);
    adapter.update({ guilds: [], badge, health: { guildBar: false, stores: ["ChannelStore", "ReadStateStore", "UserStore", "CallStore"] } });
    expect(after.find((c) => c.name === "Calls (CallStore)")).toMatchObject({ ok: true, detail: "Ringing for incoming calls" });
    adapter.update({ guilds: [], badge }); // no health in this update: keep the last report
    expect(adapter.health()).toEqual(after);
  });

  it("reports each call once, when it starts ringing", () => {
    const adapter = new DiscordAdapter(vi.fn());
    const calls = vi.fn();
    adapter.onIncomingCall(calls);
    const badge = { unread: false, mentions: 0 };
    const ringing = [{ channelId: "7", from: "Ana" }];
    adapter.update({ guilds: [], badge, calls: ringing });
    adapter.update({ guilds: [], badge, calls: ringing }); // still ringing
    adapter.update({ guilds: [], badge }); // no call data: no change
    expect(calls).toHaveBeenCalledOnce();
    expect(calls).toHaveBeenCalledWith({ conversationKey: "7", from: "Ana", video: false });
    adapter.update({ guilds: [], badge, calls: [] });
    adapter.update({ guilds: [], badge, calls: ringing }); // rings again
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("navigates to home, guilds and DMs through the preload", async () => {
    const navigate = vi.fn();
    const adapter = new DiscordAdapter(navigate);
    await adapter.openHome();
    await adapter.openServer("42");
    await adapter.openConversation("77");
    expect(navigate.mock.calls).toEqual([["home"], ["42"], ["dm:77"]]);
    await expect(adapter.openServer("../x")).rejects.toThrow("Not a Discord guild id");
    await expect(adapter.openConversation("@me")).rejects.toThrow("Not a Discord channel id");
  });

  it("exposes DMs once the store bridge reports them", async () => {
    const adapter = new DiscordAdapter(vi.fn());
    const directsChanged = vi.fn();
    adapter.onDirectsChanged(directsChanged);

    adapter.update({ guilds: [], badge: { unread: true, mentions: 4 } });
    expect(await adapter.listDirectConversations()).toEqual([]);
    expect(directsChanged).not.toHaveBeenCalled();
    expect(adapter.homeBadge()).toEqual({ unread: true, mentions: 4 });

    const dm = { id: "9", title: "Ana", avatarUrl: "https://cdn/a.png", unread: true, mentions: 4, lastActivity: 1000 };
    adapter.update({ guilds: [], badge: { unread: true, mentions: 4 }, dms: [dm] });
    const directs = await adapter.listDirectConversations();
    expect(directs).toEqual([
      {
        key: "9",
        account: { platform: "discord", instance: "discord.com", accountId: "default" },
        title: "Ana",
        avatarUrl: "https://cdn/a.png",
        lastActivity: 1000,
        unread: true,
        mentions: 4,
      },
    ]);
    expect(directsChanged).toHaveBeenCalledWith(directs);
    expect(directs[0]).not.toHaveProperty("preview");
    // DM bubbles carry their own badges now.
    expect(adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
  });

  it("passes the last message on as the DM's preview", async () => {
    const adapter = new DiscordAdapter(vi.fn());
    expect(adapter.capabilities.messagePreviews).toBe(true);
    const dm = { id: "9", title: "Ana", unread: false, mentions: 0, lastActivity: 1000 };
    adapter.update({ guilds: [], badge: { unread: false, mentions: 0 }, dms: [{ ...dm, preview: "See you at eight" }, { ...dm, id: "10" }] });
    const [withPreview, without] = await adapter.listDirectConversations();
    expect(withPreview!.preview).toBe("See you at eight");
    expect(without).not.toHaveProperty("preview");
  });

  it("implements the rest of the adapter contract", async () => {
    const adapter = new DiscordAdapter(vi.fn());
    expect(adapter.mode).toBe("webview");
    expect(adapter.capabilities.screenShare).toBe(true);
    const account = { platform: "discord", instance: "discord.com", accountId: "me" };
    await adapter.connect(account);
    adapter.update({ guilds: [{ id: "1", name: "One", unread: false, mentions: 0 }], badge: { unread: false, mentions: 0 } });
    expect((await adapter.listServers())[0]!.account).toBe(account);
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    await expect(adapter.listDirectConversations()).resolves.toEqual([]);
    for (const subscribe of [adapter.onDirectsChanged, adapter.onNotification, adapter.onIncomingCall]) {
      expect(typeof subscribe.call(adapter, vi.fn())).toBe("function");
    }
  });
});

describe("GenericWebAdapter", () => {
  it("is a single rail entry driven by the page title", async () => {
    const adapter = new GenericWebAdapter(element);
    const changed = vi.fn();
    adapter.onServersChanged(changed);
    expect(await adapter.listServers()).toMatchObject([{ key: APP_KEY, name: "Element", unread: false, mentions: 0 }]);
    expect((await adapter.listServers())[0]!.account.instance).toBe("app.element.io");

    adapter.updateTitle("Element");
    expect(changed).not.toHaveBeenCalled();
    adapter.updateTitle("Element [4]");
    expect(changed).toHaveBeenCalledWith([expect.objectContaining({ unread: true, mentions: 4 })]);
  });

  it("opens by showing the view and has no conversations yet", async () => {
    const adapter = new GenericWebAdapter(element);
    await expect(adapter.openServer(APP_KEY)).resolves.toBeUndefined();
    await expect(adapter.openConversation("x")).rejects.toThrow("Element conversations are not supported");
  });
});

describe("DiscordAdapter folders", () => {
  const guild = (id: string, folderId?: string) => ({ id, name: `G${id}`, unread: false, mentions: 0, folderId });
  const folder = (id: string, index: number, expanded: boolean) => ({
    id,
    name: `F${id}`,
    color: "#123456",
    expanded,
    unread: true,
    mentions: 1,
    iconUrls: ["https://cdn/x.png"],
    index,
  });

  it("nests folder members and keeps folders in bar order", async () => {
    const adapter = new DiscordAdapter(vi.fn());
    adapter.update({
      guilds: [guild("1"), guild("2", "50"), guild("3", "50"), guild("4"), guild("5", "99")],
      folders: [folder("50", 1, true), folder("60", 4, false), folder("70", 5, false)],
      badge: { unread: false, mentions: 0 },
    });
    const servers = await adapter.listServers();
    expect(servers.map((s) => s.key)).toEqual(["1", "folder:50", "4", "folder:60", "5", "folder:70"]);
    expect(servers[1]).toMatchObject({
      kind: "group",
      name: "F50",
      expanded: true,
      color: "#123456",
      previewIconUrls: ["https://cdn/x.png"],
      unread: true,
      mentions: 1,
    });
    expect(servers[1]!.children!.map((c) => c.key)).toEqual(["2", "3"]);
    expect(servers[3]!.children).toEqual([]);
  });

  it("toggles folders through the preload", async () => {
    const navigate = vi.fn();
    const adapter = new DiscordAdapter(navigate);
    await adapter.toggleGroup("folder:50");
    expect(navigate).toHaveBeenCalledWith("folder:50");
    await expect(adapter.toggleGroup("50")).rejects.toThrow("Not a Discord folder");
    await expect(adapter.toggleGroup("folder:x")).rejects.toThrow("Not a Discord folder");
  });
});

describe("discord:// links", () => {
  it("maps the official client's links to targets", async () => {
    const { discordLinkTarget } = await import("../../src/main/adapters/discordAdapter");
    expect(discordLinkTarget("discord://")).toBe("home");
    expect(discordLinkTarget("discord://-/channels/@me")).toBe("home");
    expect(discordLinkTarget("discord://-/channels/@me/42")).toBe("dm:42");
    expect(discordLinkTarget("discord://-/channels/7")).toBe("7");
    expect(discordLinkTarget("discord://-/channels/7/8")).toBe("channel:7/8");
    for (const bad of ["not a url", "https://discord.com/channels/7", "discord://-/channels/@me/x", "discord://-/channels/x", "discord://-/channels/7/x", "discord://-/channels/7/8/9", "discord://-/store"]) {
      expect(discordLinkTarget(bad)).toBeUndefined();
    }
  });

  it("navigates to a link's target, or reports it cannot", async () => {
    const navigate = vi.fn();
    const adapter = new DiscordAdapter(navigate);
    expect(await adapter.openLink("discord://-/channels/7/8")).toBe(true);
    expect(navigate).toHaveBeenCalledWith("channel:7/8");
    expect(await adapter.openLink("discord://-/store")).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe("relayed Discord notifications", () => {
  it("shows Discord's notifications through the shell and clicks them back", async () => {
    const navigate = vi.fn();
    const click = vi.fn();
    const adapter = new DiscordAdapter(navigate, "discord", click);
    const notes = vi.fn();
    adapter.onNotification(notes);
    adapter.relayNotification({ id: "4", title: "Ana", body: "hi" });
    expect(notes).toHaveBeenCalledWith({ title: "Ana", body: "hi", target: "notification:4" });
    await adapter.openConversation("notification:4");
    expect(click).toHaveBeenCalledWith("4");
    expect(navigate).not.toHaveBeenCalled();
    await new DiscordAdapter(navigate).openConversation("notification:5"); // default handler: nothing to do

    const sendActivity = vi.fn();
    const update = { source: "rpc-1", activity: null };
    const withActivity = new DiscordAdapter(navigate, "discord", click, sendActivity);
    withActivity.setActivity(update);
    expect(sendActivity).toHaveBeenCalledWith(update);
    // Shown activities are given again to a reloaded page; cleared ones are not.
    const playing = { source: "rpc-2", activity: { application_id: "42", type: 0, flags: 0 } };
    withActivity.setActivity(playing);
    sendActivity.mockClear();
    withActivity.replayActivities();
    expect(sendActivity.mock.calls).toEqual([[playing]]);
    withActivity.setActivity({ source: "rpc-2", activity: null });
    sendActivity.mockClear();
    withActivity.replayActivities();
    expect(sendActivity).not.toHaveBeenCalled();
    new DiscordAdapter(navigate).setActivity(update); // default: nowhere to show it
  });
});
