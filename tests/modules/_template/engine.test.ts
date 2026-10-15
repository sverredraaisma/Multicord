import { describe, expect, it, vi } from "vitest";
import type { EngineBridge } from "../../../src/preload/engine";
import { startTemplateEngine } from "../../../src/modules/_template/engine";
import type { EngineCommand, EngineRequest } from "../../../src/shared/engine";

/** A bridge as the shell's engine preload provides it, answering like the main process. */
function fakeBridge(token?: string) {
  const json = (body: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) });
  let command: (c: EngineCommand) => void = () => {};
  let action: (a: unknown) => void = () => {};
  const bridge = {
    request: vi.fn(async (request: EngineRequest) => {
      switch (request.type) {
        case "info":
          return { id: "template", name: "Example", url: "https://chat.example.org", os: "win32" };
        case "secretLoad":
          return token;
        case "http":
          return request.request.url.endsWith("/api/me") ? json({ name: "alice" }) : json([]);
        default:
          return undefined;
      }
    }),
    emit: vi.fn(),
    render: vi.fn(),
    onCommand: (cb: (c: EngineCommand) => void) => void (command = cb),
    onAction: (cb: (a: unknown) => void) => void (action = cb),
  };
  return { bridge: bridge as unknown as EngineBridge & typeof bridge, command: (c: EngineCommand) => command(c), action: (a: unknown) => action(a) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("template engine", () => {
  it("locks its hosts through the bridge and shows the sign-in screen", async () => {
    const { bridge } = fakeBridge();
    await startTemplateEngine(bridge);
    expect(bridge.request).toHaveBeenCalledWith({ type: "lockHosts", hosts: ["chat.example.org"] });
    expect(bridge.request).toHaveBeenCalledWith({ type: "secretLoad", key: "token" });
    expect(bridge.render).toHaveBeenLastCalledWith(expect.objectContaining({ screen: "login", platform: "Example" }));
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-out" } });
  });

  it("resumes over the HTTP bridge and serves the conversation to the shell", async () => {
    const { bridge, command, action } = fakeBridge("t1");
    await startTemplateEngine(bridge);
    expect(bridge.request).toHaveBeenCalledWith({
      type: "http",
      request: { url: "https://chat.example.org/api/me", method: "GET", headers: { authorization: "Bearer t1" } },
    });
    expect(bridge.emit).toHaveBeenCalledWith({ type: "directs", directs: [expect.objectContaining({ key: "1", title: "General" })] });
    expect(bridge.emit).toHaveBeenCalledWith({ type: "account", account: { state: "signed-in", name: "alice" } });

    action({ type: "logout" });
    await settle();
    expect(bridge.request).toHaveBeenCalledWith({ type: "secretDelete", key: "token" });
    expect(bridge.emit).toHaveBeenLastCalledWith({ type: "account", account: { state: "signed-out" } });

    bridge.render.mockClear();
    command({ type: "openConversation", key: "1" });
    await settle();
    expect(bridge.render).toHaveBeenCalledTimes(1);
  });
});
