// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { MAX_QR_BYTES, MAX_QR_VERSION, qrCode, qrPicture } from "../../src/renderer/components/qr";

/** Text of a length, from characters a sign-in link uses. */
const text = (length: number) => Array.from({ length }, (_, i) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[(i * 7 + length) % 64]).join("");

/** The format bits' first copy, as the standard places it around the top-left finder. */
function formatBits(m: boolean[][]): number {
  const cells: boolean[] = [];
  for (let i = 0; i <= 5; i++) cells.push(m[i]![8]!);
  cells.push(m[7]![8]!, m[8]![8]!, m[8]![7]!);
  for (let i = 9; i < 15; i++) cells.push(m[8]![14 - i]!);
  return cells.reduce((value, dark, i) => value | (Number(dark) << i), 0);
}

/** The format bits' second copy, along the bottom-left and top-right finders. */
function formatBitsAgain(m: boolean[][]): number {
  const size = m.length;
  const cells: boolean[] = [];
  for (let i = 0; i < 8; i++) cells.push(m[8]![size - 1 - i]!);
  for (let i = 8; i < 15; i++) cells.push(m[size - 15 + i]![8]!);
  return cells.reduce((value, dark, i) => value | (Number(dark) << i), 0);
}

/** A finder pattern's 7 by 7 rings: dark, light, then a dark 3 by 3 core. */
function finderAt(m: boolean[][], left: number, top: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      if (m[top + y]![left + x] !== (ring !== 2)) return false;
    }
  }
  return true;
}

describe("QR codes", () => {
  it("draws a known code exactly", () => {
    // Checked with an independent decoder (jsQR), as was every length up to MAX_QR_BYTES.
    expect(qrCode("Multicord")!.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""))).toEqual([
      "#######.##.##.#######",
      "#.....#.###...#.....#",
      "#.###.#.#..##.#.###.#",
      "#.###.#...#...#.###.#",
      "#.###.#.#####.#.###.#",
      "#.....#.......#.....#",
      "#######.#.#.#.#######",
      ".....................",
      "#..######..#.#..#.###",
      "....##....###.##.###.",
      "..#.#####..##.....###",
      ".##..#.#....##.#..##.",
      "...#.#########...#...",
      "........###.#.#.##.##",
      "#######.#..#.#..#.#..",
      "#.....#.##....##.####",
      "#.###.#.#.#...##.....",
      "#.###.#.##..###...#..",
      "#.###.#..#.###..#####",
      "#.....#..####..#.####",
      "#######.###.##.#.....",
    ]);
  });

  it("grows a version at a time, up to the largest, with finders, timing and valid level-M format bits", () => {
    const seen = new Set<number>();
    for (let length = 0; length <= MAX_QR_BYTES; length += 3) {
      const m = qrCode(text(length))!;
      const size = m.length;
      const version = (size - 17) / 4;
      seen.add(version);
      expect(finderAt(m, 0, 0) && finderAt(m, size - 7, 0) && finderAt(m, 0, size - 7)).toBe(true);
      for (let i = 8; i < size - 8; i++) expect([m[6]![i], m[i]![6]]).toEqual([i % 2 === 0, i % 2 === 0]);
      expect(m[size - 8]![8]).toBe(true);
      const format = formatBits(m);
      expect(formatBitsAgain(m)).toBe(format);
      const data = (format ^ 0x5412) >>> 10;
      // Level M is 00; the rest is the mask, then the BCH check that matches it.
      expect(data >>> 3).toBe(0);
      let remainder = data;
      for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
      expect(format ^ 0x5412).toBe((data << 10) | remainder);
      if (version >= 7) {
        // Versions 7 and up say which they are, beside the top-right finder.
        let bits = 0;
        for (let i = 0; i < 18; i++) bits |= Number(m[Math.floor(i / 3)]![size - 11 + (i % 3)]) << i;
        expect(bits >>> 12).toBe(version);
      }
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: MAX_QR_VERSION }, (_, i) => i + 1));
  });

  it("encodes UTF-8 and refuses text too long", () => {
    expect(qrCode("héllo")!.length).toBe(21);
    expect(qrCode(text(MAX_QR_BYTES))!.length).toBe(MAX_QR_VERSION * 4 + 17);
    expect(qrCode(text(MAX_QR_BYTES + 1))).toBeUndefined();
  });

  it("draws a code as an SVG picture, dark on light with a quiet zone", () => {
    const svg = qrPicture(document, "Multicord", "Scan me")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 29 29");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Scan me");
    const [background, shape] = [...svg.children];
    expect(background!.getAttribute("fill")).toBe("#fff");
    expect(shape!.getAttribute("fill")).toBe("#000");
    expect(shape!.getAttribute("d")).toMatch(/^M4 4h1v1h-1zM5 4h1v1h-1z/);
    expect(shape!.getAttribute("d")!.match(/M/g)).toHaveLength(qrCode("Multicord")!.flat().filter(Boolean).length);
    expect(qrPicture(document, text(MAX_QR_BYTES + 1), "x")).toBeUndefined();
  });
});
