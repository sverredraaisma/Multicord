import { describe, expect, it, vi } from "vitest";
import { createNativeApi } from "../../src/preload/native";
import {
  customEmojiList,
  emojiUrls,
  gifResults,
  isShownUrl,
  MAX_CUSTOM_EMOJI,
  MAX_GIF_QUERY,
  MAX_GIF_RESULTS,
  MAX_PACK_STICKERS,
  MAX_STICKER_PACKS,
  MAX_STICKERS,
  stickerPacks,
} from "../../src/shared/native";
import { channelCan, isNativeAction, MAX_ABOUT_LENGTH, MAX_JOIN_ADDRESS, MAX_THREAD_MESSAGES, threadSummary, threadView, MAX_EMBED_DESCRIPTION, MAX_EMBED_TITLE, MAX_EMBEDS, messageEmbeds, MAX_MEMBER_OFFSET, MAX_MEMBER_SECTIONS, MAX_MENTION_TEXT, MAX_MESSAGE_LENGTH, MAX_PROFILE_ROLES, MEMBER_ROWS_SHOWN, MAX_LISTED_MESSAGES, MAX_SEARCH_QUERY, MAX_POLL_OPTIONS, memberList, memberProfile, mentionText, messageList, messagePoll, NATIVE_IPC, searchResults, unreadMarker } from "../../src/shared/native";

describe("isNativeAction", () => {
  it("accepts well-formed actions", () => {
    for (const action of [
      { type: "ready" },
      { type: "cancelMfa" },
      { type: "loadOlder" },
      { type: "typing" },
      { type: "logout" },
      { type: "login", identity: "a@b.c", password: "pw" },
      { type: "mfa", code: "123456" },
      { type: "select", channelId: "123" },
      { type: "send", content: "hi" },
      { type: "send", content: "" },
      { type: "attach" },
      { type: "removeAttachment", index: 0 },
      { type: "send", content: "x".repeat(MAX_MESSAGE_LENGTH) },
    ]) {
      expect(isNativeAction(action)).toBe(true);
    }
  });

  it("rejects malformed actions", () => {
    for (const action of [
      null,
      "login",
      { type: "unknown" },
      { type: "login", identity: "", password: "pw" },
      { type: "login", identity: "a", password: "x".repeat(1025) },
      { type: "login", identity: "x".repeat(321), password: "pw" },
      { type: "mfa", code: "" },
      { type: "mfa", code: 123456 },
      { type: "select", channelId: "../x" },
      { type: "select" },
      { type: "send", content: 5 },
      { type: "removeAttachment", index: 10 },
      { type: "removeAttachment", index: 1.5 },
      { type: "removeAttachment" },
      { type: "send", content: "x".repeat(MAX_MESSAGE_LENGTH + 1) },
    ]) {
      expect(isNativeAction(action)).toBe(false);
    }
  });
});

describe("createNativeApi", () => {
  it("relays state in and actions out", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc = { send: vi.fn(), on: (c: string, l: (e: unknown, p: unknown) => void) => listeners.set(c, l) };
    const api = createNativeApi(ipc);
    const onState = vi.fn();
    api.onState(onState);
    listeners.get(NATIVE_IPC.state)!(null, { screen: "connecting", platform: "Fluxer", status: "x" });
    expect(onState).toHaveBeenCalledWith({ screen: "connecting", platform: "Fluxer", status: "x" });
    api.act({ type: "logout" });
    expect(ipc.send).toHaveBeenCalledWith(NATIVE_IPC.action, { type: "logout" });
  });
});

describe("message action validation", () => {
  it("validates replies, edits, deletes and reactions", () => {
    expect(isNativeAction({ type: "send", content: "hi", replyTo: "5" })).toBe(true);
    expect(isNativeAction({ type: "send", content: "hi", replyTo: "x" })).toBe(false);
    expect(isNativeAction({ type: "edit", messageId: "5", content: "new" })).toBe(true);
    expect(isNativeAction({ type: "edit", messageId: "5", content: " " })).toBe(false);
    expect(isNativeAction({ type: "edit", messageId: "x", content: "new" })).toBe(false);
    expect(isNativeAction({ type: "delete", messageId: "5" })).toBe(true);
    expect(isNativeAction({ type: "delete" })).toBe(false);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "👍", add: true })).toBe(true);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "party:55", add: false })).toBe(true);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "", add: true })).toBe(false);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "x".repeat(65), add: true })).toBe(false);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "👍" })).toBe(false);
  });
});

