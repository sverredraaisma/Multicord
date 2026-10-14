// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellApi } from "../../src/preload/shell";
import { attachReordering, attachTooltips, initials, moveKey, renderRail, startRail } from "../../src/renderer/rail";
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
  document.body.innerHTML = `<header id="rail-header"><button id="messages-button" data-tooltip="Messages" class="rail-item"></button></header><nav id="rail"></nav><footer id="rail-footer"><button id="settings-button" data-tooltip="Settings" class="rail-item"></button></footer>`;
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
    const home = document.querySelector<HTMLButtonElement>("#rail .rail-item")!;
    home.click();
    expect(api.open).toHaveBeenCalledWith("discord:home");
    home.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(api.tooltip).toHaveBeenCalledWith({ text: "Discord direct messages", y: expect.any(Number) });
  });

  it("opens Messages from its button and shows unread DMs on it", () => {
    let push: (s: RailState) => void = () => {};
    const api = { onRail: (cb: (s: RailState) => void) => (push = cb), open: vi.fn(), ready: vi.fn(), tooltip: vi.fn(), settings: vi.fn(), messages: vi.fn() } as unknown as ShellApi;
    startRail(document, api);
    const button = document.getElementById("messages-button")!;
    button.click();
    expect(api.messages).toHaveBeenLastCalledWith(true);
    push({ ...state, activeKey: "discord:home", messagesOpen: true, messagesBadge: { unread: true, mentions: 4 } });
    expect(button.classList.contains("active")).toBe(true);
    expect(button.classList.contains("unread")).toBe(true);
    expect(button.querySelector(".badge")!.textContent).toBe("4");
    expect(document.querySelector("#rail .active")).toBeNull();
    push({ ...state, messagesBadge: { unread: true, mentions: 0 } });
    expect(button.querySelector(".badge")).toBeNull();
    push(state);
    expect(button.classList.contains("unread")).toBe(false);
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(api.tooltip).toHaveBeenCalledWith({ text: "Messages", y: expect.any(Number) });
  });

  it("opens and closes settings from the gear and clears the active server meanwhile", () => {
    let push: (s: RailState) => void = () => {};
    const api = { onRail: (cb: (s: RailState) => void) => (push = cb), open: vi.fn(), ready: vi.fn(), tooltip: vi.fn(), settings: vi.fn() } as unknown as ShellApi;
    startRail(document, api);
    const gear = document.getElementById("settings-button")!;
    gear.click();
    expect(api.settings).toHaveBeenLastCalledWith(true);
    push({ ...state, activeKey: "discord:home", settingsOpen: true });
    expect(gear.classList.contains("active")).toBe(true);
    expect(gear.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("#rail .active")).toBeNull();
    gear.click();
    expect(api.settings).toHaveBeenLastCalledWith(false);
    push({ ...state, activeKey: "discord:home" });
    expect(gear.classList.contains("active")).toBe(false);
    expect(document.querySelector("#rail .active")).not.toBeNull();
    gear.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(api.tooltip).toHaveBeenCalledWith({ text: "Settings", y: expect.any(Number) });
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

describe("folders", () => {
  const entry = (over: Partial<RailState["entries"][number]>): RailState["entries"][number] => ({
    key: "discord:x",
    platform: "discord",
    kind: "server",
    name: "x",
    unread: false,
    mentions: 0,
    ...over,
  });

  function render(entries: RailState["entries"], onOpen = vi.fn()) {
    const root = document.getElementById("rail")!;
    renderRail(root, { entries, activeKey: "discord:2" }, onOpen);
    return root;
  }

  it("draws a collapsed folder as a tinted tile previewing its servers", () => {
    const onOpen = vi.fn();
    const root = render(
      [
        entry({ key: "discord:home", kind: "home", name: "Home" }),
        entry({
          key: "discord:folder:60",
          kind: "group",
          name: "Chill",
          color: "#00ff00",
          expanded: false,
          previewIconUrls: ["https://cdn/a.png", "https://cdn/b.png", "https://cdn/c.png", "https://cdn/d.png", "https://cdn/e.png"],
          unread: true,
          mentions: 5,
        }),
      ],
      onOpen,
    );
    const tile = root.querySelector<HTMLButtonElement>('[data-kind="group"]')!;
    expect(tile.classList.contains("rail-folder")).toBe(true);
    expect(tile.getAttribute("aria-expanded")).toBe("false");
    expect(tile.getAttribute("aria-label")).toBe("Chill");
    expect(tile.style.getPropertyValue("--folder-color")).toBe("#00ff00");
    expect(tile.querySelectorAll(".folder-grid img")).toHaveLength(4);
    expect(tile.querySelector(".badge")!.textContent).toBe("5");
    expect(root.querySelector("hr")).not.toBeNull(); // home -> folder separator
    tile.click();
    expect(onOpen).toHaveBeenCalledWith("discord:folder:60");
  });

  it("shows a folder glyph when a collapsed folder has no icons", () => {
    const root = render([entry({ key: "discord:folder:60", kind: "group", name: "Empty", expanded: false })]);
    expect(root.querySelector(".rail-folder .folder-glyph")).not.toBeNull();
    expect(root.querySelector<HTMLElement>(".rail-folder")!.style.getPropertyValue("--folder-color")).toBe("");
  });

  it("wraps an expanded folder and its servers in one container", () => {
    const root = render([
      entry({ key: "discord:1", name: "Lone" }),
      entry({ key: "discord:folder:50", kind: "group", name: "Games", color: "#ff0000", expanded: true, previewIconUrls: ["https://cdn/a.png"] }),
      entry({ key: "discord:2", name: "Alpha", parentKey: "discord:folder:50" }),
      entry({ key: "discord:3", name: "Beta", parentKey: "discord:folder:50" }),
      entry({ key: "discord:4", name: "After" }),
      entry({ key: "discord:5", name: "Orphan", parentKey: "discord:folder:99" }),
    ]);
    const top = [...root.children].map((c) => (c as HTMLElement).dataset.key ?? (c as HTMLElement).dataset.group);
    expect(top).toEqual(["discord:1", "discord:folder:50", "discord:4", "discord:5"]);

    const open = root.querySelector<HTMLElement>(".rail-folder-open")!;
    expect(open.style.getPropertyValue("--folder-color")).toBe("#ff0000");
    expect([...open.children].map((c) => (c as HTMLElement).dataset.key)).toEqual([
      "discord:folder:50",
      "discord:2",
      "discord:3",
    ]);
    const header = open.querySelector<HTMLElement>('[data-kind="group"]')!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.querySelector(".folder-glyph")).not.toBeNull();
    expect(open.querySelector('[data-key="discord:2"]')!.classList.contains("active")).toBe(true);
  });

  it("shows names of servers inside folders on hover", () => {
    const root = render([
      entry({ key: "discord:folder:50", kind: "group", name: "Games", expanded: true }),
      entry({ key: "discord:2", name: "Alpha", parentKey: "discord:folder:50" }),
    ]);
    const tooltip = vi.fn();
    attachTooltips(root, tooltip);
    root.querySelector('[data-key="discord:2"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tooltip).toHaveBeenCalledWith({ text: "Alpha", y: expect.any(Number) });
  });

  it("leaves an expanded folder without a colour untinted", () => {
    const root = render([entry({ key: "discord:folder:50", kind: "group", name: "Games", expanded: true })]);
    expect(root.querySelector<HTMLElement>(".rail-folder-open")!.style.getPropertyValue("--folder-color")).toBe("");
  });
});

describe("modules and ordering", () => {
  const discord = { label: "Discord", color: "#5865f2" };
  const fluxer = { label: "Fluxer", color: "#4f8cf7" };
  const ordered: RailState = {
    activeKey: null,
    entries: [
      { key: "discord:home", platform: "discord", kind: "home", name: "Discord DMs", unread: false, mentions: 0, module: discord },
      { key: "fluxer:home", platform: "fluxer", kind: "home", name: "Fluxer DMs", unread: false, mentions: 0, module: fluxer },
      { key: "fluxer:dm:9", platform: "fluxer", kind: "dm", name: "Ana", unread: true, mentions: 1, module: fluxer },
      { key: "fluxer:5", platform: "fluxer", kind: "server", name: "Alpha", unread: false, mentions: 0, module: fluxer },
      { key: "discord:folder:7", platform: "discord", kind: "group", name: "Games", expanded: true, unread: false, mentions: 0, module: discord },
      { key: "discord:8", platform: "discord", kind: "server", name: "Beta", parentKey: "discord:folder:7", unread: false, mentions: 0, module: discord },
      { key: "discord:1", platform: "discord", kind: "server", name: "Gamma", unread: false, mentions: 0 },
    ],
  };

  it("labels each entry with its module and names it in the tooltip", () => {
    const root = document.getElementById("rail")!;
    renderRail(root, ordered, vi.fn());
    const alpha = root.querySelector<HTMLElement>('[data-key="fluxer:5"]')!;
    const label = alpha.querySelector<HTMLElement>(".module-label")!;
    expect(label.textContent).toBe("F");
    expect(label.dataset.module).toBe("Fluxer");
    expect(label.style.getPropertyValue("--module-color")).toBe("#4f8cf7");
    expect(alpha.dataset.tooltip).toBe("Alpha · Fluxer");
    expect(root.querySelector<HTMLElement>('[data-key="discord:1"]')!.dataset.tooltip).toBe("Gamma");
    expect(root.querySelector('[data-key="discord:1"] .module-label')).toBeNull();

    const tooltip = vi.fn();
    attachTooltips(root, tooltip);
    alpha.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tooltip).toHaveBeenCalledWith({ text: "Alpha · Fluxer", y: expect.any(Number) });
  });

  it("separates personal blocks per platform but not servers", () => {
    const root = document.getElementById("rail")!;
    renderRail(root, ordered, vi.fn());
    const layout = [...root.children].map((c) => (c.tagName === "HR" ? "|" : ((c as HTMLElement).dataset.key ?? (c as HTMLElement).dataset.group)));
    expect(layout).toEqual(["discord:home", "|", "fluxer:home", "fluxer:dm:9", "|", "fluxer:5", "discord:folder:7", "discord:1"]);
  });

  it("makes top-level servers and groups draggable units, not DMs or folder members", () => {
    const root = document.getElementById("rail")!;
    renderRail(root, ordered, vi.fn());
    const units = [...root.querySelectorAll<HTMLElement>("[data-unit]")];
    expect(units.map((u) => u.dataset.unit)).toEqual(["fluxer:5", "discord:folder:7", "discord:1"]);
    expect(units.every((u) => u.draggable)).toBe(true);
    expect(units[1]!.classList.contains("rail-folder-open")).toBe(true);
  });

  it("computes moves", () => {
    expect(moveKey(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
    expect(moveKey(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
    expect(moveKey(["a", "b"], "a", "a", true)).toEqual(["a", "b"]);
    expect(moveKey(["a", "b"], "a", "zzz", true)).toEqual(["a", "b"]);
  });

  it("reorders by drag and drop", () => {
    const root = document.getElementById("rail")!;
    renderRail(root, ordered, vi.fn());
    const reorder = vi.fn();
    attachReordering(root, reorder);
    const unit = (key: string) => root.querySelector<HTMLElement>(`[data-unit="${key}"]`)!;
    for (const u of root.querySelectorAll<HTMLElement>("[data-unit]")) {
      u.getBoundingClientRect = () => ({ top: 0, height: 48 }) as DOMRect;
    }
    const drag = (type: string, target: Element, clientY = 0) => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, "clientY", { value: clientY });
      target.dispatchEvent(event);
      return event;
    };

    // Dragging over something before a drag started, or over a DM, does nothing.
    expect(drag("dragover", unit("discord:1")).defaultPrevented).toBe(false);
    drag("dragstart", root.querySelector('[data-key="fluxer:dm:9"]')!);

    drag("dragstart", unit("fluxer:5"));
    expect(unit("fluxer:5").classList.contains("dragging")).toBe(true);
    expect(drag("dragover", unit("fluxer:5")).defaultPrevented).toBe(false); // onto itself
    const over = drag("dragover", unit("discord:1"), 40);
    expect(over.defaultPrevented).toBe(true);
    expect(unit("discord:1").classList.contains("drop-after")).toBe(true);
    drag("dragover", root.querySelector('[data-key="discord:8"]')!, 5); // a member: targets its whole folder
    expect(unit("discord:folder:7").classList.contains("drop-before")).toBe(true);
    expect(unit("discord:1").classList.contains("drop-after")).toBe(false);

    drag("drop", unit("discord:1"), 40);
    expect(reorder).toHaveBeenCalledWith(["discord:folder:7", "discord:1", "fluxer:5"]);
    drag("dragend", unit("fluxer:5"));
    expect(root.querySelector(".dragging, .drop-before, .drop-after")).toBeNull();
    drag("drop", unit("discord:1")); // no drag in progress
    expect(reorder).toHaveBeenCalledOnce();
  });

  it("sends reorders through the shell API", () => {
    const api = {
      onRail: (cb: (s: RailState) => void) => cb(ordered),
      open: vi.fn(),
      ready: vi.fn(),
      tooltip: vi.fn(),
      reorder: vi.fn(),
    } as unknown as ShellApi;
    startRail(document, api);
    const root = document.getElementById("rail")!;
    const start = new Event("dragstart", { bubbles: true });
    root.querySelector('[data-unit="discord:1"]')!.dispatchEvent(start);
    const drop = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(drop, "clientY", { value: -10 });
    root.querySelector('[data-unit="fluxer:5"]')!.dispatchEvent(drop);
    expect(api.reorder).toHaveBeenCalledWith(["discord:1", "fluxer:5", "discord:folder:7"]);
  });
});

describe("grouped rail", () => {
  it("separates each platform's run of servers when grouped", () => {
    const root = document.getElementById("rail")!;
    const entries = [
      { key: "a:1", platform: "a", kind: "server", name: "One", unread: false, mentions: 0 },
      { key: "a:2", platform: "a", kind: "server", name: "Two", unread: false, mentions: 0 },
      { key: "b:3", platform: "b", kind: "server", name: "Three", unread: false, mentions: 0 },
    ] as RailState["entries"];
    renderRail(root, { activeKey: null, entries }, vi.fn());
    expect(root.querySelectorAll(".rail-separator")).toHaveLength(0);
    renderRail(root, { activeKey: null, entries, grouped: true }, vi.fn());
    const items = [...root.children].map((c) => (c.tagName === "HR" ? "|" : (c as HTMLElement).dataset.key));
    expect(items).toEqual(["a:1", "a:2", "|", "b:3"]);
  });
});
