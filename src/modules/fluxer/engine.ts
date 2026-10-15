import { bridgeFetch, bridgeSecrets, engineInfo, fileSource, pickFiles, serveAdapter } from "../../engine/runtime";
import type { EngineBridge } from "../../preload/engine";
import { FluxerAdapter } from "./adapter";
import type { SocketFactory } from "./gateway";

/**
 * Runs the Fluxer client in its engine: builds the adapter on the bridge
 * (fetch, secrets and files all go through the shell's checks) and serves it.
 */
export async function startFluxerEngine(
  bridge: EngineBridge,
  createSocket: SocketFactory = (url) => new WebSocket(url),
): Promise<FluxerAdapter> {
  const info = await engineInfo(bridge);
  let served: { sync(): void } | undefined;
  const adapter = new FluxerAdapter({
    def: info,
    fetch: bridgeFetch(bridge),
    createSocket,
    secrets: bridgeSecrets(bridge),
    render: (state) => {
      bridge.render(state);
      served?.sync();
    },
    platform: info.os,
    files: { pick: () => pickFiles(bridge), open: (file) => fileSource(bridge, file) },
    settings: info.settings,
  });
  served = serveAdapter(bridge, adapter);
  await adapter.start();
  served.sync();
  return adapter;
}
