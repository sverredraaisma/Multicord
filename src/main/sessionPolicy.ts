// Permission and navigation policy for guest views.

const ALLOWED_PERMISSIONS = new Set([
  "notifications",
  "media",
  "display-capture",
  "clipboard-sanitized-write",
  "fullscreen",
]);

export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

export type OpenDecision = "allow" | "external" | "deny";

/**
 * Same-origin popups (Discord's OAuth and pop-out flows) stay in the app; other
 * http(s) links open in the user's browser; everything else is refused.
 */
export function decideWindowOpen(url: string, platformUrl: string): OpenDecision {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return "deny";
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return "deny";
  return target.origin === new URL(platformUrl).origin ? "allow" : "external";
}
