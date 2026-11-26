/**
 * Small synthetic fonts for the font checks (BE-048). They carry the tables the check reads and
 * nothing a renderer needs: a table directory, `head`, `hhea`, `maxp`, `hmtx`, `cmap`, `name`,
 * `OS/2`, and empty `glyf` and `loca` (or a `CFF ` table).
 */
import { brotliCompressSync } from 'node:zlib';

const u16 = (n: number): number[] => [(n >> 8) & 255, n & 255];
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const utf16 = (s: string): number[] => [...s].flatMap((c) => u16(c.charCodeAt(0)));

export interface FontSpec {
  family?: string;
  subfamily?: string;
  weight?: number;
  italic?: boolean;
  fsType?: number;
  /** `cff` makes an OpenType font with a `CFF ` table. */
  outlines?: 'glyf' | 'cff';
  glyphs?: number;
  unitsPerEm?: number;
  /** Table tags to leave out. */
  omit?: string[];
  tables?: number;
}

function head(unitsPerEm: number, macStyle: number): number[] {
  const t = new Array<number>(54).fill(0);
  t.splice(12, 4, ...u32(0x5f0f3cf5));
  t.splice(18, 2, ...u16(unitsPerEm));
  t.splice(44, 2, ...u16(macStyle));
  return t;
}

function os2(weight: number, fsType: number, selection: number): number[] {
  const t = new Array<number>(78).fill(0);
  t.splice(0, 2, ...u16(4));
  t.splice(4, 2, ...u16(weight));
  t.splice(8, 2, ...u16(fsType));
  t.splice(62, 2, ...u16(selection));
  return t;
}

function nameTable(family: string, subfamily: string): number[] {
  const records: { id: number; text: number[] }[] = [
    { id: 1, text: utf16(family) },
    { id: 2, text: utf16(subfamily) },
  ];
  const head = [...u16(0), ...u16(records.length), ...u16(6 + records.length * 12)];
  let off = 0;
  const dir: number[] = [];
  const strings: number[] = [];
  for (const r of records) {
    dir.push(...u16(3), ...u16(1), ...u16(0x409), ...u16(r.id), ...u16(r.text.length), ...u16(off));
    strings.push(...r.text);
    off += r.text.length;
  }
  return [...head, ...dir, ...strings];
}

/** The tables of a font as tag and bytes, in directory order. */
export function fontTables(spec: FontSpec = {}): { tag: string; data: number[] }[] {
  const weight = spec.weight ?? 400;
  const italic = spec.italic ?? false;
  const bold = weight >= 600;
  const maxp = [...u32(0x00010000), ...u16(spec.glyphs ?? 3)];
  const all: { tag: string; data: number[] }[] = [
    { tag: 'OS/2', data: os2(weight, spec.fsType ?? 0, (italic ? 1 : 0) | (bold ? 0x20 : 0)) },
    { tag: 'cmap', data: [0, 0, 0, 0] },
    { tag: 'head', data: head(spec.unitsPerEm ?? 1000, (bold ? 1 : 0) | (italic ? 2 : 0)) },
    { tag: 'hhea', data: new Array<number>(36).fill(0) },
    { tag: 'hmtx', data: [0, 0, 0, 0] },
    { tag: 'maxp', data: maxp },
    { tag: 'name', data: nameTable(spec.family ?? 'Test Sans', spec.subfamily ?? 'Regular') },
    ...(spec.outlines === 'cff'
      ? [{ tag: 'CFF ', data: [1, 0, 4, 1] }]
      : [
          { tag: 'glyf', data: [0, 0, 0, 0] },
          { tag: 'loca', data: [0, 0, 0, 0] },
        ]),
  ];
  const omit = new Set(spec.omit ?? []);
  const out = all.filter((t) => !omit.has(t.tag));
  for (let i = 0; out.length < (spec.tables ?? 0); i++)
    out.push({ tag: `x${i % 10}${i}`.padEnd(4, ' ').slice(0, 4), data: [0] });
  return out;
}

/** A TrueType (`.ttf`) or OpenType (`.otf`) file. */
export function sfnt(spec: FontSpec = {}): Uint8Array {
  const tables = fontTables(spec).sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const flavour = spec.outlines === 'cff' ? ascii('OTTO') : u32(0x00010000);
  const dirSize = 12 + tables.length * 16;
  const out: number[] = [...flavour, ...u16(tables.length), 0, 0, 0, 0, 0, 0];
  let off = dirSize;
  const body: number[] = [];
  for (const t of tables) {
    out.push(...ascii(t.tag), ...u32(0), ...u32(off), ...u32(t.data.length));
    const padded = [...t.data, ...new Array<number>((4 - (t.data.length % 4)) % 4).fill(0)];
    body.push(...padded);
    off += padded.length;
  }
  return Uint8Array.from([...out, ...body]);
}

const KNOWN = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
];

function base128(n: number): number[] {
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return out;
}

/** A WOFF2 file whose tables are not transformed (glyf and loca carry the null transform). */
export function woff2(
  spec: FontSpec = {},
  opts: { claimedSfnt?: number; raw?: Uint8Array } = {},
): Uint8Array {
  const tables = fontTables(spec);
  const dir: number[] = [];
  const data: number[] = [];
  for (const t of tables) {
    const index = KNOWN.indexOf(t.tag);
    const nullTransform = t.tag === 'glyf' || t.tag === 'loca' ? 0xc0 : 0;
    if (index >= 0) dir.push(index | nullTransform);
    else dir.push(63, ...ascii(t.tag));
    dir.push(...base128(t.data.length));
    data.push(...t.data);
  }
  const packed = opts.raw ?? brotliCompressSync(Uint8Array.from(data));
  const sfntSize = opts.claimedSfnt ?? 12 + tables.length * 16 + data.length;
  const total = 48 + dir.length + packed.length;
  const header = [
    ...ascii('wOF2'),
    ...(spec.outlines === 'cff' ? ascii('OTTO') : u32(0x00010000)),
    ...u32(total),
    ...u16(tables.length),
    ...u16(0),
    ...u32(sfntSize),
    ...u32(packed.length),
    ...u16(1),
    ...u16(0),
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u32(0),
  ];
  return Uint8Array.from([...header, ...dir, ...packed]);
}
