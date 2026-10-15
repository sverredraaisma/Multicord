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
    expect(icon.querySelector(".module-label")!.textContent).toBe("F");
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

  it("offers no reply or reactions where the conversation takes none", () => {
    const picker = document.createElement("div");
    picker.className = "full-picker";
    const item = messageItem(document, message, handlers(), { reacting: true, reactionPicker: picker, can: { reply: false, react: false } });
    expect(item.querySelectorAll(".message-actions button")).toHaveLength(0);
    expect(item.querySelector(".reactions")).toBeNull();
    expect(item.querySelector(".full-picker")).toBeNull();
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

    const web = (await show({ name: "notes.txt", kind: "file", url: "https://cdn/notes.txt", size: 2048 })) as HTMLAnchorElement;
    expect([web.textContent, web.target, web.download]).toEqual(["📎 notes.txt (2.0 KB)", "_blank", ""]);
    const own = (await show({ name: "doc.pdf", kind: "file", url: "data:application/pdf;base64,AA" })) as HTMLAnchorElement;
    expect([own.download, own.target]).toEqual(["doc.pdf", ""]);
    expect((await show({ name: "old.zip", kind: "file" })).textContent).toBe("old.zip (link expired)");
  });

  it("asks for held-back pictures at once, and for sound and video on a click", async () => {
    const onLoad = vi.fn();
    const picture = (await show({ name: "photo.jpg", kind: "image", mediaKey: "m:1", previewUrl: "data:image/jpeg;base64,AA", width: 10, height: 5 }, onLoad)) as HTMLImageElement;
    expect(onLoad).toHaveBeenCalledWith("m:1");
    expect(picture.className).toBe("attachment-image loading");
    expect((await show({ name: "s", kind: "sticker", mediaKey: "m:2" }, onLoad)).textContent).toBe("Loading s…");

    const button = (await show({ name: "clip.mp4", kind: "video", mediaKey: "m:3", size: 5 * 1024 * 1024 }, onLoad)) as HTMLButtonElement;
    expect(button.textContent).toBe("▶ clip.mp4 (5.0 MB)");
    expect(onLoad).not.toHaveBeenCalledWith("m:3");
    button.click();
    expect(onLoad).toHaveBeenCalledWith("m:3");
    expect([button.disabled, button.textContent]).toEqual([true, "Loading clip.mp4…"]);
    expect((await show({ name: "a.bin", kind: "file", mediaKey: "m:4" }, onLoad)).textContent).toBe("⬇ a.bin");
    // Without a way to ask, a held-back file reads as gone.
    expect((await show({ name: "x", kind: "video", mediaKey: "m:5" })).textContent).toBe("x (link expired)");
  });
});
