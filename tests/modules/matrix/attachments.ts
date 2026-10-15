// Encrypts a file as Element does for encrypted rooms (matrix-encrypt-attachment):
// a new AES-CTR 256 key, a counter block of 8 random bytes and 8 zero bytes
// (64 bits counting), and the SHA-256 of the ciphertext, all in an
// EncryptedFile v2 for the event's `file` (once its `url` is added).

const unpadded = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64").replace(/=+$/, "");

export async function encryptAttachment(plain: Uint8Array<ArrayBuffer>): Promise<{ data: Uint8Array<ArrayBuffer>; info: Record<string, any> }> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  iv.fill(0, 8);
  const key = await crypto.subtle.generateKey({ name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, plain));
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return {
    data,
    info: { v: "v2", key: { kty: jwk.kty, alg: jwk.alg, k: jwk.k, key_ops: jwk.key_ops, ext: true }, iv: unpadded(iv), hashes: { sha256: unpadded(sha256) } },
  };
}
