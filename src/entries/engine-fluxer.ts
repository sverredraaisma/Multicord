import type { EngineBridge } from "../preload/engine";
import { startFluxerEngine } from "../modules/fluxer/engine";

void startFluxerEngine((window as unknown as { multicordEngine: EngineBridge }).multicordEngine);
