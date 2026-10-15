import { createDecipheriv, createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEncryptedFile } from "../../../src/modules/matrix/events";
import { AttachmentError, decodeBase64, decryptAttachment, encryptAttachment as ours, imageSize } from "../../../src/modules/matrix/media";
import type { MxEncryptedFile } from "../../../src/modules/matrix/api";
import { encryptAttachment } from "./attachments";

const PLAIN = new TextEncoder().encode("a picture, as far as this test is concerned");

/** Encrypts PLAIN as Element would, and reads the EncryptedFile back as events.ts does. */
async function encrypted() {
  const { data, info } = await encryptAttachment(PLAIN);
  const file = parseEncryptedFile({ ...info, url: "mxc://x.org/enc" }) as MxEncryptedFile;
  return { data, info, file };
}

describe("base64", () => {
  it("decodes base64 and base64url, padded or not", () => {
    expect([...decodeBase64("AQID")]).toEqual([1, 2, 3]);
    expect([...decodeBase64("AQ")]).toEqual([1]);
    expect([...decodeBase64("AQ==")]).toEqual([1]);
    expect([...decodeBase64("-_8")]).toEqual([251, 255]);
    expect([...decodeBase64("+/8=")]).toEqual([251, 255]);
  });
});

describe("encrypted attachments", () => {
  it("decrypts what Element encrypts", async () => {
    const { data, file } = await encrypted();
    expect(file).toMatchObject({ url: "mxc://x.org/enc" });
    expect(new TextDecoder().decode(await decryptAttachment(data, file))).toBe(new TextDecoder().decode(PLAIN));
  });

  it("refuses a changed ciphertext before decrypting it", async () => {
    const { data, file } = await encrypted();
    data[0]! ^= 1;
    await expect(decryptAttachment(data, file)).rejects.toThrow(AttachmentError);
    await expect(decryptAttachment(data, file)).rejects.toThrow("does not match its checksum");
  });

  it("refuses a file whose hash names other bytes", async () => {
    const { data, info } = await encrypted();
    const file = parseEncryptedFile({ ...info, url: "mxc://x.org/enc", hashes: { sha256: "A".repeat(43) } }) as MxEncryptedFile;
    await expect(decryptAttachment(data, file)).rejects.toThrow(AttachmentError);
  });

  it("takes a padded hash and counter block", async () => {
    const { data, info } = await encrypted();
    const file = parseEncryptedFile({ ...info, url: "mxc://x.org/enc", iv: `${info.iv}==`, hashes: { sha256: `${info.hashes.sha256}=` } }) as MxEncryptedFile;
    expect(await decryptAttachment(data, file)).toEqual(PLAIN);
  });

  it("gives other bytes with another key, which is why the hash is of the ciphertext", async () => {
    const { data, file } = await encrypted();
    const other = await encrypted();
    expect(await decryptAttachment(data, { ...file, key: other.file.key })).not.toEqual(PLAIN);
  });
});

describe("encrypting attachments", () => {
  it("encrypts as Element does, in a form events.ts and Multicord read back", async () => {
    const { data, file } = await ours(PLAIN);
    expect(file).toEqual({
      v: "v2",
      key: { kty: "oct", alg: "A256CTR", ext: true, k: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), key_ops: ["encrypt", "decrypt"] },
      iv: expect.stringMatching(/^[A-Za-z0-9+/]{22}$/),
      hashes: { sha256: expect.stringMatching(/^[A-Za-z0-9+/]{43}$/) },
    });
    // 8 random bytes and 8 zero bytes: the counter half starts at zero.
    expect([...decodeBase64(file.iv as string).subarray(8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Buffer.from(data).equals(Buffer.from(PLAIN))).toBe(false);
    const parsed = parseEncryptedFile({ ...file, url: "mxc://x.org/ours" }) as MxEncryptedFile;
    expect(await decryptAttachment(data, parsed)).toEqual(PLAIN);
  });

  it("decrypts with plain AES-256-CTR and SHA-256, as any other client would", async () => {
    const { data, file } = await ours(PLAIN);
    const key = file.key as { k: string };
    expect(createHash("sha256").update(data).digest("base64").replace(/=+$/, "")).toBe((file.hashes as { sha256: string }).sha256);
    const decipher = createDecipheriv("aes-256-ctr", decodeBase64(key.k), decodeBase64(file.iv as string));
    expect(new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]))).toEqual(PLAIN);
  });

  it("uses a new key and counter for every file", async () => {
    const [a, b] = [await ours(PLAIN), await ours(PLAIN)];
    expect(a.file.iv).not.toBe(b.file.iv);
    expect((a.file.key as { k: string }).k).not.toBe((b.file.key as { k: string }).k);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(false);
  });
});

describe("picture sizes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("measures what the engine can decode, and nothing else", async () => {
    expect(await imageSize(PLAIN, "image/png")).toBeUndefined();
    const close = vi.fn();
    const decode = vi.fn(async (_blob: Blob) => ({ width: 640, height: 480, close }));
    vi.stubGlobal("createImageBitmap", decode);
    expect(await imageSize(PLAIN, "image/png")).toEqual({ w: 640, h: 480 });
    expect(decode.mock.calls[0]![0].type).toBe("image/png");
    expect(close).toHaveBeenCalled();
    decode.mockResolvedValueOnce({ width: 0, height: 480, close });
    expect(await imageSize(PLAIN, "image/png")).toBeUndefined();
    decode.mockRejectedValueOnce(new Error("The source image could not be decoded."));
    expect(await imageSize(PLAIN, "image/png")).toBeUndefined();
  });
});
