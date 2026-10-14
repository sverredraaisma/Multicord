// Stand-in for livekit-client: records calls and lets tests emit room events.
import { vi } from "vitest";

export const RoomEvent = {
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  LocalTrackPublished: "localTrackPublished",
  LocalTrackUnpublished: "localTrackUnpublished",
  Disconnected: "disconnected",
} as const;

export const Track = { Kind: { Audio: "audio", Video: "video" }, Source: { Microphone: "microphone" } } as const;

/** A local microphone track that can carry a processor. */
export class FakeMicTrack {
  processor: { name: string } | undefined;
  getProcessor = vi.fn(() => this.processor);
  setProcessor = vi.fn(async (processor: { name: string }) => {
    if (FakeMicTrack.failProcessor) throw FakeMicTrack.failProcessor;
    this.processor = processor;
  });
  stopProcessor = vi.fn(async () => {
    this.processor = undefined;
  });
  static failProcessor: Error | undefined;
}

export class FakeTrack {
  readonly elements: HTMLMediaElement[] = [];
  constructor(readonly kind: "audio" | "video") {}
  attach(): HTMLMediaElement {
    const el = document.createElement(this.kind);
    this.elements.push(el);
    return el;
  }
  detach(): HTMLMediaElement[] {
    return this.elements.splice(0);
  }
}

export class Room {
  static instances: Room[] = [];
  static failConnect: Error | undefined;
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  connect = vi.fn(async (_url: string, _token: string) => {
    if (Room.failConnect) throw Room.failConnect;
  });
  disconnect = vi.fn(async () => this.emit(RoomEvent.Disconnected));
  switchActiveDevice = vi.fn(async (_kind: string, _id: string) => true);
  mic: FakeMicTrack | undefined;
  localParticipant = {
    setMicrophoneEnabled: vi.fn(async (on: boolean) => {
      if (on) this.mic ??= new FakeMicTrack();
    }),
    getTrackPublication: vi.fn((source: string) => (source === Track.Source.Microphone && this.mic ? { audioTrack: this.mic } : undefined)),
    setCameraEnabled: vi.fn(async (_on: boolean) => undefined),
    setScreenShareEnabled: vi.fn(async (_on: boolean, _options?: unknown) => undefined),
  };

  constructor(readonly options?: unknown) {
    Room.instances.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

export function resetLiveKit(): void {
  Room.instances = [];
  Room.failConnect = undefined;
  FakeMicTrack.failProcessor = undefined;
}
