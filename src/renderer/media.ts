// Device tests for the settings page: a microphone level meter, a test tone
// on the chosen speakers and a camera preview. Browser APIs come in through
// MediaEnv, so tests can stand in for them.
import type { DeviceChoice } from "../shared/settings";

/** What enumerateDevices returns, as far as we use it. */
export interface DeviceInfo {
  deviceId: string;
  kind: string;
  label: string;
}

export interface MediaEnv {
  enumerate(): Promise<DeviceInfo[]>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  onDeviceChange(cb: () => void): void;
  audioContext(): AudioContext;
  frame(cb: () => void): number;
  cancelFrame(handle: number): void;
}

export function browserMediaEnv(win: Window): MediaEnv {
  const media = win.navigator.mediaDevices;
  return {
    enumerate: async () => (await media?.enumerateDevices?.()) ?? [],
    getUserMedia: async (constraints) => {
      if (!media?.getUserMedia) throw new Error("This system offers no media devices");
      return media.getUserMedia(constraints);
    },
    onDeviceChange: (cb) => media?.addEventListener?.("devicechange", cb),
    audioContext: () => new (win as Window & typeof globalThis).AudioContext(),
    frame: (cb) => win.requestAnimationFrame(cb),
    cancelFrame: (handle) => win.cancelAnimationFrame(handle),
  };
}

/**
 * The id of a chosen device in a view. Chromium salts device ids per site,
 * so the settings page's id may not exist there; the label decides then.
 * Undefined means the system default.
 */
export function resolveDevice(devices: readonly DeviceInfo[], kind: MediaDeviceKind, choice: DeviceChoice | undefined): string | undefined {
  if (!choice) return undefined;
  const ofKind = devices.filter((d) => d.kind === kind);
  return (ofKind.find((d) => d.deviceId === choice.id) ?? ofKind.find((d) => d.label === choice.label))?.deviceId;
}

export type Stop = () => void;

export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Root mean square of 8-bit time-domain samples, from 0 (silence) to 1. */
export function level(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const centred = (sample - 128) / 128;
    sum += centred * centred;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/** Reports the microphone's loudness every frame until stopped. */
export function startMeter(env: MediaEnv, stream: MediaStream, onLevel: (value: number) => void): Stop {
  const context = env.audioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let handle = 0;
  const tick = (): void => {
    analyser.getByteTimeDomainData(samples);
    // Speech rarely passes a third of full scale; stretch it so the meter moves.
    onLevel(Math.min(1, level(samples) * 3));
    handle = env.frame(tick);
  };
  tick();
  return () => {
    env.cancelFrame(handle);
    stopStream(stream);
    void context.close();
  };
}

type SinkContext = AudioContext & { setSinkId?(id: string): Promise<void> };

/** Plays a short two-note chime on the given output (or the default one). */
export async function playTestTone(env: MediaEnv, outputId: string | undefined): Promise<void> {
  const context = env.audioContext() as SinkContext;
  if (outputId) await context.setSinkId?.(outputId);
  const gain = context.createGain();
  gain.connect(context.destination);
  const start = context.currentTime;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.8);
  for (const [frequency, offset] of [
    [660, 0],
    [880, 0.18],
  ] as const) {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(start + offset);
    oscillator.stop(start + 0.8);
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  await context.close();
}
