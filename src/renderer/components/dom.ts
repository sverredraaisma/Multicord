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
  archive: "M20.54 5.23L19.15 3.55C18.88 3.21 18.47 3 18 3H6C5.53 3 5.12 3.21 4.84 3.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V6.5C21 6.02 20.83 5.57 20.54 5.23ZM12 17.5L6.5 12H10V10H14V12H17.5L12 17.5ZM5.12 5L5.93 4H17.93L18.87 5H5.12Z",
  unarchive: "M20.55 5.22L19.16 3.54C18.88 3.21 18.47 3 18 3H6C5.53 3 5.12 3.21 4.85 3.55L3.46 5.22C3.17 5.57 3 6.01 3 6.5V19C3 20.1 3.89 21 5 21H19C20.1 21 21 20.1 21 19V6.5C21 6.01 20.83 5.57 20.55 5.22ZM12 9.5L17.5 15H14V17H10V15H6.5L12 9.5ZM5.12 5L5.94 4H17.94L18.88 5H5.12Z",
  bell: "M12 22C13.1 22 14 21.1 14 20H10C10 21.1 10.89 22 12 22ZM18 16V11C18 7.93 16.36 5.36 13.5 4.68V4C13.5 3.17 12.83 2.5 12 2.5S10.5 3.17 10.5 4V4.68C7.63 5.36 6 7.92 6 11V16L4 18V19H20V18L18 16Z",
  bellOff:
    "M20 18.69L7.84 6.14 5.27 3.49 4 4.76L6.8 7.56V7.57C6.28 8.56 6 9.73 6 10.99V15.99L4 17.99V18.99H17.73L19.73 20.99 21 19.72 20 18.69ZM12 22C13.11 22 14 21.11 14 20H10C10 21.11 10.89 22 12 22ZM18 14.68V11C18 7.92 16.36 5.36 13.5 4.68V4C13.5 3.17 12.83 2.5 12 2.5S10.5 3.17 10.5 4V4.68C10.35 4.71 10.21 4.76 10.08 4.8 9.98 4.83 9.88 4.87 9.78 4.91H9.77C9.76 4.91 9.76 4.91 9.75 4.92 9.52 5.01 9.29 5.12 9.07 5.23L18 14.68Z",
  call: "M6.62 10.79C8.06 13.62 10.38 15.93 13.21 17.38L15.41 15.18C15.68 14.91 16.08 14.82 16.43 14.94 17.55 15.31 18.76 15.51 20 15.51 20.55 15.51 21 15.96 21 16.51V20C21 20.55 20.55 21 20 21 10.61 21 3 13.39 3 4 3 3.45 3.45 3 4 3H7.5C8.05 3 8.5 3.45 8.5 4 8.5 5.25 8.7 6.45 9.07 7.57 9.18 7.92 9.1 8.31 8.82 8.59L6.62 10.79Z",
  folder: "M20 7H12L10 5H4C2.9 5 2 5.9 2 7V17C2 18.1 2.9 19 4 19H20C21.1 19 22 18.1 22 17V9C22 7.9 21.1 7 20 7Z",
  search: "M15.5 14H14.71L14.43 13.73C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16C11.11 16 12.59 15.41 13.73 14.43L14 14.71V15.5L19 20.49 20.49 19 15.5 14ZM9.5 14C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14Z",
  pin: "M16 9V4H17C17.55 4 18 3.55 18 3S17.55 2 17 2H7C6.45 2 6 2.45 6 3S6.45 4 7 4H8V9C8 10.66 6.66 12 5 12V14H10.97V21L11.97 22L12.97 21V14H19V12C17.34 12 16 10.66 16 9Z",
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
