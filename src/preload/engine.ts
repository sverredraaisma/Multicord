import { ENGINE_IPC, type EngineCommand, type EngineEvent, type EngineRequest, type EngineSocketEvent } from "../shared/engine";
import { netErrorText } from "../shared/netErrors";

/** The IPC an engine preload uses: send, listen and request/response. */
export interface EngineIpc {
  send(channel: string, payload: unknown): void;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

/**
 * Everything an engine can do outside its own page. The main process binds
 * each call to this engine, so there is no way to name another module.
 */
export interface EngineBridge {
  request(request: EngineRequest): Promise<unknown>;
  emit(event: EngineEvent): void;
  /** Display state for the module's own view. */
  render(state: unknown): void;
  onCommand(cb: (command: EngineCommand) => void): void;
  /** User actions from the module's own view, already validated by the shell. */
  onAction(cb: (action: unknown) => void): void;
  /** What happens on the engine's bridged WebSockets (bridgeWebSocket), which the engine checks. */
  onSocket(cb: (event: EngineSocketEvent) => void): void;
}

/**
 * A failed request's error as the engine passes it on to the user: without
 * Electron's "Error invoking remote method '…': Error: " wrapper, and a
 * network failure in plain words instead of its net:: code.
 */
export function requestError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const bare = message.replace(/^Error invoking remote method '[^']*': /, "").replace(/^(?:Error: )+/, "");
  const code = /net::(ERR_[A-Z_]+)/.exec(bare)?.[1];
  return new Error((code && netErrorText(code)) || bare);
}

export function createEngineBridge(ipc: EngineIpc): EngineBridge {
  return {
    request: (request) =>
      ipc.invoke(ENGINE_IPC.invoke, request).catch((error: unknown) => {
        throw requestError(error);
      }),
    emit: (event) => ipc.send(ENGINE_IPC.event, event),
    render: (state) => ipc.send(ENGINE_IPC.render, state),
    onCommand: (cb) => ipc.on(ENGINE_IPC.command, (_event, command) => cb(command as EngineCommand)),
    onAction: (cb) => ipc.on(ENGINE_IPC.action, (_event, action) => cb(action)),
    onSocket: (cb) => ipc.on(ENGINE_IPC.socket, (_event, event) => cb(event as EngineSocketEvent)),
  };
}
