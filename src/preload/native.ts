import type { EngineRequest, EngineSocketEvent } from "../shared/engine";
import { FAVOURITES_IPC, type FavouritesAction, type FavouritesState } from "../shared/favourites";
import { IPC } from "../shared/ipc";
import { NATIVE_IPC, type AudioRoute, type AudioRoutes, type NativeAction, type NativeViewState } from "../shared/native";
import { isAutoLoadLimit, isVoiceCommand, SETTINGS_IPC, type VoiceCommand, type VoiceSettings } from "../shared/settings";
import type { PreloadIpc } from "./discord/index";

/** The native chat view's whole bridge: display state in, user actions out. */
export interface NativeApi {
  onState(cb: (state: NativeViewState) => void): void;
  act(action: NativeAction): void;
  /** A screen share with system sound (Linux, venmic) ended. */
  screenAudioEnded(): void;
  /** The user's devices and audio processing for calls. */
  onVoiceSettings(cb: (settings: VoiceSettings) => void): void;
  /** This service's limit for media that loads by itself, in bytes (0: none, Infinity: any size). */
  onMediaAutoLoad(cb: (limit: number) => void): void;
  /** Whether the view sits beside the unified Messages list, which replaces its sidebar. */
  onCompact(cb: (compact: boolean) => void): void;
  /** A global voice shortcut was pressed, or the background push-to-talk key went down or up. */
  onVoiceCommand(cb: (command: VoiceCommand) => void): void;
  /** The shell's favourites, which the module behind this view never sees. */
  onFavourites(cb: (state: FavouritesState) => void): void;
  /** Changes the favourites, or sends one into the open conversation. */
  favourites(action: FavouritesAction): void;
  /** Phones only (mobile/android's view bridge): the system's back; the callback says whether the view used it. */
  onBack?(cb: () => boolean): void;
  /** Phones only: where a call plays (earpiece, speaker, headset), whenever that or what is available changes. */
  onAudioRoutes?(cb: (routes: AudioRoutes) => void): void;
  /** Phones only: plays the call through this route, one the phone said is available. */
  setAudioRoute?(route: AudioRoute): void;
  /**
   * Phones only: WebSockets the phone opens and relays for the view's calls (LiveKit's signalling), as it
   * does an engine's: socketOpen, socketSend and socketClose requests, and the socket events that follow.
   */
  sockets?: { request(request: EngineRequest): Promise<unknown>; onSocket(cb: (event: EngineSocketEvent) => void): void };
}

export function createNativeApi(ipc: PreloadIpc): NativeApi {
  return {
    onState: (cb) => ipc.on(NATIVE_IPC.state, (_event, state) => cb(state as NativeViewState)),
    screenAudioEnded: () => ipc.send(IPC.screenAudioEnd, null),
    act: (action) => ipc.send(NATIVE_IPC.action, action),
    onVoiceSettings: (cb) => ipc.on(SETTINGS_IPC.voice, (_event, settings) => cb(settings as VoiceSettings)),
    onMediaAutoLoad: (cb) =>
      ipc.on(SETTINGS_IPC.mediaAutoLoad, (_event, limit) => {
        if (isAutoLoadLimit(limit)) cb(limit);
      }),
    onCompact: (cb) => ipc.on(IPC.viewCompact, (_event, compact) => cb(compact === true)),
    onFavourites: (cb) => ipc.on(FAVOURITES_IPC.state, (_event, state) => cb(state as FavouritesState)),
    favourites: (action) => ipc.send(FAVOURITES_IPC.action, action),
    onVoiceCommand: (cb) =>
      ipc.on(SETTINGS_IPC.voiceCommand, (_event, command) => {
        if (isVoiceCommand(command)) cb(command);
      }),
  };
}
