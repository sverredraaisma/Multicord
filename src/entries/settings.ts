import type { SettingsApi } from "../preload/settings";
import { startSettings } from "../renderer/settings";
import { focusRegions, type FocusBridge } from "../renderer/regions";

startSettings(document, (window as unknown as { multicordSettings: SettingsApi }).multicordSettings);

// F6 and Shift+F6: between this page's regions, and on to the window's other pages.
focusRegions(document, [{ selector: ".settings-nav" }, { selector: ".settings-section" }], (window as unknown as { multicordFocus?: FocusBridge }).multicordFocus);
