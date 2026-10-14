import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_INTERVAL_MS, Updater, type UpdaterLike } from "../../src/main/updater";

function fakeUpdater() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const fake = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
    on: (event: string, listener: (...args: unknown[]) => void) => void listeners.set(event, listener),
    fire: (event: string, ...args: unknown[]) => listeners.get(event)!(...args),
  };
  return fake as typeof fake & UpdaterLike;
}

afterEach(() => vi.useRealTimers());

describe("Updater", () => {
  it("does nothing in a development run", async () => {
    const fake = fakeUpdater();
    const updater = new Updater(fake, false);
    expect(updater.status).toEqual({ state: "unavailable" });
    updater.setAutomatic(true);
    await updater.check();
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
  });

  it("follows electron-updater's events", () => {
    const fake = fakeUpdater();
    const updater = new Updater(fake, true);
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    const changes = vi.fn();
    updater.changed.on(changes);
    fake.fire("checking-for-update");
    expect(updater.status).toEqual({ state: "checking" });
    fake.fire("update-not-available");
    expect(updater.status).toEqual({ state: "none" });
    fake.fire("download-progress", { percent: 10 }); // not downloading: ignored
    expect(updater.status).toEqual({ state: "none" });
    fake.fire("update-available", { version: "0.2.0" });
    fake.fire("download-progress", { percent: 42.4 });
    expect(updater.status).toEqual({ state: "downloading", version: "0.2.0", percent: 42 });
    fake.fire("download-progress", {});
    expect(updater.status).toMatchObject({ percent: 0 });
    fake.fire("update-downloaded", { version: "0.2.0" });
    expect(updater.status).toEqual({ state: "ready", version: "0.2.0" });
    fake.fire("update-available", {});
    expect(updater.status).toMatchObject({ version: "" });
    fake.fire("update-downloaded", {});
    expect(updater.status).toEqual({ state: "ready", version: "" });
    fake.fire("error", new Error("offline"));
    expect(updater.status).toEqual({ state: "error", message: "offline" });
    fake.fire("error", "plain");
    expect(updater.status).toEqual({ state: "error", message: "plain" });
    expect(changes).toHaveBeenCalledTimes(10);
  });

  it("checks at start and every few hours while automatic, and on request", async () => {
    vi.useFakeTimers();
    const fake = fakeUpdater();
    const updater = new Updater(fake, true);
    updater.setAutomatic(true);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.setAutomatic(false);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
    await updater.check();
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it("skips checks while busy and reports failures", async () => {
    const fake = fakeUpdater();
    const updater = new Updater(fake, true);
    fake.fire("checking-for-update");
    await updater.check();
    fake.fire("update-available", { version: "1" });
    await updater.check();
    fake.fire("update-downloaded", { version: "1" });
    await updater.check();
    expect(fake.checkForUpdates).not.toHaveBeenCalled();

    const failing = fakeUpdater();
    failing.checkForUpdates.mockRejectedValueOnce(new Error("no network"));
    const second = new Updater(failing, true);
    await second.check();
    expect(second.status).toEqual({ state: "error", message: "no network" });
  });

  it("installs only a downloaded update", () => {
    const fake = fakeUpdater();
    const updater = new Updater(fake, true);
    updater.install();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    fake.fire("update-downloaded", { version: "2" });
    updater.install();
    expect(fake.quitAndInstall).toHaveBeenCalled();
  });
});
