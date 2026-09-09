// Generates the PWA icons (player/icons/icon-192.png, icon-512.png) with no
// dependencies: a terracotta rounded square with a white "play" triangle,
// encoded as PNG by hand using Node's zlib.  Run: node player/tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'icons');
mkdirSync(out, { recursive: true });

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // corner radius
  const bg = [196, 81, 26];
  const fg = [255, 255, 255];
  // Play triangle: apex right.
  const tx0 = size * 0.36, ty0 = size * 0.28, tx1 = size * 0.36, ty1 = size * 0.72, tx2 = size * 0.74, ty2 = size * 0.5;
  const inTri = (x, y) => {
    const d1 = (x - tx1) * (ty0 - ty1) - (tx0 - tx1) * (y - ty1);
    const d2 = (x - tx2) * (ty1 - ty2) - (tx1 - tx2) * (y - ty2);
    const d3 = (x - tx0) * (ty2 - ty0) - (tx2 - tx0) * (y - ty0);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(Math.max(x + 0.5, r), size - r);
      const cy = Math.min(Math.max(y + 0.5, r), size - r);
      const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
      const i = (y * size + x) * 4;
      if (!inside) {
        px[i + 3] = 0;
        continue;
      }
      const c = inTri(x + 0.5, y + 0.5) ? fg : bg;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = join(out, `icon-${size}.png`);
  writeFileSync(file, icon(size));
  console.log('wrote', file);
}
