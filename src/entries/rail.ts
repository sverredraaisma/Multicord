import type { ShellApi } from "../preload/shell";
import { startRail } from "../renderer/rail";
import { focusRegions, type FocusBridge } from "../renderer/regions";

startRail(document, (window as unknown as { multicord: ShellApi }).multicord);

// F6 and Shift+F6: between this page's regions, and on to the window's other pages.
focusRegions(document, [{ selector: "body", prefer: ".rail-item.active" }], (window as unknown as { multicordFocus?: FocusBridge }).multicordFocus);
