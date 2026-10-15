// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { avatar } from "../../src/renderer/components/avatar";
import { channelItem, channelList, folderTabs } from "../../src/renderer/components/channels";
import { countBadge, icon, initials, setColor } from "../../src/renderer/components/dom";
import { emojiPicker } from "../../src/renderer/components/emojiPicker";
import { memberPanel, memberRow, presenceAvatar, profileCard } from "../../src/renderer/components/members";
import { messageItem, type MessageHandlers } from "../../src/renderer/components/message";
import { matchMentions, MAX_MENTION_SUGGESTIONS, mentionCandidates, mentionOptions, mentionQuery } from "../../src/renderer/components/mentions";
import { isOwnReaction, quickReactions } from "../../src/renderer/components/reactions";
import { moduleLabel, serverIcon, serverTooltip } from "../../src/renderer/components/serverIcon";
import { pollForm } from "../../src/renderer/components/panels";
import { MAX_NEW_POLL_ANSWERS, type NativeMessage } from "../../src/shared/native";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("dom helpers", () => {
  it("builds icons, badges and colours", () => {
    expect(icon(document, "x", "M0 0").getAttribute("viewBox")).toBe("0 0 24 24");
    expect(countBadge(document, 0)).toBeNull();
    expect(countBadge(document, 150)!.textContent).toBe("99+");
    const div = document.createElement("div");
    setColor(div, "--c", undefined);
    expect(div.style.getPropertyValue("--c")).toBe("");
    setColor(div, "--c", "#fff");
    expect(div.style.getPropertyValue("--c")).toBe("#fff");
    expect(initials("ana bo")).toBe("AB");
  });

  it("falls back to initials for missing avatars", () => {
    expect(avatar(document, undefined, "Ana Bo").textContent).toBe("AB");
    expect(avatar(document, "https://a/b.png", "x").getAttribute("src")).toBe("https://a/b.png");
  });
});

describe("server icons", () => {
  it("shows the module label and names it in the tooltip", () => {
    const icon = serverIcon(document, {
      key: "fluxer:1",
      platform: "fluxer",
      kind: "server",
      name: "Alpha",
      unread: true,
      mentions: 3,
      module: { label: "Fluxer", color: "#4f8cf7" },
    });
    expect(icon.querySelector(".module-label")!.textContent).toBe("F");
    expect(icon.querySelector(".badge")!.textContent).toBe("3");
    expect(icon.dataset.tooltip).toBe("Alpha · Fluxer");
    expect(serverTooltip({ name: "Solo" })).toBe("Solo");
    expect(moduleLabel(document, { label: "Web", color: "#000" }).style.getPropertyValue("--module-color")).toBe("#000");
  });
});

