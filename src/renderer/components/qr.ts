// A QR code encoder, small enough to keep in the view: byte mode, error
// correction level M, versions 1 to 10 (up to 213 bytes), following ISO/IEC
// 18004 as Project Nayuki's reference implementation lays it out. Codes are
// made here, never by a web service, as what they hold may be a credential
// (Telegram's sign-in link).

/** Error correction codewords per block, and blocks, for level M, versions 1 to 10. */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const MAX_QR_VERSION = 10;

/** Modules that hold data and error correction, after the function patterns. */
function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version: number): number => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version - 1]! * BLOCKS[version - 1]!;

/** Most bytes a code holds. */
export const MAX_QR_BYTES = Math.floor((dataCodewords(MAX_QR_VERSION) * 8 - 4 - 16) / 8);

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The Reed-Solomon generator polynomial of a degree, highest term left out. */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => (result[i]! ^= gfMultiply(coefficient, factor)));
  }
  return result;
}

/** The data split into blocks, each with its error correction, interleaved. */
function withErrorCorrection(data: number[], version: number): number[] {
  const blocks = BLOCKS[version - 1]!;
  const ecc = ECC_PER_BLOCK[version - 1]!;
  const raw = Math.floor(rawModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const divisor = rsDivisor(ecc);
  const split: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const part = data.slice(k, k + shortLength - ecc + (i < short ? 0 : 1));
    k += part.length;
    const remainder = rsRemainder(part, divisor);
    // Short blocks get a placeholder where long ones have one more data byte.
    if (i < short) part.push(0);
    split.push([...part, ...remainder]);
  }
  const result: number[] = [];
  for (let i = 0; i < split[0]!.length; i++) {
    split.forEach((block, j) => {
      if (i !== shortLength - ecc || j >= short) result.push(block[i]!);
    });
  }
  return result;
}

/** The data codewords for text: byte mode, its length, the bytes, a terminator and padding. */
function encode(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  return codewords;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

class QrSymbol {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.dark[y]![x] = dark;
    this.fixed[y]![x] = true;
  }

  /** Timing, finder and alignment patterns, and room for the format and version bits. */
  drawFunctionPatterns(): void {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [x, y] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          if (x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size) this.set(x + dx, y + dy, distance !== 2 && distance !== 4);
        }
      }
    }
    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    positions.forEach((x, i) =>
      positions.forEach((y, j) => {
        // Not over the finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }),
    );
    this.drawFormatBits(0);
    this.drawVersion();
  }

  alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position);
    return result;
  }

  /** The format bits for level M (00) and a mask, twice, with the dark module. */
  drawFormatBits(mask: number): void {
    let remainder = mask;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((mask << 10) | remainder) ^ 0x5412;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(bits, i));
    this.set(8, size - 8, true);
  }

  /** Versions 7 and up say which they are, twice. */
  drawVersion(): void {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, bit(bits, i));
      this.set(b, a, bit(bits, i));
    }
  }

  /** The codewords in the zigzag order, two columns at a time, skipping the function patterns. */
  drawCodewords(data: number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (!this.fixed[y]![x] && i < data.length * 8) {
            this.dark[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  /** Flips the data modules a mask selects; doing it twice undoes it. */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.fixed[y]![x] && MASKS[mask]!(x, y)) this.dark[y]![x] = !this.dark[y]![x];
  }

  /** How hard the symbol is to read, as the standard scores it; the mask with the lowest score is used. */
  penalty(): number {
    const { size, dark } = this;
    let result = 0;
    const lines = [...dark, ...dark.map((_, x) => dark.map((row) => row[x]!))];
    for (const line of lines) {
      let color = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      const addHistory = (length: number) => {
        if (history[0] === 0) length += size;
        history.pop();
        history.unshift(length);
      };
      const finderLike = () => {
        const n = history[1]!;
        const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
        return (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) + (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0);
      };
      for (const cell of line) {
        if (cell === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          addHistory(run);
          if (!color) result += finderLike() * 40;
          color = cell;
          run = 1;
        }
      }
      if (color) {
        addHistory(run);
        run = 0;
      }
      addHistory(run + size);
      result += finderLike() * 40;
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = dark[y]![x];
        if (c === dark[y]![x + 1] && c === dark[y + 1]![x] && c === dark[y + 1]![x + 1]) result += 3;
      }
    }
    const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const total = size * size;
    return result + (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  }
}

/**
 * Text as a QR code: rows of modules, true for dark, without the quiet
 * zone. Undefined for text longer than MAX_QR_BYTES in UTF-8.
 */
export function qrCode(text: string): boolean[][] | undefined {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= MAX_QR_VERSION && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > MAX_QR_VERSION) return undefined;
  const symbol = new QrSymbol(version);
  symbol.drawFunctionPatterns();
  symbol.drawCodewords(withErrorCorrection(encode(bytes, version), version));
  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < MASKS.length; mask++) {
    symbol.applyMask(mask);
    symbol.drawFormatBits(mask);
    const score = symbol.penalty();
    if (score < lowest) [best, lowest] = [mask, score];
    symbol.applyMask(mask);
  }
  symbol.applyMask(best);
  symbol.drawFormatBits(best);
  return symbol.dark;
}

const SVG = "http://www.w3.org/2000/svg";

/** A QR code as an SVG picture, dark on light whatever the theme, with the standard quiet zone; undefined for text too long. */
export function qrPicture(doc: Document, text: string, label: string): SVGSVGElement | undefined {
  const modules = qrCode(text);
  if (!modules) return undefined;
  const quiet = 4;
  const size = modules.length + quiet * 2;
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "qr-code");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const background = doc.createElementNS(SVG, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "#fff");
  let path = "";
  modules.forEach((row, y) => row.forEach((dark, x) => (path += dark ? `M${x + quiet} ${y + quiet}h1v1h-1z` : "")));
  const shape = doc.createElementNS(SVG, "path");
  shape.setAttribute("d", path);
  shape.setAttribute("fill", "#000");
  svg.append(background, shape);
  return svg;
}
