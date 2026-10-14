import { IPC, type PickerChoice, type PickerRequest, type RailState } from "../shared/ipc";
import type { PreloadIpc } from "./discord/index";

/** The narrow API the shell UI and picker get through contextBridge. */
export interface ShellApi {
  onRail(cb: (state: RailState) => void): void;
  open(key: string): void;
  ready(): void;
  onPickerRequest(cb: (request: PickerRequest) => void): void;
  choose(choice: PickerChoice | null): void;
}

export function createShellApi(ipc: PreloadIpc): ShellApi {
  return {
    onRail: (cb) => ipc.on(IPC.railState, (_event, state) => cb(state as RailState)),
    open: (key) => ipc.send(IPC.railOpen, key),
    ready: () => ipc.send(IPC.railReady, null),
    onPickerRequest: (cb) => ipc.on(IPC.pickerSources, (_event, request) => cb(request as PickerRequest)),
    choose: (choice) => ipc.send(IPC.pickerChoose, choice),
  };
}
