// The modules the phone app runs: the native ones, whose logic runs in an
// engine and renders in Multicord's own chat view. Their manifests are the
// desktop's own (src/main/modules), which import nothing but types and core.
// Web-view modules and Discord come later (docs/mobile.md, section 7).
import type { ModuleManifest } from "../core/modules";
import { fluxerModule } from "../main/modules/fluxer";
import { matrixNativeModule } from "../main/modules/matrix";
import { nerimityNativeModule } from "../main/modules/nerimity";
import { spacebarNativeModule } from "../main/modules/spacebar";
import { stoatNativeModule } from "../main/modules/stoat";
import { telegramModule } from "../main/modules/telegram";

export interface MobileModule {
  manifest: ModuleManifest;
}

export const MOBILE_MODULES: readonly MobileModule[] = [
  matrixNativeModule,
  fluxerModule,
  telegramModule,
  stoatNativeModule,
  spacebarNativeModule,
  nerimityNativeModule,
];

/** What native code needs to run a module's engine, which it never takes from the page. */
export interface NativeModuleSpec {
  id: string;
  /** The engine bundle, assets/web/engines/<engine>.js. */
  engine: string;
  /** When set, the only hosts the engine may reach. */
  hosts?: string[];
  /** Keep the engine's web storage (IndexedDB) on disk. */
  storage: boolean;
}

/** The table the build writes to dist/mobile/modules.json for native code. */
export function nativeModuleTable(modules: readonly MobileModule[] = MOBILE_MODULES): NativeModuleSpec[] {
  return modules.flatMap(({ manifest: { id, engine, hosts, storage } }) => {
    if (!engine) return [];
    const spec: NativeModuleSpec = { id, engine, storage: storage === true };
    if (hosts) spec.hosts = [...hosts];
    return [spec];
  });
}
