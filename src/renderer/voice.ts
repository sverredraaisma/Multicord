import { Room, RoomEvent, Track, type Participant, type RemoteTrack, type LocalTrackPublication } from "livekit-client";
import type { NativeVoiceSession } from "../shared/native";

type Flags = Pick<NativeVoiceSession, "mute" | "deaf" | "video" | "stream">;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One LiveKit call for a native voice session. The main process hands over a
 * short-lived, call-scoped grant (url + token); this connects with it,
 * publishes the microphone, camera and screen as the session's flags say,
 * and plays remote audio and shows remote video. Updates are serialised, as
 * view state can change faster than LiveKit calls complete.
 */
export class VoiceCall {
  private room: Room | undefined;
  private token: string | undefined;
  private applied: Flags = { mute: false, deaf: false, video: false, stream: false };
  private queue: Promise<void> = Promise.resolve();
  private leaving = false;

  constructor(
    private readonly stage: HTMLElement,
    private readonly speakers: HTMLElement,
    private readonly onError: (message: string) => void,
    private readonly createRoom: () => Room = () => new Room({ adaptiveStream: true, dynacast: true }),
  ) {}

  /** Brings the call in line with the session; null leaves. Resolves once applied. */
  sync(session: NativeVoiceSession | null): Promise<void> {
    this.queue = this.queue.then(() => this.apply(session)).catch((error: unknown) => this.onError(message(error)));
    return this.queue;
  }

  private async apply(session: NativeVoiceSession | null): Promise<void> {
    if (!session?.url || !session.token) {
      await this.leave();
      return;
    }
    if (session.token !== this.token) {
      await this.leave();
      await this.join(session.url, session.token, session);
    }
    await this.setFlags(session);
  }

  private async join(url: string, token: string, flags: Flags): Promise<void> {
    const room = this.createRoom();
    this.room = room;
    this.token = token;
    this.applied = { mute: true, deaf: false, video: false, stream: false };
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication: unknown, participant: Participant) =>
      this.show(track, participant.name || participant.identity, false),
    );
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => this.hide(track));
    room.on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
      if (publication.track && publication.kind === Track.Kind.Video) this.show(publication.track, "You", true);
    });
    room.on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
      if (publication.track) this.hide(publication.track);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!this.leaving && this.room === room) this.onError("Disconnected from voice");
    });
    await room.connect(url, token);
    await this.setFlags({ ...flags, video: false, stream: false });
  }

  private async setFlags(flags: Flags): Promise<void> {
    const room = this.room!;
    const micOn = !flags.mute && !flags.deaf;
    if (micOn !== (!this.applied.mute && !this.applied.deaf)) await room.localParticipant.setMicrophoneEnabled(micOn);
    if (flags.video !== this.applied.video) await room.localParticipant.setCameraEnabled(flags.video);
    if (flags.stream !== this.applied.stream) await room.localParticipant.setScreenShareEnabled(flags.stream, { audio: true });
    // Deafened: keep receiving, but play nothing.
    for (const audio of this.speakers.querySelectorAll("audio")) audio.muted = flags.deaf;
    this.applied = { ...flags };
  }

  private show(track: { kind: string; attach(): HTMLMediaElement; sid?: string }, label: string, local: boolean): void {
    const media = track.attach();
    if (track.kind === Track.Kind.Audio) {
      media.muted = this.applied.deaf;
      this.speakers.append(media);
      return;
    }
    const tile = this.stage.ownerDocument.createElement("figure");
    tile.className = local ? "video-tile local" : "video-tile";
    const caption = this.stage.ownerDocument.createElement("figcaption");
    caption.textContent = label;
    tile.append(media, caption);
    this.stage.append(tile);
    this.stage.hidden = false;
  }

  private hide(track: { detach(): HTMLMediaElement[] }): void {
    for (const media of track.detach()) (media.closest(".video-tile") ?? media).remove();
    this.stage.hidden = this.stage.children.length === 0;
  }

  private async leave(): Promise<void> {
    const room = this.room;
    this.room = undefined;
    this.token = undefined;
    if (room) {
      this.leaving = true;
      try {
        await room.disconnect();
      } finally {
        this.leaving = false;
      }
    }
    this.stage.replaceChildren();
    this.stage.hidden = true;
    this.speakers.replaceChildren();
  }
}
