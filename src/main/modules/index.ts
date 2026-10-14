import { discordModule } from "./discord";
import { fluxerModule } from "./fluxer";
import type { PlatformModule } from "./types";
import { webModule } from "./web";

/**
 * The platform modules this build ships. A new platform is a new module here;
 * the shell needs no changes. Modules are compiled in rather than loaded from
 * disk, since a module runs with full main-process privileges.
 */
export const MODULES: readonly PlatformModule[] = [discordModule, fluxerModule, webModule];

export function findModule(id: string, modules: readonly PlatformModule[] = MODULES): PlatformModule | undefined {
  return modules.find((m) => m.manifest.id === id);
}

/** Module ids users may instantiate from platforms.json. */
export function configurableModules(modules: readonly PlatformModule[] = MODULES): string[] {
  return modules.filter((m) => m.manifest.configurable).map((m) => m.manifest.id);
}
