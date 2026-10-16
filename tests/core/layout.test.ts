import { describe, expect, it } from "vitest";
import { computeLayout, MESSAGES_LIST_WIDTH, RAIL_WIDTH, splitContent, TOOLTIP_HEIGHT, TOOLTIP_WIDTH, tooltipBounds } from "../../src/core/layout";

describe("computeLayout", () => {
  it("puts the rail left of the content", () => {
    expect(computeLayout(1000.7, 700)).toEqual({
      rail: { x: 0, y: 0, width: RAIL_WIDTH, height: 700 },
      content: { x: RAIL_WIDTH, y: 0, width: 1000 - RAIL_WIDTH, height: 700 },
    });
  });

  it("never produces negative sizes", () => {
    expect(computeLayout(40, -5)).toEqual({
      rail: { x: 0, y: 0, width: 40, height: 0 },
      content: { x: 40, y: 0, width: 0, height: 0 },
    });
  });
});

describe("tooltipBounds", () => {
  it("centres beside the rail and stays inside the window", () => {
    expect(tooltipBounds(100, 700)).toEqual({ x: RAIL_WIDTH, y: 78, width: TOOLTIP_WIDTH, height: TOOLTIP_HEIGHT });
    expect(tooltipBounds(5, 700).y).toBe(0);
    expect(tooltipBounds(695, 700).y).toBe(700 - TOOLTIP_HEIGHT);
    expect(tooltipBounds(10, 20).y).toBe(0);
  });
});

describe("messages layout", () => {
  it("splits the content area into the list and the conversation", () => {
    expect(splitContent({ x: 72, y: 0, width: 1000, height: 700 })).toEqual({
      list: { x: 72, y: 0, width: MESSAGES_LIST_WIDTH, height: 700 },
      conversation: { x: 72 + MESSAGES_LIST_WIDTH, y: 0, width: 1000 - MESSAGES_LIST_WIDTH, height: 700 },
    });
    expect(splitContent({ x: 0, y: 0, width: 200, height: 10 }).conversation.width).toBe(0);
  });
});
