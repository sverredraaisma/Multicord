/**
 * Removes the Electron and app-name tokens so web clients see the Chromium
 * build we actually ship. The Chrome version stays truthful; nothing is spoofed.
 */
export function toChromeUserAgent(userAgent: string, appName: string): string {
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return userAgent
    .replace(new RegExp(`\\s(?:Electron|${escaped})/\\S+`, "gi"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
