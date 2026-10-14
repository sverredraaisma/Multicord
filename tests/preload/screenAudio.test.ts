// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordScreenAudio } from "../../src/preload/discord/screenAudio";

const nav = navigator as unknown as { mediaDevices?: { getDisplayMedia?: unknown } };
const saved = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

afterEach(() => {
  if (saved) Object.defineProperty(navigator, "mediaDevices", saved);
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
});

function withMedia(getDisplayMedia: unknown) {
  const media = { getDisplayMedia };
  Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
  return media as { getDisplayMedia: (constraints?: unknown) => Promise<unknown> };
}

describe("discordScreenAudio", () => {
  it("leaves Multicord's own sound out of shared screen audio", async () => {
    const original = vi.fn(async (constraints?: unknown) => constraints);
    const media = withMedia(original);
    // Serialized like the real injection, so it must not depend on its module.
    const serialized = new Function(`return (${discordScreenAudio.toString()})`)() as typeof discordScreenAudio;
    serialized();
    serialized(); // patching twice keeps one layer
    expect(await media.getDisplayMedia({ video: true, audio: true })).toEqual({ video: true, audio: { restrictOwnAudio: true } });
    expect(await media.getDisplayMedia({ audio: { sampleRate: 48000 } })).toEqual({ audio: { sampleRate: 48000, restrictOwnAudio: true } });
    expect(await media.getDisplayMedia({ video: true })).toEqual({ video: true });
    expect(await media.getDisplayMedia()).toBeUndefined();
    expect(original).toHaveBeenCalledTimes(4);
    expect(original.mock.contexts[0]).toBe(media);
  });

  it("does nothing without screen capture", () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    expect(() => discordScreenAudio()).not.toThrow();
    withMedia(undefined);
    discordScreenAudio();
    expect(nav.mediaDevices!.getDisplayMedia).toBeUndefined();
  });
});
