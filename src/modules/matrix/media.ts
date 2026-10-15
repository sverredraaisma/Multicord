// Encrypted attachments: in an encrypted room a file is uploaded encrypted
// with a key of its own (AES-CTR 256), and the key, counter and SHA-256 of
// the ciphertext travel in the (Megolm-encrypted) event as an EncryptedFile.
// The hash is checked before anything is decrypted, so a file the server
// swapped or damaged is refused rather than shown.

import type { MxEncryptedFile } from "./api";
import { base64 } from "./client";

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

const unpadded = (bytes: Uint8Array): string => base64(bytes).replace(/=+$/, "");

/**
 * Encrypts a file for an encrypted room as Element does: a new AES-CTR 256
 * key for this file alone, a counter block of 8 random bytes and 8 zero
 * bytes (64 bits counting, so it never wraps), and the SHA-256 of the
 * ciphertext. Returns the ciphertext to upload and the EncryptedFile for the
 * event, which needs only the ciphertext's mxc:// URI added as its url.
 */
export async function encryptAttachment(data: Uint8Array<ArrayBuffer>): Promise<{ data: Uint8Array<ArrayBuffer>; file: Record<string, unknown> }> {
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));
  const key = await crypto.subtle.generateKey({ name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, data));
  const { k } = await crypto.subtle.exportKey("jwk", key);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext));
  return {
    data: ciphertext,
    file: { v: "v2", key: { kty: "oct", alg: "A256CTR", ext: true, k, key_ops: ["encrypt", "decrypt"] }, iv: unpadded(iv), hashes: { sha256: unpadded(hash) } },
  };
}

/** A picture's width and height, when the engine can decode it; undefined otherwise, and the event goes without them. */
export async function imageSize(data: Uint8Array<ArrayBuffer>, mime: string): Promise<{ w: number; h: number } | undefined> {
  if (typeof createImageBitmap !== "function") return undefined;
  try {
    const bitmap = await createImageBitmap(new Blob([data], { type: mime }));
    const size = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return size.w > 0 && size.h > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}
