import type { PickerChoice, PickerRequest } from "../shared/ipc";

export interface CaptureSource {
  id: string;
  name: string;
  thumbnail: { toDataURL(): string };
}

export interface ScreenShareDeps<S extends CaptureSource> {
  getSources(): Promise<S[]>;
  pick(request: PickerRequest): Promise<PickerChoice | null>;
  platform: NodeJS.Platform;
  /** The OS kernel version (os.release()); on macOS it decides whether system audio can be captured. */
  osRelease?: string;
  /** Linux: system sound through venmic, which the sharing page adds to its stream. */
  systemAudio?: { available(): boolean; start(): boolean };
}

export type DisplayMediaCallback<S> = (streams: { video?: S; audio?: "loopback" }) => void;

/**
 * Whether Chromium can capture system audio for a screen share: on Windows,
 * and on macOS 13 and later (Darwin 22), where Electron uses ScreenCaptureKit
 * or, from macOS 14.2, Apple's CoreAudio tap; the app declares
 * NSAudioCaptureUsageDescription for it. Linux needs a PipeWire helper
 * (venmic) that is not built in.
 */
export function supportsLoopbackAudio(platform: NodeJS.Platform, osRelease = ""): boolean {
  if (platform === "win32") return true;
  return platform === "darwin" && Number.parseInt(osRelease, 10) >= 22;
}

/**
 * Builds the handler for setDisplayMediaRequestHandler: shows our picker and
 * returns the chosen source, so Discord encodes and encrypts the stream itself.
 */
export function createDisplayMediaHandler<S extends CaptureSource>(deps: ScreenShareDeps<S>) {
  return async (_request: unknown, callback: DisplayMediaCallback<S>): Promise<void> => {
    try {
      const sources = await deps.getSources();
      const viaVenmic = deps.platform === "linux" && deps.systemAudio?.available() === true;
      const audioSupported = viaVenmic || supportsLoopbackAudio(deps.platform, deps.osRelease);
      const choice = await deps.pick({
        sources: sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })),
        audioSupported,
      });
      const source = choice ? sources.find((s) => s.id === choice.id) : undefined;
      if (!choice || !source) return callback({});
      if (viaVenmic) {
        // The page picks the sound up from venmic's virtual microphone.
        if (choice.audio) deps.systemAudio!.start();
        return callback({ video: source });
      }
      callback({ video: source, audio: choice.audio && audioSupported ? "loopback" : undefined });
    } catch {
      callback({});
    }
  };
}
