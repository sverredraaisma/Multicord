import type { ShellApi } from "../preload/shell";
import { startPicker } from "../renderer/picker";

startPicker(document, (window as unknown as { multicord: ShellApi }).multicord);
