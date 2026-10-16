// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusRegions, regionStep } from "../../src/renderer/regions";

const press = (shiftKey = false, target: EventTarget = document.activeElement ?? document.body) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", shiftKey, bubbles: true, cancelable: true }));

function page() {
  document.body.innerHTML = `
    <nav class="side"><button id="a">A</button><button id="b" aria-current="true">B</button></nav>
    <main class="main"><button id="send" disabled>Send</button><textarea id="composer"></textarea><button id="c">C</button></main>
    <aside class="panel" hidden><input id="search"></aside>
    <div class="empty"><p>Nothing to focus</p></div>`;
}

function bridge() {
  let enter: (direction: 1 | -1) => void = () => {};
  return { onEnter: vi.fn((cb: (direction: 1 | -1) => void) => (enter = cb)), leave: vi.fn(), enter: (direction: 1 | -1) => enter(direction) };
}

const REGIONS = [{ selector: ".side" }, { selector: ".main", prefer: "textarea" }, { selector: ".panel", prefer: "input" }];

beforeEach(page);
let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});
const regions = (...args: Parameters<typeof focusRegions>) => stops.push(focusRegions(...args));

describe("regionStep", () => {
  it("is F6 forward and Shift+F6 back, not with Alt or Meta", () => {
    const k = (more: Partial<KeyboardEvent>) => ({ key: "F6", shiftKey: false, altKey: false, metaKey: false, ...more });
    expect(regionStep(k({}))).toBe(1);
    expect(regionStep(k({ shiftKey: true }))).toBe(-1);
    expect(regionStep(k({ altKey: true }))).toBeUndefined();
    expect(regionStep(k({ metaKey: true }))).toBeUndefined();
    expect(regionStep(k({ key: "Tab" }))).toBeUndefined();
  });
});

describe("focusRegions", () => {
  it("moves between the shown regions to their current or preferred element, then leaves the page", () => {
    const shell = bridge();
    regions(document, REGIONS, shell);
    expect(press()).toBe(false);
    expect(document.activeElement?.id).toBe("b");
    expect(document.activeElement?.hasAttribute("data-region-focus")).toBe(true);
    press();
    expect(document.activeElement?.id).toBe("composer");
    expect(document.getElementById("b")!.hasAttribute("data-region-focus")).toBe(false);
    // The panel is hidden: past the last shown region, focus leaves the page.
    press();
    expect(shell.leave).toHaveBeenCalledWith(1);
    press(true);
    expect(document.activeElement?.id).toBe("b");
    press(true);
    expect(shell.leave).toHaveBeenCalledWith(-1);
  });

  it("comes back to what had focus in a region, while it can still take it", () => {
    regions(document, REGIONS, bridge());
    document.getElementById("c")!.focus();
    press(true);
    press();
    expect(document.activeElement?.id).toBe("c");
    document.getElementById("c")!.hidden = true;
    press(true);
    press();
    expect(document.activeElement?.id).toBe("composer");
  });

  it("enters at the first region going forward and the last going back", () => {
    const shell = bridge();
    regions(document, REGIONS, shell);
    document.querySelector<HTMLElement>(".panel")!.hidden = false;
    shell.enter(1);
    expect(document.activeElement?.id).toBe("b");
    shell.enter(-1);
    expect(document.activeElement?.id).toBe("search");
  });

  it("starts at an end when focus is outside every region", () => {
    regions(document, REGIONS, bridge());
    (document.activeElement as HTMLElement | null)?.blur();
    press(true, document.body);
    expect(document.activeElement?.id).toBe("composer");
  });

  it("focuses a region with nothing focusable itself", () => {
    const shell = bridge();
    regions(document, [{ selector: ".empty" }], shell);
    shell.enter(1);
    const region = document.querySelector<HTMLElement>(".empty")!;
    expect(document.activeElement).toBe(region);
    expect(region.tabIndex).toBe(-1);
  });

  it("wraps around within the page without a shell to leave to, and ignores other keys", () => {
    regions(document, REGIONS);
    press();
    press();
    press();
    expect(document.activeElement?.id).toBe("b");
    press(true);
    expect(document.activeElement?.id).toBe("composer");
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    expect(document.body.dispatchEvent(tab)).toBe(true);
  });

  it("hands focus on when no region is shown", () => {
    const shell = bridge();
    regions(document, [{ selector: ".panel" }], shell);
    press(false, document.body);
    expect(shell.leave).toHaveBeenCalledWith(1);
    shell.enter(1);
    expect(document.activeElement).toBe(document.body);
    // And without a shell, nothing happens.
    regions(document, [{ selector: ".missing" }]);
  });
});
