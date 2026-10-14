import type { ShellApi } from "../preload/shell";
import { startTooltip } from "../renderer/tooltip";

startTooltip(document, (window as unknown as { multicord: ShellApi }).multicord);
