// Engine-side helpers: what a module engine builds on. They turn the narrow
// bridge into familiar shapes (fetch, a secret store, file sources) and
// serve an ordinary PlatformAdapter to the shell.

import type { EngineBridge } from "../preload/engine";
import type { DirectConversation, PlatformAdapter, RailServer } from "../shared/adapter";
import type { EngineDirect, EngineInfo, EngineServer, HttpRequest, HttpResponse, PickedFile } from "../shared/engine";
import type { AccountStatus } from "../shared/settings";

/** A file to upload, read in ranges so it never has to sit in memory whole. */
export interface FileSource {
  filename: string;
  size: number;
  contentType: string;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface AsyncSecretStore {
  load(key: string): Promise<string | undefined>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function engineInfo(bridge: EngineBridge): Promise<EngineInfo> {
  return bridge.request({ type: "info" }) as Promise<EngineInfo>;
}

export function bridgeSecrets(bridge: EngineBridge): AsyncSecretStore {
  return {
    load: (key) => bridge.request({ type: "secretLoad", key }) as Promise<string | undefined>,
    save: async (key, value) => void (await bridge.request({ type: "secretSave", key, value })),
    delete: async (key) => void (await bridge.request({ type: "secretDelete", key })),
  };
}

/**
 * fetch over the shell's HTTP bridge, which checks every URL against the
 * module's allowed hosts and sends no cookies.
 */
export function bridgeFetch(bridge: EngineBridge): typeof fetch {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name] = value));
    const request: HttpRequest = { url, method: (init.method ?? "GET").toUpperCase(), headers };
    if (typeof init.body === "string") request.body = init.body;
    else if (init.body instanceof Uint8Array) request.body = init.body;
    else if (init.body instanceof ArrayBuffer) request.body = new Uint8Array(init.body);
    else if (init.body != null) throw new TypeError("Unsupported request body");
    const response = (await bridge.request({ type: "http", request })) as HttpResponse;
    // Null-body statuses must not carry a body in a Response.
    const empty = response.status === 204 || response.status === 205 || response.status === 304;
    return new Response(empty ? null : new Uint8Array(response.body), { status: response.status, headers: response.headers });
  };
}

/**
 * Locks the engine to these hosts from now on (e.g. its instance's API, events
 * and file hosts, once discovered). The shell only ever narrows a lock, so
 * code that later runs in the engine cannot reach anywhere else.
 */
export async function lockHosts(bridge: EngineBridge, hosts: string[]): Promise<void> {
  await bridge.request({ type: "lockHosts", hosts });
}

/**
 * Signs in through the homeserver's single sign-on (Matrix's m.login.sso):
 * the shell opens `url` (the homeserver's SSO redirect) in the browser and
 * receives the login token that comes back. Works only right after the user
 * submitted a sign-in step in the module's view.
 */
export async function ssoSignIn(bridge: EngineBridge, url: string): Promise<string> {
  const answer = (await bridge.request({ type: "ssoSignIn", url })) as { loginToken?: unknown };
  if (typeof answer?.loginToken !== "string" || answer.loginToken === "") throw new Error("Single sign-on brought no login token");
  return answer.loginToken;
}

/** The files a module may send: those the user picks, and those the shell hands it (sendFile actions). */
export interface EngineFiles {
  pick(): Promise<FileSource[]>;
  /** Opens a file the shell handed over in a sendFile action. */
  open?(file: PickedFile): FileSource;
}

/** A file the shell handed the engine (picked, or shared in a sendFile action), read through its handle. */
export function fileSource(bridge: EngineBridge, file: PickedFile): FileSource {
  return {
    filename: file.name,
    size: file.size,
    contentType: file.type,
    read: (start, end) => bridge.request({ type: "readFile", handle: file.handle, start, end }) as Promise<Uint8Array>,
  };
}

