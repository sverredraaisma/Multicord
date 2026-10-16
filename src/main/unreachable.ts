// Web services whose page failed to load (offline, or the service is down).
// Chromium shows a blank error page then; the shell covers it with a page of
// its own (static/unreachable.html) that says so in plain words, with Try
// again and a way to Settings, and takes it away once the service loads.
import { netErrorText } from "../shared/netErrors";

/** Chromium's code for a load that was cancelled (another navigation took over): not a failure. */
const ABORTED = -3;

/** The events of a service view's WebContents this watches. */
export interface LoadEvents {
  on(event: "did-start-navigation", listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown;
  on(event: "did-fail-load", listener: (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void): unknown;
  on(event: "did-finish-load", listener: () => void): unknown;
}

export interface LoadFailure {
  /** Why, in plain words. */
  reason: string;
  /** Chromium's error name (ERR_NAME_NOT_RESOLVED), for Diagnostics-minded users. */
  code: string;
  /** A new load is under way (Try again, or the page reloading itself). */
  retrying: boolean;
}

/** A failed load's reason in plain words. */
export function failureReason(code: string): string {
  return netErrorText(code) ?? "the page did not load";
}

/** Which services' pages failed to load, kept current from their views' load events. */
export class LoadFailures {
  private readonly failures = new Map<string, LoadFailure>();

  /** `changed` hears the service whose failure appeared, changed or cleared. */
  constructor(private readonly changed: (id: string) => void) {}

  watch(id: string, contents: LoadEvents): void {
    // Chromium commits an error page after a failure, which "finishes loading" too: that does not clear it.
    let failed = false;
    contents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      failed = false;
      const failure = this.failures.get(id);
      if (failure && !failure.retrying) {
        failure.retrying = true;
        this.changed(id);
      }
    });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === ABORTED) return;
      failed = true;
      this.failures.set(id, { reason: failureReason(description), code: description, retrying: false });
      this.changed(id);
    });
    contents.on("did-finish-load", () => {
      if (!failed && this.failures.delete(id)) this.changed(id);
    });
  }

  /** The service's failure, while its page has not loaded since. */
  get(id: string): LoadFailure | undefined {
    const failure = this.failures.get(id);
    return failure && { ...failure };
  }
}
