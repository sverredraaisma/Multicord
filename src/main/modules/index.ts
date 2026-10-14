import { discordModule } from "./discord";
import { fluxerModule } from "./fluxer";
import { matrixNativeModule } from "./matrix";
import { stoatNativeModule } from "./stoat";
import { telegramModule } from "./telegram";
import type { ModuleRule } from "../platforms";
import type { PlatformModule } from "./types";
import { matrixModule, nerimityModule, spacebarModule, stoatModule, webModule } from "./web";

/**
 * The platform modules this build ships. A new platform is a new module here;
 * the shell needs no changes. Modules are compiled in rather than loaded from
 * disk, since a module runs with full main-process privileges.
 */
export const MODULES: readonly PlatformModule[] = [
  discordModule,
  fluxerModule,
  telegramModule,
  matrixNativeModule,
  matrixModule,
  stoatNativeModule,
  stoatModule,
  spacebarModule,
  nerimityModule,
  webModule,
];

export function findModule(id: string, modules: readonly PlatformModule[] = MODULES): PlatformModule | undefined {
  return modules.find((m) => m.manifest.id === id);
}

/** Modules users may instantiate from platforms.json, with their address rules. */
export function configurableModules(modules: readonly PlatformModule[] = MODULES): ModuleRule[] {
  return modules
    .filter((m) => m.manifest.configurable)
    .map(({ manifest: { id, defaultUrl, fixedUrl } }) => ({ id, defaultUrl, fixedUrl }));
}
