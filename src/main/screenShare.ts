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
}

export type DisplayMediaCallback<S> = (streams: { video?: S; audio?: "loopback" }) => void;

/** Loopback audio works out of the box on Windows only; see the study for macOS and Linux. */
export function supportsLoopbackAudio(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/**
 * Builds the handler for setDisplayMediaRequestHandler: shows our picker and
 * returns the chosen source, so Discord encodes and encrypts the stream itself.
 */
export function createDisplayMediaHandler<S extends CaptureSource>(deps: ScreenShareDeps<S>) {
  return async (_request: unknown, callback: DisplayMediaCallback<S>): Promise<void> => {
    try {
      const sources = await deps.getSources();
      const audioSupported = supportsLoopbackAudio(deps.platform);
      const choice = await deps.pick({
        sources: sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })),
        audioSupported,
      });
      const source = choice ? sources.find((s) => s.id === choice.id) : undefined;
      if (!choice || !source) return callback({});
      callback({ video: source, audio: choice.audio && audioSupported ? "loopback" : undefined });
    } catch {
      callback({});
    }
  };
}
