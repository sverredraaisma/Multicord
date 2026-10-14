import { SETTINGS_IPC, type SettingsAction, type SettingsViewState } from "../shared/settings";
import type { PreloadIpc } from "./discord/index";

/** The settings page's bridge: state in, actions out. */
export interface SettingsApi {
  onState(cb: (state: SettingsViewState) => void): void;
  act(action: SettingsAction): void;
  ready(): void;
}

export function createSettingsApi(ipc: PreloadIpc): SettingsApi {
  return {
    onState: (cb) => ipc.on(SETTINGS_IPC.state, (_event, state) => cb(state as SettingsViewState)),
    act: (action) => ipc.send(SETTINGS_IPC.action, action),
    ready: () => ipc.send(SETTINGS_IPC.ready, null),
  };
}
