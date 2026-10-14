import { bridgeFetch, bridgeSecrets, engineInfo, serveAdapter } from "../../engine/runtime";
import type { EngineBridge } from "../../preload/engine";
import { MatrixAdapter } from "./adapter";
import type { MatrixApi } from "./api";
import { createMatrixClient } from "./client";

export interface MatrixEngineOptions {
  createApi?: (fetchFn: typeof fetch) => MatrixApi;
}

/**
 * Runs the Matrix client in its engine: the API goes over the bridge's
 * fetch (which keeps it off local and private addresses) and the session
 * lives in the instance's own secrets.
 */
export async function startMatrixEngine(bridge: EngineBridge, options: MatrixEngineOptions = {}): Promise<MatrixAdapter> {
  const info = await engineInfo(bridge);
  const createApi = options.createApi ?? createMatrixClient;
  let served: { sync(): void } | undefined;
  const adapter = new MatrixAdapter({
    def: info,
    secrets: bridgeSecrets(bridge),
    render: (state) => {
      bridge.render(state);
      served?.sync();
    },
    api: createApi(bridgeFetch(bridge)),
  });
  served = serveAdapter(bridge, adapter);
  await adapter.start();
  served.sync();
  return adapter;
}
