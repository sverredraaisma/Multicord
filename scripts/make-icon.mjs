// Writes static/icon.png: a 32x32 blurple rounded square, generated so the
// repo needs no binary design assets yet.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const size = 32;
const rows = [];
for (let y = 0; y < size; y++) {
  const row = [0];
  for (let x = 0; x < size; x++) {
    const dx = Math.max(0, Math.abs(x - 15.5) - 9);
    const dy = Math.max(0, Math.abs(y - 15.5) - 9);
    const inside = Math.hypot(dx, dy) <= 6.5;
    row.push(0x58, 0x65, 0xf2, inside ? 255 : 0);
  }
  rows.push(...row);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header.set([8, 6, 0, 0, 0], 8);

writeFileSync(
  "static/icon.png",
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
