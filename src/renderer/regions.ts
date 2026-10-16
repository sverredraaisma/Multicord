// F6 and Shift+F6 (also with Ctrl) move focus between the parts of the
// window, as browsers move between their frames and toolbars. Each part of
// Multicord's window is a page of its own (the rail, a service, Settings), so
// a page moves focus between its own regions and, past its first or last,
// asks the shell to move on to the next page, which then focuses its first
// region (or its last, going backwards).

/** The shell's side: leave this page in a direction, and hear when focus arrives from another. */
export interface FocusBridge {
  onEnter(cb: (direction: 1 | -1) => void): void;
  leave(direction: 1 | -1): void;
}

/** A region of the page: where it is, and optionally what in it to focus first. */
export interface Region {
  selector: string;
  prefer?: string;
}

/** The direction F6 (forward) or Shift+F6 (back) moves in; undefined for other keys. Ctrl+F6 is F6. */
export function regionStep(event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "metaKey">): 1 | -1 | undefined {
  if (event.key !== "F6" || event.altKey || event.metaKey) return undefined;
  return event.shiftKey ? -1 : 1;
}

const FOCUSABLE = 'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])';
const CURRENT = '[aria-current]:not([aria-current="false"]), [aria-selected="true"], [aria-pressed="true"], .active';

function shown(element: Element): boolean {
  if (element.closest("[hidden]")) return false;
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(element) : true;
}

function usable(element: Element | null | undefined): element is HTMLElement {
  return element !== null && element !== undefined && element.isConnected && shown(element) && !(element as HTMLButtonElement).disabled;
}

/**
 * Moves focus between `regions` (those shown, in this order) on F6, and in
 * from the shell through `bridge`. Without a bridge (a phone, where the page
 * is the whole screen), focus wraps around within the page. Returns what
 * stops it listening.
 */
export function focusRegions(doc: Document, regions: Region[], bridge?: Partial<FocusBridge>): () => void {
  /** What had focus last in each region, to come back to. */
  const last = new WeakMap<Element, HTMLElement>();
  const present = (): { element: HTMLElement; region: Region }[] =>
    regions.flatMap((region) => [...doc.querySelectorAll<HTMLElement>(region.selector)].filter(shown).map((element) => ({ element, region })));

  const remember = (event: FocusEvent): void => {
    const target = event.target as HTMLElement;
    const region = present().find((r) => r.element.contains(target));
    if (region) last.set(region.element, target);
  };

  const enter = ({ element, region }: { element: HTMLElement; region: Region }): void => {
    const remembered = last.get(element);
    const candidates = [
      remembered,
      region.prefer ? element.querySelector(region.prefer) : null,
      ...element.querySelectorAll(CURRENT),
      ...element.querySelectorAll(FOCUSABLE),
    ];
    let target = candidates.find((c) => usable(c) && (c === remembered || c.matches(FOCUSABLE) || c.tabIndex >= 0)) as HTMLElement | undefined;
    if (!target) {
      element.tabIndex = -1;
      target = element;
    }
    // Shown as keyboard focus: the key was pressed in another page, which Chromium's own heuristic cannot see.
    target.setAttribute("data-region-focus", "");
    target.addEventListener("blur", () => target.removeAttribute("data-region-focus"), { once: true });
    target.focus({ focusVisible: true } as FocusOptions);
  };

  const move = (direction: 1 | -1): void => {
    const list = present();
    if (list.length === 0) return bridge?.leave?.(direction);
    const active = doc.activeElement;
    const at = list.findIndex((r) => active !== null && r.element.contains(active));
    const next = at === -1 ? (direction === 1 ? 0 : list.length - 1) : at + direction;
    if (next >= 0 && next < list.length) return enter(list[next]!);
    if (bridge?.leave) return bridge.leave(direction);
    enter(list[(next + list.length) % list.length]!);
  };

  const onKey = (event: KeyboardEvent): void => {
    const direction = regionStep(event);
    if (direction === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    move(direction);
  };

  let listening = true;
  doc.addEventListener("focusin", remember);
  doc.addEventListener("keydown", onKey, true);
  bridge?.onEnter?.((direction) => {
    const list = present();
    if (listening && list.length > 0) enter(list[direction === 1 ? 0 : list.length - 1]!);
  });
  return () => {
    listening = false;
    doc.removeEventListener("focusin", remember);
    doc.removeEventListener("keydown", onKey, true);
  };
}
