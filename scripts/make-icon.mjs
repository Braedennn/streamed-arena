import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'electron', 'icon.ico');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const RED = [0xff, 0x22, 0x33];
const BLACK = [0x07, 0x04, 0x05];

function insideRoundedSquare(x, y, size) {
  const margin = size * 0.02;
  const radius = size * 0.24;
  const lo = margin;
  const hi = size - margin;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.max(lo + radius, Math.min(x, hi - radius));
  const cy = Math.max(lo + radius, Math.min(y, hi - radius));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideRing(x, y, cx, cy, rOuter, rInner) {
  return insideCircle(x, y, cx, cy, rOuter) && !insideCircle(x, y, cx, cy, rInner);
}

function glyphColor(x, y, size) {
  const c = size / 2;
  if (insideCircle(x, y, c, c, size * 0.1)) return BLACK;
  if (insideRing(x, y, c, c, size * 0.22, size * 0.16)) return BLACK;
  if (insideRing(x, y, c, c, size * 0.36, size * 0.3)) return BLACK;
  return null;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = size >= 48 ? 3 : 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          let color = null;
          let alpha = 0;
          if (insideRoundedSquare(px, py, size)) {
            alpha = 255;
            color = RED;
            const glyph = glyphColor(px, py, size);
            if (glyph) color = glyph;
          }
          r += color ? color[0] : 0;
          g += color ? color[1] : 0;
          b += color ? color[2] : 0;
          a += alpha;
        }
      }
      const total = samples * samples;
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(r / total);
      pixels[offset + 1] = Math.round(g / total);
      pixels[offset + 2] = Math.round(b / total);
      pixels[offset + 3] = Math.round(a / total);
    }
  }
  return png(size, pixels);
}

mkdirSync(dirname(OUT), { recursive: true });

const sizes = [256, 48, 32, 16];
const blobs = sizes.map((size) => ({ size, data: render(size) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(blobs.length, 4);

const entries = [];
let offset = 6 + blobs.length * 16;
for (const blob of blobs) {
  const entry = Buffer.alloc(16);
  entry[0] = blob.size === 256 ? 0 : blob.size;
  entry[1] = blob.size === 256 ? 0 : blob.size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(blob.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += blob.data.length;
}

const ico = Buffer.concat([header, ...entries, ...blobs.map((blob) => blob.data)]);
writeFileSync(OUT, ico);
console.log(`icon written: ${OUT} (${(ico.length / 1024).toFixed(1)} KB, ${sizes.join('/')})`);
