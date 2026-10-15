// Encrypted attachments: in an encrypted room a file is uploaded encrypted
// with a key of its own (AES-CTR 256), and the key, counter and SHA-256 of
// the ciphertext travel in the (Megolm-encrypted) event as an EncryptedFile.
// The hash is checked before anything is decrypted, so a file the server
// swapped or damaged is refused rather than shown.

import type { MxEncryptedFile } from "./api";

/** An encrypted attachment that must not be shown; its message says why, in a few words. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Base64 or base64url, padded or not, as bytes. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Decrypts a downloaded attachment (EncryptedFile v2, as events.ts checked
 * it): SHA-256 of the ciphertext first, then AES-CTR with the event's key and
 * counter block, 64 bits of it counting, as Element encrypts.
 */
export async function decryptAttachment(data: Uint8Array<ArrayBuffer>, file: MxEncryptedFile): Promise<Uint8Array<ArrayBuffer>> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  if (!equal(digest, decodeBase64(file.sha256))) throw new AttachmentError("it does not match its checksum, so it may have been changed");
  const key = await crypto.subtle.importKey("raw", decodeBase64(file.key), { name: "AES-CTR" }, false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: decodeBase64(file.iv), length: 64 }, key, data));
}
