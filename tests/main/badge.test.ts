import { describe, expect, it } from "vitest";
import { BADGE_SIZE, badgeBitmap, badgeText } from "../../src/main/badge";

/** The badge as rows of characters: "." outside, "r" red, "w" white. */
function picture(count: number): string[] {
  const pixels = badgeBitmap(count);
  const rows: string[] = [];
  for (let y = 0; y < BADGE_SIZE; y++) {
    let row = "";
    for (let x = 0; x < BADGE_SIZE; x++) {
      const at = (y * BADGE_SIZE + x) * 4;
      row += pixels[at + 3] === 0 ? "." : pixels[at] === 0xff ? "w" : "r";
    }
    rows.push(row);
  }
  return rows;
}

describe("taskbar badge", () => {
  it("says the count up to 9, then 9+", () => {
    expect([0, 1, 9, 10, 250, -3, 2.7].map(badgeText)).toEqual(["0", "1", "9", "9+", "9+", "0", "2"]);
  });

  it("draws a red disc with the count in white, as BGRA", () => {
    const pixels = badgeBitmap(1);
    expect(pixels).toHaveLength(BADGE_SIZE * BADGE_SIZE * 4);
    const rows = picture(1);
    // Corners stay clear, the middle is the disc.
    expect(rows[0]![0]).toBe(".");
    expect(rows[15]![15]).toBe(".");
    expect(rows[1]![8]).toBe("r");
    // Red is stored blue first.
    const edge = (1 * BADGE_SIZE + 8) * 4;
    expect([...pixels.subarray(edge, edge + 4)]).toEqual([0x3c, 0x3d, 0xed, 255]);
    // A "1", twice as large: its foot is a 6-pixel bar.
    expect(rows.filter((row) => row.includes("wwwwww"))).toHaveLength(2);
  });

  it("fits 9+ in plain size", () => {
    const rows = picture(12).map((row) => row.replace(/[.r]/g, " ").trimEnd());
    expect(rows.filter((row) => row.trim() !== "")).toEqual(["    www", "    w w  w", "    www www", "      w  w", "    www"]);
  });
});
