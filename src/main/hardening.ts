import { app, session, type WebContents } from "electron";

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

/** App-wide hardening; call once the app is ready. */
export function installHardening(): void {
  app.on("web-contents-created", (_event, contents) => hardenContents(contents));
  // Every view has a session of its own; anything on the default one gets no permissions.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}
