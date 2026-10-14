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

export const TOOLTIP_WIDTH = 280;
export const TOOLTIP_HEIGHT = 44;

/** Places the tooltip overlay beside the rail, centred on the hovered item and kept on screen. */
export function tooltipBounds(itemCentreY: number, windowHeight: number, railWidth = RAIL_WIDTH): Rect {
  const max = Math.max(0, Math.floor(windowHeight) - TOOLTIP_HEIGHT);
  const y = Math.min(max, Math.max(0, Math.round(itemCentreY - TOOLTIP_HEIGHT / 2)));
  return { x: railWidth, y, width: TOOLTIP_WIDTH, height: TOOLTIP_HEIGHT };
}
