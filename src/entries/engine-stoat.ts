import type { EngineBridge } from "../preload/engine";
import { startStoatEngine } from "../modules/stoat/engine";

void startStoatEngine((window as unknown as { multicordEngine: EngineBridge }).multicordEngine);
