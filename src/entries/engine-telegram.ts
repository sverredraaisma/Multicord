import type { EngineBridge } from "../preload/engine";
import { parseCredentials } from "../modules/telegram/adapter";
import { startTelegramEngine } from "../modules/telegram/engine";

// Set at build time (scripts/build.mjs) from the environment and package.json.
declare const __TELEGRAM_API_ID__: string;
declare const __TELEGRAM_API_HASH__: string;
declare const __APP_VERSION__: string;

const builtIn = parseCredentials(JSON.stringify({ apiId: Number(__TELEGRAM_API_ID__), apiHash: __TELEGRAM_API_HASH__ }));
void startTelegramEngine((window as unknown as { multicordEngine: EngineBridge }).multicordEngine, { builtIn, appVersion: __APP_VERSION__ });
