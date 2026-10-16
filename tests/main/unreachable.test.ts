import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { failureReason, LoadFailures, type LoadEvents } from "../../src/main/unreachable";

const page = () => new EventEmitter() as EventEmitter & LoadEvents;
const navigate = (contents: EventEmitter, details = { isMainFrame: true, isSameDocument: false }) => contents.emit("did-start-navigation", details);
const fail = (contents: EventEmitter, code = -105, description = "ERR_NAME_NOT_RESOLVED", isMainFrame = true) =>
  contents.emit("did-fail-load", {}, code, description, "https://discord.com/app", isMainFrame);

describe("failureReason", () => {
  it("says a failure in plain words, with a fallback for codes it does not know", () => {
    expect(failureReason("ERR_INTERNET_DISCONNECTED")).toBe("there is no internet connection");
    expect(failureReason("ERR_SOMETHING_NEW")).toBe("the page did not load");
  });
});

describe("LoadFailures", () => {
  it("records a main-frame failure and keeps it through the error page Chromium loads after it", () => {
    const changed = vi.fn();
    const failures = new LoadFailures(changed);
    const contents = page();
    failures.watch("discord", contents);
    navigate(contents);
    fail(contents);
    contents.emit("did-finish-load");
    expect(failures.get("discord")).toEqual({ reason: "the server's address could not be found; check your internet connection", code: "ERR_NAME_NOT_RESOLVED", retrying: false });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("discord");
  });

  it("ignores cancelled loads and frames other than the main one", () => {
    const changed = vi.fn();
    const failures = new LoadFailures(changed);
    const contents = page();
    failures.watch("discord", contents);
    fail(contents, -3, "ERR_ABORTED");
    fail(contents, -105, "ERR_NAME_NOT_RESOLVED", false);
    expect(failures.get("discord")).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });

  it("marks a new load as a retry and clears the failure once the page loads", () => {
    const changed = vi.fn();
    const failures = new LoadFailures(changed);
    const contents = page();
    failures.watch("discord", contents);
    fail(contents);
    // An in-page navigation or a frame's is not a new load.
    navigate(contents, { isMainFrame: true, isSameDocument: true });
    navigate(contents, { isMainFrame: false, isSameDocument: false });
    expect(failures.get("discord")?.retrying).toBe(false);
    navigate(contents);
    expect(failures.get("discord")?.retrying).toBe(true);
    navigate(contents);
    expect(changed).toHaveBeenCalledTimes(2);
    contents.emit("did-finish-load");
    expect(failures.get("discord")).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(3);
    // A load that never failed changes nothing.
    contents.emit("did-finish-load");
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("hands out copies", () => {
    const failures = new LoadFailures(() => {});
    const contents = page();
    failures.watch("discord", contents);
    fail(contents);
    failures.get("discord")!.retrying = true;
    expect(failures.get("discord")!.retrying).toBe(false);
  });
});
