import rnnoiseWasm from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm";
import type { NativeApi } from "../preload/native";
import { RnnoiseProcessor } from "../renderer/denoise";
import { startNative } from "../renderer/native";

// The worklet script is copied next to the page by the build; the WebAssembly is bundled in.
const assets = { workletUrl: "audio/rnnoise-worklet.js", wasm: async () => rnnoiseWasm.slice().buffer };

// LiveKit's end-to-end encryption worker, copied next to the page by the build: the page's CSP lets workers load only from there.
const e2eeWorker = (): Worker => new Worker("livekit-e2ee-worker.js");

startNative(document, (window as unknown as { multicordNative: NativeApi }).multicordNative, () => new RnnoiseProcessor(assets), e2eeWorker);
