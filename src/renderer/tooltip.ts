import type { ShellApi } from "../preload/shell";

export function startTooltip(doc: Document, api: Pick<ShellApi, "onTooltip">): void {
  const bubble = doc.getElementById("tooltip")!;
  api.onTooltip((text) => {
    bubble.textContent = text;
  });
}
