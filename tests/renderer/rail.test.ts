// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellApi } from "../../src/preload/shell";
import { attachTooltips, initials, renderRail, startRail } from "../../src/renderer/rail";
import type { RailState } from "../../src/shared/ipc";

const state: RailState = {
  activeKey: "discord:1",
  entries: [
    { key: "discord:home", platform: "discord", kind: "home", name: "Discord direct messages", unread: true, mentions: 2 },
    { key: "discord:1", platform: "discord", kind: "server", name: "Gaming Club", iconUrl: "https://x/icon.png", unread: false, mentions: 0 },
    { key: "element:app", platform: "element", kind: "server", name: "Element", unread: false, mentions: 150 },
  ],
};

beforeEach(() => {
  document.body.innerHTML = `<nav id="rail"></nav>`;
});

describe("initials", () => {
  it("takes up to three initials", () => {
    expect(initials("gaming club")).toBe("GC");
    expect(initials("a b c d")).toBe("ABC");
    expect(initials("   ")).toBe("?");
  });
});

describe("renderRail", () => {
  it("renders entries, badges, separators and the active state", () => {
    const root = document.getElementById("rail")!;
    const onOpen = vi.fn();
    renderRail(root, state, onOpen);

    const items = root.querySelectorAll<HTMLButtonElement>(".rail-item");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toBe("DM2");
    expect(items[0]!.classList.contains("unread")).toBe(true);
    expect(items[1]!.classList.contains("active")).toBe(true);
    expect(items[1]!.querySelector("img")!.getAttribute("src")).toBe("https://x/icon.png");
    expect(items[2]!.querySelector(".initials")!.textContent).toBe("E");
    expect(items[2]!.querySelector(".badge")!.textContent).toBe("99+");
    expect([...root.children].map((c) => (c.tagName === "HR" ? "|" : (c as HTMLElement).dataset.key))).toEqual([
      "discord:home",
      "|",
      "discord:1",
      "|",
      "element:app",
    ]);
    expect(items[1]!.hasAttribute("title")).toBe(false);

    items[2]!.click();
    expect(onOpen).toHaveBeenCalledWith("element:app");
  });

  it("replaces previous content on re-render", () => {
    const root = document.getElementById("rail")!;
    renderRail(root, state, vi.fn());
    renderRail(root, { entries: [], activeKey: null }, vi.fn());
    expect(root.children).toHaveLength(0);
  });
});

describe("startRail", () => {
  it("renders pushed state, opens entries and signals readiness", () => {
    let push: (s: RailState) => void = () => {};
    const api = {
      onRail: (cb: (s: RailState) => void) => (push = cb),
      open: vi.fn(),
      ready: vi.fn(),
      tooltip: vi.fn(),
    } as unknown as ShellApi;
    startRail(document, api);
    expect(api.ready).toHaveBeenCalled();
    push(state);
    const home = document.querySelector<HTMLButtonElement>(".rail-item")!;
    home.click();
    expect(api.open).toHaveBeenCalledWith("discord:home");
    home.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(api.tooltip).toHaveBeenCalledWith({ text: "Discord direct messages", y: expect.any(Number) });
  });
});

describe("DM bubbles", () => {
  it("renders DMs between home and servers with their avatar", () => {
    const root = document.getElementById("rail")!;
    renderRail(
      root,
      {
        activeKey: null,
        entries: [
          { key: "discord:home", platform: "discord", kind: "home", name: "Home", unread: false, mentions: 0 },
          { key: "discord:dm:5", platform: "discord", kind: "dm", name: "Ana", iconUrl: "https://cdn/a.png", unread: true, mentions: 3 },
          { key: "discord:dm:6", platform: "discord", kind: "dm", name: "Bo Chen", unread: true, mentions: 0 },
          { key: "discord:1", platform: "discord", kind: "server", name: "S", unread: false, mentions: 0 },
        ],
      },
      vi.fn(),
    );
    const kinds = [...root.children].map((c) => (c.tagName === "HR" ? "|" : (c as HTMLElement).dataset.kind));
    expect(kinds).toEqual(["home", "dm", "dm", "|", "server"]);
    const dm = root.querySelector<HTMLElement>('[data-key="discord:dm:5"]')!;
    expect(dm.querySelector("img")!.getAttribute("src")).toBe("https://cdn/a.png");
    expect(dm.querySelector(".badge")!.textContent).toBe("3");
    expect(root.querySelector('[data-key="discord:dm:6"] .initials')!.textContent).toBe("BC");
  });
});

describe("attachTooltips", () => {
  function setup() {
    const root = document.getElementById("rail")!;
    renderRail(root, state, vi.fn());
    const tooltip = vi.fn();
    attachTooltips(root, tooltip);
    const item = root.querySelector<HTMLElement>('[data-key="discord:1"]')!;
    item.getBoundingClientRect = () => ({ top: 100, height: 48 }) as DOMRect;
    return { root, item, tooltip };
  }

  it("shows the item's name centred on it, once per item", () => {
    const { item, tooltip } = setup();
    item.querySelector("img")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tooltip.mock.calls).toEqual([[{ text: "Gaming Club", y: 124 }]]);
  });

  it("hides when leaving items, the rail, or scrolling", () => {
    const { root, item, tooltip } = setup();
    root.dispatchEvent(new MouseEvent("mouseleave"));
    expect(tooltip).not.toHaveBeenCalled();

    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    root.querySelector("hr")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tooltip).toHaveBeenLastCalledWith(null);

    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("mouseleave"));
    expect(tooltip).toHaveBeenLastCalledWith(null);

    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    root.dispatchEvent(new Event("scroll"));
    expect(tooltip).toHaveBeenCalledTimes(6);
    expect(tooltip).toHaveBeenLastCalledWith(null);
  });

  it("falls back to empty text without a label", () => {
    const { root, tooltip } = setup();
    const bare = document.createElement("button");
    bare.className = "rail-item";
    root.append(bare);
    bare.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tooltip).toHaveBeenCalledWith({ text: "", y: expect.any(Number) });
  });
});
