import { isRecord } from "./types";

const DIGESTS: Record<string, string> = {
  "PBKDF2/SHA-256": "SHA-256",
  "PBKDF2/SHA-384": "SHA-384",
  "PBKDF2/SHA-512": "SHA-512",
};

export interface AltchaChallenge {
  parameters: Record<string, unknown>;
  signature?: unknown;
}

export interface AltchaSolution {
  counter: number;
  derivedKey: string;
  time: number;
}

const HEX = /^(?:[0-9a-f]{2})*$/i;

export function isAltchaChallenge(value: unknown): value is AltchaChallenge {
  return isRecord(value) && isRecord(value.parameters);
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Solves an ALTCHA v2 proof-of-work challenge, as Fluxer issues on login.
 * The password is the nonce followed by a big-endian uint32 counter; the
 * PBKDF2 key over the salt must start with `keyPrefix` (per altcha-lib v2).
 * Uses WebCrypto, so it runs in a sandboxed engine as well as in Node.
 */
export async function solveAltcha(
  challenge: AltchaChallenge,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<AltchaSolution> {
  const { algorithm, nonce, salt, cost, keyLength = 32, keyPrefix } = challenge.parameters;
  const hash = typeof algorithm === "string" ? DIGESTS[algorithm] : undefined;
  if (!hash) throw new Error(`Unsupported captcha algorithm: ${String(algorithm)}`);
  if (typeof nonce !== "string" || !HEX.test(nonce) || typeof salt !== "string" || !HEX.test(salt)) {
    throw new Error("Malformed captcha challenge");
  }
  if (!Number.isInteger(cost) || (cost as number) < 1 || !Number.isInteger(keyLength) || (keyLength as number) < 1) {
    throw new Error("Malformed captcha challenge");
  }
  if (typeof keyPrefix !== "string" || keyPrefix === "" || !/^[0-9a-f]+$/i.test(keyPrefix)) {
    throw new Error("Malformed captcha challenge");
  }

  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const prefix = keyPrefix.toLowerCase();
  const saltBytes = fromHex(salt);
  const nonceBytes = fromHex(nonce);
  const password = new Uint8Array(nonceBytes.length + 4);
  password.set(nonceBytes);
  const view = new DataView(password.buffer);
  const start = now();

  for (let counter = 0; counter <= 0xffffffff; counter++) {
    if (now() - start > timeoutMs) break;
    view.setUint32(password.length - 4, counter, false);
    const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash, salt: saltBytes, iterations: cost as number }, key, (keyLength as number) * 8);
    const hex = toHex(new Uint8Array(bits));
    if (hex.startsWith(prefix)) return { counter, derivedKey: hex, time: now() - start };
  }
  throw new Error("Captcha could not be solved in time");
}

/** The X-Captcha-Token header: base64 of {challenge: {parameters, signature}, solution}. */
export function captchaToken(challenge: AltchaChallenge, solution: AltchaSolution): string {
  const payload = { challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
