import { pbkdf2 } from "node:crypto";
import { promisify } from "node:util";
import { isRecord } from "./types";

const pbkdf2Async = promisify(pbkdf2);

const DIGESTS: Record<string, string> = {
  "PBKDF2/SHA-256": "sha256",
  "PBKDF2/SHA-384": "sha384",
  "PBKDF2/SHA-512": "sha512",
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

/**
 * Solves an ALTCHA v2 proof-of-work challenge, as Fluxer issues on login.
 * The password is the nonce followed by a big-endian uint32 counter; the
 * PBKDF2 key over the salt must start with `keyPrefix` (per altcha-lib v2).
 */
export async function solveAltcha(
  challenge: AltchaChallenge,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<AltchaSolution> {
  const { algorithm, nonce, salt, cost, keyLength = 32, keyPrefix } = challenge.parameters;
  const digest = typeof algorithm === "string" ? DIGESTS[algorithm] : undefined;
  if (!digest) throw new Error(`Unsupported captcha algorithm: ${String(algorithm)}`);
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
  const saltBuffer = Buffer.from(salt, "hex");
  const password = Buffer.alloc(nonce.length / 2 + 4);
  Buffer.from(nonce, "hex").copy(password);
  const start = now();

  for (let counter = 0; counter <= 0xffffffff; counter++) {
    if (now() - start > timeoutMs) break;
    password.writeUInt32BE(counter, password.length - 4);
    const key = await pbkdf2Async(password, saltBuffer, cost as number, keyLength as number, digest);
    const hex = key.toString("hex");
    if (hex.startsWith(prefix)) return { counter, derivedKey: hex, time: now() - start };
  }
  throw new Error("Captcha could not be solved in time");
}

/** The X-Captcha-Token header: base64 of {challenge: {parameters, signature}, solution}. */
export function captchaToken(challenge: AltchaChallenge, solution: AltchaSolution): string {
  const payload = { challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}
