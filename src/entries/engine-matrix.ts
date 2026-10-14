import type { EngineBridge } from "../preload/engine";
import { startMatrixEngine } from "../modules/matrix/engine";

void startMatrixEngine((window as unknown as { multicordEngine: EngineBridge }).multicordEngine);
