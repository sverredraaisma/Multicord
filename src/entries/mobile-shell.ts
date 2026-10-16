import { startMobileShell } from "../mobile/page";
import type { ShellBridge } from "../mobile/protocol";

// The shell bridge is native code's document-start script on the shell's own origin (mobile/android, assets/bridge/shell.js).
startMobileShell(document, (window as unknown as { multicordShell: ShellBridge }).multicordShell);
