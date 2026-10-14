import { IPC } from "../shared/ipc";
import { NATIVE_IPC, type NativeAction, type NativeViewState } from "../shared/native";
import { isVoiceCommand, SETTINGS_IPC, type VoiceCommand, type VoiceSettings } from "../shared/settings";
import type { PreloadIpc } from "./discord/index";

/** The native chat view's whole bridge: display state in, user actions out. */
export interface NativeApi {
  onState(cb: (state: NativeViewState) => void): void;
  act(action: NativeAction): void;
  /** A screen share with system sound (Linux, venmic) ended. */
  screenAudioEnded(): void;
  /** The user's devices and audio processing for calls. */
  onVoiceSettings(cb: (settings: VoiceSettings) => void): void;
  /** Whether the view sits beside the unified Messages list, which replaces its sidebar. */
  onCompact(cb: (compact: boolean) => void): void;
  /** A global voice shortcut was pressed, or the background push-to-talk key went down or up. */
  onVoiceCommand(cb: (command: VoiceCommand) => void): void;
}

export function createNativeApi(ipc: PreloadIpc): NativeApi {
  return {
    onState: (cb) => ipc.on(NATIVE_IPC.state, (_event, state) => cb(state as NativeViewState)),
    screenAudioEnded: () => ipc.send(IPC.screenAudioEnd, null),
    act: (action) => ipc.send(NATIVE_IPC.action, action),
    onVoiceSettings: (cb) => ipc.on(SETTINGS_IPC.voice, (_event, settings) => cb(settings as VoiceSettings)),
    onCompact: (cb) => ipc.on(IPC.viewCompact, (_event, compact) => cb(compact === true)),
    onVoiceCommand: (cb) =>
      ipc.on(SETTINGS_IPC.voiceCommand, (_event, command) => {
        if (isVoiceCommand(command)) cb(command);
      }),
  };
}
