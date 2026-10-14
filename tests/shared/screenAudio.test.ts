// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { screenAudioPatch } from "../../src/shared/screenAudio";

const saved = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const END = "test:screen-audio-end";
const MIC = "vencord-screen-share";

afterEach(() => {
  if (saved) Object.defineProperty(navigator, "mediaDevices", saved);
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
});

class FakeTrack extends EventTarget {
  stop = vi.fn();
}

class FakeStream {
  constructor(
    readonly video: FakeTrack[] = [new FakeTrack()],
    readonly audio: FakeTrack[] = [],
  ) {}
  getAudioTracks = () => this.audio;
  getVideoTracks = () => this.video;
  addTrack = (track: FakeTrack) => this.audio.push(track);
}

function withMedia(media: Record<string, unknown>) {
  Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
  return media as { getDisplayMedia: (constraints?: unknown) => Promise<FakeStream> };
}

describe("screenAudioPatch", () => {
  it("leaves Multicord's own sound out of shared screen audio", async () => {
    const original = vi.fn(async (_constraints?: unknown) => new FakeStream([new FakeTrack()], [new FakeTrack()]));
    const media = withMedia({ getDisplayMedia: original });
    // Serialized like the real injection, so it must not depend on its module.
    const serialized = new Function(`return (${screenAudioPatch.toString()})`)() as typeof screenAudioPatch;
    serialized(MIC, END);
    serialized(MIC, END); // patching twice keeps one layer
    await media.getDisplayMedia({ video: true, audio: true });
    await media.getDisplayMedia({ audio: { sampleRate: 48000 } });
    await media.getDisplayMedia({ video: true });
    await media.getDisplayMedia();
    expect(original.mock.calls.map(([c]) => c)).toEqual([
      { video: true, audio: { restrictOwnAudio: true } },
      { audio: { sampleRate: 48000, restrictOwnAudio: true } },
      { video: true },
      undefined,
    ]);
    expect(original.mock.contexts[0]).toBe(media);
  });

  it("adds venmic's microphone where the capture has no sound, and says when the share ends", async () => {
    const shared = new FakeStream();
    const micTrack = new FakeTrack();
    const getUserMedia = vi.fn(async () => new FakeStream([], [micTrack]));
    const media = withMedia({
      getDisplayMedia: async () => shared,
      enumerateDevices: async () => [
        { kind: "audioinput", label: "Built-in", deviceId: "a" },
        { kind: "audioinput", label: `${MIC} (virtual)`, deviceId: "vm" },
      ],
      getUserMedia,
    });
    screenAudioPatch(MIC, END);
    const ended = vi.fn();
    document.addEventListener(END, ended);
    const stream = await media.getDisplayMedia({ video: true, audio: true });
    expect(stream.audio).toEqual([micTrack]);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "vm" }, autoGainControl: false, echoCancellation: false, noiseSuppression: false, channelCount: 2 },
    });
    shared.video[0]!.dispatchEvent(new Event("ended"));
    expect(micTrack.stop).toHaveBeenCalled();
    expect(ended).toHaveBeenCalledTimes(1);
    document.removeEventListener(END, ended);
  });

  it("shares without sound when there is no virtual microphone or it fails", async () => {
    for (const media of [
      { enumerateDevices: async () => [{ kind: "audioinput", label: "Built-in", deviceId: "a" }], getUserMedia: vi.fn() },
      { enumerateDevices: async () => [{ kind: "audioinput", label: MIC, deviceId: "vm" }], getUserMedia: async () => new FakeStream([], []) },
      { enumerateDevices: async () => [{ kind: "audioinput", label: MIC, deviceId: "vm" }], getUserMedia: async () => Promise.reject(new Error("denied")) },
    ]) {
      const shared = new FakeStream([]);
      const patched = withMedia({ getDisplayMedia: async () => shared, ...media });
      screenAudioPatch(MIC, END);
      const stream = await patched.getDisplayMedia({ video: true, audio: true });
      expect(stream.audio).toEqual([]);
    }
  });

  it("does nothing without screen capture", () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    expect(() => screenAudioPatch(MIC, END)).not.toThrow();
    const media = withMedia({ getDisplayMedia: undefined });
    screenAudioPatch(MIC, END);
    expect(media.getDisplayMedia).toBeUndefined();
  });
});
