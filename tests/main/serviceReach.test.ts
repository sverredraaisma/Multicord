import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import type { Session } from "electron";
import { FakeSession } from "../mocks/electron";
import { createServiceReach, REACH_TIMEOUT_MS } from "../../src/main/serviceReach";

const made = () => {
  const ses = new FakeSession("service-check-test");
  const open = vi.fn(() => ses as unknown as Session);
  return { ses, open, reach: createServiceReach(open, "stoat.chat") };
};

/** What the session's request filter decides for a URL. */
const decide = (ses: FakeSession, url: string) => new Promise<boolean>((resolve) => ses.beforeRequest!({ url }, ({ cancel }) => resolve(cancel)));

describe("service reach", () => {
  it("asks the service's own host without cookies, through a session made on first use, and gives the status", async () => {
    const { ses, open, reach } = made();
    expect(open).not.toHaveBeenCalled();
    const body = new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([1])) });
    const cancel = vi.spyOn(body, "cancel");
    ses.fetch.mockResolvedValueOnce(new Response(body, { status: 404 }));
    await expect(reach("https://stoat.chat/api/")).resolves.toBe(404);
    expect(cancel).toHaveBeenCalled();
    const [url, init] = ses.fetch.mock.calls[0]! as [string, { credentials: string; signal: AbortSignal }];
    expect(url).toBe("https://stoat.chat/api/");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    await expect(reach("https://stoat.chat/api/")).resolves.toBe(200);
    expect(open).toHaveBeenCalledTimes(1);
    expect(REACH_TIMEOUT_MS).toBe(10_000);
    // The session grants nothing.
    const granted = vi.fn();
    const handlers = ses as unknown as { permissionRequestHandler(wc: unknown, permission: string, callback: (granted: boolean) => void): void; permissionCheckHandler(): boolean };
    handlers.permissionRequestHandler({}, "media", granted);
    expect(granted).toHaveBeenCalledWith(false);
    expect(handlers.permissionCheckHandler()).toBe(false);
  });

  it("refuses other hosts, plain http and private addresses, also on redirects", async () => {
    const { ses, reach } = made();
    for (const url of ["https://evil.example/api/", "http://stoat.chat/api/", "https://user:pw@stoat.chat/"]) await expect(reach(url)).rejects.toThrow();
    expect(ses.fetch).not.toHaveBeenCalled();
    await reach("https://stoat.chat/");
    expect(await decide(ses, "https://stoat.chat/api/")).toBe(false);
    expect(await decide(ses, "https://cdn.stoat.chat/")).toBe(true);
    expect(await decide(ses, "http://stoat.chat/")).toBe(true);
    // A name that resolves to the local network is refused too.
    const local = made();
    local.ses.resolveHost.mockResolvedValue({ endpoints: [{ address: "10.0.0.2", family: "ipv4" }] });
    await local.reach("https://stoat.chat/");
    expect(await decide(local.ses, "https://stoat.chat/x")).toBe(true);
  });

  it("rejects when the service cannot be reached", async () => {
    const { ses, reach } = made();
    ses.fetch.mockRejectedValueOnce(new Error("net::ERR_NAME_NOT_RESOLVED"));
    await expect(reach("https://stoat.chat/api/")).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
    // A body that will not cancel does not matter.
    ses.fetch.mockResolvedValueOnce({ status: 502, body: { cancel: () => Promise.reject(new Error("gone")) } } as unknown as Response);
    await expect(reach("https://stoat.chat/api/")).resolves.toBe(502);
    ses.fetch.mockResolvedValueOnce({ status: 204, body: null } as unknown as Response);
    await expect(reach("https://stoat.chat/api/")).resolves.toBe(204);
  });
});
