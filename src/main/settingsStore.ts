import fs from "node:fs";
import path from "node:path";
import { applySettingsPatch, parseSettings, type AppSettings, type SettingsPatch } from "../shared/settings";
import { Emitter } from "./adapters/emitter";

/** settings.json: read leniently at start, written on every change. */
export class SettingsStore {
  private current: AppSettings;
  readonly changed = new Emitter<{ settings: AppSettings; patch: SettingsPatch }>();

  constructor(private readonly file: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      raw = undefined; // Missing or broken: defaults.
    }
    this.current = parseSettings(raw);
  }

  get(): AppSettings {
    return this.current;
  }

  update(patch: SettingsPatch): AppSettings {
    this.current = applySettingsPatch(this.current, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.current, null, 2));
    this.changed.emit({ settings: this.current, patch });
    return this.current;
  }
}
