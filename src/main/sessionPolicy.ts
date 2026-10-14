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

/** Domains under which unrelated parties get their own subdomains: never one site. */
const SHARED_PARENTS = new Set(["github.io", "gitlab.io", "pages.dev", "netlify.app", "vercel.app", "herokuapp.com", "web.app", "firebaseapp.com", "glitch.me", "onrender.com", "fly.dev", "co.uk", "org.uk", "com.au", "co.jp", "com.br"]);

/**
 * Whether a page at `url` belongs to the platform at `platformUrl`: https on
 * the platform's host or its subdomains, or a sibling under the same parent
 * (so Element's call.element.io counts for app.element.io), but never across
 * a shared hosting domain. Only such pages get the platform's permissions;
 * a view that navigated elsewhere, or a foreign frame, gets none.
 */
export function isPlatformPage(url: string | undefined, platformUrl: string): boolean {
  if (!url) return false;
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return false;
  }
  if (page.protocol !== "https:") return false;
  const host = page.hostname.toLowerCase();
  const own = new URL(platformUrl).hostname.toLowerCase();
  if (host === own || host.endsWith(`.${own}`)) return true;
  const labels = own.split(".");
  const parent = labels.slice(1).join(".");
  return labels.length >= 3 && !SHARED_PARENTS.has(parent) && host.endsWith(`.${parent}`);
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
