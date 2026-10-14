import { createCipheriv, createHmac, hkdfSync, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkKey,
  decodeRecoveryKey,
  decryptSecret,
  encodeRecoveryKey,
  encryptBytes,
  encryptSecret,
  fromBase64,
  keyFromPassphrase,
  parseEncryptedSecret,
  parseKeyDescription,
  SECRET_STORAGE_ALGORITHM,
  toBase64,
} from "../../../src/modules/matrix/recovery";

// A fixed key and IV, and what the spec's m.secret_storage.v1.aes-hmac-sha2
// makes of them, computed with Node's own crypto (not the code under test).
const KEY = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
const IV = new Uint8Array(Array.from({ length: 16 }, (_, i) => (i * 7) & 0x7f));
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function reference(key: Uint8Array, name: string, plaintext: Uint8Array, iv: Uint8Array) {
  const keys = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(32), Buffer.from(name), 64));
  const cipher = createCipheriv("aes-256-ctr", keys.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", keys.subarray(32)).update(ciphertext).digest();
  return { iv: Buffer.from(iv).toString("base64"), ciphertext: ciphertext.toString("base64"), mac: mac.toString("base64") };
}

/** Element's recovery key format, written out independently: 0x8B 0x01, the key, a parity byte, in base58. */
function referenceRecoveryKey(key: Uint8Array): string {
  const bytes = [0x8b, 0x01, ...key];
  bytes.push(bytes.reduce((a, b) => a ^ b, 0));
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

describe("recovery keys", () => {
  it("encodes and decodes Element's format", () => {
    const encoded = encodeRecoveryKey(KEY);
    expect(encoded.replace(/ /g, "")).toBe(referenceRecoveryKey(KEY));
    expect(encoded).toMatch(/^(\w{4} ){11}\w{4}$/);
    expect(decodeRecoveryKey(encoded)).toEqual(KEY);
    expect(decodeRecoveryKey(`  ${encoded.replace(/ /g, "\n")} `)).toEqual(KEY);
  });

  it("rejects text that is not a recovery key", () => {
    const encoded = encodeRecoveryKey(KEY).replace(/ /g, "");
    expect(decodeRecoveryKey("")).toBeUndefined();
    expect(decodeRecoveryKey("0OIl")).toBeUndefined();
    expect(decodeRecoveryKey("x".repeat(201))).toBeUndefined();
    expect(decodeRecoveryKey(encoded.slice(0, -1))).toBeUndefined();
    // One character off breaks the parity.
    const last = encoded.at(-1) === "2" ? "3" : "2";
    expect(decodeRecoveryKey(encoded.slice(0, -1) + last)).toBeUndefined();
    // A different prefix (here a plain base58 number of the right size).
    expect(decodeRecoveryKey(referenceRecoveryKey(KEY).replace(/^./, "1"))).toBeUndefined();
    expect(decodeRecoveryKey("correct horse battery staple")).toBeUndefined();
  });
});

describe("secret encryption", () => {
  it("matches the spec's algorithm", async () => {
    const expected = reference(KEY, "m.cross_signing.master", new TextEncoder().encode("c2VjcmV0"), IV);
    expect(await encryptBytes(KEY, "m.cross_signing.master", new TextEncoder().encode("c2VjcmV0"), IV)).toEqual(expected);
    expect(await decryptSecret(KEY, "m.cross_signing.master", expected)).toBe("c2VjcmV0");
  });

  it("round-trips with a random IV whose bit 63 is clear", async () => {
    const secret = await encryptSecret(KEY, "m.megolm_backup.v1", "a backup key");
    expect(fromBase64(secret.iv)![8]! & 0x80).toBe(0);
    expect(await decryptSecret(KEY, "m.megolm_backup.v1", secret)).toBe("a backup key");
  });

  it("refuses secrets whose MAC or IV does not fit", async () => {
    const secret = await encryptSecret(KEY, "name", "value");
    expect(await decryptSecret(KEY, "other name", secret)).toBeUndefined();
    expect(await decryptSecret(new Uint8Array(32), "name", secret)).toBeUndefined();
    expect(await decryptSecret(KEY, "name", { ...secret, iv: toBase64(new Uint8Array(8)) })).toBeUndefined();
  });

  it("checks a key against its description", async () => {
    const check = reference(KEY, "", new Uint8Array(32), IV);
    const description = { iv: check.iv, mac: check.mac };
    expect(await checkKey(KEY, description)).toBe(true);
    expect(await checkKey(new Uint8Array(32), description)).toBe(false);
    expect(await checkKey(KEY, { ...description, mac: toBase64(new Uint8Array(16)) })).toBe(false);
    expect(await checkKey(KEY, { ...description, iv: toBase64(new Uint8Array(4)) })).toBe(false);
  });

  it("derives keys from a security phrase with PBKDF2-SHA-512", async () => {
    const expected = pbkdf2Sync("my phrase", "salt123", 1000, 32, "sha512");
    expect(Buffer.from(await keyFromPassphrase("my phrase", { salt: "salt123", iterations: 1000 }))).toEqual(expected);
  });
});

describe("account data", () => {
  const description = { algorithm: SECRET_STORAGE_ALGORITHM, iv: "AAAA", mac: "BBBB" };

  it("reads key descriptions, with a usable passphrase only", () => {
    expect(parseKeyDescription(description)).toEqual({ iv: "AAAA", mac: "BBBB" });
    const passphrase = { algorithm: "m.pbkdf2", salt: "s", iterations: 500000 };
    expect(parseKeyDescription({ ...description, passphrase })).toEqual({ iv: "AAAA", mac: "BBBB", passphrase: { salt: "s", iterations: 500000 } });
    expect(parseKeyDescription({ ...description, passphrase: { ...passphrase, bits: 256 } })?.passphrase).toBeDefined();
    for (const bad of [{ bits: 512 }, { iterations: 0 }, { iterations: 1e9 }, { iterations: 1.5 }, { salt: 5 }, { salt: "x".repeat(2000) }, { algorithm: "m.argon" }]) {
      expect(parseKeyDescription({ ...description, passphrase: { ...passphrase, ...bad } })?.passphrase).toBeUndefined();
    }
    expect(parseKeyDescription({ ...description, passphrase: "x" })?.passphrase).toBeUndefined();
    expect(parseKeyDescription({ ...description, algorithm: "m.secret_storage.v2" })).toBeUndefined();
    expect(parseKeyDescription({ ...description, iv: "!!" })).toBeUndefined();
    expect(parseKeyDescription({ ...description, mac: 1 })).toBeUndefined();
    expect(parseKeyDescription(null)).toBeUndefined();
  });

  it("reads encrypted secrets", () => {
    expect(parseEncryptedSecret({ iv: "AA", ciphertext: "BB", mac: "CC" })).toEqual({ iv: "AA", ciphertext: "BB", mac: "CC" });
    expect(parseEncryptedSecret({ iv: "AA", ciphertext: "x".repeat(20000), mac: "CC" })).toBeUndefined();
    expect(parseEncryptedSecret({ iv: "AA", mac: "CC" })).toBeUndefined();
    expect(parseEncryptedSecret("x")).toBeUndefined();
  });

  it("decodes padded and unpadded base64 alike", () => {
    expect(fromBase64("AQI=")).toEqual(new Uint8Array([1, 2]));
    expect(fromBase64("AQI")).toEqual(new Uint8Array([1, 2]));
    expect(fromBase64("A")).toBeUndefined();
  });
});

describe("oversized input", () => {
  it("does not decode base64 longer than any key or secret", () => {
    expect(fromBase64("A".repeat(16_385))).toBeUndefined();
  });
});