describe("channel items", () => {
  it("shows categories as headings, or as buttons that fold their rows away where collapsible", () => {
    const category = { id: "c", name: "Archive", kind: "category" as const, unread: true, mentions: 4, active: false };
    const row = (id: string, active = false) => ({ id, name: id, kind: "dm" as const, unread: false, mentions: 0, active });
    const onFold = vi.fn();
    const handlers = { onSelect: vi.fn(), onJoinVoice: vi.fn(), onFold };
    const plain = channelItem(document, category, handlers);
    expect(plain.textContent).toBe("Archive");
    expect(plain.querySelector("button")).toBeNull();
    // Without a way to fold it, a collapsible category is a plain heading, and hides nothing.
    const items = [{ ...category, collapsible: true, collapsed: true }, row("a"), row("b", true), { ...category, id: "d", name: "Groups" }, row("c")];
    expect(channelItem(document, items[0]!, { onSelect: vi.fn(), onJoinVoice: vi.fn() }).querySelector("button")).toBeNull();
    expect(channelList(document, items, { onSelect: vi.fn(), onJoinVoice: vi.fn() })).toHaveLength(5);

    const open = channelItem(document, { ...category, collapsible: true }, handlers).querySelector<HTMLButtonElement>(".category-toggle")!;
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(open.dataset.id).toBe("c");
    expect(open.querySelector(".badge")).toBeNull();
    expect(open.classList.contains("unread")).toBe(false);
    open.click();
    expect(onFold).toHaveBeenCalledWith("c", true);

    const shut = channelItem(document, { ...category, collapsible: true, collapsed: true }, handlers).querySelector<HTMLButtonElement>(".category-toggle")!;
    expect(shut.getAttribute("aria-expanded")).toBe("false");
    expect(shut.querySelector(".badge")!.textContent).toBe("4");
    expect(shut.classList.contains("unread")).toBe(true);
    shut.click();
    expect(onFold).toHaveBeenLastCalledWith("c", false);
    // Folded rows go, except the open conversation, until the next category.
    const listed = channelList(document, items, handlers).map((li) => li.textContent);
    expect(listed).toEqual(["Archive4", "Bb", "Groups", "Cc"]);
  });

  it("selects text channels and joins voice channels", () => {
    const onSelect = vi.fn();
    const onJoinVoice = vi.fn();
    const text = channelItem(document, { id: "1", name: "general", kind: "text", unread: false, mentions: 0, active: false }, { onSelect, onJoinVoice });
    const voice = channelItem(document, { id: "2", name: "Lounge", kind: "voice", unread: false, mentions: 0, active: false }, { onSelect, onJoinVoice });
    text.querySelector("button")!.click();
    voice.querySelector("button")!.click();
    expect(onSelect).toHaveBeenCalledWith("1");
    expect(onJoinVoice).toHaveBeenCalledWith("2");
    expect(voice.querySelector(".voice-members")).toBeNull();
  });

  it("show muted conversations in words too, and offer a mute bell where the module can mute them", () => {
    const onMute = vi.fn();
    const handlers = { onSelect: vi.fn(), onJoinVoice: vi.fn(), onMute };
    const base = { id: "1", name: "Ana", kind: "dm" as const, unread: true, mentions: 0, active: false };
    const plain = channelItem(document, base, handlers);
    expect(plain.querySelector(".channel")!.classList.contains("muted")).toBe(false);
    expect(plain.querySelector(".muted-mark, .mute-toggle")).toBeNull();

    const muted = channelItem(document, { ...base, muted: true, canMute: true }, handlers);
    expect(muted.querySelector(".channel")!.classList.contains("muted")).toBe(true);
    expect(muted.querySelector(".muted-mark")!.getAttribute("aria-label")).toBe("Muted");
    const unmute = muted.querySelector<HTMLButtonElement>(".mute-toggle")!;
    expect(unmute.getAttribute("aria-pressed")).toBe("true");
    expect(unmute.getAttribute("aria-label")).toBe("Unmute Ana");
    unmute.click();
    expect(onMute).toHaveBeenLastCalledWith("1", false);

    const mute = channelItem(document, { ...base, canMute: true }, handlers).querySelector<HTMLButtonElement>(".mute-toggle")!;
    expect(mute.getAttribute("aria-label")).toBe("Mute Ana");
    mute.click();
    expect(onMute).toHaveBeenLastCalledWith("1", true);
    // Not offered without the module saying it can, or without a handler.
    expect(channelItem(document, { ...base, canMute: "yes" as unknown as boolean }, handlers).querySelector(".mute-toggle")).toBeNull();
    expect(channelItem(document, { ...base, canMute: true }, { onSelect: vi.fn(), onJoinVoice: vi.fn() }).querySelector(".mute-toggle")).toBeNull();
  });

  it("shows folder tabs with their unread state and mentions, the shown one pressed", () => {
    const onPick = vi.fn();
    const [all, work] = folderTabs(document, [{ id: "all", name: "All chats", active: true, unread: false, mentions: 0 }, { id: "f2", name: "Work", active: false, unread: true, mentions: 5 }], onPick);
    expect(all!.getAttribute("aria-pressed")).toBe("true");
    expect(all!.classList.contains("unread")).toBe(false);
    expect(all!.querySelector(".badge")).toBeNull();
    expect(work!.dataset.id).toBe("f2");
    expect(work!.getAttribute("aria-pressed")).toBe("false");
    expect(work!.classList.contains("unread")).toBe(true);
    expect(work!.textContent).toBe("Work5");
    work!.click();
    expect(onPick).toHaveBeenCalledWith("f2");
  });

  it("offers an archive button where the module can archive a conversation", () => {
    const onArchive = vi.fn();
    const handlers = { onSelect: vi.fn(), onJoinVoice: vi.fn(), onArchive };
    const base = { id: "1", name: "Ana", kind: "dm" as const, unread: false, mentions: 0, active: false };
    expect(channelItem(document, base, handlers).querySelector(".archive-toggle")).toBeNull();
    const row = channelItem(document, { ...base, canArchive: true }, handlers);
    expect(row.classList.contains("archivable")).toBe(true);
    const archive = row.querySelector<HTMLButtonElement>(".archive-toggle")!;
    expect(archive.getAttribute("aria-label")).toBe("Archive Ana");
    expect(archive.title).toBe("Archive");
    archive.click();
    expect(onArchive).toHaveBeenLastCalledWith("1", true);
    const unarchive = channelItem(document, { ...base, archived: true, canArchive: true }, handlers).querySelector<HTMLButtonElement>(".archive-toggle")!;
    expect(unarchive.getAttribute("aria-label")).toBe("Unarchive Ana");
    expect(unarchive.title).toBe("Move out of the archive");
    unarchive.click();
    expect(onArchive).toHaveBeenLastCalledWith("1", false);
    expect(channelItem(document, { ...base, canArchive: true }, { onSelect: vi.fn(), onJoinVoice: vi.fn() }).querySelector(".archive-toggle")).toBeNull();
  });

  it("offers to accept or decline invitations, and to join conversations open to the user", () => {
    const onJoin = vi.fn();
    const onDecline = vi.fn();
    const handlers = { onSelect: vi.fn(), onJoinVoice: vi.fn(), onJoin, onDecline };
    const base = { id: "7", name: "Book club", kind: "text" as const, unread: false, mentions: 0, active: false };
    const invite = channelItem(document, { ...base, invite: { from: "Ana" } }, handlers);
    expect(invite.classList.contains("offer")).toBe(true);
    expect(invite.querySelector(".channel")).toBeNull();
    expect(invite.querySelector(".offer-text")!.textContent).toBe("# Book clubInvited by Ana");
    invite.querySelector<HTMLButtonElement>('[aria-label="Accept Book club"]')!.click();
    invite.querySelector<HTMLButtonElement>('[aria-label="Decline Book club"]')!.click();
    expect(onJoin).toHaveBeenCalledWith("7");
    expect(onDecline).toHaveBeenCalledWith("7");
    // Without a name for who sent it, a DM invitation with the other person's picture.
    const dm = channelItem(document, { ...base, kind: "dm", name: "Bo", invite: { from: " " } }, handlers);
    expect(dm.querySelector(".offer-from")!.textContent).toBe("Invitation");
    expect(dm.querySelector(".avatar")).not.toBeNull();
    expect(channelItem(document, { ...base, invite: "x" as unknown as { from?: string } }, handlers).querySelector(".offer-from")).toBeNull();
    const open = channelItem(document, { ...base, joinable: true }, handlers);
    expect(open.querySelector(".offer-from")).toBeNull();
    expect([...open.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Join"]);
    open.querySelector("button")!.click();
    expect(onJoin).toHaveBeenLastCalledWith("7");
    // Without handlers, no buttons.
    expect(channelItem(document, { ...base, invite: {} }, { onSelect: vi.fn(), onJoinVoice: vi.fn() }).querySelectorAll("button")).toHaveLength(0);
  });
});

describe("reactions", () => {
  it("adds a more button only when asked and knows our own reactions", () => {
    const more = vi.fn();
    expect(quickReactions(document, [], vi.fn()).querySelector(".more")).toBeNull();
    quickReactions(document, [], vi.fn(), more).querySelector<HTMLButtonElement>(".more")!.click();
    expect(more).toHaveBeenCalled();
    const reactions = [{ key: "👍", label: "👍", count: 1, me: true }];
    expect(isOwnReaction(reactions, "👍")).toBe(true);
    expect(isOwnReaction(reactions, "🎉")).toBe(false);
  });
});

describe("messages", () => {
  const handlers = (): MessageHandlers => ({
    onReply: vi.fn(),
    onToggleReactionPicker: vi.fn(),
    onReact: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  });
  const message: NativeMessage = {
    id: "5",
    author: "Ana",
    content: "**hi** <:party:55> :joy:",
    timestamp: "2026-10-14T12:00:00Z",
    edited: false,
    mine: false,
    canEdit: false,
    canDelete: false,
    reactions: [],
    attachments: [],
  };

  it("shows a thread's summary, which opens it where the conversation has threads, and offers to open one", () => {
    const onOpenThread = vi.fn();
    const h = { ...handlers(), onOpenThread };
    const threads = { reply: true, react: true, threads: true };
    const item = messageItem(document, { ...message, thread: { count: 3, latest: "Bo" } }, h, { can: threads });
    const summary = item.querySelector<HTMLButtonElement>("button.thread-summary")!;
    expect(summary.textContent).toBe("3 replies · latest from Bo");
    summary.click();
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    [...item.querySelectorAll<HTMLButtonElement>(".message-actions button")].find((b) => b.textContent === "Thread")!.click();
    expect(onOpenThread).toHaveBeenCalledTimes(2);
    // Without threads here, or without a handler, the summary only shows; without replies there is none.
    const plain = messageItem(document, { ...message, thread: { count: 1 } }, h, { can: { reply: true, react: true } });
    expect(plain.querySelector("div.thread-summary")!.textContent).toBe("1 reply");
    expect([...plain.querySelectorAll(".message-actions button")].map((b) => b.textContent)).not.toContain("Thread");
    expect(messageItem(document, { ...message, thread: { count: 2 } }, handlers(), { can: threads }).querySelector("div.thread-summary")).not.toBeNull();
    expect(messageItem(document, { ...message, thread: { count: 0 } }, h, { can: threads }).querySelector(".thread-summary")).toBeNull();
  });

  it("makes a reply's quote lead to the original where it says where that is", () => {
    const onJumpToReply = vi.fn();
    const original = { author: "Bo", content: "earlier", id: "4", timestamp: "2026-10-14T11:00:00Z" };
    const item = messageItem(document, { ...message, reply: original }, { ...handlers(), onJumpToReply });
    const quote = item.querySelector<HTMLButtonElement>("button.reply")!;
    expect(quote.textContent).toBe("↪ Bo: earlier");
    quote.click();
    expect(onJumpToReply).toHaveBeenCalledWith({ id: "4", author: "Bo", content: "earlier", timestamp: "2026-10-14T11:00:00Z" });
    // Without a usable id or time, or a handler, it stays a quote.
    for (const reply of [{ ...original, id: "x" }, { ...original, timestamp: "soon" }, { author: "Bo", content: "earlier" }]) {
      expect(messageItem(document, { ...message, reply }, { ...handlers(), onJumpToReply }).querySelector("button.reply")).toBeNull();
    }
    expect(messageItem(document, { ...message, reply: original }, handlers()).querySelector("div.reply")!.textContent).toBe("↪ Bo: earlier");
  });

  it("renders markdown content with custom emoji", () => {
    const item = messageItem(document, message, handlers(), { customEmojiUrl: (id) => `https://media/${id}.webp` });
    expect(item.dataset.id).toBe("5");
    expect(item.querySelector(".content strong")!.textContent).toBe("hi");
    expect(item.querySelector(".content img.emoji")!.getAttribute("src")).toBe("https://media/55.webp");
    expect(item.querySelector(".content span.emoji")!.textContent).toBe("😂");
  });

  it("highlights messages that mention the user, in words as well as colour", () => {
    expect(messageItem(document, message, handlers()).classList.contains("mentions-me")).toBe(false);
    expect(messageItem(document, { ...message, mentionsMe: "yes" as unknown as boolean }, handlers()).querySelector(".mention-marker")).toBeNull();
    const item = messageItem(document, { ...message, mentionsMe: true }, handlers());
    expect(item.classList.contains("mentions-me")).toBe(true);
    const marker = item.querySelector(".meta .mention-marker")!;
    expect(marker.textContent).toBe("@");
    expect(marker.getAttribute("aria-label")).toBe("Mentions you");
  });

  it("offers the full picker from the quick palette when supported", () => {
    const h = { ...handlers(), onMoreReactions: vi.fn() };
    const item = messageItem(document, message, h, { reacting: true });
    item.querySelector<HTMLButtonElement>(".quick-reactions .more")!.click();
    expect(h.onMoreReactions).toHaveBeenCalledWith(message);
    expect(messageItem(document, message, handlers(), { reacting: true }).querySelector(".more")).toBeNull();
  });

  it("offers no reply or reactions where the conversation takes none", () => {
    const picker = document.createElement("div");
    picker.className = "full-picker";
    const item = messageItem(document, message, handlers(), { reacting: true, reactionPicker: picker, can: { reply: false, react: false } });
    expect(item.querySelectorAll(".message-actions button")).toHaveLength(0);
    expect(item.querySelector(".reactions")).toBeNull();
    expect(item.querySelector(".full-picker")).toBeNull();
  });
});

describe("link previews", () => {
  const handlers = (): MessageHandlers => ({ onReply: vi.fn(), onToggleReactionPicker: vi.fn(), onReact: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onLoadMedia: vi.fn() });
  const base: NativeMessage = { id: "5", author: "Ana", content: "see", timestamp: "", edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] };

  it("shows cards with a linked title, text and a picture, and nothing from malformed ones", () => {
    const item = messageItem(
      document,
      {
        ...base,
        embeds: [
          { url: "https://a.b/c", site: "Site", title: "Title", description: "**bold**", color: "#ff0000", image: { url: "https://a.b/i.png", thumbnail: true } },
          { title: "Plain", image: { url: "https://a.b/big.png", width: 400, height: 200 } },
          { site: "Only site", description: "words" },
          { url: "https://x" } as never,
        ],
      },
      handlers(),
    );
    const cards = item.querySelectorAll<HTMLElement>(".embed");
    expect(cards).toHaveLength(3);
    const link = cards[0]!.querySelector<HTMLAnchorElement>("a.embed-title")!;
    expect([link.textContent, link.href, link.target, link.rel]).toEqual(["Title", "https://a.b/c", "_blank", "noreferrer"]);
    expect(cards[0]!.querySelector(".embed-site")!.textContent).toBe("Site");
    expect(cards[0]!.querySelector(".embed-description strong")!.textContent).toBe("bold");
    expect(cards[0]!.style.getPropertyValue("--embed-color")).toBe("#ff0000");
    expect(cards[0]!.classList.contains("with-thumbnail")).toBe(true);
    expect(cards[0]!.querySelector("img.embed-thumbnail")!.getAttribute("alt")).toBe("Title");
    expect(cards[1]!.querySelector("div.embed-title")!.textContent).toBe("Plain");
    expect(cards[1]!.querySelector("img.embed-image")).not.toBeNull();
    expect(cards[2]!.querySelector(".embed-title")).toBeNull();
    expect(messageItem(document, { ...base, embeds: "no" as never }, handlers()).querySelector(".embed")).toBeNull();
  });

  it("loads held-back pictures through the engine, named by the site when untitled", () => {
    const h = handlers();
    const item = messageItem(document, { ...base, embeds: [{ site: "Telegram", description: "x", image: { mediaKey: "m:9", size: 2048 } }, { description: "y", image: { mediaKey: "m:8" } }] }, h);
    const load = item.querySelector<HTMLButtonElement>(".embed button.attachment.load")!;
    expect(load.textContent).toBe("Show Telegram (2.0 KB)");
    load.click();
    expect(h.onLoadMedia).toHaveBeenCalledWith("m:9");
    expect(item.querySelectorAll(".embed button.attachment.load")[1]!.textContent).toBe("Show Preview");
  });
});

describe("pinned messages", () => {
  const handlers = (): MessageHandlers => ({ onReply: vi.fn(), onToggleReactionPicker: vi.fn(), onReact: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onPin: vi.fn() });
  const base: NativeMessage = { id: "5", author: "Ana", content: "x", timestamp: "", edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] };
  const buttons = (item: HTMLElement) => [...item.querySelectorAll(".message-actions button")].map((b) => b.textContent);

  it("marks pinned messages and offers pinning where the message may be", () => {
    const h = handlers();
    const pinned = messageItem(document, { ...base, pinned: true, canPin: true }, h, { highlighted: true });
    expect(pinned.querySelector(".pin-marker")!.getAttribute("aria-label")).toBe("Pinned");
    expect(pinned.classList.contains("jump-target")).toBe(true);
    [...pinned.querySelectorAll<HTMLButtonElement>(".message-actions button")].find((b) => b.textContent === "Unpin")!.click();
    expect(h.onPin).toHaveBeenCalledWith(expect.objectContaining({ id: "5" }), false);
    const plain = messageItem(document, { ...base, canPin: true }, h);
    expect(plain.querySelector(".pin-marker")).toBeNull();
    expect(plain.classList.contains("jump-target")).toBe(false);
    [...plain.querySelectorAll<HTMLButtonElement>(".message-actions button")].find((b) => b.textContent === "Pin")!.click();
    expect(h.onPin).toHaveBeenLastCalledWith(expect.objectContaining({ id: "5" }), true);
    expect(buttons(messageItem(document, base, h))).not.toContain("Pin");
    expect(buttons(messageItem(document, { ...base, canPin: true }, { ...h, onPin: undefined }))).not.toContain("Pin");
  });

  it("lists messages that open when clicked, with notes, errors and loading", async () => {
    const { listedMessages } = await import("../../src/renderer/components/panels");
    const onOpen = vi.fn();
    const message = { id: "5", author: "Ana", content: "", timestamp: "2026-10-14T12:00:00Z" };
    const parts = listedMessages(document, { messages: [message], loading: true, note: "A note", error: "Oops" }, onOpen, "Nothing");
    const holder = document.createElement("div");
    holder.append(...parts);
    expect(holder.querySelector(".panel-note")!.textContent).toBe("A note");
    expect(holder.querySelector(".member-error")!.textContent).toBe("Oops");
    expect(holder.querySelector(".listed-content")!.textContent).toBe("(no text)");
    expect(holder.querySelector(".listed-author")!.textContent).toBe("Ana");
    expect(holder.textContent).toContain("Loading…");
    holder.querySelector<HTMLButtonElement>(".listed-message")!.click();
    expect(onOpen).toHaveBeenCalledWith(message);
    const empty = listedMessages(document, { messages: [], loading: false }, onOpen, "Nothing");
    expect(empty.map((p) => p.textContent)).toEqual(["Nothing"]);
    expect(listedMessages(document, { messages: [], loading: false, error: "Oops" }, onOpen, "Nothing")).toHaveLength(1);
  });
});

