import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../../src/main/adapters/discordAdapter";
import { Emitter } from "../../src/main/adapters/emitter";
import { APP_KEY, GenericWebAdapter } from "../../src/main/adapters/genericWebAdapter";
import type { PlatformDef } from "../../src/main/platforms";

const element: PlatformDef = {
  id: "element",
  name: "Element",
  url: "https://app.element.io",
  partition: "persist:element",
  kind: "web",
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
    // DM bubbles carry their own badges now.
    expect(adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
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
