import { bridgeFetch, bridgeSecrets, bridgeWebSocket, engineInfo, fileSource, lockHosts, pickFiles, serveAdapter } from "../../engine/runtime";
import type { EngineBridge } from "../../preload/engine";
import { SpacebarAdapter } from "./adapter";
import type { SocketFactory } from "./gateway";

/**
 * Runs the Spacebar client in its engine: builds the adapter on the bridge
 * (fetch, the gateway socket, secrets, files and the host lock all go
 * through the shell's checks) and serves it.
 */
export async function startSpacebarEngine(bridge: EngineBridge, createSocket: SocketFactory = bridgeWebSocket(bridge)): Promise<SpacebarAdapter> {
  const info = await engineInfo(bridge);
  let served: { sync(): void } | undefined;
  const adapter = new SpacebarAdapter({
    def: info,
    fetch: bridgeFetch(bridge),
    createSocket,
    secrets: bridgeSecrets(bridge),
    render: (state) => {
      bridge.render(state);
      served?.sync();
    },
    lockHosts: (hosts) => lockHosts(bridge, hosts),
    platform: info.os,
    files: { pick: () => pickFiles(bridge), open: (file) => fileSource(bridge, file) },
    settings: info.settings,
  });
  served = serveAdapter(bridge, adapter);
  await adapter.start();
  served.sync();
  return adapter;
}
