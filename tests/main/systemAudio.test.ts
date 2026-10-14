import { describe, expect, it, vi } from "vitest";
import { loadVenmic, SystemAudio, type PatchBayLike, type Venmic } from "../../src/main/systemAudio";

function fakeVenmic(pipewire = true) {
  const bay = { link: vi.fn((_data: unknown) => true), unlink: vi.fn() } satisfies PatchBayLike;
  const PatchBay = Object.assign(
    vi.fn(function () {
      return bay;
    }),
    { hasPipeWire: vi.fn(() => pipewire) },
  );
  return { venmic: { PatchBay } as unknown as Venmic, bay, PatchBay };
}

describe("SystemAudio", () => {
  it("routes the speakers' sound, minus Multicord's own processes, and stops", () => {
    const { venmic, bay, PatchBay } = fakeVenmic();
    const load = vi.fn(() => venmic);
    const audio = new SystemAudio(load, () => [10, 11]);
    expect(audio.available()).toBe(true);
    expect(audio.available()).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(audio.start()).toBe(true);
    expect(bay.link).toHaveBeenCalledWith({
      exclude: [{ "application.process.id": "10" }, { "application.process.id": "11" }],
      only_speakers: true,
      only_default_speakers: true,
      ignore_devices: true,
    });
    audio.start(); // the same patch bay, relinked
    expect(PatchBay).toHaveBeenCalledTimes(1);
    expect(bay.unlink).toHaveBeenCalledTimes(2);
    audio.stop();
    expect(bay.unlink).toHaveBeenCalledTimes(3);
    bay.unlink.mockImplementation(() => {
      throw new Error("PipeWire gone");
    });
    expect(() => audio.stop()).not.toThrow();
    expect(audio.start()).toBe(false);
  });

  it("is unavailable without venmic or PipeWire", () => {
    expect(new SystemAudio(() => undefined, () => []).available()).toBe(false);
    expect(new SystemAudio(() => undefined, () => []).start()).toBe(false);
    expect(new SystemAudio(() => fakeVenmic(false).venmic, () => []).available()).toBe(false);
    const broken = fakeVenmic();
    broken.PatchBay.hasPipeWire.mockImplementation(() => {
      throw new Error("no libpipewire");
    });
    expect(new SystemAudio(() => broken.venmic, () => []).available()).toBe(false);
    new SystemAudio(() => undefined, () => []).stop(); // nothing to stop
    // Not installed here (venmic ships for Linux only).
    expect(loadVenmic()).toBeUndefined();
  });
});