describe("polls", () => {
  const base: NativeMessage = { id: "5", author: "Ana", content: "", timestamp: "", edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] };
  const handlers = (): MessageHandlers => ({ onReply: vi.fn(), onToggleReactionPicker: vi.fn(), onReact: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onVote: vi.fn() });
  const options = [
    { id: "a", text: "Yes", votes: 3, chosen: true },
    { id: "b", text: "No", votes: 1 },
  ];
  const buttons = (item: HTMLElement) => [...item.querySelectorAll<HTMLButtonElement>("button.poll-option")];

  it("votes for one option, showing shares, and takes the vote back", () => {
    const h = handlers();
    const item = messageItem(document, { ...base, poll: { question: "Lunch?", options, multiple: false, closed: false, canVote: true } }, h);
    expect(item.querySelector(".poll-question")!.textContent).toBe("Lunch?");
    expect(buttons(item).map((b) => [b.textContent, b.getAttribute("aria-pressed"), b.style.getPropertyValue("--share")])).toEqual([
      ["Yes75%", "true", "75%"],
      ["No25%", "false", "25%"],
    ]);
    expect(item.querySelector(".poll-meta")!.textContent).toBe("Choose one · 4 votes");
    buttons(item)[0]!.click();
    expect(h.onVote).not.toHaveBeenCalled();
    buttons(item)[1]!.click();
    expect(h.onVote).toHaveBeenLastCalledWith(expect.objectContaining({ id: "5" }), ["b"]);
    item.querySelector<HTMLButtonElement>(".poll-retract")!.click();
    expect(h.onVote).toHaveBeenLastCalledWith(expect.objectContaining({ id: "5" }), []);
  });

  it("adds and removes options in a multiple-choice poll", () => {
    const h = handlers();
    const item = messageItem(document, { ...base, poll: { question: "Q", options, multiple: true, closed: false, canVote: true, total: 1 } }, h);
    expect(item.querySelector(".poll-meta")!.textContent).toBe("Choose one or more · 1 vote");
    buttons(item)[1]!.click();
    expect(h.onVote).toHaveBeenLastCalledWith(expect.anything(), ["a", "b"]);
    buttons(item)[0]!.click();
    expect(h.onVote).toHaveBeenLastCalledWith(expect.anything(), []);
  });

  it("only shows closed polls, those the user may not vote in, and those without counts", () => {
    const h = handlers();
    const closed = messageItem(document, { ...base, poll: { question: "Q", options: [{ id: "a", text: "A", correct: true }], multiple: false, closed: true, canVote: true, total: 0 } }, h);
    expect(buttons(closed)).toHaveLength(0);
    expect(closed.querySelector(".poll-option.correct")).not.toBeNull();
    expect(closed.querySelector(".poll-meta")!.textContent).toBe("Final results · 0 votes");
    expect(closed.querySelector(".poll-retract")).toBeNull();
    const quiet = messageItem(document, { ...base, poll: { question: "Q", options: [{ id: "a", text: "A", votes: 0 }], multiple: false, closed: false } }, h);
    expect(buttons(quiet)).toHaveLength(0);
    expect(quiet.querySelector(".poll-share")!.textContent).toBe("0%");
    expect(quiet.querySelector(".poll-meta")!.textContent).toBe("Choose one");
    const noHandler = messageItem(document, { ...base, poll: { question: "Q", options: [{ id: "a", text: "A" }], multiple: false, closed: false, canVote: true } }, { ...h, onVote: undefined });
    expect(buttons(noHandler)).toHaveLength(0);
    expect(messageItem(document, { ...base, poll: "junk" as never }, h).querySelector(".poll")).toBeNull();
  });

  it("offers to end a poll the user may end, where there is a handler for it", () => {
    const onEndPoll = vi.fn();
    const poll = { question: "Q", options: [{ id: "a", text: "A" }], multiple: false, closed: false, canEnd: true };
    const actions = (item: HTMLElement) => [...item.querySelectorAll<HTMLButtonElement>(".message-actions button")];
    const item = messageItem(document, { ...base, poll }, { ...handlers(), onEndPoll });
    actions(item).find((b) => b.textContent === "End poll")!.click();
    expect(onEndPoll).toHaveBeenCalledWith(expect.objectContaining({ id: "5" }));
    for (const shown of [messageItem(document, { ...base, poll }, handlers()), messageItem(document, { ...base, poll: { ...poll, closed: true } }, { ...handlers(), onEndPoll }), messageItem(document, base, { ...handlers(), onEndPoll })]) {
      expect(actions(shown).map((b) => b.textContent)).not.toContain("End poll");
    }
  });
});

