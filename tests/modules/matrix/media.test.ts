import { describe, expect, it } from "vitest";
import { parseEncryptedFile } from "../../../src/modules/matrix/events";
import { AttachmentError, decodeBase64, decryptAttachment } from "../../../src/modules/matrix/media";
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
