import { describe, expect, it } from "vitest";
import { computeLayout, RAIL_WIDTH, TOOLTIP_HEIGHT, TOOLTIP_WIDTH, tooltipBounds } from "../../src/main/layout";
import { decideWindowOpen, isPermissionAllowed } from "../../src/main/sessionPolicy";
import { toChromeUserAgent } from "../../src/main/userAgent";
import { DEFAULT_WINDOW_STATE, parseWindowState, serializeWindowState } from "../../src/main/windowState";

describe("toChromeUserAgent", () => {
  it("strips Electron and app tokens but keeps the real Chrome version", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Multicord/0.1.0 Chrome/140.0.0.0 Electron/44.7.2 Safari/537.36";
    expect(toChromeUserAgent(ua, "Multicord")).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    );
  });

  it("escapes regex characters in the app name", () => {
    expect(toChromeUserAgent("A a.b/1 Chrome/1 x+y/2", "x+y")).toBe("A a.b/1 Chrome/1");
  });
});

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

describe("window state", () => {
  it("round-trips", () => {
    const text = serializeWindowState({ x: 5, y: 6, width: 900, height: 600 }, true);
    expect(parseWindowState(text)).toEqual({ x: 5, y: 6, width: 900, height: 600, maximized: true });
  });

  it("falls back to defaults on bad input", () => {
    expect(parseWindowState(undefined)).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState("{")).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState("null")).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState(JSON.stringify({ width: 10, height: 1.5, x: 1 }))).toEqual(DEFAULT_WINDOW_STATE);
  });
});

describe("session policy", () => {
  it("allows only the permissions chat clients need", () => {
    expect(isPermissionAllowed("notifications")).toBe(true);
    expect(isPermissionAllowed("media")).toBe(true);
    expect(isPermissionAllowed("geolocation")).toBe(false);
    expect(isPermissionAllowed("openExternal")).toBe(false);
  });

  it("keeps same-origin popups, sends other web links to the browser", () => {
    const base = "https://discord.com/app";
    expect(decideWindowOpen("https://discord.com/oauth2/authorize", base)).toBe("allow");
    expect(decideWindowOpen("https://example.com", base)).toBe("external");
    expect(decideWindowOpen("http://example.com", base)).toBe("external");
    expect(decideWindowOpen("file:///C:/Windows", base)).toBe("deny");
    expect(decideWindowOpen("not a url", base)).toBe("deny");
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
  it("splits the content area into the list and the conversation", async () => {
    const { splitContent, MESSAGES_LIST_WIDTH } = await import("../../src/main/layout");
    expect(splitContent({ x: 72, y: 0, width: 1000, height: 700 })).toEqual({
      list: { x: 72, y: 0, width: MESSAGES_LIST_WIDTH, height: 700 },
      conversation: { x: 72 + MESSAGES_LIST_WIDTH, y: 0, width: 1000 - MESSAGES_LIST_WIDTH, height: 700 },
    });
    expect(splitContent({ x: 0, y: 0, width: 200, height: 10 }).conversation.width).toBe(0);
  });
});
