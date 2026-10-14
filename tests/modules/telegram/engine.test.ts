import { describe, expect, it, vi } from "vitest";
import type { EngineBridge } from "../../../src/preload/engine";
import { startTelegramEngine } from "../../../src/modules/telegram/engine";
import { createGramApi } from "../../../src/modules/telegram/gram";
import type { TelegramApi } from "../../../src/modules/telegram/api";
import type { EngineCommand, EngineRequest } from "../../../src/shared/engine";

vi.mock("../../../src/modules/telegram/gram", () => ({ createGramApi: vi.fn() }));

const CREDENTIALS = { apiId: 7, apiHash: "b".repeat(32) };

function fakeBridge(secrets: Record<string, string> = {}) {
  let command: (c: EngineCommand) => void = () => {};
  const bridge = {
    request: vi.fn(async (request: EngineRequest) => {
      switch (request.type) {
        case "info":
          return { id: "telegram", name: "Telegram", url: "https://telegram.org", os: "linux" };
        case "secretLoad":
          return secrets[request.key];
        default:
          return undefined;
      }
    }),
    emit: vi.fn(),
    render: vi.fn(),
    onCommand: (cb: (c: EngineCommand) => void) => void (command = cb),
    onAction: vi.fn(),
  };
  return { bridge: bridge as unknown as EngineBridge & typeof bridge, command: (c: EngineCommand) => command(c) };
}

function fakeApi(authorized: boolean): TelegramApi {
  return {
    connect: vi.fn(async () => {}),
    authorized: vi.fn(async () => authorized),
    onUpdate: vi.fn(),
    session: vi.fn(() => "s"),
    me: vi.fn(async () => ({ id: "1", name: "Me", bot: false })),
    dialogs: vi.fn(async () => []),
    avatar: vi.fn(async () => undefined),
  } as unknown as TelegramApi;
}

describe("Telegram engine", () => {
  it("asks for API credentials when none are stored or built in", async () => {
    const { bridge } = fakeBridge();
    const createApi = vi.fn();
    await startTelegramEngine(bridge, { appVersion: "1.0.0", createApi });
    expect(createApi).not.toHaveBeenCalled();
    expect(bridge.render).toHaveBeenLastCalledWith(expect.objectContaining({ screen: "prompt", platform: "Telegram", prompt: expect.objectContaining({ id: "api" }) }));
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-out" } });
  });

  it("hands built-in credentials, an empty session and the OS to createApi", async () => {
    const { bridge } = fakeBridge();
    const createApi = vi.fn(() => fakeApi(false));
    await startTelegramEngine(bridge, { builtIn: CREDENTIALS, appVersion: "1.0.0", createApi });
    expect(createApi).toHaveBeenCalledWith(CREDENTIALS, "", { os: "linux", appVersion: "1.0.0" });
    expect(bridge.render).toHaveBeenLastCalledWith(expect.objectContaining({ screen: "prompt", prompt: expect.objectContaining({ id: "phone" }) }));
  });

  it("resumes a stored session and reports the account", async () => {
    const { bridge } = fakeBridge({ session: "stored" });
    const createApi = vi.fn(() => fakeApi(true));
    await startTelegramEngine(bridge, { builtIn: CREDENTIALS, appVersion: "1.0.0", createApi });
    expect(createApi).toHaveBeenCalledWith(CREDENTIALS, "stored", expect.anything());
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-in", name: "Me" } });
  });

  it("uses the GramJS implementation by default", async () => {
    vi.mocked(createGramApi).mockReturnValue(fakeApi(false));
    const { bridge } = fakeBridge();
    await startTelegramEngine(bridge, { builtIn: CREDENTIALS, appVersion: "2.0.0" });
    expect(createGramApi).toHaveBeenCalledWith(CREDENTIALS, "", { os: "linux", appVersion: "2.0.0" });
  });
});
