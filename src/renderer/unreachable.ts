import type { ShellApi } from "../preload/shell";

/**
 * The shell's own page over a web service whose page did not load: which
 * service, why in plain words, Try again (which says so while it tries) and
 * a way to Settings. It shows nothing of the service itself.
 */
export function startUnreachable(doc: Document, api: Pick<ShellApi, "onUnreachable" | "retry" | "openSettings">): void {
  const title = doc.getElementById("unreachable-title")!;
  const reason = doc.getElementById("unreachable-reason")!;
  const code = doc.getElementById("unreachable-code")!;
  const retry = doc.getElementById("unreachable-retry") as HTMLButtonElement;
  const settings = doc.getElementById("unreachable-settings") as HTMLButtonElement;
  retry.addEventListener("click", () => {
    if (retry.getAttribute("aria-disabled") !== "true") api.retry();
  });
  settings.addEventListener("click", () => api.openSettings());
  api.onUnreachable((state) => {
    title.textContent = `Couldn't reach ${state.service}`;
    const why = state.reason.charAt(0).toUpperCase() + state.reason.slice(1);
    reason.textContent = `${why}. ${state.service} may also be down for a while.`;
    code.textContent = state.code ? `Error: ${state.code}` : "";
    retry.textContent = state.retrying ? "Trying again…" : "Try again";
    // Kept focusable while busy (aria-disabled, not disabled), so focus is not lost mid-retry.
    retry.setAttribute("aria-disabled", String(state.retrying));
  });
}
