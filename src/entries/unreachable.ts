import type { ShellApi } from "../preload/shell";
import { startUnreachable } from "../renderer/unreachable";
import { focusRegions, type FocusBridge } from "../renderer/regions";

startUnreachable(document, (window as unknown as { multicord: ShellApi }).multicord);

// F6 and Shift+F6: between this page's regions, and on to the window's other pages.
focusRegions(document, [{ selector: ".unreachable", prefer: "#unreachable-retry" }], (window as unknown as { multicordFocus?: FocusBridge }).multicordFocus);
