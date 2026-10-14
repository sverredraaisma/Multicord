import { NATIVE_IPC, type NativeAction, type NativeViewState } from "../shared/native";
import { SETTINGS_IPC, type VoiceSettings } from "../shared/settings";
import type { PreloadIpc } from "./discord/index";

/** The native chat view's whole bridge: display state in, user actions out. */
export interface NativeApi {
  onState(cb: (state: NativeViewState) => void): void;
  act(action: NativeAction): void;
  /** The user's devices and audio processing for calls. */
  onVoiceSettings(cb: (settings: VoiceSettings) => void): void;
}

export function createNativeApi(ipc: PreloadIpc): NativeApi {
  return {
    onState: (cb) => ipc.on(NATIVE_IPC.state, (_event, state) => cb(state as NativeViewState)),
    act: (action) => ipc.send(NATIVE_IPC.action, action),
    onVoiceSettings: (cb) => ipc.on(SETTINGS_IPC.voice, (_event, settings) => cb(settings as VoiceSettings)),
  };
}
