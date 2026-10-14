// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { startTooltip } from "../../src/renderer/tooltip";

describe("startTooltip", () => {
  it("shows the text it is sent", () => {
    document.body.innerHTML = `<div id="tooltip"></div>`;
    let push: (text: string) => void = () => {};
    startTooltip(document, { onTooltip: (cb) => (push = cb) });
    push("Gaming Club");
    expect(document.getElementById("tooltip")!.textContent).toBe("Gaming Club");
  });
});
