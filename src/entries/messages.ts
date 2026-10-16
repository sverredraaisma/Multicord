import type { MessagesApi } from "../preload/messages";
import { startMessages } from "../renderer/messages";
import { focusRegions, type FocusBridge } from "../renderer/regions";

startMessages(document, (window as unknown as { multicordMessages: MessagesApi }).multicordMessages);

// F6 and Shift+F6: between this page's regions, and on to the window's other pages.
focusRegions(document, [{ selector: "#messages" }], (window as unknown as { multicordFocus?: FocusBridge }).multicordFocus);
