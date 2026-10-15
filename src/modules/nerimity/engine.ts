import { bridgeFetch, bridgeSecrets, engineInfo, fileSource, lockHosts, pickFiles, serveAdapter } from "../../engine/runtime";
import type { EngineBridge } from "../../preload/engine";
import { NerimityAdapter } from "./adapter";
import type { SocketFactory } from "./socket";

/**
 * Runs the Nerimity client in its engine: builds the adapter on the bridge
 * (fetch, secrets, files and the host lock all go through the shell's
 * checks) and serves it.
 */
export async function startNerimityEngine(bridge: EngineBridge, createSocket: SocketFactory = (url) => new WebSocket(url)): Promise<NerimityAdapter> {
  const info = await engineInfo(bridge);
  let served: { sync(): void } | undefined;
  const adapter = new NerimityAdapter({
    def: info,
    fetch: bridgeFetch(bridge),
    createSocket,
    secrets: bridgeSecrets(bridge),
    render: (state) => {
      bridge.render(state);
      served?.sync();
    },
    lockHosts: (hosts) => lockHosts(bridge, hosts),
    files: { pick: () => pickFiles(bridge), open: (file) => fileSource(bridge, file) },
    settings: info.settings,
  });
  served = serveAdapter(bridge, adapter);
  await adapter.start();
  served.sync();
  return adapter;
}
