import { IPC } from "../shared/ipc";
import type { FocusBridge } from "../renderer/regions";
import type { PreloadIpc } from "./discord/index";

/** F6 travel between the window's pages, for the shell's own pages: leave this one, or hear focus arrive. */
export function createFocusApi(ipc: PreloadIpc): FocusBridge {
  return {
    onEnter: (cb) =>
      ipc.on(IPC.focusEnter, (_event, direction) => {
        if (direction === 1 || direction === -1) cb(direction);
      }),
    leave: (direction) => ipc.send(IPC.focusLeave, direction),
  };
}
