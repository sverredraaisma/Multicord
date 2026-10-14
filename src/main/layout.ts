export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const RAIL_WIDTH = 72;

export function computeLayout(width: number, height: number, railWidth = RAIL_WIDTH): { rail: Rect; content: Rect } {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const rail = Math.min(railWidth, w);
  return {
    rail: { x: 0, y: 0, width: rail, height: h },
    content: { x: rail, y: 0, width: w - rail, height: h },
  };
}
