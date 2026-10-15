// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordStoreBridge } from "../../src/preload/discord/storeBridge";
import { isBridgePayload, isDiscordDmList } from "../../src/shared/ipc";

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
    "42": { username: "ana42", globalName: "Ana" },
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

/**
 * Installs a fake webpack chunk global whose module cache exports the given
 * values. Like Discord's, it has several runtimes: a pushed chunk also
 * reaches a small one, last, which holds none of the app's modules.
 */
function installWebpack(exportsList: unknown[]) {
  const cache: Record<string, { exports: unknown }> = {};
  exportsList.forEach((exports, i) => (cache[i] = { exports }));
  const chunks: unknown[] & { push: (chunk: unknown) => number } = [] as never;
  const push = Array.prototype.push;
  chunks.push = function (chunk: unknown) {
    (chunk as [unknown, unknown, (r: unknown) => void])[2]({ c: cache });
    (chunk as [unknown, unknown, (r: unknown) => void])[2]({ c: { overlay: { exports: {} } } });
    return push.call(this, chunk);
  };
  (window as unknown as Record<string, unknown>).webpackChunkdiscord_app = chunks;
  return chunks;
}

/** Collects one field of each bridge payload (DMs by default). */
function listen(field: "dms" | "guilds" | "layout" | "user" | "calls" | "stores" = "dms") {
  const received: unknown[] = [];
  document.addEventListener(EVENT, (e) => {
    const payload = JSON.parse((e as CustomEvent<string>).detail);
    expect(isBridgePayload(payload)).toBe(true);
    received.push(payload[field]);
  });
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

  it("reports the signed-in user, or null on the login screen", () => {
    const stores = discordStores();
    let me: unknown = { username: "ana", globalName: "Ana" };
    Object.assign(stores.UserStore, { getCurrentUser: () => me });
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
    const received = listen("user");
    discordStoreBridge(EVENT, 1000, 3);
    me = null;
    stores.UserStore.change();
    vi.advanceTimersByTime(300);
    Object.assign(stores.UserStore, { getCurrentUser: () => { throw new Error("changed shape"); } });
    stores.UserStore.change();
    vi.advanceTimersByTime(300);
    expect(received).toEqual([{ name: "Ana" }, null, undefined]);
  });

  it("reports calls ringing the current user, named after their DM", () => {
    const stores = discordStores();
    Object.assign(stores.UserStore, { getCurrentUser: () => ({ id: "me", username: "me" }) });
    Object.assign(stores.ChannelStore, { getChannel: (id: string) => (id === "100" ? { id: "100", type: 1, recipients: ["u1"] } : undefined) });
    let calls: unknown[] = [
      { channelId: "100", ringing: ["me"] },
      { channelId: "200", ringing: ["someone-else"] },
      { channelId: "300", ringing: ["me"] }, // channel unknown to the store
      { channelId: "bad id", ringing: ["me"] },
      null,
    ];
    const CallStore = { getName: () => "CallStore", addChangeListener: () => {}, getCalls: () => calls };
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore, CallStore]);
    const received = listen("calls");
    discordStoreBridge(EVENT, 1000, 3);
    calls = "not a list" as never;
    stores.UserStore.change();
    vi.advanceTimersByTime(300);
    expect(received).toEqual([
      [
        { channelId: "100", from: "Ana" },
        { channelId: "300", from: "Someone" },
      ],
      [],
    ]);
  });

  it("names the stores it found, for diagnostics", () => {
    const stores = discordStores();
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
    const received = listen("stores");
    discordStoreBridge(EVENT, 1000, 3);
    expect(received).toEqual([["ChannelStore", "ReadStateStore", "UserStore"]]);
  });

  it("reports no calls without CallStore or a signed-in user", () => {
    const stores = discordStores();
    installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
    const received = listen("calls");
    discordStoreBridge(EVENT, 1000, 3);
    expect(received).toEqual([[]]);
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

  describe("message previews", () => {
    const LAST: Record<string, string> = { "100": snowflakeAt(2_000_000_000_000), "200": snowflakeAt(1_900_000_000_000) };
    /** A MessageStore holding the given last messages; only a lookup by the channel's lastMessageId finds them. */
    const messageStore = (byChannel: Record<string, unknown>, lookups: string[][] = []) =>
      store("MessageStore", {
        getMessage: (channelId: string, messageId: string) => {
          lookups.push([channelId, messageId]);
          return messageId === LAST[channelId] ? byChannel[channelId] : undefined;
        },
      });

    /** Runs the bridge with these extra stores; returns each DM's preview by channel id, per emit. */
    function previews(extra: unknown[], change?: (stores: ReturnType<typeof discordStores>) => void) {
      const stores = discordStores();
      Object.assign(stores.UserStore, { getCurrentUser: () => ({ id: "me", username: "me" }) });
      Object.assign(stores.ChannelStore, { getChannel: (id: string) => (id === "99" ? { id: "99", name: "general" } : undefined) });
      installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore, ...extra]);
      const received = listen();
      discordStoreBridge(EVENT, 1000, 1);
      if (change) {
        change(stores);
        stores.ChannelStore.change();
        vi.advanceTimersByTime(300);
      }
      return (received as { id: string; preview?: string }[][]).map((dms) => Object.fromEntries(dms.map((d) => [d.id, d.preview])));
    }

    it("reads only loaded last messages, by the channel's lastMessageId", () => {
      const lookups: string[][] = [];
      const [result] = previews([messageStore({ "100": { content: "hi there" } }, lookups)]);
      expect(result).toEqual({ "100": "hi there", "200": undefined, "300": undefined, "500": undefined });
      // Channel 300 has no last message to look up at all.
      expect(lookups).toEqual([["100", LAST["100"]], ["200", LAST["200"]], ["500", "junk"]]);
    });

    it("turns Discord's markup into plain text, keeping spoilers hidden", () => {
      const content =
        "# **Hi** <@42>, see <#99> and <#5> at `8` ||secret plans|| <:wave:123> <a:dance:456> [link](https://x.y) <https://a.b/c>\n" +
        "> ~~old~~ _it_ snake_case_name *em* ***both*** __under__ <@&7> </ping:1> <@!9>\n- item\n-# small\n```js\ncode()\n```";
      const [result] = previews([messageStore({ "100": { content } })]);
      expect(result!["100"]).toBe(
        "Hi @Ana, see #general and #channel at 8 ▒▒▒ :wave: :dance: link https://a.b/c old it snake_case_name em both under @role /ping @Unknown user item small code()",
      );
    });

    it("shows Discord timestamps as dates", () => {
      const [result] = previews([messageStore({ "100": { content: "due <t:1700000000:R>, not <t:9999999999999>" } })]);
      expect(result!["100"]).toBe(`due ${new Date(1_700_000_000_000).toLocaleDateString()}, not <t:9999999999999>`);
    });

    it("names the author in group DMs, and you as You", () => {
      const author = { id: "u2", username: "bo" };
      const [first, second] = previews([messageStore({ "100": { content: "one", author }, "200": { content: "two", author } })], (stores) => {
        Object.assign(stores.UserStore, { getCurrentUser: () => ({ id: "u2" }) });
      });
      expect(first).toMatchObject({ "100": "one", "200": "bo: two" });
      expect(second).toMatchObject({ "100": "one", "200": "You: two" });
    });

    it("labels messages without text by what they hold", () => {
      const cases: [unknown, string | undefined][] = [
        [{ content: "", stickerItems: [{ name: "Wave" }] }, "Sticker"],
        [{ content: "", sticker_items: [{ name: "Wave" }] }, "Sticker"],
        [{ content: "", attachments: [{ filename: "plan.pdf" }] }, "📎 plan.pdf"],
        [{ content: "", attachments: [{}] }, "📎 Attachment"],
        [{ content: "", attachments: [{ filename: "a" }, { filename: "b" }] }, "📎 2 attachments"],
        [{ content: "", embeds: [{ title: "A video" }] }, "🔗 A video"],
        [{ content: "", embeds: [{}] }, "Embed"],
        [{ content: "", type: 3 }, "📞 Call"],
        [{ content: "   " }, undefined],
        [{}, undefined],
        ["not a message", undefined],
      ];
      for (const [message, expected] of cases) {
        const [result] = previews([messageStore({ "100": message })]);
        expect(result!["100"], JSON.stringify(message)).toBe(expected);
      }
      const [group] = previews([messageStore({ "200": { content: "", attachments: [{ filename: "x.png" }], author: { username: "cy" } } })]);
      expect(group!["200"]).toBe("cy: 📎 x.png");
    });

    it("strips control and bidirectional characters and caps the length", () => {
      const [result] = previews([
        messageStore({
          "100": { content: "a\u202eb\u0000c\u2066d\u200f\u0085e\tf" },
          "200": { content: "x".repeat(500), author: { username: "bo" } },
        }),
      ]);
      expect(result!["100"]).toBe("abcde f");
      expect(result!["200"]).toHaveLength(200);
      expect(result!["200"]).toMatch(/^bo: x+…$/);
    });

    it("falls back to the cached message list, never fetching", () => {
      const list = (last: unknown) => ({ last: () => last });
      const byChannel: Record<string, unknown> = { "100": list({ id: LAST["100"], content: "from the list" }), "200": list({ id: "1", content: "older" }) };
      const [result] = previews([store("MessageStore", { getMessages: (id: string) => byChannel[id] })]);
      expect(result).toMatchObject({ "100": "from the list", "200": undefined });
    });

    it("shows no previews while Discord's own streamer mode is on", () => {
      const streamer = store("StreamerModeStore", { enabled: true });
      const [on, off] = previews([messageStore({ "100": { content: "secret" } }), streamer], () => {
        Object.assign(streamer, { enabled: false });
      });
      expect(on!["100"]).toBeUndefined();
      expect(off!["100"]).toBe("secret");
    });

    it("leaves previews out, and reports it, when MessageStore is missing or broken", () => {
      const stores = listen("stores");
      const [missing] = previews([]);
      expect(Object.values(missing!)).toEqual([undefined, undefined, undefined, undefined]);
      expect(stores[0]).not.toContain("MessageStore");

      const throwing = store("MessageStore", {
        getMessage: () => {
          throw new Error("changed shape");
        },
      });
      const [broken] = previews([throwing]);
      expect(Object.keys(broken!)).toEqual(["100", "200", "300", "500"]);
      expect(Object.values(broken!)).toEqual([undefined, undefined, undefined, undefined]);
      expect(stores.at(-1)).toContain("MessageStore");
    });
  });

  describe("guild names", () => {
    const guildStore = (guilds: unknown) => store("GuildStore", { getGuilds: () => guilds });

    it("reads names and icons from GuildStore", () => {
      const stores = discordStores();
      installWebpack([
        stores.ChannelStore,
        stores.ReadStateStore,
        stores.UserStore,
        guildStore({
          "1": { id: "1", name: "Gaming Club", icon: "abc" },
          "2": { id: "2", name: "No Icon" },
          "3": { id: "3" }, // nameless: skipped
          "4": null,
        }),
      ]);
      const received = listen("guilds");
      discordStoreBridge(EVENT, 1000, 1);
      expect(received).toEqual([
        [
          { id: "1", name: "Gaming Club", iconUrl: "https://cdn.discordapp.com/icons/1/abc.png?size=96" },
          { id: "2", name: "No Icon" },
        ],
      ]);
    });

    it("still sends DMs when GuildStore is missing or broken", () => {
      const stores = discordStores();
      installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
      const guilds = listen("guilds");
      const dms = listen("dms");
      discordStoreBridge(EVENT, 1000, 1);

      const broken = discordStores();
      const throwing = store("GuildStore", {
        getGuilds: () => {
          throw new Error("changed shape");
        },
      });
      installWebpack([broken.ChannelStore, broken.ReadStateStore, broken.UserStore, throwing]);
      discordStoreBridge(EVENT, 1000, 1);

      installWebpack([broken.ChannelStore, broken.ReadStateStore, broken.UserStore, store("GuildStore", {})]);
      discordStoreBridge(EVENT, 1000, 1);

      expect(guilds).toEqual([[], [], []]);
      expect((dms as unknown[][]).map((d) => d.length)).toEqual([4, 4, 4]);
    });
  });
  describe("guild layout", () => {
    function layoutStores(folders: unknown, extra: unknown[] = []) {
      const stores = discordStores();
      installWebpack([
        stores.ChannelStore,
        stores.ReadStateStore,
        stores.UserStore,
        store("SortedGuildStore", { getGuildFolders: () => folders }),
        ...extra,
      ]);
    }

    it("reads folders, colours and expanded state in bar order", () => {
      layoutStores(
        [
          { guildIds: ["1"] },
          { folderId: 4242, folderName: "Games", folderColor: 0x00ff7f, guildIds: ["2", "3", 7] },
          { folderId: 99, folderName: null, guildIds: ["4"] },
          { folderId: -1, guildIds: ["5"] }, // unusable id: guilds become lone guilds
          null,
          { folderId: 1, guildIds: "nope" },
        ],
        [store("ExpandedGuildFolderStore", { isFolderExpanded: (id: number) => (id === 4242 ? true : undefined) })],
      );
      const received = listen("layout");
      discordStoreBridge(EVENT, 1000, 1);
      expect(received).toEqual([
        [
          { guildIds: ["1"] },
          { folderId: "4242", name: "Games", color: "#00ff7f", expanded: true, guildIds: ["2", "3"] },
          { folderId: "99", guildIds: ["4"] },
          { guildIds: ["5"] },
        ],
      ]);
    });

    it("omits the layout when SortedGuildStore is missing or broken", () => {
      const stores = discordStores();
      installWebpack([stores.ChannelStore, stores.ReadStateStore, stores.UserStore]);
      const received = listen("layout");
      discordStoreBridge(EVENT, 1000, 1);
      layoutStores(undefined);
      discordStoreBridge(EVENT, 1000, 1);
      const throwing = () => {
        throw new Error("changed");
      };
      const broken = discordStores();
      installWebpack([
        broken.ChannelStore,
        broken.ReadStateStore,
        broken.UserStore,
        store("SortedGuildStore", { getGuildFolders: throwing }),
      ]);
      discordStoreBridge(EVENT, 1000, 1);
      expect(received).toEqual([undefined, [], undefined]);
    });

    it("adds guild read state when GuildReadStateStore offers it", () => {
      const stores = discordStores();
      installWebpack([
        stores.ChannelStore,
        stores.ReadStateStore,
        stores.UserStore,
        store("GuildStore", { getGuilds: () => ({ 1: { id: "1", name: "A" }, 2: { id: "2", name: "B" } }) }),
        store("GuildReadStateStore", {
          hasUnread: (id: string) => (id === "1" ? true : "maybe"),
          getMentionCount: (id: string) => (id === "1" ? 3 : -1),
        }),
      ]);
      const received = listen("guilds");
      discordStoreBridge(EVENT, 1000, 1);
      expect(received).toEqual([
        [
          { id: "1", name: "A", unread: true, mentions: 3 },
          { id: "2", name: "B" },
        ],
      ]);
    });
  });
});
