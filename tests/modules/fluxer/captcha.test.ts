import { createChallenge, verifySolution } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { describe, expect, it } from "vitest";
import { captchaToken, isAltchaChallenge, solveAltcha, type AltchaChallenge } from "../../../src/modules/fluxer/captcha";

const SECRET = "test-secret";

describe("solveAltcha", () => {
  // Interop: the reference ALTCHA v2 server library must accept our solutions.
  it.each([
    ["random prefix", {}],
    ["deterministic counter", { counter: 300 }],
    ["SHA-512", { algorithm: "PBKDF2/SHA-512" }],
  ])("solves challenges altcha-lib verifies (%s)", async (_label, extra) => {
    const challenge = await createChallenge({
      algorithm: "PBKDF2/SHA-256",
      cost: 2,
      deriveKey,
      hmacSignatureSecret: SECRET,
      keyPrefixLength: 1,
      ...extra,
    });
    const solution = await solveAltcha(challenge as unknown as AltchaChallenge);
    const result = await verifySolution({ challenge, solution, deriveKey, hmacSignatureSecret: SECRET });
    expect(result.verified).toBe(true);

    // The header decodes to the payload shape Fluxer documents, and still verifies.
    const decoded = JSON.parse(Buffer.from(captchaToken(challenge as unknown as AltchaChallenge, solution), "base64").toString("utf8"));
    expect(Object.keys(decoded)).toEqual(["challenge", "solution"]);
    expect((await verifySolution({ ...decoded, deriveKey, hmacSignatureSecret: SECRET })).verified).toBe(true);
  });

  it("rejects malformed or unsupported challenges", async () => {
    const base = { algorithm: "PBKDF2/SHA-256", nonce: "00", salt: "00", cost: 1, keyLength: 32, keyPrefix: "0" };
    const cases: Record<string, unknown>[] = [
      { ...base, algorithm: "ARGON2ID" },
      { ...base, algorithm: 5 },
      { ...base, nonce: "xyz" },
      { ...base, salt: 4 },
      { ...base, cost: 0 },
      { ...base, keyLength: 1.5 },
      { ...base, keyPrefix: "" },
      { ...base, keyPrefix: "zz" },
    ];
    for (const parameters of cases) {
      await expect(solveAltcha({ parameters })).rejects.toThrow(/Unsupported|Malformed/);
    }
  });

  it("gives up after the timeout", async () => {
    let clock = 0;
    const impossible = { algorithm: "PBKDF2/SHA-256", nonce: "00", salt: "00", cost: 1, keyPrefix: "0".repeat(64) };
    await expect(solveAltcha({ parameters: impossible }, { timeoutMs: 5, now: () => (clock += 1) })).rejects.toThrow(
      "Captcha could not be solved in time",
    );
  });

  it("recognises challenges", () => {
    expect(isAltchaChallenge({ parameters: {}, signature: "s" })).toBe(true);
    expect(isAltchaChallenge({ signature: "s" })).toBe(false);
  });
});