describe("the new poll form", () => {
  const make = (anonymity = false) => {
    const onCreate = vi.fn();
    const onCancel = vi.fn();
    const form = pollForm(document, anonymity, { onCreate, onCancel });
    document.body.append(form);
    const answers = () => [...form.querySelectorAll<HTMLInputElement>(".poll-answers input")];
    const removers = () => [...form.querySelectorAll<HTMLButtonElement>(".poll-answers button")];
    const add = form.querySelector<HTMLButtonElement>(".poll-add")!;
    const question = form.querySelector<HTMLInputElement>(".poll-question-input")!;
    const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
    const error = form.querySelector<HTMLElement>(".member-error")!;
    const boxes = () => [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    return { form, onCreate, onCancel, answers, removers, add, question, submit, error, boxes };
  };

  it("starts with two answers, adds up to ten and removes down to two, numbering them", () => {
    const { answers, removers, add } = make();
    expect(answers().map((a) => a.placeholder)).toEqual(["Answer 1", "Answer 2"]);
    expect(removers().every((r) => r.hidden)).toBe(true);
    add.click();
    expect(document.activeElement).toBe(answers()[2]);
    expect(removers().some((r) => r.hidden)).toBe(false);
    for (let i = 3; i < MAX_NEW_POLL_ANSWERS; i++) add.click();
    expect(answers()).toHaveLength(MAX_NEW_POLL_ANSWERS);
    expect(add.hidden).toBe(true);
    removers()[0]!.click();
    expect(add.hidden).toBe(false);
    expect(answers().map((a) => a.getAttribute("aria-label")).at(-1)).toBe(`Answer ${MAX_NEW_POLL_ANSWERS - 1}`);
    expect(removers()[0]!.getAttribute("aria-label")).toBe("Remove answer 1");
  });

  it("says what is missing, and hands on a tidy poll", () => {
    const { onCreate, answers, add, question, submit, error, boxes } = make();
    submit();
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Write a question.");
    question.value = "  Lunch?\t";
    answers()[0]!.value = "Pizza";
    submit();
    expect(error.textContent).toBe("Give at least 2 answers.");
    add.click();
    answers()[1]!.value = " ";
    answers()[2]!.value = "Pizza ";
    submit();
    expect(error.textContent).toBe("Each answer can be given only once.");
    expect(onCreate).not.toHaveBeenCalled();
    answers()[2]!.value = "Soup";
    expect(boxes()).toHaveLength(1);
    boxes()[0]!.click();
    submit();
    expect(error.hidden).toBe(true);
    expect(onCreate).toHaveBeenCalledWith({ question: "Lunch?", answers: ["Pizza", "Soup"], multiple: true });
  });

  it("offers anonymous votes where the conversation lets the user choose, and cancels", () => {
    const { form, onCreate, onCancel, answers, question, submit, boxes } = make(true);
    question.value = "Q";
    answers()[0]!.value = "A";
    answers()[1]!.value = "B";
    expect(boxes()[1]!.checked).toBe(true);
    submit();
    expect(onCreate).toHaveBeenLastCalledWith({ question: "Q", answers: ["A", "B"], multiple: false, anonymous: true });
    boxes()[1]!.click();
    submit();
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ anonymous: false }));
    form.querySelector<HTMLButtonElement>(".poll-form-buttons .link")!.click();
    form.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe("mention suggestions", () => {
  const base = { content: "", timestamp: "2026-10-14T12:00:00Z", edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] };

  it("gathers recent authors, newest first, then listed members, each once", () => {
    const messages: NativeMessage[] = [
      { ...base, id: "1", author: "Ana", authorId: "a", authorMention: "<@a>", avatarUrl: "https://x/a.png" },
      { ...base, id: "2", author: "Bo", authorId: "b" },
      { ...base, id: "3", author: "Me", authorId: "m", mine: true },
      { ...base, id: "4", author: "No id" },
      { ...base, id: "5", author: " ", authorId: "blank" },
      { ...base, id: "6", author: "Bad mention", authorId: "c", authorMention: "a\nb" },
      { ...base, id: "7", author: "Ana again", authorId: "a" },
    ];
    const members = { sections: [{ name: "Members", members: [{ id: "b", name: "Bo" }, { id: "d", name: "Di", mention: "@di", avatarUrl: "" }] }], hasMore: false, loading: false };
    expect(mentionCandidates(messages, members)).toEqual([
      { id: "a", name: "Ana again", text: "Ana again" },
      { id: "c", name: "Bad mention", text: "Bad mention" },
      { id: "b", name: "Bo", text: "Bo" },
      { id: "d", name: "Di", text: "@di" },
    ]);
    expect(mentionCandidates(messages.slice(0, 1), undefined)).toEqual([{ id: "a", name: "Ana", text: "<@a>", avatarUrl: "https://x/a.png" }]);
  });

  it("finds the @name before the cursor", () => {
    expect(mentionQuery("hi @an", 6)).toEqual({ start: 3, query: "an" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("hi @an there", 6)).toEqual({ start: 3, query: "an" });
    expect(mentionQuery("mail a@b", 8)).toBeUndefined();
    expect(mentionQuery("hi @an there", 12)).toBeUndefined();
    expect(mentionQuery(`@${"x".repeat(33)}`, 34)).toBeUndefined();
  });

  it("matches names by a word's start before names that merely contain the text, up to a limit", () => {
    const people = [
      { id: "1", name: "Joanna", text: "Joanna" },
      { id: "2", name: "Ana Lee", text: "Ana Lee" },
      { id: "3", name: "Bo", text: "Bo" },
      { id: "4", name: "Mila Anders", text: "Mila Anders" },
    ];
    expect(matchMentions(people, "AN").map((p) => p.id)).toEqual(["2", "4", "1"]);
    expect(matchMentions(people, "").map((p) => p.id)).toEqual(["1", "2", "3", "4"]);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `P${i}`, text: `P${i}` }));
    expect(matchMentions(many, "p")).toHaveLength(MAX_MENTION_SUGGESTIONS);
  });

  it("lists options with the active one selected, picked by pressing without taking focus", () => {
    const onPick = vi.fn();
    const people = [
      { id: "1", name: "Ana", text: "<@1>", avatarUrl: "https://x/a.png" },
      { id: "2", name: "Bo", text: "Bo" },
    ];
    const rows = mentionOptions(document, people, 1, onPick);
    expect(rows.map((r) => [r.id, r.getAttribute("role"), r.getAttribute("aria-selected")])).toEqual([
      ["mention-option-0", "option", "false"],
      ["mention-option-1", "option", "true"],
    ]);
    expect(rows[0]!.querySelector("img.avatar")).not.toBeNull();
    expect(rows[0]!.querySelector(".mention-text")!.textContent).toBe("<@1>");
    expect(rows[1]!.querySelector(".mention-text")).toBeNull();
    const press = new MouseEvent("mousedown", { cancelable: true });
    rows[0]!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledWith(people[0]);
  });
});

