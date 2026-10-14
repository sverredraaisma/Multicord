import { el, initials } from "./dom";

/** A round user or channel picture, falling back to initials. */
export function avatar(doc: Document, url: string | undefined, name: string): HTMLElement {
  if (url) {
    const img = el(doc, "img", "avatar");
    img.src = url;
    img.alt = "";
    return img;
  }
  return el(doc, "span", "avatar initials", initials(name));
}