/** Lets the user pick files through the shell; each is read through its handle. */
export async function pickFiles(bridge: EngineBridge): Promise<FileSource[]> {
  const picked = (await bridge.request({ type: "pickFiles" })) as PickedFile[];
  return picked.map((file) => fileSource(bridge, file));
}

/** An adapter an engine serves: the PlatformAdapter contract plus the view's actions. */
export interface ServedAdapter extends PlatformAdapter {
  handleAction?(action: unknown): Promise<void>;
}

function toEngineServer(server: RailServer): EngineServer {
  const { account: _account, children, ...rest } = server;
  const out: EngineServer = { ...rest };
  if (children) out.children = children.map(toEngineServer);
  return out;
}

function toEngineDirect({ account: _account, ...rest }: DirectConversation): EngineDirect {
  return rest;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Serves an adapter to the shell: its rail data, notifications and calls go
 * out as events, and shell commands and view actions come in. Returns
 * `sync`, which reports account and home badge changes; call it after
 * anything that may change them (e.g. after each render).
 */
export function serveAdapter(bridge: EngineBridge, adapter: ServedAdapter, log: (message: string) => void = console.warn): { sync(): void } {
  let lastAccount = "";
  let lastBadge = "";
  let lastSettings = "{}";
  let lastHealth = "[]";
  const sync = (): void => {
    const checks = adapter.health?.();
    const checksJson = JSON.stringify(checks ?? []);
    if (checks && checksJson !== lastHealth) {
      lastHealth = checksJson;
      bridge.emit({ type: "health", checks });
    }
    const status = adapter.settingsStatus?.();
    const statusJson = JSON.stringify(status ?? {});
    if (status && statusJson !== lastSettings) {
      lastSettings = statusJson;
      bridge.emit({ type: "settingsStatus", status });
    }
    const account: AccountStatus = adapter.accountStatus?.() ?? { state: "unknown" };
    const accountJson = JSON.stringify(account);
    if (accountJson !== lastAccount) {
      lastAccount = accountJson;
      bridge.emit({ type: "account", account });
    }
    const badge = adapter.homeBadge?.();
    const badgeJson = JSON.stringify(badge);
    if (badge && badgeJson !== lastBadge) {
      lastBadge = badgeJson;
      bridge.emit({ type: "homeBadge", badge });
    }
  };

  adapter.onServersChanged((servers) => {
    bridge.emit({ type: "servers", servers: servers.map(toEngineServer) });
    sync();
  });
  adapter.onDirectsChanged((directs) => {
    bridge.emit({ type: "directs", directs: directs.map(toEngineDirect) });
    sync();
  });
  adapter.onNotification((notification) => bridge.emit({ type: "notification", notification }));
  adapter.onIncomingCall((call) => bridge.emit({ type: "call", call }));

  const attempt = (what: string, task: () => Promise<void> | void): void => {
    void Promise.resolve()
      .then(task)
      .catch((error: unknown) => log(`${what}: ${messageOf(error)}`));
  };
  bridge.onCommand((command) => {
    switch (command.type) {
      case "openHome":
        return attempt("open home", () => adapter.openHome?.());
      case "openServer":
        return attempt("open server", () => adapter.openServer(command.key));
      case "openConversation":
        return attempt("open conversation", () => adapter.openConversation(command.key));
      case "toggleGroup":
        return attempt("toggle group", () => adapter.toggleGroup?.(command.key));
      case "visible":
        return adapter.setVisible?.(command.visible);
      case "signOut":
        return attempt("sign out", () => adapter.signOut?.());
      case "settings":
        return attempt("apply settings", () => {
          adapter.applySettings?.(command.values);
          sync();
        });
      case "settingAction":
        return attempt(`setting ${command.key}`, async () => {
          try {
            await adapter.runSettingAction?.(command.key);
          } finally {
            sync();
          }
        });
    }
  });
  bridge.onAction((action) => attempt("action", () => adapter.handleAction?.(action)));
  return { sync };
}