describe("forum post validation", () => {
  it("requires a title and a first message", () => {
    expect(isNativeAction({ type: "createPost", name: "Idea", content: "body" })).toBe(true);
    expect(isNativeAction({ type: "createPost", name: " ", content: "body" })).toBe(false);
    expect(isNativeAction({ type: "createPost", name: "x".repeat(101), content: "body" })).toBe(false);
    expect(isNativeAction({ type: "createPost", name: "Idea", content: "" })).toBe(false);
  });
});

describe("unreadMarker", () => {
  const messages = [{ id: "1" }, { id: "2" }];
  it("places the first unread message only among the loaded ones, and takes sane counts", () => {
    expect(unreadMarker(undefined, messages)).toBeUndefined();
    expect(unreadMarker("x", messages)).toBeUndefined();
    expect(unreadMarker({ firstId: "2", count: 3 }, messages)).toEqual({ firstId: "2", count: 3 });
    expect(unreadMarker({ firstId: "9", count: 0 }, messages)).toEqual({});
    expect(unreadMarker({ firstId: 2, count: 1.5 }, messages)).toEqual({});
    expect(unreadMarker({ count: 5_000_000 }, messages)).toEqual({ count: 1_000_000 });
  });
});

describe("mute actions", () => {
  it("take a conversation id and whether to mute", () => {
    expect(isNativeAction({ type: "mute", channelId: "5", mute: true })).toBe(true);
    expect(isNativeAction({ type: "mute", channelId: "5", mute: false })).toBe(true);
    expect(isNativeAction({ type: "mute", channelId: "x", mute: true })).toBe(false);
    expect(isNativeAction({ type: "mute", channelId: "5", mute: "yes" })).toBe(false);
    expect(isNativeAction({ type: "mute", channelId: "5" })).toBe(false);
  });
});

describe("voice action validation", () => {
  it("validates joins, toggles and errors", () => {
    expect(isNativeAction({ type: "joinVoice", channelId: "5" })).toBe(true);
    expect(isNativeAction({ type: "joinVoice", channelId: "x" })).toBe(false);
    expect(isNativeAction({ type: "leaveVoice" })).toBe(true);
    expect(isNativeAction({ type: "voiceState", mute: true, deaf: false, video: false, stream: false })).toBe(true);
    expect(isNativeAction({ type: "voiceState", mute: true, deaf: false, video: false })).toBe(false);
    expect(isNativeAction({ type: "voiceError", message: "ICE failed" })).toBe(true);
    expect(isNativeAction({ type: "voiceError", message: "" })).toBe(false);
    expect(isNativeAction({ type: "voiceNotice", message: "No camera" })).toBe(true);
    expect(isNativeAction({ type: "voiceNotice", message: "No camera", off: "video" })).toBe(true);
    expect(isNativeAction({ type: "voiceNotice", message: "No screen", off: "stream" })).toBe(true);
    expect(isNativeAction({ type: "voiceNotice", message: "x", off: "mute" })).toBe(false);
    expect(isNativeAction({ type: "voiceNotice", message: "" })).toBe(false);
  });
});

describe("prompt actions", () => {
  it("accepts answers to a prompt step and rejects malformed ones", () => {
    expect(isNativeAction({ type: "prompt", id: "phone", values: { phone: "+31 6 1234" } })).toBe(true);
    expect(isNativeAction({ type: "prompt", id: "api-id", values: {} })).toBe(true);
    expect(isNativeAction({ type: "cancelPrompt", id: "code" })).toBe(true);
    for (const bad of [
      { type: "prompt", id: "Phone", values: {} },
      { type: "prompt", id: "phone", values: null },
      { type: "prompt", id: "phone", values: [] },
      { type: "prompt", id: "phone", values: { "bad name": "x" } },
      { type: "prompt", id: "phone", values: { phone: 5 } },
      { type: "prompt", id: "phone", values: { phone: "x".repeat(1025) } },
      { type: "prompt", id: "phone", values: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, "x"])) },
      { type: "cancelPrompt", id: "" },
    ]) {
      expect(isNativeAction(bad)).toBe(false);
    }
  });
});

