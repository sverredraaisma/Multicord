import { describe, expect, it, vi } from "vitest";
import { createDisplayMediaHandler, supportsLoopbackAudio } from "../../src/main/screenShare";

const sources = [
  { id: "screen:0", name: "Screen", thumbnail: { toDataURL: () => "data:a" } },
  { id: "window:1", name: "Game", thumbnail: { toDataURL: () => "data:b" } },
];

function handler(choice: unknown, platform: NodeJS.Platform = "win32") {
  const pick = vi.fn(async () => choice as never);
  const run = createDisplayMediaHandler({ getSources: async () => sources, pick, platform });
  return { run, pick };
}

describe("supportsLoopbackAudio", () => {
  it("is Windows, and macOS 13 or later", () => {
    expect(supportsLoopbackAudio("win32")).toBe(true);
    expect(supportsLoopbackAudio("darwin")).toBe(false);
    expect(supportsLoopbackAudio("darwin", "21.6.0")).toBe(false); // macOS 12
    expect(supportsLoopbackAudio("darwin", "22.1.0")).toBe(true); // macOS 13
    expect(supportsLoopbackAudio("darwin", "24.0.0")).toBe(true);
    expect(supportsLoopbackAudio("linux", "6.8.0")).toBe(false);
  });
});

describe("createDisplayMediaHandler", () => {
  it("offers thumbnails and returns the chosen source with loopback audio", async () => {
    const { run, pick } = handler({ id: "window:1", audio: true });
    const callback = vi.fn();
    await run({}, callback);
    expect(pick).toHaveBeenCalledWith({
      sources: [
        { id: "screen:0", name: "Screen", thumbnail: "data:a" },
        { id: "window:1", name: "Game", thumbnail: "data:b" },
      ],
      audioSupported: true,
    });
    expect(callback).toHaveBeenCalledWith({ video: sources[1], audio: "loopback" });
  });

  it("on Linux, shares system sound through venmic, which the page picks up", async () => {
    const systemAudio = { available: vi.fn(() => true), start: vi.fn(() => true) };
    const pick = vi.fn(async () => ({ id: "screen:0", audio: true }) as never);
    const callback = vi.fn();
    await createDisplayMediaHandler({ getSources: async () => sources, pick, platform: "linux", systemAudio })({}, callback);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ audioSupported: true }));
    expect(systemAudio.start).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ video: sources[0] });
    // No sound asked for: venmic stays off.
    systemAudio.start.mockClear();
    pick.mockResolvedValueOnce({ id: "screen:0", audio: false } as never);
    await createDisplayMediaHandler({ getSources: async () => sources, pick, platform: "linux", systemAudio })({}, callback);
    expect(systemAudio.start).not.toHaveBeenCalled();
    // Without venmic, Linux has no screen-share sound.
    systemAudio.available.mockReturnValue(false);
    await createDisplayMediaHandler({ getSources: async () => sources, pick, platform: "linux", systemAudio })({}, callback);
    expect(pick).toHaveBeenLastCalledWith(expect.objectContaining({ audioSupported: false }));
  });

  it("omits audio when not requested or unsupported", async () => {
    const callback = vi.fn();
    await handler({ id: "screen:0", audio: false }).run({}, callback);
    await handler({ id: "screen:0", audio: true }, "linux").run({}, callback);
    expect(callback.mock.calls).toEqual([
      [{ video: sources[0], audio: undefined }],
      [{ video: sources[0], audio: undefined }],
    ]);
  });

  it("denies on cancel, unknown source or failure", async () => {
    const callback = vi.fn();
    await handler(null).run({}, callback);
    await handler({ id: "gone", audio: false }).run({}, callback);
    await createDisplayMediaHandler({
      getSources: async () => {
        throw new Error("no permission");
      },
      pick: vi.fn(),
      platform: "darwin",
    })({}, callback);
    expect(callback.mock.calls).toEqual([[{}], [{}], [{}]]);
  });
});
