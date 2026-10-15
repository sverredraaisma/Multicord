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
  members:
    "M16 11C17.66 11 19 9.66 19 8S17.66 5 16 5 13 6.34 13 8 14.34 11 16 11ZM8 11C9.66 11 11 9.66 11 8S9.66 5 8 5 5 6.34 5 8 6.34 11 8 11ZM8 13C5.67 13 1 14.17 1 16.5V19H15V16.5C15 14.17 10.33 13 8 13ZM16 13C15.71 13 15.38 13.02 15.03 13.05 16.19 13.89 17 15.02 17 16.5V19H23V16.5C23 14.17 18.33 13 16 13Z",
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