describe("Stoat ids in actions", () => {
  it("accepts ULIDs as well as snowflakes, and nothing looser", () => {
    const ulid = "01HZ0000000000000000000111";
    expect(isNativeAction({ type: "select", channelId: ulid })).toBe(true);
    expect(isNativeAction({ type: "send", content: "x", replyTo: ulid })).toBe(true);
    expect(isNativeAction({ type: "react", messageId: ulid, emoji: ulid, add: true })).toBe(true);
    expect(isNativeAction({ type: "select", channelId: ulid.toLowerCase() })).toBe(false);
    expect(isNativeAction({ type: "select", channelId: `${ulid}0` })).toBe(false);
    expect(isNativeAction({ type: "select", channelId: "01HZ000000000000000000011I" })).toBe(false);
  });
});

describe("media requests", () => {
  it("accepts plain media keys only", () => {
    expect(isNativeAction({ type: "loadMedia", key: "tg:123:456" })).toBe(true);
    for (const key of ["", "a b", "<x>", "k".repeat(201), 5]) expect(isNativeAction({ type: "loadMedia", key })).toBe(false);
  });
});

describe("conversation capability flags", () => {
  it("turns a flag on only when it is exactly true", () => {
    const none = { reply: false, react: false, attach: false, typing: false, members: false, stickers: false, gifs: false, pins: false, search: false, forward: false, threads: false };
    const all = { reply: true, react: true, attach: true, typing: true, members: true, stickers: true, gifs: true, pins: true, search: true, forward: true, threads: true };
    expect(channelCan(all)).toEqual(all);
    expect(channelCan({ reply: true, react: "yes", attach: 1, members: "true", stickers: "yes", extra: true })).toEqual({ ...none, reply: true });
    for (const value of [undefined, null, "all", 5]) expect(channelCan(value)).toEqual(none);
  });
});

describe("member panel actions", () => {
  it("validates opening, closing and paging", () => {
    expect(isNativeAction({ type: "members", open: true })).toBe(true);
    expect(isNativeAction({ type: "members", open: false })).toBe(true);
    expect(isNativeAction({ type: "members", open: "yes" })).toBe(false);
    expect(isNativeAction({ type: "members" })).toBe(false);
    expect(isNativeAction({ type: "loadMembers", offset: 0 })).toBe(true);
    expect(isNativeAction({ type: "loadMembers", offset: MAX_MEMBER_OFFSET })).toBe(true);
    for (const offset of [-1, 1.5, MAX_MEMBER_OFFSET + 1, "5", undefined]) expect(isNativeAction({ type: "loadMembers", offset })).toBe(false);
  });
});

describe("mentionText", () => {
  it("takes one line of plain text within the cap", () => {
    expect(mentionText("<@123>")).toBe("<@123>");
    expect(mentionText("@ana:example.org")).toBe("@ana:example.org");
    expect(mentionText("x".repeat(MAX_MENTION_TEXT))).toBe("x".repeat(MAX_MENTION_TEXT));
  });

  it("refuses anything else", () => {
    const char = (code: number) => String.fromCharCode(code);
    for (const value of [undefined, 5, "", "  ", "x".repeat(MAX_MENTION_TEXT + 1), "a\nb", `a${char(0)}b`, `a${char(0x202e)}b`, `a${char(0x200b)}b`, `a${char(0x2028)}b`]) {
      expect(mentionText(value)).toBeUndefined();
    }
  });
});

