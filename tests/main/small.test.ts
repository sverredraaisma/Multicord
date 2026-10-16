import { describe, expect, it } from "vitest";
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

describe("isPlatformPage", () => {
  it("accepts the platform's own https site, and siblings under a parent it owns", async () => {
    const { isPlatformPage } = await import("../../src/main/sessionPolicy");
    expect(isPlatformPage("https://discord.com/app", "https://discord.com/app")).toBe(true);
    expect(isPlatformPage("https://media.discord.com/x", "https://discord.com/app")).toBe(true);
    expect(isPlatformPage("https://call.element.io/room", "https://app.element.io")).toBe(true);
    expect(isPlatformPage("https://evildiscord.com/", "https://discord.com/app")).toBe(false);
    expect(isPlatformPage("https://other.github.io/", "https://me.github.io/chat")).toBe(false);
    expect(isPlatformPage("https://me.github.io/x", "https://me.github.io/chat")).toBe(true);
    expect(isPlatformPage("http://discord.com/", "https://discord.com/app")).toBe(false);
    expect(isPlatformPage("not a url", "https://discord.com/app")).toBe(false);
    expect(isPlatformPage(undefined, "https://discord.com/app")).toBe(false);
  });
});
