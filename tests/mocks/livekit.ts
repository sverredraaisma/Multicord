// Stand-in for livekit-client: records calls and lets tests emit room events.
import { vi } from "vitest";

export const RoomEvent = {
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  LocalTrackPublished: "localTrackPublished",
  LocalTrackUnpublished: "localTrackUnpublished",
  Disconnected: "disconnected",
} as const;

export const Track = { Kind: { Audio: "audio", Video: "video" } } as const;

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
  localParticipant = {
    setMicrophoneEnabled: vi.fn(async (_on: boolean) => undefined),
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
}
