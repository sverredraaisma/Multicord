// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { placeholderImage, renderGallery, SAMPLE_CONVERSATIONS, SAMPLE_RAIL } from "../../src/renderer/gallery";

describe("component gallery", () => {
  it("renders every component section", () => {
    document.body.innerHTML = `<main id="gallery"></main>`;
    const root = document.getElementById("gallery")!;
    renderGallery(root);
    expect([...root.querySelectorAll(".gallery-section h2")].map((h) => h.textContent)).toEqual([
      "Server rail",
      "Direct messages",
      "Channel list",
      "Messages",
      "Markdown",
      "Reactions",
      "Emoji picker",
      "Media picker",
      "Forum",
      "Composer extras",
      "Voice panel",
      "Sign-in",
    ]);
    expect([...root.querySelectorAll(".gallery-rail .module-label")].map((l) => (l as HTMLElement).dataset.module)).toContain("Web");
    expect(root.querySelectorAll(".gallery-rail [data-unit]").length).toBeGreaterThan(0);
    expect(root.querySelector(".messages .content h1")!.textContent).toBe("Release notes");
    expect(root.querySelector(".markdown.jumbo")).not.toBeNull();
    expect(root.querySelector(".emoji-picker")).not.toBeNull();
    expect(root.querySelector(".media-picker .picker-tab")).not.toBeNull();
    expect(root.querySelector('form.auth input[type="email"]')).not.toBeNull();
  });

  it("only logs when components are used", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    document.body.innerHTML = `<main id="gallery"></main>`;
    renderGallery(document.getElementById("gallery")!);
    document.querySelector<HTMLButtonElement>('.gallery-rail [data-key="fluxer:2"]')!.click();
    document.querySelector<HTMLButtonElement>(".message-actions button")!.click();
    expect(info).toHaveBeenCalledWith("[gallery] open", "fluxer:2");
    expect(info).toHaveBeenCalledWith("[gallery] reply", expect.objectContaining({ id: "1" }));
  });

  it("makes placeholder images as escaped SVG data URLs", () => {
    const url = placeholderImage("#fff", "<");
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url)).toContain("<svg");
    expect(SAMPLE_RAIL.entries.every((e) => e.module)).toBe(true);
    expect(SAMPLE_CONVERSATIONS.map((c) => c.lastActivity)).toEqual([...SAMPLE_CONVERSATIONS.map((c) => c.lastActivity)].sort((a, b) => b - a));
  });
});
