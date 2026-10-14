import { bridgeSecrets, engineInfo, serveAdapter } from "../../engine/runtime";
import type { EngineBridge } from "../../preload/engine";
import { TelegramAdapter } from "./adapter";
import type { TelegramApi, TelegramCredentials } from "./api";
import { createGramApi, type GramOptions } from "./gram";

export interface TelegramEngineOptions {
  /** API credentials built into this build, if any; else the user enters their own. */
  builtIn?: TelegramCredentials;
  appVersion: string;
  createApi?: (credentials: TelegramCredentials, session: string, options: GramOptions) => TelegramApi;
}

/** Runs the Telegram client in its engine, on the bridge's scoped secrets. */
export async function startTelegramEngine(bridge: EngineBridge, options: TelegramEngineOptions): Promise<TelegramAdapter> {
  const info = await engineInfo(bridge);
  const createApi = options.createApi ?? createGramApi;
  let served: { sync(): void } | undefined;
  const adapter = new TelegramAdapter({
    def: info,
    secrets: bridgeSecrets(bridge),
    render: (state) => {
      bridge.render(state);
      served?.sync();
    },
    builtInCredentials: options.builtIn,
    createApi: (credentials, session) => createApi(credentials, session, { os: info.os, appVersion: options.appVersion }),
  });
  served = serveAdapter(bridge, adapter);
  await adapter.start();
  served.sync();
  return adapter;
}