describe("emoji picker", () => {
  const custom = [{ id: "55", name: "party", animated: false, url: "https://media/55.webp", text: "<:party:55>", key: "party:55" }];

  it("opens on the custom emoji when there are some, else on the first group", () => {
    const withCustom = emojiPicker(document, vi.fn(), custom);
    expect(withCustom.querySelector(".emoji-tab.active")!.getAttribute("data-group")).toBe("custom");
    expect(withCustom.querySelectorAll(".emoji-grid .emoji-option.custom")).toHaveLength(1);
    const plain = emojiPicker(document, vi.fn());
    expect(plain.querySelector(".emoji-tab.active")!.getAttribute("data-group")).toBe("0");
    expect(plain.querySelectorAll(".emoji-grid .emoji-option").length).toBeGreaterThan(50);
  });

  it("picks Unicode and custom emoji with their message text and reaction key", () => {
    const onPick = vi.fn();
    const picker = emojiPicker(document, onPick, custom);
    picker.querySelector<HTMLButtonElement>(".emoji-option.custom")!.click();
    expect(onPick).toHaveBeenLastCalledWith({ text: "<:party:55>", key: "party:55" });
    // A module's own syntax goes in as it says.
    const own = emojiPicker(document, onPick, [{ ...custom[0]!, text: ":01ARZ3NDEKTSV4RRFFQ69G5FAV:", key: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }]);
    own.querySelector<HTMLButtonElement>(".emoji-option.custom")!.click();
    expect(onPick).toHaveBeenLastCalledWith({ text: ":01ARZ3NDEKTSV4RRFFQ69G5FAV:", key: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });

    const search = picker.querySelector<HTMLInputElement>(".emoji-search")!;
    search.value = "joy";
    search.dispatchEvent(new Event("input"));
    const first = picker.querySelector<HTMLButtonElement>(".emoji-grid .emoji-option")!;
    expect(first.title).toBe(":joy:");
    first.click();
    expect(onPick).toHaveBeenLastCalledWith({ text: "😂", key: "😂" });
    expect(picker.querySelector(".emoji-tab.active")).toBeNull(); // searching: no tab highlighted
  });

  it("shows where each custom emoji comes from", () => {
    const badge = { label: "FX", color: "#4f8cf7", name: "Fluxer" };
    const picker = emojiPicker(document, vi.fn(), [{ ...custom[0]!, source: "Cats" }, { ...custom[0]!, id: "56", name: "wave", source: "Dogs" }, { ...custom[0]!, id: "57", name: "loose" }], badge);
    expect([...picker.querySelectorAll(".picker-heading")].map((h) => h.textContent)).toEqual(["FXCats", "FXDogs", "FXCustom emoji"]);
    const badgeEl = picker.querySelector<HTMLElement>(".source-badge")!;
    expect(badgeEl.style.backgroundColor).toBeTruthy();
    expect(badgeEl.getAttribute("aria-label")).toBe("Fluxer");
    expect(picker.querySelector<HTMLButtonElement>(".emoji-option.custom")!.title).toBe(":party: from Cats, Fluxer");
    expect(picker.querySelector(".emoji-tab")!.getAttribute("aria-label")).toBe("Custom emoji from Fluxer");
    const plain = emojiPicker(document, vi.fn(), custom);
    expect(plain.querySelector(".source-badge")).toBeNull();
    expect(plain.querySelector(".emoji-tab")!.getAttribute("aria-label")).toBe("Custom emoji");
  });

  it("searches custom emoji too, reports no results, and switches groups", () => {
    const picker = emojiPicker(document, vi.fn(), custom);
    const search = picker.querySelector<HTMLInputElement>(".emoji-search")!;
    search.value = "part";
    search.dispatchEvent(new Event("input"));
    expect(picker.querySelector(".emoji-grid .emoji-option.custom")).not.toBeNull();
    search.value = "zzqqxx";
    search.dispatchEvent(new Event("input"));
    expect(picker.querySelector(".emoji-empty")!.textContent).toBe("No emoji found");

    const food = picker.querySelector<HTMLButtonElement>('.emoji-tab[data-group="4"]')!;
    food.click();
    expect(search.value).toBe("");
    expect(food.classList.contains("active")).toBe(true);
    expect([...picker.querySelectorAll(".emoji-grid .emoji-option")].map((b) => b.textContent)).toContain("🍕");
  });
});

