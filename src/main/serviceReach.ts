import type { Session } from "electron";
import { checkUrl, createAddressGuard } from "./netPolicy";

/** How long a reachability check waits for an answer. */
export const REACH_TIMEOUT_MS = 10_000;

/**
 * Asks addresses on one service's own host whether it answers, for the
 * checks web apps make of their service. The requests go through a session
 * of the shell's own, made on first use (an in-memory partition, so none of
 * the service's cookies or storage go with them, and nothing is kept):
 * https only, every hop on that host and at a public address (names checked
 * by what they resolve to), without permissions, within REACH_TIMEOUT_MS.
 * Resolves to the HTTP status, with the body left unread; rejects when the
 * service could not be reached.
 */
export function createServiceReach(open: () => Session, host: string, timeoutMs = REACH_TIMEOUT_MS): (url: string) => Promise<number> {
  const policy = { schemes: ["https:"], hosts: [host] };
  let ses: Session | undefined;
  const prepare = (): Session => {
    if (ses) return ses;
    const made = open();
    made.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    made.setPermissionCheckHandler(() => false);
    const publicAddress = createAddressGuard(async (name) => (await made.resolveHost(name)).endpoints.map((e) => e.address));
    made.webRequest.onBeforeRequest((details, callback) => {
      if (checkUrl(details.url, policy) !== undefined) return callback({ cancel: true });
      void publicAddress(details.url).then((ok) => callback({ cancel: !ok }));
    });
    return (ses = made);
  };
  return async (url) => {
    const problem = checkUrl(url, policy);
    if (problem) throw new Error(problem);
    const response = await prepare().fetch(url, { credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => {});
    return response.status;
  };
}
