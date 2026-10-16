import { discordModule } from "./discord";
import { fluxerModule } from "./fluxer";
import { matrixNativeModule } from "./matrix";
import { nerimityNativeModule } from "./nerimity";
import { spacebarNativeModule } from "./spacebar";
import { stoatNativeModule } from "./stoat";
import { telegramModule } from "./telegram";
import { configurableModules as configurableIn, findModule as findModuleIn } from "../../core/modules";
import type { ModuleRule } from "../../core/platforms";
import type { PlatformModule } from "./types";
import { fluxerWebModule, matrixModule, mumbleModule, nerimityModule, spacebarModule, stoatModule, webModule } from "./web";

/**
 * The platform modules this build ships. A new platform is a new module here;
 * the shell needs no changes. Modules are compiled in rather than loaded from
 * disk, since a module runs with full main-process privileges.
 */
export const MODULES: readonly PlatformModule[] = [
  discordModule,
  fluxerModule,
  fluxerWebModule,
  telegramModule,
  matrixNativeModule,
  matrixModule,
  stoatNativeModule,
  stoatModule,
  spacebarNativeModule,
  spacebarModule,
  nerimityNativeModule,
  nerimityModule,
  mumbleModule,
  webModule,
];

export function findModule(id: string, modules: readonly PlatformModule[] = MODULES): PlatformModule | undefined {
  return findModuleIn(id, modules);
}

/** Modules users may instantiate from platforms.json, with their address rules. */
export function configurableModules(modules: readonly PlatformModule[] = MODULES): ModuleRule[] {
  return configurableIn(modules);
}
