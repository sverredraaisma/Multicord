// Loads the crypto library's WebAssembly from bytes bundled into the engine.
// The package's browser loader would fetch the .wasm from a URL next to the
// script, which the engine's origin does not serve (and its CSP would not
// let it fetch from elsewhere); instantiating the bytes here does the same
// as that loader without any request.

import * as bindings from "@matrix-org/matrix-sdk-crypto-wasm";

/** The generated glue the module's imports resolve to, and its setter (exported, but not in the typings). */
type Glue = typeof bindings & { __wbg_set_wasm(exports: WebAssembly.Exports): void };

let loading: Promise<void> | undefined;

/** Instantiates the crypto library once; later calls wait for the first. */
export function loadCryptoWasm(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  loading ??= (async () => {
    const glue = bindings as Glue;
    const { instance } = await WebAssembly.instantiate(bytes, { "./matrix_sdk_crypto_wasm_bg.js": glue as unknown as WebAssembly.ModuleImports });
    glue.__wbg_set_wasm(instance.exports);
    (instance.exports.__wbindgen_start as () => void)();
  })();
  // A failed load may be tried again (e.g. after the next sign-in).
  loading.catch(() => (loading = undefined));
  return loading;
}
