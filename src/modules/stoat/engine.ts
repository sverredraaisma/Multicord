import { bridgeFetch, bridgeSecrets, engineInfo, lockHosts, fileSource, pickFiles, serveAdapter } from "../../engine/runtime";
import type { EngineBridge } from "../../preload/engine";
import { StoatAdapter } from "./adapter";
import type { SocketFactory } from "./events";

/**
 * Runs the Stoat client in its engine: builds the adapter on the bridge
 * (fetch, secrets and files all go through the shell's checks) and serves it.
 */
export async function startStoatEngine(
  bridge: EngineBridge,
  createSocket: SocketFactory = (url) => new WebSocket(url),
): Promise<StoatAdapter> {
  const info = await engineInfo(bridge);
  let served: { sync(): void } | undefined;
  const adapter = new StoatAdapter({
    def: info,
    fetch: bridgeFetch(bridge),
    createSocket,
    secrets: bridgeSecrets(bridge),
    render: (state) => {
      bridge.render(state);
      served?.sync();
    },
    files: { pick: () => pickFiles(bridge), open: (file) => fileSource(bridge, file) },
    lockHosts: (hosts) => lockHosts(bridge, hosts),
  });
  served = serveAdapter(bridge, adapter);
  await adapter.start();
  served.sync();
  return adapter;
}
