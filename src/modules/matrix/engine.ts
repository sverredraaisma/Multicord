import { bridgeFetch, bridgeSecrets, engineInfo, lockHosts, fileSource, pickFiles, serveAdapter } from "../../engine/runtime";
import type { EngineBridge } from "../../preload/engine";
import { MatrixAdapter, type MatrixCryptoDeps } from "./adapter";
import type { MatrixApi } from "./api";
import { createMatrixClient, type MatrixClientOptions } from "./client";
import { createOAuthClient, type MatrixOAuth } from "./oauth";

export interface MatrixEngineOptions {
  createApi?: (fetchFn: typeof fetch, options: MatrixClientOptions) => MatrixApi;
  createOAuth?: (fetchFn: typeof fetch) => MatrixOAuth;
  /** End-to-end encryption; the entry passes it with the WebAssembly bundled in. */
  crypto?: MatrixCryptoDeps;
}

/**
 * Runs the Matrix client in its engine: the API goes over the bridge's
 * fetch (which keeps it off local and private addresses), the session
 * lives in the instance's own secrets, and encryption keys in the engine's
 * own storage.
 */
export async function startMatrixEngine(bridge: EngineBridge, options: MatrixEngineOptions = {}): Promise<MatrixAdapter> {
  const info = await engineInfo(bridge);
  const createApi = options.createApi ?? createMatrixClient;
  const fetchFn = bridgeFetch(bridge);
  let served: { sync(): void } | undefined;
  // The client refreshes OAuth tokens through the adapter, which stores them.
  let adapter: MatrixAdapter | undefined;
  const api = createApi(fetchFn, { refresh: (session) => adapter!.refreshSession(session) });
  adapter = new MatrixAdapter({
    def: info,
    secrets: bridgeSecrets(bridge),
    render: (state) => {
      bridge.render(state);
      served?.sync();
    },
    api,
    oauth: (options.createOAuth ?? createOAuthClient)(fetchFn),
    crypto: options.crypto,
    lockHosts: (hosts) => lockHosts(bridge, hosts),
    files: { pick: () => pickFiles(bridge), open: (file) => fileSource(bridge, file) },
    settings: info.settings,
  });
  served = serveAdapter(bridge, adapter);
  await adapter.start();
  served.sync();
  return adapter;
}
