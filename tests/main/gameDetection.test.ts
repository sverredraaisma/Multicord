import { afterEach, describe, expect, it, vi } from "vitest";
import { createGameDetector, DETECTED_SOURCE, GameDetector, indexDetectable, type GameDetectorDeps } from "../../src/main/gameDetection";
import type { ActivityUpdate } from "../../src/shared/adapter";

const LIST = [
  { id: "1", name: "Space Game", executables: [{ name: "bin/SpaceGame.exe", os: "win32" }, { name: "spacegame", os: "linux" }] },
  { id: "2", name: "Racer", executables: [{ name: "racer.exe", os: "win32" }, { name: "RacerLauncher.exe", os: "win32", is_launcher: true }] },
  // Two games with the same file name: neither is guessed from it.
  { id: "3", name: "Shared A", executables: [{ name: "game.exe", os: "win32" }] },
  { id: "4", name: "Shared B", executables: [{ name: "x/game.exe", os: "win32" }, { name: "game.exe", os: "win32" }] },
  { id: "5", name: "Again", executables: [{ name: "game.exe", os: "win32" }] },
  { id: "6", name: "Long Linux Name", executables: [{ name: "averyverylongprocessname", os: "linux" }] },
  { id: "bad", name: "Bad id", executables: [{ name: "bad.exe", os: "win32" }] },
  { id: "7", name: "No exes" },
  { id: "8", name: "Odd exes", executables: [null, { os: "win32" }, { name: "", os: "win32" }] },
  null,
];

describe("indexDetectable", () => {
  it("indexes this OS's distinctive executables", () => {
    const win = indexDetectable(LIST, "win32");
    expect([...win.keys()].sort()).toEqual(["racer.exe", "spacegame.exe"]);
    expect(win.get("spacegame.exe")).toEqual({ id: "1", name: "Space Game" });
    const linux = indexDetectable(LIST, "linux");
    expect(linux.get("averyverylongpr")).toEqual({ id: "6", name: "Long Linux Name" });
    expect(indexDetectable({ not: "a list" }, "win32").size).toBe(0);
  });
});

describe("GameDetector", () => {
  afterEach(() => vi.useRealTimers());

  function detector(processes: string[][], extra: Partial<GameDetectorDeps> = {}) {
    const updates: ActivityUpdate[] = [];
    let clock = 1000;
    const list = vi.fn(async () => processes.shift() ?? []);
    const deps: GameDetectorDeps = {
      platform: "win32",
      list,
      fetchDetectable: vi.fn(async () => LIST),
      onActivity: (u) => updates.push(u),
      now: () => clock,
      ...extra,
    };
    const d = new GameDetector(deps);
    return { d, deps, updates, list, tick: (ms: number) => (clock += ms) };
  }

  it("shows the game that runs, keeps it while it runs and clears it when it closes", async () => {
    const { d, updates } = detector([["explorer.exe", "SpaceGame.exe"], ["racer.exe", "spacegame.exe"], ["racer.exe"], []]);
    d.start();
    await d.scan();
    expect(updates).toEqual([
      { source: DETECTED_SOURCE, activity: { application_id: "1", name: "Space Game", type: 0, flags: 0, timestamps: { start: 1000 } } },
    ]);
    await d.scan(); // both run: the one shown stays
    expect(updates).toHaveLength(1);
    await d.scan();
    expect(updates[1]!.activity).toMatchObject({ application_id: "2", name: "Racer" });
    await d.scan();
    expect(updates[2]).toEqual({ source: DETECTED_SOURCE, activity: null });
    d.stop();
    expect(updates).toHaveLength(3);
  });

  it("leaves games a Rich Presence app already shows, and clears on stop", async () => {
    const { d, updates } = detector([["SpaceGame.exe"], ["SpaceGame.exe"]], { covered: (id) => id === "1" });
    d.start();
    await d.scan();
    expect(updates).toEqual([]);
    const other = detector([["racer.exe"]]);
    other.d.start();
    await other.d.scan();
    other.d.stop();
    expect(other.updates.at(-1)).toEqual({ source: DETECTED_SOURCE, activity: null });
    d.stop();
  });

  it("downloads the list daily, retries failures later, and does nothing once stopped", async () => {
    const fetchDetectable = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(LIST);
    const { d, list, tick } = detector([], { fetchDetectable });
    d.start();
    await d.scan();
    expect(list).not.toHaveBeenCalled(); // no list yet
    tick(60_000);
    await d.scan();
    expect(fetchDetectable).toHaveBeenCalledTimes(1); // too soon to retry
    tick(10 * 60_000);
    await d.scan();
    expect(fetchDetectable).toHaveBeenCalledTimes(2);
    await d.scan();
    expect(fetchDetectable).toHaveBeenCalledTimes(2);
    tick(24 * 60 * 60_000);
    await d.scan();
    expect(fetchDetectable).toHaveBeenCalledTimes(3);
    d.stop();
    await d.scan();
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("ignores a process list that arrives after stopping", async () => {
    let release: (names: string[]) => void = () => {};
    const { d, updates } = detector([], { list: () => new Promise((resolve) => (release = resolve)) });
    d.start();
    const scanning = d.scan();
    await Promise.resolve();
    await Promise.resolve();
    d.stop();
    release(["racer.exe"]);
    await scanning;
    expect(updates).toEqual([]);
  });

  it("scans on a timer while started", async () => {
    vi.useFakeTimers();
    const { d, list } = detector([["racer.exe"]], { intervalMs: 5000 });
    d.start();
    d.start(); // once
    await vi.advanceTimersByTimeAsync(2000);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(list).toHaveBeenCalledTimes(2);
    d.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("matches Linux's shortened process names", async () => {
    const { d, updates } = detector([["/usr/bin/averyverylongpr"]], { platform: "linux" });
    d.start();
    await d.scan();
    expect(updates[0]!.activity).toMatchObject({ application_id: "6" });
    d.stop();
  });

  it("downloads Discord's list in the app", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(LIST)));
    vi.stubGlobal("fetch", fetchMock);
    const updates: ActivityUpdate[] = [];
    const d = createGameDetector("win32", async () => ["racer.exe"], (u) => updates.push(u), () => false);
    d.start();
    await d.scan();
    expect(fetchMock).toHaveBeenCalledWith("https://discord.com/api/v9/applications/detectable", expect.anything());
    expect(updates[0]!.activity).toMatchObject({ name: "Racer" });
    d.stop();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    const failing = createGameDetector("win32", async () => [], () => {}, () => false);
    failing.start();
    await failing.scan();
    failing.stop();
    vi.unstubAllGlobals();
  });
});
