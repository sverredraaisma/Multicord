// Single sign-on for engines (Matrix's m.login.sso): the homeserver's sign-in
// page runs in the user's browser and sends the browser back to a redirect
// address with a one-time login token. Engines are sandboxed and cannot
// listen anywhere, so the shell receives that token for them: on a loopback
// address only, on a random port and a random path, for one request, for a
// few minutes. The token goes back only to the engine that asked, as the
// answer to its request.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** How long the browser has to come back with a token. */
export const SSO_TIMEOUT_MS = 5 * 60_000;
/** Login tokens are opaque; these are the characters homeservers use (Synapse's are "syl_" and base64). */
export const LOGIN_TOKEN = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
/** What an engine may send the browser to: a homeserver's SSO redirect (generic, or for one identity provider), https, without a query of its own. */
const SSO_PATH = /^\/_matrix\/client\/(?:v3|r0)\/login\/sso\/redirect(?:\/[A-Za-z0-9._~-]{1,255})?$/;

const PAGE_HEADERS = { Connection: "close", "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const DONE_PAGE = "<!doctype html><meta charset=utf-8><title>Multicord</title><p>Signed in. You can close this tab and go back to Multicord.</p>";
const FAILED_PAGE = "<!doctype html><meta charset=utf-8><title>Multicord</title><p>Signing in did not work. Go back to Multicord and try again.</p>";

/** Whether an engine may start single sign-on at this address. */
export function isSsoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.search === "" && url.hash === "" && SSO_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export interface LoopbackDeps {
  /** Opens an address in the user's browser. */
  open(url: string): Promise<void>;
  timeoutMs?: number;
}

/**
 * Sends the browser to `ssoUrl` (checked with isSsoUrl) with a loopback
 * address as its redirectUrl, and waits for the one request that brings the
 * login token back. Requests to any other path, or by another method, get
 * 404 and change nothing; the first to the path ends it, with the token or
 * as a failure. Rejects on timeout, or when `signal` aborts.
 */
export function receiveLoginToken(ssoUrl: string, deps: LoopbackDeps, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const secret = `/sso/${randomBytes(24).toString("hex")}`;
    let port = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = URL.parse(`${request.url}`, "http://127.0.0.1");
      // Only the browser coming back to our address: another Host would be a page reaching here by name (DNS rebinding).
      if (settled || !url || request.method !== "GET" || url.pathname !== secret || request.headers.host !== `127.0.0.1:${port}`) {
        response.writeHead(404, { Connection: "close", "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      const token = url.searchParams.get("loginToken");
      const ok = token !== null && LOGIN_TOKEN.test(token);
      response.writeHead(ok ? 200 : 400, PAGE_HEADERS).end(ok ? DONE_PAGE : FAILED_PAGE);
      finish(ok ? undefined : new Error("The sign-in page sent back no usable login token"), token ?? "");
    });
    const finish = (error: Error | undefined, token = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      server.close();
      if (error) reject(error);
      else resolve(token);
    };
    const aborted = (): void => finish(new Error("Single sign-on was cancelled"));
    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted);
    server.on("error", (error) => finish(error));
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      timer = setTimeout(() => finish(new Error("Single sign-on timed out")), deps.timeoutMs ?? SSO_TIMEOUT_MS);
      const target = new URL(ssoUrl);
      target.searchParams.set("redirectUrl", `http://127.0.0.1:${port}${secret}`);
      deps.open(target.href).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  });
}
