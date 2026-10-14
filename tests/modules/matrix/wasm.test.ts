import { readFileSync } from "node:fs";
import path from "node:path";
import { DeviceId, OlmMachine, UserId } from "@matrix-org/matrix-sdk-crypto-wasm";
import { describe, expect, it } from "vitest";
import { loadCryptoWasm } from "../../../src/modules/matrix/wasm";

// The same bytes the engine bundles.
const pkg = path.join(process.cwd(), "node_modules", "@matrix-org", "matrix-sdk-crypto-wasm", "pkg");
const bytes = new Uint8Array(readFileSync(path.join(pkg, "matrix_sdk_crypto_wasm_bg.wasm")));

describe("loading the crypto library", () => {
  it("can try again after a failed load, then instantiates the bundled bytes once", async () => {
    await expect(loadCryptoWasm(new Uint8Array([0, 1, 2, 3]))).rejects.toThrow();
    const first = loadCryptoWasm(bytes);
    expect(loadCryptoWasm(bytes)).toBe(first);
    await first;
    const machine = await OlmMachine.initialize(new UserId("@a:x.org"), new DeviceId("DEV"));
    expect(machine.identityKeys.ed25519.toBase64()).toMatch(/^[A-Za-z0-9+/]{43}$/);
    machine.close();
  });
});
