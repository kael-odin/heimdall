/**
 * A tiny TrueType font wrapped as WOFF2, assembled at test time.
 *
 * Tests that need a real web font should not depend on a third-party font
 * file (licence, size, and no one can see what is inside). This one carries
 * only the tables Chromium's font sanitizer (OTS) requires and a single square
 * glyph mapped to "A" with an advance of exactly 1 em, so "AAAA" at 20px is
 * 80px wide when the font is used and some other width when the browser falls
 * back to a system font.
 *
 * glyf/loca use the WOFF2 null transform (version 3), so the payload is just
 * the concatenated tables, Brotli-compressed with node:zlib.
 */
import { brotliCompressSync, constants } from 'node:zlib';

function be(bytes, signed, values) {
  const out = Buffer.alloc(bytes * values.length);
  values.forEach((value, i) => {
    if (bytes === 4) out.writeUInt32BE(value >>> 0, i * 4);
    else if (signed) out.writeInt16BE(value, i * 2);
    else out.writeUInt16BE(value, i * 2);
  });
  return out;
}
const u16 = (...values) => be(2, false, values);
const i16 = (...values) => be(2, true, values);
const u32 = (...values) => be(4, false, values);
const align4 = n => (n + 3) & ~3;

function base128(value) {
  const bytes = [value & 0x7f];
  while ((value >>>= 7)) bytes.unshift(0x80 | (value & 0x7f));
  return Buffer.from(bytes);
}

function nameTable(records) {
  const strings = records.map(([, text]) => Buffer.from(text, 'utf16le').swap16());
  let offset = 0;
  const entries = records.map(([id], i) => {
    const entry = u16(3, 1, 0x409, id, strings[i].length, offset);
    offset += strings[i].length;
    return entry;
  });
  return Buffer.concat([u16(0, records.length, 6 + 12 * records.length), ...entries, ...strings]);
}

/** The square glyph spans x 100..900, y 0..700 on a 1000-unit em. */
function sfntTables() {
  const square = Buffer.concat([
    i16(1, 100, 0, 900, 700),        // one contour + bounding box
    u16(3, 0),                       // last point index, no instructions
    Buffer.from([1, 1, 1, 1]),       // four on-curve points, 16-bit deltas
    i16(100, 0, 800, 0),             // x: 100, 100, 900, 900
    i16(0, 700, 0, -700),            // y: 0, 700, 700, 0
  ]);
  const glyf = Buffer.concat([square, Buffer.alloc(align4(square.length) - square.length)]);
  return [
    ['cmap', 0, Buffer.concat([
      u16(0, 1), u16(3, 1), u32(12),  // one Windows Unicode BMP subtable
      u16(4, 32, 0, 4, 4, 1, 0),      // format 4, length, language, 2 segments
      u16(0x41, 0xffff, 0, 0x41, 0xffff), i16(1 - 0x41, 1), u16(0, 0),
    ])],
    ['head', 1, Buffer.concat([
      u16(1, 0), u32(0x00010000, 0, 0x5f0f3cf5), u16(1, 1000), u32(0, 0, 0, 0),
      i16(100, 0, 900, 700), u16(0, 8), i16(2, 0, 0),
    ])],
    ['hhea', 2, Buffer.concat([
      u32(0x00010000), i16(800, -200, 0), u16(1000), i16(100, 100, 900, 1, 0, 0, 0, 0, 0, 0, 0), u16(2),
    ])],
    ['hmtx', 3, Buffer.concat([u16(1000), i16(0), u16(1000), i16(100)])],
    ['maxp', 4, Buffer.concat([u32(0x00010000), u16(2, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)])],
    ['name', 5, nameTable([[1, 'Heimdall Probe'], [2, 'Regular'], [4, 'Heimdall Probe Regular'],
      [5, 'Version 1.000'], [6, 'HeimdallProbe-Regular']])],
    ['OS/2', 6, Buffer.concat([
      u16(4), i16(1000), u16(400, 5, 0), i16(650, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0),
      Buffer.alloc(10), u32(1, 0, 0, 0), Buffer.from('NONE'), u16(0x40, 0x41, 0x41),
      i16(800, -200, 0), u16(800, 200), u32(1, 0), i16(500, 700), u16(0, 0x20, 1),
    ])],
    ['post', 7, Buffer.concat([u32(0x00030000, 0), i16(-100, 50), u32(0, 0, 0, 0, 0)])],
    ['glyf', 10, glyf],
    ['loca', 11, u16(0, 0, glyf.length / 2)],
  ];
}

export function probeFontWoff2() {
  const tables = sfntTables();
  const directory = Buffer.concat(tables.map(([tag, known, data]) => Buffer.concat([
    // Known-tag index; glyf/loca additionally declare transform version 3 (none).
    Buffer.from([tag === 'glyf' || tag === 'loca' ? known | 0xc0 : known]),
    base128(data.length),
  ])));
  const compressed = brotliCompressSync(Buffer.concat(tables.map(([, , data]) => data)), {
    params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT },
  });
  const sfntSize = 12 + 16 * tables.length + tables.reduce((sum, [, , data]) => sum + align4(data.length), 0);
  const length = align4(48 + directory.length + compressed.length);
  const header = Buffer.concat([
    Buffer.from('wOF2'), u32(0x00010000, length), u16(tables.length, 0),
    u32(sfntSize, compressed.length), u16(1, 0), u32(0, 0, 0, 0, 0),
  ]);
  const font = Buffer.concat([header, directory, compressed]);
  return Buffer.concat([font, Buffer.alloc(length - font.length)]);
}