describe("memberList", () => {
  const ana = { id: "1", name: "Ana" };

  it("has no list without an object", () => {
    for (const value of [undefined, null, "list", 5, []]) expect(memberList(value)).toBeUndefined();
  });

  it("keeps well-formed rows and sections, with their optional fields", () => {
    const row = { id: "@ana:example.org", name: "Ana", avatarUrl: "https://x/a.png", presence: "dnd", color: "#AABBCC", status: "Busy", mention: "<@1>" };
    expect(memberList({ sections: [{ name: "Admins", members: [row] }], more: 12, hasMore: true, loading: true, error: "Partly" })).toEqual({
      sections: [{ name: "Admins", members: [row] }],
      more: 12,
      hasMore: true,
      loading: true,
      error: "Partly",
    });
    expect(memberList({})).toEqual({ sections: [], hasMore: false, loading: false });
  });

  it("drops malformed rows, sections and fields, and cuts long texts", () => {
    const list = memberList({
      sections: [
        { name: "", members: [ana] },
        { name: "Empty", members: [] },
        { name: "No rows", members: "Ana" },
        null,
        {
          name: "x".repeat(150),
          members: [
            null,
            { id: "bad id", name: "Bo" },
            { id: "2", name: " " },
            { id: "3", name: "y".repeat(150), avatarUrl: "", presence: "away", color: "red", status: 5 },
            ana,
          ],
        },
      ],
      more: -3,
      hasMore: "yes",
      loading: 1,
      error: "",
    })!;
    expect(list.sections).toHaveLength(1);
    expect(list.sections[0]!.name).toHaveLength(100);
    expect(list.sections[0]!.members).toEqual([{ id: "3", name: "y".repeat(100) }, ana]);
    expect(list).toMatchObject({ hasMore: false, loading: false });
    expect(list.more).toBeUndefined();
    expect(list.error).toBeUndefined();
  });

  it("shows at most MEMBER_ROWS_SHOWN rows in MAX_MEMBER_SECTIONS sections, counting the rest, and asks for no further pages then", () => {
    const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), name: `M${from + i}` }));
    const list = memberList({ sections: [{ name: "A", members: rows(150) }, { name: "B", members: rows(100, 150) }], more: 10, hasMore: true, loading: false })!;
    expect(list.sections.map((s) => s.members.length)).toEqual([150, MEMBER_ROWS_SHOWN - 150]);
    expect(list.more).toBe(10 + 250 - MEMBER_ROWS_SHOWN);
    expect(list.hasMore).toBe(false);
    const many = memberList({ sections: Array.from({ length: 30 }, (_, i) => ({ name: `S${i}`, members: rows(1, i) })), hasMore: true })!;
    expect(many.sections).toHaveLength(MAX_MEMBER_SECTIONS);
    expect(many.hasMore).toBe(true);
    expect(memberList({ sections: [], more: 1e12 })!.more).toBe(100_000_000);
  });
});

describe("profiles", () => {
  it("asks for a profile by a plain member id", () => {
    for (const id of ["123", "01HZ0000000000000000000111", "@ana:example.org", "a/b+c=d"]) expect(isNativeAction({ type: "profile", id })).toBe(true);
    for (const id of ["", "a b", "<x>", "x".repeat(256), 5, undefined]) expect(isNativeAction({ type: "profile", id })).toBe(false);
  });

  it("trusts a profile only with a usable id, keeping well-formed fields", () => {
    for (const value of [undefined, null, [], { id: "bad id" }, { name: "Ana" }]) expect(memberProfile(value)).toBeUndefined();
    const full = { id: "5", name: "Ana", avatarUrl: "data:image/png;base64,x", presence: "idle", status: "Away", username: "@ana", about: "Hi\nthere", roles: [{ name: "Admin", color: "#00ff00" }, { name: "Mod" }], loading: true };
    expect(memberProfile(full)).toEqual(full);
    expect(memberProfile({ id: "5" })).toEqual({ id: "5" });
  });

  it("drops malformed fields and cuts long texts and role lists", () => {
    const profile = memberProfile({
      id: "5",
      name: " ",
      avatarUrl: 5,
      presence: "busy",
      status: "",
      username: null,
      about: "a".repeat(MAX_ABOUT_LENGTH + 50),
      roles: [null, { name: "" }, { name: "Admin", color: "green" }, ...Array.from({ length: 30 }, (_, i) => ({ name: `R${i}` }))],
      loading: "yes",
    })!;
    expect(profile.about).toHaveLength(MAX_ABOUT_LENGTH);
    expect(profile.roles![0]).toEqual({ name: "Admin" });
    expect(profile.roles).toHaveLength(MAX_PROFILE_ROLES - 2);
    expect(Object.keys(profile).sort()).toEqual(["about", "id", "roles"]);
    expect(memberProfile({ id: "5", roles: "Admin" })).toEqual({ id: "5" });
  });
});

