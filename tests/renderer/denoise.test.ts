// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RnnoiseProcessor, type DenoiseAudio } from "../../src/renderer/denoise";

const processed = { id: "clean" } as unknown as MediaStreamTrack;

function fakeAudio(opts: { failModule?: Error; state?: AudioContextState } = {}) {
  const node = { port: { postMessage: vi.fn() }, disconnect: vi.fn(), connect: vi.fn() };
  const output = { stream: { getAudioTracks: () => [processed] } };
  node.connect.mockReturnValue(output);
  const source = { connect: vi.fn(() => node) };
  const context = {
    state: opts.state ?? "running",
    audioWorklet: { addModule: vi.fn(async () => { if (opts.failModule) throw opts.failModule; }) },
    createMediaStreamDestination: vi.fn(() => output),
    createMediaStreamSource: vi.fn(() => source),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async function (this: { state: string }) { this.state = "closed"; }),
  };
  const audio: DenoiseAudio = {
    context: vi.fn(() => context as unknown as AudioContext),
    worklet: vi.fn(() => node as unknown as AudioWorkletNode),
  };
  return { audio, context, node, source };
}

const options = { kind: "audio", track: { id: "mic" } as MediaStreamTrack, audioContext: {} as AudioContext } as never;

beforeEach(() => {
  vi.stubGlobal("MediaStream", class { constructor(readonly tracks: unknown[]) {} });
});

describe("RnnoiseProcessor", () => {
  it("runs the microphone through the RNNoise worklet and tears it down", async () => {
    const wasm = new ArrayBuffer(4);
    const assets = { workletUrl: "audio/rnnoise-worklet.js", wasm: vi.fn(async () => wasm) };
    const { audio, context, node, source } = fakeAudio({ state: "suspended" });
    const processor = new RnnoiseProcessor(assets, audio);
    await processor.init(options);
    expect(processor.name).toBe("rnnoise");
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith("audio/rnnoise-worklet.js");
    expect(audio.worklet).toHaveBeenCalledWith(context, { processorOptions: { maxChannels: 1, wasmBinary: wasm } });
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(context.resume).toHaveBeenCalled();
    expect(processor.processedTrack).toBe(processed);

    await processor.restart(options);
    expect(node.port.postMessage).toHaveBeenCalledWith("destroy");
    expect(context.close).toHaveBeenCalled();
    expect(assets.wasm).toHaveBeenCalledTimes(1); // fetched once
    expect(processor.processedTrack).toBe(processed);

    await processor.destroy();
    expect(processor.processedTrack).toBeUndefined();
    await processor.destroy(); // nothing left to stop
  });

  it("cleans up when the worklet cannot load and fetches the WebAssembly again after a failure", async () => {
    const { audio, context } = fakeAudio({ failModule: new Error("blocked") });
    const wasm = vi.fn<() => Promise<ArrayBuffer>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new ArrayBuffer(1));
    const processor = new RnnoiseProcessor({ workletUrl: "w.js", wasm }, audio);
    await expect(processor.init(options)).rejects.toThrow("offline");
    await expect(processor.init(options)).rejects.toThrow("blocked");
    expect(context.close).toHaveBeenCalled();
    expect(processor.processedTrack).toBeUndefined();
    expect(wasm).toHaveBeenCalledTimes(2);
  });
});
