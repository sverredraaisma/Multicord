import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStore, MAX_SCOPED_CHARS, MAX_SCOPED_SECRETS, type SecretBox } from "../../src/main/credentials";

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
    getSelectedStorageBackend: () => "gnome_libsecret",
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

  it("on Linux, writes nothing under Chromium's built-in fallback key", () => {
    const box = (backend?: string): SecretBox => ({ ...fakeBox(), getSelectedStorageBackend: backend ? () => backend : undefined });
    for (const backend of ["basic_text", "unknown", undefined]) {
      const store = new CredentialStore(file, box(backend), "linux");
      expect(store.persistent).toBe(false);
      store.save("k", "v");
      expect(store.load("k")).toBe("v");
      expect(fs.existsSync(file)).toBe(false);
    }
    for (const backend of ["gnome_libsecret", "kwallet5", "kwallet6"]) expect(new CredentialStore(file, box(backend), "linux").persistent).toBe(true);
    // Elsewhere the backend is not asked: DPAPI and the keychain are real stores.
    const asked = { ...fakeBox(), getSelectedStorageBackend: () => { throw new Error("Linux only"); } };
    expect(new CredentialStore(file, asked, "win32").persistent).toBe(true);
    expect(new CredentialStore(file, asked, "darwin").persistent).toBe(true);
  });

  it("gives each service instance only its own keys", () => {
    const store = new CredentialStore(file, fakeBox());
    const fluxer = store.scope("fluxer");
    const other = store.scope("fluxer-2");
    fluxer.save("fluxer.app:token", "mine");
    expect(store.load("fluxer:fluxer.app:token")).toBe("mine");
    expect(other.load("fluxer.app:token")).toBeUndefined();
    expect(other.load("../fluxer:fluxer.app:token")).toBeUndefined();
    other.save(":fluxer.app:token", "x"); // stays under fluxer-2
    expect(fluxer.load("fluxer.app:token")).toBe("mine");
    fluxer.delete("fluxer.app:token");
    expect(store.load("fluxer:fluxer.app:token")).toBeUndefined();
    expect(() => store.scope("Bad:Id")).toThrow("Invalid instance id");
  });

  it("caps what one instance may keep, leaving the others alone", () => {
    for (const persistent of [true, false]) {
      const store = new CredentialStore(file, fakeBox(persistent));
      const greedy = store.scope("greedy");
      for (let i = 0; i < MAX_SCOPED_SECRETS; i++) greedy.save(`k${i}`, "v");
      expect(() => greedy.save("one-more", "v")).toThrow("too many secrets");
      greedy.save("k0", "changed"); // replacing an existing key is fine
      store.scope("other").save("token", "fine");
      expect(store.load("other:token")).toBe("fine");
      store.deletePrefix("greedy:");
      store.deletePrefix("other:");
      const big = store.scope("big");
      expect(() => big.save("blob", "x".repeat(MAX_SCOPED_CHARS + 1))).toThrow("too many secrets");
      big.save("blob", "x".repeat(1000));
      store.deletePrefix("big:");
    }
  });

  it("forgets every secret of a removed service", () => {
    const store = new CredentialStore(file, fakeBox());
    store.save("el:x:token", "1");
    store.save("fluxer:x:token", "2");
    store.deletePrefix("el:");
    store.deletePrefix("none:");
    expect(store.load("el:x:token")).toBeUndefined();
    const fresh = new CredentialStore(file, fakeBox());
    expect(fresh.load("el:x:token")).toBeUndefined();
    expect(fresh.load("fluxer:x:token")).toBe("2");
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