describe("stickers, emoji and GIFs", () => {
  it("validates sticker and GIF search actions", () => {
    expect(isNativeAction({ type: "sendSticker", stickerId: "123" })).toBe(true);
    expect(isNativeAction({ type: "sendSticker", stickerId: "tg:set:5", replyTo: "9" })).toBe(true);
    expect(isNativeAction({ type: "sendSticker", stickerId: "a b" })).toBe(false);
    expect(isNativeAction({ type: "sendSticker", stickerId: "1", replyTo: "x" })).toBe(false);
    expect(isNativeAction({ type: "searchGifs", query: "" })).toBe(true);
    expect(isNativeAction({ type: "searchGifs", query: "x".repeat(MAX_GIF_QUERY + 1) })).toBe(false);
    expect(isNativeAction({ type: "loadMedia", key: "tg:doc:5" })).toBe(true);
    expect(isNativeAction({ type: "picker", open: true })).toBe(true);
    expect(isNativeAction({ type: "picker", open: "yes" })).toBe(false);
  });

  it("shows media only from https or data: pictures and videos", () => {
    expect(isShownUrl("https://cdn.example/a.webp")).toBe(true);
    expect(isShownUrl("data:image/webp;base64,AAAA")).toBe(true);
    expect(isShownUrl("data:video/webm;base64,AAAA")).toBe(true);
    for (const url of ["http://cdn.example/a", "javascript:alert(1)", "data:text/html;base64,AA", "https://a b", 5]) expect(isShownUrl(url)).toBe(false);
  });

  it("trusts custom emoji only with an id, a name and a picture", () => {
    const list = customEmojiList(
      [
        { id: "55", name: "party", animated: false, source: "Cats" },
        { id: "56", name: "dance", animated: true, url: "https://cdn.example/56.gif", text: ":dance:", key: "dance", react: false },
        { id: "57", name: "bad name" },
        { id: "../x", name: "x" },
        { id: "58", name: "long", text: "x".repeat(201), key: "k".repeat(65) },
        { id: "59", name: "evil", url: "javascript:alert(1)" },
        { id: "60", name: "spin", animated: true },
        null,
      ],
      "https://media.example/emojis",
    );
    expect(list).toEqual([
      { id: "55", name: "party", animated: false, url: "https://media.example/emojis/55.webp?size=48", text: "<:party:55>", key: "party:55", react: true, source: "Cats" },
      { id: "56", name: "dance", animated: true, url: "https://cdn.example/56.gif", text: ":dance:", key: "dance", react: false },
      { id: "58", name: "long", animated: false, url: "https://media.example/emojis/58.webp?size=48", text: "<:long:58>", key: "long:58", react: false },
      { id: "59", name: "evil", animated: false, url: "https://media.example/emojis/59.webp?size=48", text: "<:evil:59>", key: "evil:59", react: true },
      { id: "60", name: "spin", animated: true, url: "https://media.example/emojis/60.gif?size=48", text: "<a:spin:60>", key: "spin:60", react: true },
    ]);
    // Without a picture of its own or a base, nothing shows.
    expect(customEmojiList([{ id: "55", name: "party" }])).toEqual([]);
    expect(customEmojiList([{ id: "55", name: "party" }], "javascript:x")).toEqual([]);
    expect(customEmojiList("nope")).toEqual([]);
    expect(customEmojiList(Array.from({ length: MAX_CUSTOM_EMOJI + 5 }, (_, i) => ({ id: String(i), name: "e", url: "https://x/e.png" })))).toHaveLength(MAX_CUSTOM_EMOJI);
  });

  it("trusts emoji pictures only by plain id, from https or data: pictures", () => {
    expect([...emojiUrls({ "01ARZ3NDEKTSV4RRFFQ69G5FAV": "https://cdn/a.webp", "x.org/m": "data:image/png;base64,AA", "a b": "https://x", bad: "javascript:1" })]).toEqual([
      ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "https://cdn/a.webp"],
      ["x.org/m", "data:image/png;base64,AA"],
    ]);
    expect(emojiUrls(undefined).size).toBe(0);
    const many = Object.fromEntries(Array.from({ length: MAX_CUSTOM_EMOJI + 3 }, (_, i) => [`e${i}`, "https://x/e.png"]));
    expect(emojiUrls(many).size).toBe(MAX_CUSTOM_EMOJI);
  });

  it("trusts sticker packs only with whole stickers, within the caps", () => {
    const packs = stickerPacks([
      {
        id: "p1",
        name: "Cats",
        stickers: [
          { id: "s1", name: "Wave", format: "webp", url: "https://cdn.example/s1.webp", emoji: "👋" },
          { id: "s2", emoji: "😺", format: "lottie", mediaKey: "tg:thumb:2" },
          { id: "s3", name: "Bad", format: "svg", url: "https://cdn.example/s3.svg" },
          { id: "s4", name: "Nowhere", format: "png" },
          { id: "s5", name: "Evil", format: "png", url: "javascript:alert(1)" },
          { id: "a b", name: "Space", format: "png", url: "https://cdn.example/x.png" },
          "junk",
        ],
      },
      { id: "p2", name: "Empty", stickers: [] },
      { id: "p3", name: "", stickers: [{ id: "s", name: "s", format: "png", url: "https://x/s.png" }] },
      { id: "p4", name: "No list" },
      null,
    ]);
    expect(packs).toEqual([
      {
        id: "p1",
        name: "Cats",
        stickers: [
          { id: "s1", name: "Wave", format: "webp", url: "https://cdn.example/s1.webp", emoji: "👋" },
          { id: "s2", name: "😺", format: "lottie", mediaKey: "tg:thumb:2", emoji: "😺" },
        ],
      },
    ]);
    expect(stickerPacks(undefined)).toEqual([]);
    const sticker = (i: number) => ({ id: `s${i}`, name: "s", format: "png", url: "https://x/s.png" });
    const big = Array.from({ length: MAX_STICKER_PACKS + 10 }, (_, p) => ({ id: `p${p}`, name: "P", stickers: Array.from({ length: MAX_PACK_STICKERS + 1 }, (_, i) => sticker(i)) }));
    const capped = stickerPacks(big);
    expect(capped[0]!.stickers).toHaveLength(MAX_PACK_STICKERS);
    expect(capped.reduce((n, p) => n + p.stickers.length, 0)).toBe(MAX_STICKERS);
  });

  it("trusts GIF results only with https addresses", () => {
    expect(gifResults(undefined)).toBeUndefined();
    expect(
      gifResults({
        query: "cats",
        loading: true,
        error: "Rate limited",
        results: [
          { id: "g1", url: "https://gifs.example/g1", preview: "https://media.example/g1.mp4", video: true, width: 10000, height: 200, name: "Cat" },
          { id: "g2", url: "https://gifs.example/g2", preview: "https://media.example/g2.gif", width: 0 },
          { id: "g3", url: "http://gifs.example/g3", preview: "https://media.example/g3.gif" },
          { id: "g4", url: "https://gifs.example/g4", preview: "data:image/gif;base64,AA" },
          null,
        ],
      }),
    ).toEqual({
      query: "cats",
      loading: true,
      error: "Rate limited",
      results: [
        { id: "g1", url: "https://gifs.example/g1", preview: "https://media.example/g1.mp4", video: true, width: 4096, height: 200, name: "Cat" },
        { id: "g2", url: "https://gifs.example/g2", preview: "https://media.example/g2.gif", video: false },
      ],
    });
    expect(gifResults({ query: 5, results: "no" })).toEqual({ query: "", results: [], loading: false });
    const many = Array.from({ length: MAX_GIF_RESULTS + 3 }, (_, i) => ({ id: `g${i}`, url: "https://g/x", preview: "https://g/x.gif" }));
    expect(gifResults({ results: many })!.results).toHaveLength(MAX_GIF_RESULTS);
  });
});

