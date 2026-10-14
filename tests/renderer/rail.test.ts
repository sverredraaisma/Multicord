// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellApi } from "../../src/preload/shell";
import { initials, renderRail, startRail } from "../../src/renderer/rail";
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
    expect(root.querySelectorAll(".rail-separator")).toHaveLength(1);

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
    const api = { onRail: (cb: (s: RailState) => void) => (push = cb), open: vi.fn(), ready: vi.fn() } as unknown as ShellApi;
    startRail(document, api);
    expect(api.ready).toHaveBeenCalled();
    push(state);
    document.querySelector<HTMLButtonElement>(".rail-item")!.click();
    expect(api.open).toHaveBeenCalledWith("discord:home");
  });
});
