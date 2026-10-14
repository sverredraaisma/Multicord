// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordStoreBridge } from "../../src/preload/discord/storeBridge";
import { isDiscordDmList } from "../../src/shared/ipc";

const EVENT = "test:dms";
const DISCORD_EPOCH = 1420070400000;
const snowflakeAt = (ms: number) => String(BigInt(ms - DISCORD_EPOCH) << 22n);

function store(name: string, methods: Record<string, unknown>) {
  const listeners: (() => void)[] = [];
  return {
    getName: () => name,
    addChangeListener: (cb: () => void) => listeners.push(cb),
    change: () => listeners.forEach((cb) => cb()),
    ...methods,
  };
}

function discordStores() {
  const users: Record<string, unknown> = {
    u1: { username: "ana", globalName: "Ana", getAvatarURL: () => "https://cdn.discordapp.com/avatars/u1/a.png?size=64" },
    u2: { username: "bo", getAvatarURL: () => "/assets/default.png" },
    u3: { username: "cy" },
  };
  const channels = [
    { id: "100", type: 1, recipients: ["u1"], lastMessageId: snowflakeAt(2_000_000_000_000) },
    { id: "200", type: 3, recipients: ["u2", "u3"], name: "", icon: "abc", lastMessageId: snowflakeAt(1_900_000_000_000) },
    { id: "300", type: 3, recipients: [], name: "Named group" },
    { id: "400", type: 0, recipients: [] }, // guild text channel: skipped
    { id: "500", type: 1, recipients: ["missing"], lastMessageId: "junk" },
  ];
  const mentions: Record<string, number> = { "100": 2 };
  const unread = new Set(["200"]);
  return {
    ChannelStore: store("ChannelStore", { getSortedPrivateChannels: () => channels }),
    ReadStateStore: store("ReadStateStore", {
      getMentionCount: (id: string) => mentions[id] ?? 0,
      hasUnread: (id: string) => unread.has(id),
    }),
    UserStore: store("UserStore", { getUser: (id: string) => users[id] }),
    mentions,
  };
}

/** Installs a fake webpack chunk global whose module cache exports the given values. */
function installWebpack(exportsList: unknown[]) {
  const cache: Record<string, { exports: unknown }> = {};
  exportsList.forEach((exports, i) => (cache[i] = { exports }));
  const chunks: unknown[] & { push: (chunk: unknown) => number } = [] as never;
  const push = Array.prototype.push;
  chunks.push = function (chunk: unknown) {
    (chunk as [unknown, unknown, (r: unknown) => void])[2]({ c: cache });
    return push.call(this, chunk);
  };
  (window as unknown as Record<string, unknown>).webpackChunkdiscord_app = chunks;
  return chunks;
}

function listen() {
  const received: unknown[] = [];
  document.addEventListener(EVENT, (e) => received.push(JSON.parse((e as CustomEvent<string>).detail)));
  return received;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).webpackChunkdiscord_app;
});

