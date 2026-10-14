import { IPC, type PickerChoice, type PickerRequest, type RailState, type TooltipRequest } from "../shared/ipc";
import type { PreloadIpc } from "./discord/index";

/** The narrow API the shell UI, tooltip and picker get through contextBridge. */
export interface ShellApi {
  onRail(cb: (state: RailState) => void): void;
  open(key: string): void;
  ready(): void;
  tooltip(request: TooltipRequest | null): void;
  /** Saves a new order of top-level servers and groups. */
  reorder(keys: string[]): void;
  onTooltip(cb: (text: string) => void): void;
  onPickerRequest(cb: (request: PickerRequest) => void): void;
  choose(choice: PickerChoice | null): void;
}

export function createShellApi(ipc: PreloadIpc): ShellApi {
  return {
    onRail: (cb) => ipc.on(IPC.railState, (_event, state) => cb(state as RailState)),
    open: (key) => ipc.send(IPC.railOpen, key),
    ready: () => ipc.send(IPC.railReady, null),
    tooltip: (request) => ipc.send(IPC.railTooltip, request),
    reorder: (keys) => ipc.send(IPC.railReorder, keys),
    onTooltip: (cb) => ipc.on(IPC.tooltipShow, (_event, text) => cb(String(text))),
    onPickerRequest: (cb) => ipc.on(IPC.pickerSources, (_event, request) => cb(request as PickerRequest)),
    choose: (choice) => ipc.send(IPC.pickerChoose, choice),
  };
}
