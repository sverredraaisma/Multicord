import {
  Room,
  RoomEvent,
  Track,
  type AudioProcessorOptions,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrack,
  type RoomOptions,
  type TrackProcessor,
} from "livekit-client";
import type { NativeVoiceSession } from "../shared/native";
import { DEFAULT_SETTINGS, type DeviceChoice, type VoiceSettings } from "../shared/settings";
import type { DeviceInfo } from "./media";

/**
 * The id of a chosen device in this view. Chromium salts device ids per
 * site, so the settings page's id may not exist here; the label decides
 * then. Undefined means the system default.
 */
export function resolveDevice(devices: readonly DeviceInfo[], kind: MediaDeviceKind, choice: DeviceChoice | undefined): string | undefined {
  if (!choice) return undefined;
  const ofKind = devices.filter((d) => d.kind === kind);
  return (ofKind.find((d) => d.deviceId === choice.id) ?? ofKind.find((d) => d.label === choice.label))?.deviceId;
}

const listDevices = async (): Promise<DeviceInfo[]> => (await globalThis.navigator?.mediaDevices?.enumerateDevices?.()) ?? [];

/**
 * Screen-share audio: Multicord's own sound (the call itself) is left out, so
 * others don't hear themselves; voice processing is off, as it would mangle
 * music and games.
 */
const SHARED_AUDIO = { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false };

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
  private settings: VoiceSettings = DEFAULT_SETTINGS.voice;

  constructor(
    private readonly stage: HTMLElement,
    private readonly speakers: HTMLElement,
    private readonly onError: (message: string) => void,
    private readonly createRoom: (options: RoomOptions) => Room = (options) => new Room(options),
    private readonly devices: () => Promise<DeviceInfo[]> = listDevices,
    /** Makes the enhanced noise suppression processor; absent where it cannot run. */
    private readonly denoiser?: () => TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>,
  ) {}

  /**
   * Uses these devices and audio processing from now on. A call in progress
   * switches devices at once; processing changes apply when the microphone
   * next starts.
   */
  configure(settings: VoiceSettings): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        this.settings = settings;
        const room = this.room;
        if (!room) return;
        const ids = await this.deviceIds();
        await room.switchActiveDevice("audioinput", ids.input ?? "default");
        await room.switchActiveDevice("audiooutput", ids.output ?? "default");
        if (ids.camera) await room.switchActiveDevice("videoinput", ids.camera);
        await this.syncDenoise(room);
      })
      .catch((error: unknown) => this.onError(message(error)));
    return this.queue;
  }

  private async deviceIds(): Promise<{ input?: string; output?: string; camera?: string }> {
    const { input, output, camera } = this.settings;
    if (!input && !output && !camera) return {};
    const devices = await this.devices();
    return {
      input: resolveDevice(devices, "audioinput", input),
      output: resolveDevice(devices, "audiooutput", output),
      camera: resolveDevice(devices, "videoinput", camera),
    };
  }

  private async roomOptions(): Promise<RoomOptions> {
    const ids = await this.deviceIds();
    const { echoCancellation, noiseSuppression, autoGainControl } = this.settings;
    const options: RoomOptions = {
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { deviceId: ids.input, echoCancellation, noiseSuppression, autoGainControl },
    };
    if (ids.output) options.audioOutput = { deviceId: ids.output };
    if (ids.camera) options.videoCaptureDefaults = { deviceId: ids.camera };
    return options;
  }

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
    const room = this.createRoom(await this.roomOptions());
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
    if (micOn !== (!this.applied.mute && !this.applied.deaf)) {
      await room.localParticipant.setMicrophoneEnabled(micOn);
      if (micOn) await this.syncDenoise(room);
    }
    if (flags.video !== this.applied.video) await room.localParticipant.setCameraEnabled(flags.video);
    if (flags.stream !== this.applied.stream) await room.localParticipant.setScreenShareEnabled(flags.stream, { audio: SHARED_AUDIO });
    // Deafened: keep receiving, but play nothing.
    for (const audio of this.speakers.querySelectorAll("audio")) audio.muted = flags.deaf;
    this.applied = { ...flags };
  }

  /**
   * Runs the microphone through RNNoise while the setting is on. A processor
   * that fails to start leaves the plain microphone in use and says why.
   */
  private async syncDenoise(room: Room): Promise<void> {
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    if (!mic || !this.denoiser) return;
    const running = mic.getProcessor() !== undefined;
    if (this.settings.enhancedNoiseSuppression && !running) {
      try {
        await mic.setProcessor(this.denoiser());
      } catch (error) {
        this.onError(`Enhanced noise suppression could not start: ${message(error)}`);
      }
    } else if (!this.settings.enhancedNoiseSuppression && running) {
      await mic.stopProcessor();
    }
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
