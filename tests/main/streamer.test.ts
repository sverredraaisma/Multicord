import { afterEach, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

import { isStreamingProcess, listProcesses, parseProcessList, StreamerWatch } from "../../src/main/streamer";

afterEach(() => vi.useRealTimers());

describe("streaming software", () => {
  it("recognises streaming apps by bare name, .exe or path", () => {
    expect(isStreamingProcess("obs64.exe")).toBe(true);
    expect(isStreamingProcess("/Applications/OBS.app/Contents/MacOS/OBS")).toBe(true);
    expect(isStreamingProcess("C:\\Program Files\\Streamlabs OBS\\Streamlabs OBS.exe")).toBe(true);
    expect(isStreamingProcess(" vMix64.exe ")).toBe(true);
    expect(isStreamingProcess("notepad.exe")).toBe(false);
    expect(isStreamingProcess("obsidian")).toBe(false);
  });

  it("parses tasklist and ps output", () => {
    expect(parseProcessList('"obs64.exe","1234","Console","1","200,000 K"\r\n"explorer.exe","5"\r\n\r\nbroken line\n', "win32")).toEqual(["obs64.exe", "explorer.exe"]);
    expect(parseProcessList("  /usr/bin/obs\nbash\n\n", "linux")).toEqual(["/usr/bin/obs", "bash"]);
  });

  it("lists processes with the OS's tool, or nothing when it fails", async () => {
    execFile.mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, '"obs64.exe","1"\n'));
    expect(await listProcesses("win32")).toEqual(["obs64.exe"]);
    expect(execFile).toHaveBeenLastCalledWith("tasklist", ["/fo", "csv", "/nh"], expect.objectContaining({ windowsHide: true }), expect.any(Function));
    execFile.mockImplementationOnce((_cmd, _args, _options, callback) => callback(new Error("ENOENT"), ""));
    expect(await listProcesses("darwin")).toEqual([]);
    expect(execFile).toHaveBeenLastCalledWith("ps", ["-A", "-o", "comm="], expect.anything(), expect.any(Function));
  });
});

describe("StreamerWatch", () => {
  it("looks a moment after starting, then every interval, and reports changes only", async () => {
    vi.useFakeTimers();
    let names = ["explorer.exe"];
    const list = vi.fn(async () => names);
    const watch = new StreamerWatch(list, 1000, 100);
    const changes = vi.fn();
    watch.changed.on(changes);
    watch.start();
    watch.start(); // already running
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(list).toHaveBeenCalledOnce();
    expect(watch.active).toBe(false);
    names = ["obs64.exe"];
    await vi.advanceTimersByTimeAsync(1000);
    expect(watch.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes.mock.calls).toEqual([[true]]);
    watch.stop();
    expect(watch.active).toBe(false);
    expect(changes).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("ignores a listing that finishes after stopping", async () => {
    vi.useFakeTimers();
    let finish: (names: string[]) => void = () => {};
    const watch = new StreamerWatch(() => new Promise((resolve) => (finish = resolve)), 1000, 10);
    watch.start();
    await vi.advanceTimersByTimeAsync(10);
    watch.stop();
    finish(["obs"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(watch.active).toBe(false);
  });
});