describe("messageEmbeds", () => {
  it("keeps sane link previews, cut short and within the caps", () => {
    expect(messageEmbeds(undefined)).toEqual([]);
    expect(messageEmbeds([null, "x", {}, { url: "https://a.b/c" }])).toEqual([]);
    expect(
      messageEmbeds([
        {
          url: "https://a.b/c",
          site: "Site",
          title: "T".repeat(MAX_EMBED_TITLE + 5),
          description: "D".repeat(MAX_EMBED_DESCRIPTION + 5),
          color: "#ff0000",
          image: { url: "https://a.b/i.png", width: 10_000, height: 20, size: 5, thumbnail: true },
        },
      ]),
    ).toEqual([
      {
        url: "https://a.b/c",
        site: "Site",
        title: "T".repeat(MAX_EMBED_TITLE),
        description: "D".repeat(MAX_EMBED_DESCRIPTION),
        color: "#ff0000",
        image: { url: "https://a.b/i.png", width: 4096, height: 20, size: 5, thumbnail: true },
      },
    ]);
    // Links other than https, odd colours and pictures from elsewhere are left out.
    expect(messageEmbeds([{ url: "javascript:alert(1)", title: "x", color: "red", image: { url: "http://a/i.png" } }])).toEqual([{ title: "x" }]);
    expect(messageEmbeds([{ image: { mediaKey: "m:1", width: 5, thumbnail: "yes" } }])).toEqual([{ image: { mediaKey: "m:1" } }]);
    expect(messageEmbeds([{ title: "x", image: "no" }])).toEqual([{ title: "x" }]);
    const many = Array.from({ length: MAX_EMBEDS + 3 }, (_, i) => ({ title: `t${i}` }));
    expect(messageEmbeds(many)).toHaveLength(MAX_EMBEDS);
  });
});

