import type { ShellApi } from "../preload/shell";
import { startUnreachable } from "../renderer/unreachable";

startUnreachable(document, (window as unknown as { multicord: ShellApi }).multicord);
