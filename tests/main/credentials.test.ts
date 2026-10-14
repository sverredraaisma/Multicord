import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStore, type SecretBox } from "../../src/main/credentials";

// Reversible stand-in for safeStorage: base64 of a reversed string.
function fakeBox(available = true): SecretBox {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from([...plain].reverse().join("")),
    decryptString: (encrypted) => {
      const text = encrypted.toString();
      if (text.startsWith("!")) throw new Error("not ours");
      return [...text].reverse().join("");
    },
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicord-creds-"));
  file = path.join(dir, "nested", "credentials.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CredentialStore", () => {
  it("encrypts secrets at rest and reads them back in a new session", () => {
    new CredentialStore(file, fakeBox()).save("fluxer:token", "secret-token");
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).not.toContain("secret-token");
    expect(new CredentialStore(file, fakeBox()).load("fluxer:token")).toBe("secret-token");
  });

  it("keeps secrets in memory only when encryption is unavailable", () => {
    const store = new CredentialStore(file, fakeBox(false));
    expect(store.persistent).toBe(false);
    store.save("k", "v");
    expect(store.load("k")).toBe("v");
    expect(fs.existsSync(file)).toBe(false);
    expect(new CredentialStore(file, fakeBox(false)).load("k")).toBeUndefined();
  });

  it("deletes secrets from memory and disk", () => {
    const store = new CredentialStore(file, fakeBox());
    store.save("a", "1");
    store.save("b", "2");
    store.delete("a");
    store.delete("missing");
    expect(store.load("a")).toBeUndefined();
    const fresh = new CredentialStore(file, fakeBox());
    expect(fresh.load("a")).toBeUndefined();
    expect(fresh.load("b")).toBe("2");
  });

  it("ignores unreadable, foreign or malformed entries", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ foreign: Buffer.from("!x").toString("base64"), number: 5 }));
    const store = new CredentialStore(file, fakeBox());
    expect(store.load("foreign")).toBeUndefined();
    expect(store.load("number")).toBeUndefined();
    expect(store.load("absent")).toBeUndefined();

    for (const content of ["not json", "[]", "null"]) {
      fs.writeFileSync(file, content);
      expect(new CredentialStore(file, fakeBox()).load("x")).toBeUndefined();
    }
    const store2 = new CredentialStore(file, fakeBox());
    store2.save("x", "y");
    expect(new CredentialStore(file, fakeBox()).load("x")).toBe("y");
  });

  it("deletes without a file present", () => {
    const store = new CredentialStore(file, fakeBox());
    expect(() => store.delete("x")).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});
