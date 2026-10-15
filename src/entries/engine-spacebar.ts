import type { EngineBridge } from "../preload/engine";
import { startSpacebarEngine } from "../modules/spacebar/engine";

void startSpacebarEngine((window as unknown as { multicordEngine: EngineBridge }).multicordEngine);
