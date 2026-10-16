import type { EngineBridge } from "../preload/engine";
import { parseCredentials } from "../modules/telegram/adapter";
import { startTelegramEngine } from "../modules/telegram/engine";
import { useSocketBridge } from "../modules/telegram/websocket";

// Set at build time (scripts/build.mjs) from the environment and package.json.
declare const __TELEGRAM_API_ID__: string;
declare const __TELEGRAM_API_HASH__: string;
declare const __APP_VERSION__: string;

const builtIn = parseCredentials(JSON.stringify({ apiId: Number(__TELEGRAM_API_ID__), apiHash: __TELEGRAM_API_HASH__ }));
const bridge = (window as unknown as { multicordEngine: EngineBridge }).multicordEngine;
// GramJS's sockets (it imports the websocket package, which the build points at this module) go through the shell.
useSocketBridge(bridge);
void startTelegramEngine(bridge, { builtIn, appVersion: __APP_VERSION__ });