describe("pins", () => {
  it("validates opening the panel and pinning messages", () => {
    expect(isNativeAction({ type: "pins", open: true })).toBe(true);
    expect(isNativeAction({ type: "pins", open: "yes" })).toBe(false);
    expect(isNativeAction({ type: "pin", messageId: "5", pin: false })).toBe(true);
    expect(isNativeAction({ type: "pin", messageId: "x", pin: true })).toBe(false);
    expect(isNativeAction({ type: "pin", messageId: "5" })).toBe(false);
  });

  it("keeps listed messages with an id, author and time, texts cut short", () => {
    expect(messageList(undefined)).toBeUndefined();
    expect(messageList({ messages: "x" })).toEqual({ messages: [], loading: false });
    const list = messageList({
      messages: [
        { id: "5", author: "Ana", content: "c".repeat(400), timestamp: "2026-10-14T12:00:00Z", avatarUrl: "https://a/b.png" },
        { id: "6", author: "Bo", timestamp: "t", content: 5, avatarUrl: "" },
        { id: "x", author: "Bad id", timestamp: "t" },
        { id: "7", author: " ", timestamp: "t" },
        { id: "8", author: "No time" },
        { id: "9", author: "Long time", timestamp: "t".repeat(41) },
        null,
      ],
      loading: true,
      error: "Failed",
      note: "Some note",
    })!;
    expect(list).toEqual({
      messages: [
        { id: "5", author: "Ana", content: "c".repeat(300), timestamp: "2026-10-14T12:00:00Z", avatarUrl: "https://a/b.png" },
        { id: "6", author: "Bo", content: "", timestamp: "t" },
      ],
      loading: true,
      error: "Failed",
      note: "Some note",
    });
    const many = Array.from({ length: MAX_LISTED_MESSAGES + 5 }, (_, i) => ({ id: String(i + 1), author: "A", timestamp: "t" }));
    expect(messageList({ messages: many })!.messages).toHaveLength(MAX_LISTED_MESSAGES);
  });
});

describe("search", () => {
  it("validates queries, an empty one ending the search", () => {
    expect(isNativeAction({ type: "search", query: "hello" })).toBe(true);
    expect(isNativeAction({ type: "search", query: "" })).toBe(true);
    expect(isNativeAction({ type: "search", query: "q".repeat(MAX_SEARCH_QUERY + 1) })).toBe(false);
    expect(isNativeAction({ type: "search" })).toBe(false);
  });

  it("reads results as a message list with their query", () => {
    expect(searchResults(undefined)).toBeUndefined();
    expect(searchResults({ query: "q".repeat(MAX_SEARCH_QUERY + 5), messages: [{ id: "5", author: "Ana", timestamp: "t" }], loading: false })).toEqual({
      query: "q".repeat(MAX_SEARCH_QUERY),
      messages: [{ id: "5", author: "Ana", content: "", timestamp: "t" }],
      loading: false,
    });
    expect(searchResults({ query: 5, loading: true })).toEqual({ query: "", messages: [], loading: true });
  });
});

describe("forwarding", () => {
  it("takes a message and a conversation of the same module", () => {
    expect(isNativeAction({ type: "forward", messageId: "5", channelId: "6" })).toBe(true);
    expect(isNativeAction({ type: "forward", messageId: "5", channelId: "!room:x.org" })).toBe(false);
    expect(isNativeAction({ type: "forward", messageId: "$e", channelId: "6" })).toBe(false);
  });
});

