import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileSettingsStore, platformsFile } from "../../src/main/settingsFiles";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicord-settings-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("settings files", () => {
  it("keeps the settings in settings.json, read leniently", () => {
    const file = path.join(dir, "nested", "settings.json");
    const store = fileSettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    store.update({ general: { notifications: false } });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(store.get());
    expect(fileSettingsStore(file).get().general.notifications).toBe(false);
    fs.writeFileSync(file, "not json");
    expect(fileSettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);
  });

  it("reads and writes platforms.json, which may not exist yet", () => {
    const config = platformsFile(path.join(dir, "nested", "platforms.json"));
    expect(config.read()).toBeUndefined();
    config.write("[]\n");
    expect(config.read()).toBe("[]\n");
  });
});
