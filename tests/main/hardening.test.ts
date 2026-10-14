import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import * as electron from "../mocks/electron";
import { hardenContents, installHardening, isNavigableUrl, isShellRequestAllowed } from "../../src/main/hardening";

beforeEach(() => electron.resetElectron());

describe("hardening", () => {
  it("lets views navigate only to web pages", () => {
    expect(isNavigableUrl("https://discord.com/app")).toBe(true);
    expect(isNavigableUrl("HTTP://example.com")).toBe(true);
    for (const url of ["file:///C:/secret", "javascript:alert(1)", "data:text/html,x", "multicord-engine://x/", "chrome://gpu"]) {
      expect(isNavigableUrl(url)).toBe(false);
    }
  });

  it("blocks webviews and navigation or redirects away from the web", () => {
    const contents = new EventEmitter();
    hardenContents(contents as never);
    const event = () => ({ preventDefault: vi.fn() });
    const webview = event();
    contents.emit("will-attach-webview", webview);
    expect(webview.preventDefault).toHaveBeenCalled();
    const file = event();
    contents.emit("will-navigate", file, "file:///C:/x");
    expect(file.preventDefault).toHaveBeenCalled();
    const web = event();
    contents.emit("will-navigate", web, "https://example.com");
    expect(web.preventDefault).not.toHaveBeenCalled();
    const redirect = event();
    contents.emit("will-redirect", redirect, "javascript:alert(1)");
    expect(redirect.preventDefault).toHaveBeenCalled();
  });

  it("hardens every new web contents and denies the default session everything", () => {
    installHardening();
    const contents = new EventEmitter();
    electron.app.emit("web-contents-created", {}, contents);
    const webview = { preventDefault: vi.fn() };
    contents.emit("will-attach-webview", webview);
    expect(webview.preventDefault).toHaveBeenCalled();
    const ses = electron.session.defaultSession;
    const callback = vi.fn();
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "media", callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect((ses.permissionCheckHandler as (...a: unknown[]) => boolean)(null, "notifications")).toBe(false);
    let cancel: boolean | undefined;
    ses.beforeRequest!({ url: "https://10.0.0.1/icon.png" }, (response) => (cancel = response.cancel));
    expect(cancel).toBe(true);
  });

  it("lets Multicord's own pages load their files and public https images only", () => {
    for (const url of ["file:///C:/app/dist/rail.js", "data:image/png;base64,AA", "blob:file:///1", "https://cdn.discordapp.com/icons/1/a.png"]) {
      expect(isShellRequestAllowed(url)).toBe(true);
    }
    for (const url of ["http://cdn.example/a.png", "https://localhost/a.png", "https://192.168.0.1/", "ftp://x/", "not a url"]) {
      expect(isShellRequestAllowed(url)).toBe(false);
    }
  });
});