describe("attachments", () => {
  const show = async (file: import("../../src/shared/native").NativeAttachment, onLoad?: (key: string) => void) => {
    const { attachment } = await import("../../src/renderer/components/message");
    return attachment(document, file, onLoad);
  };

  it("shows each kind of media as it should", async () => {
    const image = (await show({ name: "cat.png", kind: "image", url: "https://cdn/cat.png", width: 640, height: 480 })) as HTMLImageElement;
    expect(image.tagName).toBe("IMG");
    expect([image.width, image.height, image.loading]).toEqual([640, 480, "lazy"]);

    const video = (await show({ name: "clip.mp4", kind: "video", url: "https://cdn/clip.mp4", previewUrl: "https://cdn/poster.jpg" })) as HTMLVideoElement;
    expect([video.tagName, video.controls, video.poster]).toEqual(["VIDEO", true, "https://cdn/poster.jpg"]);

    const gif = (await show({ name: "GIF", kind: "video", url: "https://cdn/g.mp4", loop: true })) as HTMLVideoElement;
    expect([gif.loop, gif.muted, gif.autoplay, gif.controls]).toEqual([true, true, true, false]);

    const audio = await show({ name: "voice.ogg", kind: "audio", url: "https://cdn/v.ogg" });
    expect(audio.querySelector("audio")!.controls).toBe(true);
    expect(audio.textContent).toBe("voice.ogg");

    const sticker = (await show({ name: "Wave", kind: "sticker", url: "https://cdn/s.webp" })) as HTMLImageElement;
    expect([sticker.className, sticker.title]).toEqual(["attachment-sticker", "Wave"]);
    const moving = (await show({ name: "Dance", kind: "sticker", url: "data:video/webm;base64,AA", mime: "video/webm" })) as HTMLVideoElement;
    expect([moving.tagName, moving.loop, moving.muted]).toEqual(["VIDEO", true, true]);
    expect((await show({ name: "Lottie", kind: "sticker" })).textContent).toBe("Lottie (sticker)");
    // With a still of it, the still shows, said to be one.
    const still = await show({ name: "Spin", kind: "sticker", previewUrl: "data:image/webp;base64,AA", mime: "application/x-tgsticker" });
    expect(still.querySelector("img")!.getAttribute("src")).toBe("data:image/webp;base64,AA");
    expect(still.querySelector("figcaption")!.textContent).toBe("Animated sticker");
    expect(still.title).toBe("Spin: an animated sticker, shown still");

    const web = (await show({ name: "notes.txt", kind: "file", url: "https://cdn/notes.txt", size: 2048 })) as HTMLAnchorElement;
    expect([web.textContent, web.target, web.download]).toEqual(["📎 notes.txt (2.0 KB)", "_blank", ""]);
    const own = (await show({ name: "doc.pdf", kind: "file", url: "data:application/pdf;base64,AA" })) as HTMLAnchorElement;
    expect([own.download, own.target]).toEqual(["doc.pdf", ""]);
    expect((await show({ name: "old.zip", kind: "file" })).textContent).toBe("old.zip (link expired)");
  });

  it("marks held-back media that loads by itself for the view to ask for, and lets the rest wait for a click", async () => {
    const { attachment } = await import("../../src/renderer/components/message");
    const onLoad = vi.fn();
    const auto = () => true as const;
    const picture = attachment(document, { name: "photo.jpg", kind: "image", mediaKey: "m:1", previewUrl: "data:image/jpeg;base64,AA", width: 10, height: 5 }, onLoad, auto) as HTMLImageElement;
    expect([picture.className, picture.dataset.autoLoad]).toEqual(["attachment-image loading", "m:1"]);
    const sticker = attachment(document, { name: "s", kind: "sticker", mediaKey: "m:2" }, onLoad, auto);
    expect([sticker.textContent, sticker.dataset.autoLoad]).toEqual(["Loading s…", "m:2"]);
    // A video's still is not a picture of the right kind to stand in.
    expect(attachment(document, { name: "v", kind: "video", mediaKey: "m:6", previewUrl: "data:image/jpeg;base64,AA" }, onLoad, auto).textContent).toBe("Loading v…");
    expect(onLoad).not.toHaveBeenCalled();

    const button = attachment(document, { name: "clip.mp4", kind: "video", mediaKey: "m:3", size: 5 * 1024 * 1024 }, onLoad, () => "It is larger than the 1.0 MB that loads by itself.") as HTMLButtonElement;
    expect([button.textContent, button.title, button.dataset.autoLoad]).toEqual(["▶ clip.mp4 (5.0 MB)", "Load this video. It is larger than the 1.0 MB that loads by itself.", undefined]);
    button.click();
    expect(onLoad).toHaveBeenCalledWith("m:3");
    expect([button.disabled, button.textContent]).toEqual([true, "Loading clip.mp4…"]);
    const file = await show({ name: "a.bin", kind: "file", mediaKey: "m:4" }, onLoad);
    expect([file.textContent, file.title]).toEqual(["⬇ a.bin", "Load this file"]);
    expect((await show({ name: "big.png", kind: "image", mediaKey: "m:7" }, onLoad)).textContent).toBe("Show big.png");
    // Without a way to ask, a held-back file reads as gone.
    expect((await show({ name: "x", kind: "video", mediaKey: "m:5" })).textContent).toBe("x (link expired)");
  });

  it("loads media by itself up to the limit, stickers always, files and media of unknown size only when asked", async () => {
    const { autoLoads } = await import("../../src/renderer/components/message");
    const MB = 1024 * 1024;
    const image = { name: "p", kind: "image" as const, size: 2 * MB };
    expect(autoLoads(image, 5 * MB)).toBe(true);
    expect(autoLoads({ ...image, kind: "audio" }, 2 * MB)).toBe(true);
    expect(autoLoads(image, MB)).toBe("It is larger than the 1.0 MB that loads by itself.");
    expect(autoLoads(image, 0)).toBe("Media does not load by itself here (Settings).");
    expect(autoLoads({ name: "p", kind: "video" }, 25 * MB)).toBe("Its size is unknown, so it does not load by itself.");
    expect(autoLoads({ name: "p", kind: "video" }, Number.POSITIVE_INFINITY)).toBe(true);
    expect(autoLoads({ name: "s", kind: "sticker" }, 0)).toBe(true);
    expect(autoLoads({ name: "f", kind: "file", size: 1 }, Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("favourite stars", () => {
  const handlers = (): MessageHandlers => ({ onReply: vi.fn(), onToggleReactionPicker: vi.fn(), onReact: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() });
  const base: NativeMessage = { id: "1", author: "Ana", content: "", timestamp: "2026-01-01T00:00:00Z", edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] };
  const files = [
    { name: "cat.png", kind: "image" as const, url: "https://cdn/cat.png" },
    { name: "dance.gif", kind: "image" as const, url: "https://cdn/dance.gif", mime: "image/gif" },
    { name: "GIF", kind: "video" as const, url: "https://cdn/g.mp4", loop: true },
    { name: "Wave", kind: "sticker" as const, url: "data:image/webp;base64,AA" },
    { name: "clip.mp4", kind: "video" as const, url: "https://cdn/clip.mp4" },
    { name: "notes.txt", kind: "file" as const, url: "https://cdn/notes.txt" },
    { name: "old.png", kind: "image" as const },
    { name: "blob.png", kind: "image" as const, url: "blob:file:///1" },
  ];

  it("knows what can be kept, and as what", async () => {
    const { favouriteKind } = await import("../../src/renderer/components/message");
    expect(files.map(favouriteKind)).toEqual(["image", "gif", "gif", "sticker", undefined, undefined, undefined, undefined]);
  });

  it("stars pictures, GIFs and stickers, showing which are kept", () => {
    const onFavourite = vi.fn();
    const item = messageItem(document, { ...base, attachments: files }, { ...handlers(), onFavourite, isFavourite: (file) => file.name === "dance.gif" });
    const stars = [...item.querySelectorAll<HTMLButtonElement>(".favourite-star")];
    expect(stars.map((s) => [s.textContent, s.getAttribute("aria-pressed")])).toEqual([
      ["☆", "false"],
      ["★", "true"],
      ["☆", "false"],
      ["☆", "false"],
    ]);
    expect(stars[1]!.getAttribute("aria-label")).toBe("Remove dance.gif from favourites");
    stars[3]!.click();
    expect(onFavourite).toHaveBeenCalledWith(files[3], "sticker");
    // Without the handler, no stars at all.
    expect(messageItem(document, { ...base, attachments: files }, handlers()).querySelector(".favourite-star")).toBeNull();
    const noCheck = messageItem(document, { ...base, attachments: [files[0]!] }, { ...handlers(), onFavourite });
    expect(noCheck.querySelector(".favourite-star")!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("member list", () => {
  const ana = { id: "1", name: "Ana", presence: "online" as const, color: "#ff0000", status: "Bot" };

  it("shows presence as a labelled dot, or none", () => {
    const holder = presenceAvatar(document, undefined, "Ana", "dnd");
    expect(holder.querySelector(".presence")!.getAttribute("aria-label")).toBe("Do not disturb");
    expect(holder.querySelector(".presence")!.getAttribute("role")).toBe("img");
    expect(presenceAvatar(document, "https://x/a.png", "Ana", undefined).querySelector(".presence")).toBeNull();
  });

  it("renders rows as buttons that open a profile, or as plain rows", () => {
    const onOpen = vi.fn();
    const row = memberRow(document, ana, onOpen);
    const button = row.querySelector<HTMLButtonElement>("button.member")!;
    expect(button.type).toBe("button");
    expect(button.dataset.id).toBe("1");
    expect(row.querySelector<HTMLElement>(".member-name")!.style.getPropertyValue("--member-color")).toBe("#ff0000");
    expect(row.querySelector(".member-status")!.textContent).toBe("Bot");
    button.click();
    expect(onOpen).toHaveBeenCalledWith(ana);
    const plain = memberRow(document, { id: "2", name: "Bo" });
    expect(plain.querySelector("button")).toBeNull();
    expect(plain.querySelector(".member-status")).toBeNull();
  });

  it("lists sections with counts, what is not listed, and loads more once", () => {
    const onLoadMore = vi.fn();
    const box = document.createElement("div");
    box.append(...memberPanel(document, { sections: [{ name: "Admins", members: [ana] }, { name: "Members", members: [{ id: "2", name: "Bo" }] }], more: 1234, hasMore: true, loading: false }, { onLoadMore }));
    expect([...box.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Admins — 1", "Members — 1"]);
    const lists = box.querySelectorAll("ul.member-list");
    expect(lists[1]!.getAttribute("aria-labelledby")).toBe(box.querySelectorAll("h3")[1]!.id);
    expect(box.querySelector(".member-note")!.textContent).toBe("1,234 more");
    const more = box.querySelector<HTMLButtonElement>(".member-more")!;
    more.click();
    expect(more.disabled).toBe(true);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("says when it is loading, empty or failed", () => {
    const parts = (list: Parameters<typeof memberPanel>[1]) => memberPanel(document, list, { onLoadMore: vi.fn() }).map((p) => p.textContent);
    expect(parts({ sections: [], hasMore: true, loading: true })).toEqual(["Loading members…"]);
    expect(parts({ sections: [], hasMore: false, loading: false })).toEqual(["No members to show."]);
    expect(parts({ sections: [], hasMore: false, loading: false, error: "Only admins can see the members." })).toEqual(["Only admins can see the members."]);
  });
});

describe("authors and profile cards", () => {
  const message: NativeMessage = { id: "5", author: "Ana", content: "hi", timestamp: "2026-10-14T12:00:00Z", edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] };
  const handlers = (extra: Partial<MessageHandlers> = {}): MessageHandlers => ({ onReply: vi.fn(), onToggleReactionPicker: vi.fn(), onReact: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), ...extra });

  it("makes the author's name and picture open their profile when the message names them", () => {
    const onOpenProfile = vi.fn();
    const item = messageItem(document, { ...message, authorId: "7" }, handlers({ onOpenProfile }));
    const name = item.querySelector<HTMLButtonElement>("button.author")!;
    expect(name.textContent).toBe("Ana");
    name.click();
    const face = item.querySelector<HTMLButtonElement>("button.avatar-button")!;
    expect(face.tabIndex).toBe(-1);
    expect(face.getAttribute("aria-label")).toBe("Profile of Ana");
    expect(face.querySelector(".avatar")).not.toBeNull();
    face.click();
    expect(onOpenProfile).toHaveBeenCalledTimes(2);
    expect(onOpenProfile).toHaveBeenCalledWith(expect.objectContaining({ authorId: "7" }));
  });

  it("keeps the author plain without an id or a handler", () => {
    for (const item of [messageItem(document, message, handlers({ onOpenProfile: vi.fn() })), messageItem(document, { ...message, authorId: "7" }, handlers())]) {
      expect(item.querySelector("strong.author")!.textContent).toBe("Ana");
      expect(item.querySelector("button.author, .avatar-button")).toBeNull();
    }
  });

  it("shows a profile with what it has, and closes", () => {
    const onClose = vi.fn();
    const box = document.createElement("div");
    box.append(
      ...profileCard(
        document,
        { id: "7", name: "Ana", color: "#123456", presence: "online", status: "last seen recently", username: "@ana", about: "Hello", roles: [{ name: "Owner", color: "#ff0000" }, { name: "Bot" }], loading: true },
        onClose,
      ),
    );
    expect(box.querySelector("#profile-name")!.textContent).toBe("Ana");
    expect(box.querySelector<HTMLElement>(".profile-name")!.style.getPropertyValue("--member-color")).toBe("#123456");
    expect(box.querySelector(".profile-username")!.textContent).toBe("@ana");
    expect(box.querySelector(".profile-status")!.textContent).toBe("Online · last seen recently");
    expect([...box.querySelectorAll(".profile-role")].map((r) => r.textContent)).toEqual(["Owner", "Bot"]);
    expect(box.querySelector<HTMLElement>(".profile-role")!.style.getPropertyValue("--role-color")).toBe("#ff0000");
    expect(box.querySelector(".profile-about")!.textContent).toBe("Hello");
    expect(box.textContent).toContain("Loading…");
    box.querySelector<HTMLButtonElement>(".profile-close")!.click();
    expect(onClose).toHaveBeenCalled();
    const bare = profileCard(document, { id: "7", name: "Bo", status: "Bot", roles: [] }, onClose).map((p) => p.className);
    expect(bare).toEqual(["profile-close", "presence-avatar", "profile-name", "profile-status"]);
    expect(profileCard(document, { id: "7", name: "Bo" }, onClose)).toHaveLength(3);
  });
});
