import fs from "node:fs";
import path from "node:path";

/** A module's own secrets; see CredentialStore.scope. */
export interface SecretStore {
  load(key: string): string | undefined;
  save(key: string, value: string): void;
  delete(key: string): void;
}

/** The subset of Electron's safeStorage we use (OS keychain, DPAPI or libsecret). */
export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Persists native adapters' tokens, encrypted with the OS secret store. When
 * encryption is unavailable (e.g. no keyring on Linux), secrets are kept in
 * memory only and never written in plain text.
 */
export class CredentialStore {
  private readonly memory = new Map<string, string>();

  constructor(
    private readonly file: string,
    private readonly box: SecretBox,
  ) {}

  get persistent(): boolean {
    return this.box.isEncryptionAvailable();
  }

  load(key: string): string | undefined {
    const cached = this.memory.get(key);
    if (cached !== undefined) return cached;
    if (!this.persistent) return undefined;
    const encoded = this.readAll()[key];
    if (typeof encoded !== "string") return undefined;
    try {
      const value = this.box.decryptString(Buffer.from(encoded, "base64"));
      this.memory.set(key, value);
      return value;
    } catch {
      return undefined; // Encrypted by another user or machine.
    }
  }

  save(key: string, value: string): void {
    this.memory.set(key, value);
    if (!this.persistent) return;
    const all = this.readAll();
    all[key] = this.box.encryptString(value).toString("base64");
    this.writeAll(all);
  }

  delete(key: string): void {
    this.memory.delete(key);
    const all = this.readAll();
    if (!(key in all)) return;
    delete all[key];
    this.writeAll(all);
  }

  /**
   * A view of this store limited to one service instance: every key gets
   * the instance id as prefix, so a module can never name another
   * instance's secrets.
   */
  scope(instanceId: string): SecretStore {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(instanceId)) throw new Error(`Invalid instance id: ${instanceId}`);
    const full = (key: string): string => `${instanceId}:${key}`;
    return {
      load: (key) => this.load(full(key)),
      save: (key, value) => this.save(full(key), value),
      delete: (key) => this.delete(full(key)),
    };
  }

  /** Forgets every secret whose key starts with `prefix`, e.g. a removed service's. */
  deletePrefix(prefix: string): void {
    for (const key of [...this.memory.keys()]) if (key.startsWith(prefix)) this.memory.delete(key);
    const all = this.readAll();
    const keys = Object.keys(all).filter((key) => key.startsWith(prefix));
    if (keys.length === 0) return;
    for (const key of keys) delete all[key];
    this.writeAll(all);
  }

  private readAll(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private writeAll(all: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }
}
