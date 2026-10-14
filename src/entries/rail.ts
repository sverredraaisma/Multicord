import type { ShellApi } from "../preload/shell";
import { startRail } from "../renderer/rail";

startRail(document, (window as unknown as { multicord: ShellApi }).multicord);
