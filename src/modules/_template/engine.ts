import { bridgeFetch, bridgeSecrets, engineInfo, lockHosts, serveAdapter } from "../../engine/runtime";
import type { EngineBridge } from "../../preload/engine";
import { TemplateAdapter } from "./adapter";

/**
 * Runs the template module in its engine: builds the adapter on the bridge
 * (fetch and secrets go through the shell's checks) and serves it. A real
 * module's bundle entry, src/entries/engine-<id>.ts, calls this with the
 * page's window.multicordEngine.
 */
export async function startTemplateEngine(bridge: EngineBridge): Promise<TemplateAdapter> {
  const info = await engineInfo(bridge);
  let served: { sync(): void } | undefined;
  const adapter = new TemplateAdapter({
    def: info,
    fetch: bridgeFetch(bridge),
    secrets: bridgeSecrets(bridge),
    render: (state) => {
      bridge.render(state);
      served?.sync();
    },
    lockHosts: (hosts) => lockHosts(bridge, hosts),
  });
  served = serveAdapter(bridge, adapter);
  await adapter.start();
  served.sync();
  return adapter;
}
