// F6 travel between the window's pages (the rail, a service, Settings,
// Messages), as browsers move between their frames: the main process knows
// which pages are on screen and in which order.

/** The keyboard input F6 travel takes, as Electron's before-input-event gives it. */
export interface KeyInput {
  type: string;
  key: string;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** F6 (also Ctrl+F6) forward, Shift+F6 back; undefined for any other input. */
export function regionStep(input: KeyInput): 1 | -1 | undefined {
  if (input.type !== "keyDown" || input.key !== "F6" || input.alt || input.meta) return undefined;
  return input.shift ? -1 : 1;
}

/** The page after (or before) `from` among `pages`, wrapping around; the first (or last) if `from` is not among them. */
export function nextPage<T>(pages: readonly T[], from: T, direction: 1 | -1): T | undefined {
  if (pages.length === 0) return undefined;
  const at = pages.indexOf(from);
  if (at === -1) return pages[direction === 1 ? 0 : pages.length - 1];
  return pages[(at + direction + pages.length) % pages.length];
}
