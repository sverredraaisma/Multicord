import type { SettingsApi } from "../preload/settings";
import { startSettings } from "../renderer/settings";

startSettings(document, (window as unknown as { multicordSettings: SettingsApi }).multicordSettings);
