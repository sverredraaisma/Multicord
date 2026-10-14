import type { NativeApi } from "../preload/native";
import { startNative } from "../renderer/native";

startNative(document, (window as unknown as { multicordNative: NativeApi }).multicordNative);
