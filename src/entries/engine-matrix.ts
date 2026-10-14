import type { EngineBridge } from "../preload/engine";
import { deleteCryptoStore, openE2ee } from "../modules/matrix/crypto";
import { startMatrixEngine } from "../modules/matrix/engine";
import { loadCryptoWasm } from "../modules/matrix/wasm";
// The crypto library's WebAssembly, bundled as its bytes (esbuild's binary loader). The package exports no
// path to it, hence the relative import; its typings describe the module's exports, not the bytes.
import * as cryptoWasm from "../../node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm";

const wasmBytes = (cryptoWasm as unknown as { default: Uint8Array<ArrayBuffer> }).default;

void startMatrixEngine((window as unknown as { multicordEngine: EngineBridge }).multicordEngine, {
  crypto: {
    open: async (options) => {
      await loadCryptoWasm(wasmBytes);
      return openE2ee(options);
    },
    deleteStore: (name) => deleteCryptoStore(name),
  },
});
