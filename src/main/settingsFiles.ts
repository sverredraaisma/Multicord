import fs from "node:fs";
import path from "node:path";
import type { PlatformsConfig } from "../core/settingsController";
import { SettingsStore } from "../core/settingsStore";

/** A text file that may not exist yet; writing creates its directory. */
function textFile(file: string): { read(): string | undefined; write(text: string): void } {
  return {
    read() {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
    write(text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
  };
}

/** settings.json: read leniently at start, written on every change. */
export function fileSettingsStore(file: string): SettingsStore {
  const text = textFile(file);
  return new SettingsStore({
    read: () => JSON.parse(text.read() ?? ""),
    write: (settings) => text.write(JSON.stringify(settings, null, 2)),
  });
}

/** platforms.json, which the settings page edits. */
export function platformsFile(file: string): PlatformsConfig {
  return textFile(file);
}
