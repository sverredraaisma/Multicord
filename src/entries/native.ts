import rnnoiseWasm from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm";
import type { NativeApi } from "../preload/native";
import { RnnoiseProcessor } from "../renderer/denoise";
import { startNative } from "../renderer/native";

// The worklet script is copied next to the page by the build; the WebAssembly is bundled in.
const assets = { workletUrl: "audio/rnnoise-worklet.js", wasm: async () => rnnoiseWasm.slice().buffer };

startNative(document, (window as unknown as { multicordNative: NativeApi }).multicordNative, () => new RnnoiseProcessor(assets));
