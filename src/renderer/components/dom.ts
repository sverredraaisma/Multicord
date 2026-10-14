// Small DOM helpers shared by every component. Components only ever set text
// through textContent and attributes through the DOM API, never innerHTML, so
// platform data cannot inject markup.

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A one-path SVG icon (24x24 viewBox), hidden from assistive technology. */
export function icon(doc: Document, className: string, pathData: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}

export const ICONS = {
  folder: "M20 7H12L10 5H4C2.9 5 2 5.9 2 7V17C2 18.1 2.9 19 4 19H20C21.1 19 22 18.1 22 17V9C22 7.9 21.1 7 20 7Z",
} as const;

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 3).map((w) => [...w][0]!.toUpperCase()).join("") || "?";
}

/** A mention count bubble; null when there is nothing to show. */
export function countBadge(doc: Document, count: number, className = "badge"): HTMLElement | null {
  return count > 0 ? el(doc, "span", className, count > 99 ? "99+" : String(count)) : null;
}

/** Sets a CSS custom property from platform data (CSSOM, so it passes a strict style-src CSP). */
export function setColor(element: HTMLElement, property: string, color: string | undefined): void {
  if (color) element.style.setProperty(property, color);
}
