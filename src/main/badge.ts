/**
 * The unread badge Windows shows over the taskbar button (setOverlayIcon):
 * app.setBadgeCount does nothing there. Drawn here as a 16x16 bitmap, a red
 * disc with the count in white, so it needs no image files or libraries.
 */

export const BADGE_SIZE = 16;

/** 3x5 pixel glyphs, one string per row, "#" lit. */
const GLYPHS: Record<string, string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", "###", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", "..#", "..#", "..#"],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  "+": ["...", ".#.", "###", ".#.", "..."],
};

/** What the badge says: the count up to 9, then "9+". */
export function badgeText(count: number): string {
  return count > 9 ? "9+" : String(Math.max(0, Math.floor(count)));
}

/**
 * The badge as raw BGRA pixels (what nativeImage.createFromBitmap takes on
 * Windows). One digit is drawn twice as large; "9+" at its plain size.
 */
export function badgeBitmap(count: number): Buffer {
  const pixels = Buffer.alloc(BADGE_SIZE * BADGE_SIZE * 4);
  const set = (x: number, y: number, [b, g, r]: readonly [number, number, number]): void => {
    const at = (y * BADGE_SIZE + x) * 4;
    pixels[at] = b;
    pixels[at + 1] = g;
    pixels[at + 2] = r;
    pixels[at + 3] = 255;
  };
  const red = [0x3c, 0x3d, 0xed] as const;
  const white = [0xff, 0xff, 0xff] as const;
  const centre = (BADGE_SIZE - 1) / 2;
  for (let y = 0; y < BADGE_SIZE; y++) {
    for (let x = 0; x < BADGE_SIZE; x++) if ((x - centre) ** 2 + (y - centre) ** 2 <= (BADGE_SIZE / 2) ** 2) set(x, y, red);
  }
  const text = badgeText(count);
  const scale = text.length === 1 ? 2 : 1;
  const width = text.length * 3 * scale + (text.length - 1);
  const left = Math.floor((BADGE_SIZE - width) / 2);
  const top = Math.floor((BADGE_SIZE - 5 * scale) / 2);
  [...text].forEach((char, i) => {
    const rows = GLYPHS[char]!;
    const x0 = left + i * (3 * scale + 1);
    rows.forEach((row, gy) => {
      [...row].forEach((cell, gx) => {
        if (cell !== "#") return;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(x0 + gx * scale + dx, top + gy * scale + dy, white);
      });
    });
  });
  return pixels;
}
