// Secret storage (Matrix spec, "Secret storage"): the user's cross-signing
// keys and key backup key, kept in their account data, encrypted with a key
// only they have: the recovery key Element shows (or a key derived from a
// security phrase). This file decodes that key, checks it against the key
// description, and decrypts secrets with m.secret_storage.v1.aes-hmac-sha2,
// all with WebCrypto. Account data comes from the server and is untrusted.

import { isRecord } from "./events";

export const SECRET_STORAGE_ALGORITHM = "m.secret_storage.v1.aes-hmac-sha2";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Recovery keys start with these two bytes, then the 32-byte key and a parity byte. */
const PREFIX = [0x8b, 0x01];
const KEY_BYTES = 32;
const MAX_INPUT = 200;
/** Bounds on a security phrase's key derivation, so a hostile description cannot stall the engine. */
const MAX_ITERATIONS = 5_000_000;
const MAX_BASE64 = 16_384;

type Bytes = Uint8Array<ArrayBuffer>;

/** A secret storage key's description (m.secret_storage.key.<id>). */
export interface KeyDescription {
  iv: string;
  mac: string;
  passphrase?: { salt: string; iterations: number };
}

/** One encrypted secret, as stored for one key. */
export interface EncryptedSecret {
  iv: string;
  ciphertext: string;
  mac: string;
}

const text = new TextEncoder();

export function fromBase64(value: string): Bytes | undefined {
  if (value.length > MAX_BASE64) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const isBase64 = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_BASE64 && fromBase64(value) !== undefined;

/** The recovery key's 32 bytes, or undefined when the text is not a recovery key (wrong characters, prefix or parity). */
export function decodeRecoveryKey(input: string): Bytes | undefined {
  const compact = input.replace(/\s+/g, "");
  if (compact === "" || compact.length > MAX_INPUT) return undefined;
  let value = 0n;
  for (const char of compact) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return undefined;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  if (bytes.length !== PREFIX.length + KEY_BYTES + 1 || bytes[0] !== PREFIX[0] || bytes[1] !== PREFIX[1]) return undefined;
  // The parity byte makes the XOR of all bytes zero.
  if (bytes.reduce((parity, byte) => parity ^ byte, 0) !== 0) return undefined;
  return new Uint8Array(bytes.slice(PREFIX.length, PREFIX.length + KEY_BYTES));
}

/** A key as Element shows recovery keys: base58 in groups of four. */
export function encodeRecoveryKey(key: Uint8Array): string {
  const bytes = [...PREFIX, ...key];
  bytes.push(bytes.reduce((parity, byte) => parity ^ byte, 0));
  let value = bytes.reduce((acc, byte) => acc * 256n + BigInt(byte), 0n);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return encoded.match(/.{1,4}/g)!.join(" ");
}

/** A key description we can use, or undefined. */
export function parseKeyDescription(raw: unknown): KeyDescription | undefined {
  if (!isRecord(raw) || raw.algorithm !== SECRET_STORAGE_ALGORITHM || !isBase64(raw.iv) || !isBase64(raw.mac)) return undefined;
  const description: KeyDescription = { iv: raw.iv, mac: raw.mac };
  const phrase = raw.passphrase;
  if (
    isRecord(phrase) &&
    phrase.algorithm === "m.pbkdf2" &&
    typeof phrase.salt === "string" &&
    phrase.salt.length <= 1024 &&
    typeof phrase.iterations === "number" &&
    Number.isInteger(phrase.iterations) &&
    phrase.iterations > 0 &&
    phrase.iterations <= MAX_ITERATIONS &&
    (phrase.bits === undefined || phrase.bits === 256)
  ) {
    description.passphrase = { salt: phrase.salt, iterations: phrase.iterations };
  }
  return description;
}

export function parseEncryptedSecret(raw: unknown): EncryptedSecret | undefined {
  return isRecord(raw) && isBase64(raw.iv) && isBase64(raw.ciphertext) && isBase64(raw.mac) ? { iv: raw.iv, ciphertext: raw.ciphertext, mac: raw.mac } : undefined;
}

/** The key behind a security phrase (PBKDF2 with SHA-512, as the spec has it). */
export async function keyFromPassphrase(passphrase: string, settings: { salt: string; iterations: number }): Promise<Bytes> {
  const base = await crypto.subtle.importKey("raw", text.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: text.encode(settings.salt), iterations: settings.iterations }, base, KEY_BYTES * 8);
  return new Uint8Array(bits);
}

/** The AES and HMAC keys for one secret name (HKDF-SHA-256 with a zero salt). */
async function secretKeys(key: Bytes, name: string): Promise<{ aes: CryptoKey; hmac: CryptoKey }> {
  const base = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: text.encode(name) }, base, 512));
  const [aes, hmac] = await Promise.all([
    crypto.subtle.importKey("raw", bits.slice(0, 32), { name: "AES-CTR" }, false, ["encrypt", "decrypt"]),
    crypto.subtle.importKey("raw", bits.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  ]);
  return { aes, hmac };
}

/** Encrypts bytes under a secret name; `iv` is random unless given. */
export async function encryptBytes(key: Bytes, name: string, plaintext: Bytes, iv?: Bytes): Promise<EncryptedSecret> {
  const counter = iv ?? crypto.getRandomValues(new Uint8Array(16));
  // The spec clears bit 63 so the 64-bit counter cannot wrap.
  if (!iv) counter[8]! &= 0x7f;
  const { aes, hmac } = await secretKeys(key, name);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, aes, plaintext));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, ciphertext));
  return { iv: toBase64(counter), ciphertext: toBase64(ciphertext), mac: toBase64(mac) };
}

export function encryptSecret(key: Bytes, name: string, secret: string): Promise<EncryptedSecret> {
  return encryptBytes(key, name, text.encode(secret));
}

/** Decrypts a secret after checking its MAC; undefined when the MAC does not match. */
export async function decryptSecret(key: Bytes, name: string, secret: EncryptedSecret): Promise<string | undefined> {
  const iv = fromBase64(secret.iv)!;
  const ciphertext = fromBase64(secret.ciphertext)!;
  const mac = fromBase64(secret.mac)!;
  if (iv.length !== 16) return undefined;
  const { aes, hmac } = await secretKeys(key, name);
  if (!(await crypto.subtle.verify("HMAC", hmac, mac, ciphertext))) return undefined;
  const plaintext = await crypto.subtle.decrypt({ name: "AES-CTR", counter: iv, length: 64 }, aes, ciphertext);
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

/** Whether a key is the one a description was made for: it must encrypt 32 zero bytes under "" to the stored MAC. */
export async function checkKey(key: Bytes, description: KeyDescription): Promise<boolean> {
  const iv = fromBase64(description.iv)!;
  if (iv.length !== 16) return false;
  const { mac } = await encryptBytes(key, "", new Uint8Array(32), iv);
  const expected = fromBase64(description.mac)!;
  const actual = fromBase64(mac)!;
  return expected.length === actual.length && expected.every((byte, i) => byte === actual[i]);
}
