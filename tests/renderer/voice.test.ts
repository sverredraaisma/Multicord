// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("livekit-client", () => import("../mocks/livekit"));

import { FakeTrack, Room, resetLiveKit } from "../mocks/livekit";
import { resolveDevice, VoiceCall } from "../../src/renderer/voice";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import type { NativeVoiceSession } from "../../src/shared/native";

const session = (extra: Partial<NativeVoiceSession> = {}): NativeVoiceSession => ({
  channelId: "112",
  channelName: "voice",
  guildName: "Alpha",
  url: "wss://voice.fx",
  token: "t1",
  mute: false,
  deaf: false,
  video: false,
  stream: false,
  ...extra,
});

let stage: HTMLElement;
let speakers: HTMLElement;
let onError: ReturnType<typeof vi.fn<(message: string) => void>>;
let call: VoiceCall;

beforeEach(() => {
  resetLiveKit();
  document.body.innerHTML = `<div id="stage" hidden></div><div id="speakers"></div>`;
  stage = document.getElementById("stage")!;
  speakers = document.getElementById("speakers")!;
  onError = vi.fn<(message: string) => void>();
  call = new VoiceCall(stage, speakers, onError);
});

describe("VoiceCall", () => {
  it("does nothing until the grant arrives, then connects and opens the microphone", async () => {
    await call.sync(session({ token: undefined }));
    expect(Room.instances).toHaveLength(0);
    await call.sync(session());
    const room = Room.instances[0]!;
    expect(room.options).toEqual({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { deviceId: undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(room.connect).toHaveBeenCalledWith("wss://voice.fx", "t1");
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    await call.sync(session()); // nothing changed
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
  });

  it("applies mute, deafen, camera and screen share", async () => {
    await call.sync(session());
    const room = Room.instances[0]!;
    const audio = new FakeTrack("audio");
    room.emit("trackSubscribed", audio, {}, { name: "Ana", identity: "user_2_a" });
    expect(speakers.querySelector("audio")).not.toBeNull();

    await call.sync(session({ mute: true }));
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await call.sync(session({ mute: true, deaf: true }));
    expect(speakers.querySelector<HTMLAudioElement>("audio")!.muted).toBe(true);
    await call.sync(session({ video: true, stream: true }));
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(room.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(true, { audio: true });
    expect(speakers.querySelector<HTMLAudioElement>("audio")!.muted).toBe(false);

    // Audio arriving while deafened starts muted.
    await call.sync(session({ deaf: true }));
    room.emit("trackSubscribed", new FakeTrack("audio"), {}, { name: "", identity: "user_3_b" });
    expect(speakers.querySelectorAll<HTMLAudioElement>("audio")[1]!.muted).toBe(true);
  });

  it("shows remote and local video and removes it again", async () => {
    await call.sync(session());
    const room = Room.instances[0]!;
    const remote = new FakeTrack("video");
    room.emit("trackSubscribed", remote, {}, { name: "", identity: "user_2_a" });
    expect(stage.hidden).toBe(false);
    expect(stage.querySelector("figcaption")!.textContent).toBe("user_2_a");

    const camera = new FakeTrack("video");
    room.emit("localTrackPublished", { kind: "video", track: camera });
    room.emit("localTrackPublished", { kind: "audio", track: new FakeTrack("audio") }); // own audio is not shown
    room.emit("localTrackPublished", { kind: "video" }); // no track yet
    expect(stage.querySelector(".video-tile.local figcaption")!.textContent).toBe("You");

    room.emit("localTrackUnpublished", { track: camera });
    room.emit("localTrackUnpublished", {});
    room.emit("trackUnsubscribed", remote);
    expect(stage.children).toHaveLength(0);
    expect(stage.hidden).toBe(true);

    const audio = new FakeTrack("audio");
    room.emit("trackSubscribed", audio, {}, { name: "Ana", identity: "x" });
    room.emit("trackUnsubscribed", audio);
    expect(speakers.children).toHaveLength(0);
  });

  it("reconnects with a new grant and leaves cleanly", async () => {
    await call.sync(session());
    await call.sync(session({ token: "t2" }));
    expect(Room.instances).toHaveLength(2);
    expect(Room.instances[0]!.disconnect).toHaveBeenCalled();
    await call.sync(null);
    expect(Room.instances[1]!.disconnect).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled(); // our own disconnects are not errors
    await call.sync(null); // already gone
  });

  it("reports failures and unexpected disconnects", async () => {
    Room.failConnect = new Error("could not establish signal connection");
    await call.sync(session());
    expect(onError).toHaveBeenCalledWith("could not establish signal connection");

    Room.failConnect = undefined;
    await call.sync(session({ token: "t2" }));
    Room.instances.at(-1)!.emit("disconnected");
    expect(onError).toHaveBeenLastCalledWith("Disconnected from voice");

    const stale = Room.instances[0]!;
    stale.emit("disconnected"); // an old room: ignored
    expect(onError).toHaveBeenCalledTimes(2);

    await call.sync(session({ token: "t3" }));
    Room.instances.at(-1)!.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce("denied");
    await call.sync(session({ token: "t3", mute: true }));
    expect(onError).toHaveBeenLastCalledWith("denied");
  });

  it("creates real rooms by default", () => {
    expect(new VoiceCall(stage, speakers, onError)).toBeInstanceOf(VoiceCall);
  });
});

describe("devices", () => {
  const devices = [
    { deviceId: "mic-a", kind: "audioinput", label: "Headset" },
    { deviceId: "spk-a", kind: "audiooutput", label: "Headset" },
    { deviceId: "cam-a", kind: "videoinput", label: "Webcam" },
  ];

  it("finds a chosen device by id, else by label, else falls back to the default", () => {
    expect(resolveDevice(devices, "audioinput", undefined)).toBeUndefined();
    expect(resolveDevice(devices, "audioinput", { id: "mic-a", label: "Renamed" })).toBe("mic-a");
    expect(resolveDevice(devices, "audiooutput", { id: "salted-elsewhere", label: "Headset" })).toBe("spk-a");
    expect(resolveDevice(devices, "videoinput", { id: "gone", label: "Gone" })).toBeUndefined();
  });

  it("joins with the chosen devices and processing", async () => {
    const withDevices = new VoiceCall(stage, speakers, onError, undefined, async () => devices);
    await withDevices.configure({
      input: { id: "x", label: "Headset" },
      output: { id: "spk-a", label: "Headset" },
      camera: { id: "cam-a", label: "Webcam" },
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
    });
    await withDevices.sync(session());
    expect(Room.instances[0]!.options).toEqual({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { deviceId: "mic-a", echoCancellation: false, noiseSuppression: true, autoGainControl: false },
      audioOutput: { deviceId: "spk-a" },
      videoCaptureDefaults: { deviceId: "cam-a" },
    });
  });

  it("switches devices during a call and goes back to the defaults", async () => {
    const withDevices = new VoiceCall(stage, speakers, onError, undefined, async () => devices);
    await withDevices.sync(session());
    const room = Room.instances[0]!;
    await withDevices.configure({ ...DEFAULT_SETTINGS.voice, input: { id: "mic-a", label: "Headset" }, camera: { id: "cam-a", label: "Webcam" } });
    expect(room.switchActiveDevice.mock.calls).toEqual([
      ["audioinput", "mic-a"],
      ["audiooutput", "default"],
      ["videoinput", "cam-a"],
    ]);
    room.switchActiveDevice.mockClear();
    await withDevices.configure(DEFAULT_SETTINGS.voice);
    expect(room.switchActiveDevice.mock.calls).toEqual([
      ["audioinput", "default"],
      ["audiooutput", "default"],
    ]);
  });

  it("reports a device that cannot be switched to", async () => {
    await call.sync(session());
    Room.instances[0]!.switchActiveDevice.mockRejectedValueOnce(new Error("NotFoundError"));
    await call.configure(DEFAULT_SETTINGS.voice);
    expect(onError).toHaveBeenCalledWith("NotFoundError");
  });

  it("lists devices through the browser when not given a source", async () => {
    const enumerateDevices = vi.fn(async () => devices);
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });
    const plain = new VoiceCall(stage, speakers, onError);
    await plain.configure({ ...DEFAULT_SETTINGS.voice, input: { id: "mic-a", label: "Headset" } });
    await plain.sync(session());
    expect(enumerateDevices).toHaveBeenCalled();
    expect((Room.instances[0]!.options as { audioCaptureDefaults: { deviceId: string } }).audioCaptureDefaults.deviceId).toBe("mic-a");
    vi.stubGlobal("navigator", {});
    const none = new VoiceCall(stage, speakers, onError);
    await none.configure({ ...DEFAULT_SETTINGS.voice, input: { id: "mic-a", label: "Headset" } });
    await none.sync(session({ token: "t2" }));
    expect((Room.instances[1]!.options as { audioCaptureDefaults: { deviceId?: string } }).audioCaptureDefaults.deviceId).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