describe("threads", () => {
  it("validates opening and closing a thread, and sending into one", () => {
    expect(isNativeAction({ type: "thread" })).toBe(true);
    expect(isNativeAction({ type: "thread", rootId: "5" })).toBe(true);
    expect(isNativeAction({ type: "thread", rootId: "$root" })).toBe(false);
    expect(isNativeAction({ type: "send", content: "hi", thread: "5" })).toBe(true);
    expect(isNativeAction({ type: "send", content: "hi", thread: "x" })).toBe(false);
  });

  it("keeps sane summaries and threads", () => {
    for (const value of [undefined, { count: 0 }, { count: -1 }, { count: 1.5 }, { count: "3" }]) expect(threadSummary(value)).toBeUndefined();
    expect(threadSummary({ count: 3, latest: "Ana" })).toEqual({ count: 3, latest: "Ana" });
    expect(threadSummary({ count: 1e12, latest: " " })).toEqual({ count: 100_000_000 });
    expect(threadView(undefined)).toBeUndefined();
    expect(threadView({ rootId: "$root", messages: [] })).toBeUndefined();
    const message = (id: unknown) => ({ id, author: "Ana", content: "x", timestamp: "t", edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] });
    expect(threadView({ rootId: "5", messages: [message("5"), message("bad"), null, message("6")], loading: "yes", error: "E", note: " ", locked: "No" })).toEqual({
      rootId: "5",
      messages: [message("5"), message("6")],
      loading: false,
      error: "E",
      locked: "No",
    });
    const many = Array.from({ length: MAX_THREAD_MESSAGES + 2 }, (_, i) => message(String(i + 1)));
    const thread = threadView({ rootId: "1", messages: many, loading: true, note: "Latest only" })!;
    expect(thread.messages).toHaveLength(MAX_THREAD_MESSAGES);
    expect(thread.messages[0]!.id).toBe("3");
    expect(thread).toMatchObject({ loading: true, note: "Latest only" });
    expect(threadView({ rootId: "1", messages: "x" })).toEqual({ rootId: "1", messages: [], loading: false });
  });
});

describe("joining", () => {
  it("takes invitations to answer and addresses to join by, one word each", () => {
    expect(isNativeAction({ type: "join", channelId: "5" })).toBe(true);
    expect(isNativeAction({ type: "decline", channelId: "5" })).toBe(true);
    expect(isNativeAction({ type: "join", channelId: "!room:x.org" })).toBe(false);
    expect(isNativeAction({ type: "decline" })).toBe(false);
    expect(isNativeAction({ type: "joinAddress", address: "#room:x.org" })).toBe(true);
    expect(isNativeAction({ type: "joinAddress", address: "x".repeat(MAX_JOIN_ADDRESS) })).toBe(true);
    for (const address of ["", "a b", "a\nb", `a${String.fromCharCode(0x202e)}b`, "x".repeat(MAX_JOIN_ADDRESS + 1), 5]) expect(isNativeAction({ type: "joinAddress", address })).toBe(false);
  });
});

describe("polls", () => {
  it("validates votes: a message and distinct option ids, none taking the vote back", () => {
    expect(isNativeAction({ type: "vote", messageId: "5", options: ["a", "b-1"] })).toBe(true);
    expect(isNativeAction({ type: "vote", messageId: "5", options: [] })).toBe(true);
    expect(isNativeAction({ type: "vote", messageId: "5", options: ["a", "a"] })).toBe(false);
    expect(isNativeAction({ type: "vote", messageId: "5", options: ["a b"] })).toBe(false);
    expect(isNativeAction({ type: "vote", messageId: "5", options: "a" })).toBe(false);
    expect(isNativeAction({ type: "vote", messageId: "x", options: ["a"] })).toBe(false);
    expect(isNativeAction({ type: "vote", messageId: "5", options: Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => `o${i}`) })).toBe(false);
  });

  it("keeps sane polls with usable options", () => {
    expect(messagePoll(undefined)).toBeUndefined();
    expect(messagePoll({ question: " ", options: [{ id: "a", text: "A" }] })).toBeUndefined();
    expect(messagePoll({ question: "Q", options: "x" })).toBeUndefined();
    expect(messagePoll({ question: "Q", options: [{ id: "a b", text: "A" }] })).toBeUndefined();
    expect(
      messagePoll({
        question: "Q".repeat(400),
        options: [{ id: "a", text: "A", votes: 3, chosen: true, correct: true }, { id: "a", text: "again" }, { id: "b", text: "B", votes: -1, chosen: "yes" }, { id: "c" }, null],
        multiple: true,
        closed: "no",
        total: 7,
        canVote: true,
      }),
    ).toEqual({ question: "Q".repeat(300), options: [{ id: "a", text: "A", votes: 3, chosen: true, correct: true }, { id: "b", text: "B" }], multiple: true, closed: false, total: 7, canVote: true });
    expect(messagePoll({ question: "Q", options: [{ id: "a", text: "A" }], total: 1.5, closed: true })).toEqual({ question: "Q", options: [{ id: "a", text: "A" }], multiple: false, closed: true });
  });
});
