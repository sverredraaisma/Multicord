import { IPC, type MessagesState } from "../shared/ipc";
import type { PreloadIpc } from "./discord/index";

/** The unified Messages page's bridge: the conversation list in, the one to open out. */
export interface MessagesApi {
  onState(cb: (state: MessagesState) => void): void;
  open(key: string): void;
  ready(): void;
}

export function createMessagesApi(ipc: PreloadIpc): MessagesApi {
  return {
    onState: (cb) => ipc.on(IPC.messagesState, (_event, state) => cb(state as MessagesState)),
    open: (key) => ipc.send(IPC.messagesOpen, key),
    ready: () => ipc.send(IPC.messagesReady, null),
  };
}
