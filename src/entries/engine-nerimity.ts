import type { EngineBridge } from "../preload/engine";
import { startNerimityEngine } from "../modules/nerimity/engine";

void startNerimityEngine((window as unknown as { multicordEngine: EngineBridge }).multicordEngine);