describe("discordStoreBridge", () => {
  it("reads DMs from Discord's stores, newest first", () => {
    const stores = discordStores();
    const chunks = installWebpack([
      { default: stores.ChannelStore },
      { Z: stores.ReadStateStore, other: { getName: () => { throw new Error("not a store"); } } },
      stores.UserStore,
      null,
      "string export",
      { noise: null },
    ]);
    const received = listen();
    discordStoreBridge(EVENT, 1000, 3);

    expect(chunks).toHaveLength(0); // our probe chunk is removed again
    expect(received).toHaveLength(1);
    const dms = received[0];
    expect(isDiscordDmList(dms)).toBe(true);
    expect(dms).toEqual([
      {
        id: "100",
        title: "Ana",
        avatarUrl: "https://cdn.discordapp.com/avatars/u1/a.png?size=64",
        unread: true,
        mentions: 2,
        lastActivity: 2_000_000_000_000,
      },
      {
        id: "200",
        title: "bo, cy",
        avatarUrl: "https://cdn.discordapp.com/channel-icons/200/abc.png?size=64",
        unread: true,
        mentions: 0,
        lastActivity: 1_900_000_000_000,
      },
      { id: "300", title: "Named group", unread: false, mentions: 0, lastActivity: 0 },
      { id: "500", title: "Unknown user", unread: false, mentions: 0, lastActivity: 0 },
    ]);
  });

  it("re-emits, debounced, when a store changes", () => {
    const stores = discordStores();
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
    const received = listen();
    discordStoreBridge(EVENT, 1000, 3);

    stores.mentions["100"] = 5;
    stores.ReadStateStore.change();
    stores.UserStore.change();
    vi.advanceTimersByTime(250);
    expect(received).toHaveLength(2);
    expect((received[1] as { mentions: number }[])[0]!.mentions).toBe(5);
  });

  it("resolves relative avatar URLs against Discord's origin", () => {
    const stores = discordStores();
    stores.ChannelStore = store("ChannelStore", {
      getSortedPrivateChannels: () => [{ id: "1", type: 1, recipients: ["u2"] }],
    }) as never;
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
    const received = listen();
    discordStoreBridge(EVENT, 1000, 1);
    const origin = window.location.origin;
    const expected = origin.startsWith("https:") ? `${origin}/assets/default.png` : undefined;
    expect((received[0] as { avatarUrl?: string }[])[0]!.avatarUrl).toBe(expected);
  });

  it("falls back to the unsorted private channel map", () => {
    const stores = discordStores();
    stores.ChannelStore = store("ChannelStore", {
      getMutablePrivateChannels: () => ({ a: { id: "7", type: 1, recipients: ["u1"] } }),
    }) as never;
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
    const received = listen();
    discordStoreBridge(EVENT, 1000, 1);
    expect((received[0] as { id: string }[]).map((d) => d.id)).toEqual(["7"]);
  });

  it("emits nothing when the stores change shape", () => {
    const stores = discordStores();
    stores.ChannelStore = store("ChannelStore", {}) as never;
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
    const received = listen();
    discordStoreBridge(EVENT, 1000, 1);
    expect(received).toEqual([[]]);

    const broken = discordStores();
    broken.ReadStateStore = store("ReadStateStore", {}) as never;
    installWebpack([broken.ChannelStore, broken.ReadStateStore, broken.UserStore]);
    discordStoreBridge(EVENT, 1000, 1);
    expect(received).toHaveLength(1);
  });

  it("retries until webpack and the stores exist, then gives up", () => {
    const received = listen();
    discordStoreBridge(EVENT, 1000, 3);
    (window as unknown as Record<string, unknown>).webpackChunkdiscord_app = { push: "not a function" };
    vi.advanceTimersByTime(1000);
    installWebpack([discordStores().ChannelStore]); // stores incomplete
    vi.advanceTimersByTime(1000);
    expect(received).toHaveLength(0);
    const stores = discordStores();
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
    vi.advanceTimersByTime(10_000); // attempts exhausted
    expect(received).toHaveLength(0);

    discordStoreBridge(EVENT, 1000, 1);
    expect(received).toHaveLength(1);
  });

  it("survives a webpack runtime without a module cache or a throwing scan", () => {
    const received = listen();
    (window as unknown as Record<string, unknown>).webpackChunkdiscord_app = {
      push: (chunk: [unknown, unknown, (r: unknown) => void]) => chunk[2]({}),
    };
    discordStoreBridge(EVENT, 1000, 1);
    (window as unknown as Record<string, unknown>).webpackChunkdiscord_app = {
      push: () => {
        throw new Error("boom");
      },
    };
    discordStoreBridge(EVENT, 1000, 1);
    expect(received).toHaveLength(0);
  });

  it("is self-contained, so it survives serialization into the main world", () => {
    const stores = discordStores();
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
    const received = listen();
    const serialized = new Function(`return (${discordStoreBridge.toString()})`)() as typeof discordStoreBridge;
    serialized(EVENT, 1000, 1);
    expect(received).toHaveLength(1);
  });
});
