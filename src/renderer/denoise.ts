import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

/** The AudioWorklet processor name the RNNoise worklet script registers. */
const PROCESSOR = "@sapphi-red/web-noise-suppressor/rnnoise";

/** Where the RNNoise worklet comes from: its script URL and the WebAssembly it runs. */
export interface RnnoiseAssets {
  workletUrl: string;
  wasm(): Promise<ArrayBuffer>;
}

/** The parts of the Web Audio API the processor uses, so tests can stand in for them. */
export interface DenoiseAudio {
  context(): AudioContext;
  worklet(context: AudioContext, options: AudioWorkletNodeOptions): AudioWorkletNode;
}

const webAudio: DenoiseAudio = {
  // RNNoise works on 48 kHz frames, so the processor owns a context at that rate.
  context: () => new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" }),
  worklet: (context, options) => new AudioWorkletNode(context, PROCESSOR, options),
};

/**
 * Noise suppression with RNNoise (an open recurrent network, the study's
 * stand-in for Krisp), as a LiveKit track processor: the microphone runs
 * through an AudioWorklet and the cleaned track is what gets sent.
 */
export class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "rnnoise";
  processedTrack?: MediaStreamTrack;
  private context: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private wasm: Promise<ArrayBuffer> | undefined;

  constructor(
    private readonly assets: RnnoiseAssets,
    private readonly audio: DenoiseAudio = webAudio,
  ) {}

  async init({ track }: AudioProcessorOptions): Promise<void> {
    // The WebAssembly is fetched once and reused; a failed fetch is retried next time.
    this.wasm ??= this.assets.wasm().catch((error: unknown) => {
      this.wasm = undefined;
      throw error;
    });
    const wasmBinary = await this.wasm;
    const context = this.audio.context();
    this.context = context;
    try {
      await context.audioWorklet.addModule(this.assets.workletUrl);
      const node = this.audio.worklet(context, { processorOptions: { maxChannels: 1, wasmBinary } });
      this.node = node;
      const output = context.createMediaStreamDestination();
      context.createMediaStreamSource(new MediaStream([track])).connect(node).connect(output);
      this.processedTrack = output.stream.getAudioTracks()[0];
      if (context.state === "suspended") await context.resume();
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  async restart(options: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(options);
  }

  async destroy(): Promise<void> {
    const { node, context } = this;
    this.node = undefined;
    this.context = undefined;
    this.processedTrack = undefined;
    if (node) {
      node.port.postMessage("destroy"); // frees the WebAssembly state in the worklet
      node.disconnect();
    }
    if (context && context.state !== "closed") await context.close();
  }
}
