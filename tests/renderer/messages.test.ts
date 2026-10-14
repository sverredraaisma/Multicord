// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationItem, filterConversations } from "../../src/renderer/components/conversations";
import { formatRecent } from "../../src/renderer/components/format";
import { MessagesPage, REFRESH_MS, startMessages } from "../../src/renderer/messages";
import type { MessagesApi } from "../../src/preload/messages";
import type { Conversation, MessagesState } from "../../src/shared/ipc";

const NOW = new Date(2026, 9, 14, 15, 0).getTime();
const HOUR = 3_600_000;
const ana: Conversation = { key: "discord:dm:1", platform: "discord", title: "Ana", lastActivity: NOW - HOUR, unread: false, mentions: 0, module: { label: "Discord", color: "#5865f2" } };
const mila: Conversation = { key: "telegram:dm:7", platform: "telegram", title: "Mila", avatarUrl: "https://cdn/m.png", preview: "See you at eight", lastActivity: NOW - 30 * HOUR, unread: true, mentions: 3 };
const bo: Conversation = { key: "fluxer:dm:3", platform: "fluxer", title: "Bo", lastActivity: 0, unread: true, mentions: 0 };

beforeEach(() => {
  document.body.innerHTML = `<main id="messages"></main>`;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRecent", () => {
  it("shows the time today, the weekday this week, else the date", () => {
    expect(formatRecent(NOW - HOUR, NOW, "en-GB")).toBe("14:00");
    expect(formatRecent(NOW - 2 * 24 * HOUR, NOW, "en-GB")).toBe("Mon");
    expect(formatRecent(NOW - 30 * 24 * HOUR, NOW, "en-GB")).toBe("14 Sept");
    expect(formatRecent(new Date(2025, 0, 2).getTime(), NOW, "en-GB")).toBe("02/01/2025");
    expect(formatRecent(Date.now())).not.toBe("");
  });
});

describe("conversation rows", () => {
  it("show the picture, name, module, preview, time and unread state", () => {
    const onOpen = vi.fn();
    const row = conversationItem(document, mila, { now: NOW, onOpen });
    expect(row.dataset.key).toBe("telegram:dm:7");
    expect(row.querySelector("img.avatar")!.getAttribute("src")).toBe("https://cdn/m.png");
    expect(row.querySelector(".conversation-title")!.textContent).toBe("Mila");
    expect(row.querySelector(".module-tag")).toBeNull();
    expect(row.querySelector(".conversation-preview")!.textContent).toBe("See you at eight");
    expect(row.querySelector(".conversation-badge")!.textContent).toBe("3");
    expect(row.querySelector("time")!.getAttribute("datetime")).toBe(new Date(NOW - 30 * HOUR).toISOString());
    row.querySelector("button")!.click();
    expect(onOpen).toHaveBeenCalledWith("telegram:dm:7");

    const active = conversationItem(document, ana, { active: true });
    expect(active.querySelector(".module-tag")!.textContent).toBe("Discord");
    expect(active.querySelector("button")!.getAttribute("aria-current")).toBe("true");
    expect(active.querySelector(".avatar.initials")!.textContent).toBe("A");
    expect(active.querySelector(".conversation-dot")).toBeNull();
    active.querySelector("button")!.click(); // no handler: nothing happens

    const unknownTime = conversationItem(document, bo);
    expect(unknownTime.querySelector("time")!.textContent).toBe("");
    expect(unknownTime.querySelector(".conversation-dot")).not.toBeNull();
  });

  it("filter on every word of the query across name, preview and module", () => {
    expect(filterConversations([ana, mila, bo], "  ")).toEqual([ana, mila, bo]);
    expect(filterConversations([ana, mila, bo], "eight MILA")).toEqual([mila]);
    expect(filterConversations([ana, mila, bo], "discord")).toEqual([ana]);
    expect(filterConversations([ana, mila, bo], "nobody")).toEqual([]);
  });
});

describe("MessagesPage", () => {
  const state: MessagesState = { conversations: [ana, mila, bo], activeKey: "telegram:dm:7" };

  it("lists conversations, marks the open one and opens on click", () => {
    const api = { open: vi.fn() };
    const page = new MessagesPage(document.getElementById("messages")!, api, () => NOW);
    expect(document.querySelector(".messages-empty")!.textContent).toMatch(/No direct messages yet/);
    page.render(state);
    const rows = [...document.querySelectorAll(".conversation")].map((r) => (r as HTMLElement).dataset.key);
    expect(rows).toEqual(["discord:dm:1", "telegram:dm:7", "fluxer:dm:3"]);
    expect(document.querySelector(".conversation-button.active")!.closest("li")!.dataset.key).toBe("telegram:dm:7");
    expect((document.querySelector(".messages-empty") as HTMLElement).hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-key="fluxer:dm:3"] button')!.click();
    expect(api.open).toHaveBeenCalledWith("fluxer:dm:3");
  });

  it("keeps the search across updates and says when nothing matches", () => {
    const page = new MessagesPage(document.getElementById("messages")!, { open: vi.fn() });
    page.render(state);
    const search = document.querySelector<HTMLInputElement>(".messages-search")!;
    search.value = "zzz";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".conversation")).toHaveLength(0);
    expect(document.querySelector(".messages-empty")!.textContent).toBe("No conversations match your search.");
    page.render({ ...state, activeKey: null });
    expect(search.value).toBe("zzz");
    search.value = "bo";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".conversation")).toHaveLength(1);
  });

  it("starts from the bridge and refreshes times every minute", () => {
    vi.useFakeTimers();
    let push: (s: MessagesState) => void = () => {};
    const api: MessagesApi = { onState: (cb) => void (push = cb), open: vi.fn(), ready: vi.fn() };
    const page = startMessages(document, api);
    expect(api.ready).toHaveBeenCalled();
    push(state);
    expect(document.querySelectorAll(".conversation")).toHaveLength(3);
    const refresh = vi.spyOn(page, "renderList");
    vi.advanceTimersByTime(REFRESH_MS);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
