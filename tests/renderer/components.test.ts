// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { avatar } from "../../src/renderer/components/avatar";
import { channelItem } from "../../src/renderer/components/channels";
import { countBadge, icon, initials, setColor } from "../../src/renderer/components/dom";
import { emojiPicker } from "../../src/renderer/components/emojiPicker";
import { messageItem, type MessageHandlers } from "../../src/renderer/components/message";
import { isOwnReaction, quickReactions } from "../../src/renderer/components/reactions";
import { moduleLabel, serverIcon, serverTooltip } from "../../src/renderer/components/serverIcon";
import type { NativeMessage } from "../../src/shared/native";

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
    expect(icon.querySelector(".module-label")!.textContent).toBe("Fluxer");
    expect(icon.querySelector(".badge")!.textContent).toBe("3");
    expect(icon.dataset.tooltip).toBe("Alpha · Fluxer");
    expect(serverTooltip({ name: "Solo" })).toBe("Solo");
    expect(moduleLabel(document, { label: "Web", color: "#000" }).style.getPropertyValue("--module-color")).toBe("#000");
  });
});

describe("channel items", () => {
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

  it("renders markdown content with custom emoji", () => {
    const item = messageItem(document, message, handlers(), { customEmojiUrl: (id) => `https://media/${id}.webp` });
    expect(item.dataset.id).toBe("5");
    expect(item.querySelector(".content strong")!.textContent).toBe("hi");
    expect(item.querySelector(".content img.emoji")!.getAttribute("src")).toBe("https://media/55.webp");
    expect(item.querySelector(".content span.emoji")!.textContent).toBe("😂");
  });

  it("offers the full picker from the quick palette when supported", () => {
    const h = { ...handlers(), onMoreReactions: vi.fn() };
    const item = messageItem(document, message, h, { reacting: true });
    item.querySelector<HTMLButtonElement>(".quick-reactions .more")!.click();
    expect(h.onMoreReactions).toHaveBeenCalledWith(message);
    expect(messageItem(document, message, handlers(), { reacting: true }).querySelector(".more")).toBeNull();
  });
});

describe("emoji picker", () => {
  const custom = [{ id: "55", name: "party", animated: false, url: "https://media/55.webp" }];

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
    const animated = emojiPicker(document, onPick, [{ ...custom[0]!, animated: true }]);
    animated.querySelector<HTMLButtonElement>(".emoji-option.custom")!.click();
    expect(onPick).toHaveBeenLastCalledWith({ text: "<a:party:55>", key: "party:55" });

    const search = picker.querySelector<HTMLInputElement>(".emoji-search")!;
    search.value = "joy";
    search.dispatchEvent(new Event("input"));
    const first = picker.querySelector<HTMLButtonElement>(".emoji-grid .emoji-option")!;
    expect(first.title).toBe(":joy:");
    first.click();
    expect(onPick).toHaveBeenLastCalledWith({ text: "😂", key: "😂" });
    expect(picker.querySelector(".emoji-tab.active")).toBeNull(); // searching: no tab highlighted
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
