import { NATIVE_IPC, type NativeAction, type NativeViewState } from "../shared/native";
import type { PreloadIpc } from "./discord/index";

/** The native chat view's whole bridge: display state in, user actions out. */
export interface NativeApi {
  onState(cb: (state: NativeViewState) => void): void;
  act(action: NativeAction): void;
}

export function createNativeApi(ipc: PreloadIpc): NativeApi {
  return {
    onState: (cb) => ipc.on(NATIVE_IPC.state, (_event, state) => cb(state as NativeViewState)),
    act: (action) => ipc.send(NATIVE_IPC.action, action),
  };
}
