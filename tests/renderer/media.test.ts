// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserMediaEnv, level, playTestTone, startMeter, stopStream, type MediaEnv } from "../../src/renderer/media";

const fakeStream = () => {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
};

function fakeContext(opts: { sink?: boolean; fill?: number } = {}) {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const gain = { gain: param(), connect: vi.fn() };
  const oscillators: { frequency: { value: number }; connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const source = { connect: vi.fn() };
  const analyser = {
    fftSize: 0,
    getByteTimeDomainData: vi.fn((samples: Uint8Array) => samples.fill(opts.fill ?? 128)),
  };
  const context = {
    currentTime: 2,
    destination: { id: "dest" },
    createAnalyser: () => analyser,
    createMediaStreamSource: vi.fn(() => source),
    createGain: () => gain,
    createOscillator: () => {
      const o = { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      oscillators.push(o);
      return o;
    },
    close: vi.fn(async () => {}),
    ...(opts.sink ? { setSinkId: vi.fn(async () => {}) } : {}),
  };
  return { context, gain, oscillators, source, analyser };
}

function fakeEnv(context: unknown): MediaEnv & { frame: ReturnType<typeof vi.fn>; cancelFrame: ReturnType<typeof vi.fn> } {
  let next = 0;
  return {
    enumerate: async () => [],
    getUserMedia: async () => fakeStream().stream,
    onDeviceChange: () => {},
    audioContext: () => context as AudioContext,
    frame: vi.fn(() => ++next),
    cancelFrame: vi.fn((_handle: number) => {}),
  };
}

afterEach(() => vi.useRealTimers());

describe("level", () => {
  it("is 0 for silence and for no samples", () => {
    expect(level(new Uint8Array(0))).toBe(0);
    expect(level(new Uint8Array(16).fill(128))).toBe(0);
  });

  it("is the RMS of the centred samples, capped at 1", () => {
    expect(level(new Uint8Array(16).fill(192))).toBeCloseTo(0.5);
    expect(level(new Uint8Array([0, 255, 0, 255]))).toBeCloseTo(1, 1);
    expect(level(new Uint8Array(4).fill(0))).toBe(1);
  });
});

describe("stopStream", () => {
  it("stops every track", () => {
    const { stream, tracks } = fakeStream();
    stopStream(stream);
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
  });
});

describe("startMeter", () => {
  it("reports a level each frame, stretched and capped", () => {
    const { context, analyser, source } = fakeContext({ fill: 192 });
    const env = fakeEnv(context);
    const { stream } = fakeStream();
    const onLevel = vi.fn();
    startMeter(env, stream, onLevel);
    expect(analyser.fftSize).toBe(512);
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(onLevel).toHaveBeenLastCalledWith(1); // 0.5 * 3 capped
    env.frame.mock.calls[0]![0]();
    expect(onLevel).toHaveBeenCalledTimes(2);
    expect(env.frame).toHaveBeenCalledTimes(2);
  });

  it("reports silence as 0", () => {
    const { context } = fakeContext();
    const onLevel = vi.fn();
    startMeter(fakeEnv(context), fakeStream().stream, onLevel);
    expect(onLevel).toHaveBeenCalledWith(0);
  });

  it("stops by cancelling the frame, stopping tracks and closing the context", () => {
    const { context } = fakeContext();
    const env = fakeEnv(context);
    const { stream, tracks } = fakeStream();
    const stop = startMeter(env, stream, vi.fn());
    stop();
    expect(env.cancelFrame).toHaveBeenCalledWith(1);
    expect(tracks[0]!.stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });
});

describe("playTestTone", () => {
  async function play(outputId: string | undefined, sink: boolean) {
    vi.useFakeTimers();
    const fake = fakeContext({ sink });
    const promise = playTestTone(fakeEnv(fake.context), outputId);
    await vi.advanceTimersByTimeAsync(900);
    await promise;
    return fake;
  }

  it("plays two notes through a gain envelope and closes the context", async () => {
    const { context, gain, oscillators } = await play(undefined, true);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.0001, 2);
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledTimes(2);
    expect(oscillators.map((o) => o.frequency.value)).toEqual([660, 880]);
    expect(oscillators[1]!.start).toHaveBeenCalledWith(2.18);
    expect(oscillators[0]!.stop).toHaveBeenCalledWith(2.8);
    expect(context.setSinkId).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });

  it("routes to the chosen output when the context supports it", async () => {
    const { context } = await play("speaker-1", true);
    expect(context.setSinkId).toHaveBeenCalledWith("speaker-1");
  });

  it("tolerates a context without setSinkId", async () => {
    const { context } = await play("speaker-1", false);
    expect(context.close).toHaveBeenCalled();
  });
});

describe("browserMediaEnv", () => {
  function fakeWindow(mediaDevices: unknown) {
    const created: unknown[] = [];
    class AudioContext {
      constructor() {
        created.push(this);
      }
    }
    const win = {
      navigator: { mediaDevices },
      AudioContext,
      requestAnimationFrame: vi.fn(() => 7),
      cancelAnimationFrame: vi.fn(),
    };
    return { win: win as unknown as Window, raw: win, created };
  }

  it("delegates to the window's media APIs", async () => {
    const devices = [{ deviceId: "a", kind: "audioinput", label: "Mic" }];
    const stream = fakeStream().stream;
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => devices),
      getUserMedia: vi.fn(async () => stream),
      addEventListener: vi.fn(),
    };
    const { win, raw, created } = fakeWindow(mediaDevices);
    const env = browserMediaEnv(win);
    expect(await env.enumerate()).toBe(devices);
    expect(await env.getUserMedia({ audio: true })).toBe(stream);
    const cb = vi.fn();
    env.onDeviceChange(cb);
    expect(mediaDevices.addEventListener).toHaveBeenCalledWith("devicechange", cb);
    expect(env.audioContext()).toBe(created[0]);
    const frameCb = vi.fn();
    expect(env.frame(frameCb)).toBe(7);
    expect(raw.requestAnimationFrame).toHaveBeenCalledWith(frameCb);
    env.cancelFrame(7);
    expect(raw.cancelAnimationFrame).toHaveBeenCalledWith(7);
  });

  it("lists no devices when the window has no mediaDevices", async () => {
    const env = browserMediaEnv(fakeWindow(undefined).win);
    expect(await env.enumerate()).toEqual([]);
    await expect(env.getUserMedia({ audio: true })).rejects.toThrow("This system offers no media devices");
    expect(() => env.onDeviceChange(() => {})).not.toThrow();
  });

  it("lists no devices when enumerateDevices is missing", async () => {
    expect(await browserMediaEnv(fakeWindow({}).win).enumerate()).toEqual([]);
  });
});
