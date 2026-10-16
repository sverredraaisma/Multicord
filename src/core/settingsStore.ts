import { applySettingsPatch, parseSettings, type AppSettings, type SettingsPatch } from "../shared/settings";
import { Emitter } from "../shared/emitter";

/** Where the settings are kept: settings.json on the desktop. */
export interface SettingsPersistence {
  /** What was saved last; may throw or be anything when it is missing or broken. */
  read(): unknown;
  write(settings: AppSettings): void;
}

/** The app settings: read leniently at start, written on every change. */
export class SettingsStore {
  private current: AppSettings;
  readonly changed = new Emitter<{ settings: AppSettings; patch: SettingsPatch }>();

  constructor(private readonly persistence: SettingsPersistence) {
    let raw: unknown;
    try {
      raw = persistence.read();
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
    this.persistence.write(this.current);
    this.changed.emit({ settings: this.current, patch });
    return this.current;
  }
}
