import { app, session, type Session, type WebContents } from "electron";
import { isPrivateHost } from "./netPolicy";

/** Only web pages may navigate a view; never to file:, javascript:, data: and the like. */
export function isNavigableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Defaults every web contents gets, whatever its own setup says: no
 * <webview> tags (only the shell creates views) and no page-initiated
 * navigation or redirect to anything but http(s).
 */
export function hardenContents(contents: WebContents): void {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (!isNavigableUrl(url)) event.preventDefault();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
}

/**
 * Requests Multicord's own pages (rail, tooltip, picker, Messages, Settings)
 * may make: their own files and inline data, and https images from public
 * hosts (icons and avatars services name). Nothing on this machine or the
 * local network, and nothing unencrypted.
 */
export function isShellRequestAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (["file:", "data:", "blob:", "devtools:"].includes(parsed.protocol)) return true;
  return parsed.protocol === "https:" && !isPrivateHost(parsed.hostname);
}

export function filterShellRequests(ses: Session): void {
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isShellRequestAllowed(details.url) }));
}

/** App-wide hardening; call once the app is ready. */
export function installHardening(): void {
  app.on("web-contents-created", (_event, contents) => hardenContents(contents));
  // Every view has a session of its own; anything on the default one gets no permissions.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // The rail, tooltip and picker live there.
  filterShellRequests(session.defaultSession);
}
