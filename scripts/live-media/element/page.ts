// The "Element" side's media page: Element Call's media layer, cut down.
// livekit-client with its E2EE worker and a key provider like Element Call's
// MatrixKeyProvider (per-participant HKDF key material, ratchetWindowSize 10,
// keyringSize 256). The keys come from matrix-js-sdk's MatrixRTC in run.mjs,
// over DevTools. It publishes the (fake) microphone, and camera on request,
// and measures what it hears and sees from each remote participant.
// Bundled by run.mjs with esbuild; not part of the app.
import { BaseKeyProvider, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from "livekit-client";

class MatrixKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ ratchetWindowSize: 10, keyringSize: 256 });
  }

  async set(identity: string, index: number, base64: string): Promise<void> {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const material = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits", "deriveKey"]);
    this.onSetEncryptionKey(material, identity, index);
  }
}

export interface Hearing {
  rmsDb: number | null;
  peakHz: number;
}

const provider = new MatrixKeyProvider();
const room = new Room({ e2ee: { keyProvider: provider, worker: new Worker("livekit-e2ee-worker.js") } });
const audio = new AudioContext();
const analysers = new Map<string, AnalyserNode>();
const errors: string[] = [];
let errorCount = 0;

room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
  const element = track.attach();
  element.muted = true; // measured, not played
  element.dataset["identity"] = participant.identity;
  document.body.append(element);
  if (track.kind === Track.Kind.Audio) {
    const analyser = audio.createAnalyser();
    analyser.fftSize = 8192;
    audio.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser);
    analysers.set(participant.identity, analyser);
  }
});
room.on(RoomEvent.EncryptionError, (error: Error) => {
  errorCount++;
  if (errors.length < 20) errors.push(error.message);
});

/** RMS level (dBFS, null for digital silence) and the most frequent strongest frequency over about a second. */
async function measure(analyser: AnalyserNode): Promise<Hearing> {
  await audio.resume();
  const time = new Float32Array(analyser.fftSize);
  const freq = new Float32Array(analyser.frequencyBinCount);
  let sum = 0;
  let count = 0;
  const peaks = new Map<number, number>();
  for (let i = 0; i < 20; i++) {
    analyser.getFloatTimeDomainData(time);
    for (const v of time) sum += v * v;
    count += time.length;
    analyser.getFloatFrequencyData(freq);
    let best = 1;
    for (let b = 1; b < freq.length; b++) if ((freq[b] ?? -Infinity) > (freq[best] ?? -Infinity)) best = b;
    const hz = Math.round((best * audio.sampleRate) / analyser.fftSize);
    peaks.set(hz, (peaks.get(hz) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, 50));
  }
  const rms = Math.sqrt(sum / count);
  const peakHz = [...peaks].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  return { rmsDb: rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : null, peakHz };
}

const api = {
  async join(url: string, token: string): Promise<string> {
    await room.setE2EEEnabled(true);
    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);
    return room.localParticipant.identity;
  },
  async camera(on: boolean): Promise<void> {
    await room.localParticipant.setCameraEnabled(on);
  },
  setKey: (identity: string, index: number, base64: string): Promise<void> => provider.set(identity, index, base64),
  async hear(): Promise<Record<string, Hearing>> {
    const out: Record<string, Hearing> = {};
    for (const [identity, analyser] of analysers) out[identity] = await measure(analyser);
    return out;
  },
  /** Video frames decoded per remote participant. */
  videos: (): { identity: string; width: number; height: number; frames: number }[] =>
    [...document.querySelectorAll("video")].map((v) => ({
      identity: v.dataset["identity"] ?? "",
      width: v.videoWidth,
      height: v.videoHeight,
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
    })),
  errors: (): { count: number; first: string[] } => ({ count: errorCount, first: errors.slice(0, 3) }),
  leave: (): Promise<void> => room.disconnect(),
};

Object.assign(window, { el: api });
document.title = "element-ready";
