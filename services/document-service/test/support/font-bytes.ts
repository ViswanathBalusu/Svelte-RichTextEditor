/**
 * A small synthetic TrueType font for the tests of tenant fonts (BE-048): the tables the font check
 * reads (`head`, `hhea`, `maxp`, `hmtx`, `cmap`, `name`, `OS/2`, empty `glyf` and `loca`) and
 * nothing a renderer needs. The asset worker's own tests build more shapes (`test/font-fixtures.ts`
 * there); this copy only builds valid files.
 */
const u16 = (n: number): number[] => [(n >> 8) & 255, n & 255];
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const utf16 = (s: string): number[] => [...s].flatMap((c) => u16(c.charCodeAt(0)));

export interface FontSpec {
  family: string;
  /** 400 or 700. */
  weight?: number;
  italic?: boolean;
  fsType?: number;
}

export function ttf(spec: FontSpec): Uint8Array {
  const weight = spec.weight ?? 400;
  const bold = weight >= 600;
  const italic = spec.italic ?? false;
  const head = new Array<number>(54).fill(0);
  head.splice(12, 4, ...u32(0x5f0f3cf5));
  head.splice(18, 2, ...u16(1000));
  head.splice(44, 2, ...u16((bold ? 1 : 0) | (italic ? 2 : 0)));
  const os2 = new Array<number>(78).fill(0);
  os2.splice(4, 2, ...u16(weight));
  os2.splice(8, 2, ...u16(spec.fsType ?? 0));
  os2.splice(62, 2, ...u16((italic ? 1 : 0) | (bold ? 0x20 : 0)));
  const names = [
    { id: 1, text: utf16(spec.family) },
    { id: 2, text: utf16(bold ? 'Bold' : 'Regular') },
  ];
  const nameDir: number[] = [];
  const strings: number[] = [];
  let off = 0;
  for (const n of names) {
    nameDir.push(
      ...u16(3),
      ...u16(1),
      ...u16(0x409),
      ...u16(n.id),
      ...u16(n.text.length),
      ...u16(off),
    );
    strings.push(...n.text);
    off += n.text.length;
  }
  const name = [
    ...u16(0),
    ...u16(names.length),
    ...u16(6 + names.length * 12),
    ...nameDir,
    ...strings,
  ];
  const tables = [
    { tag: 'OS/2', data: os2 },
    { tag: 'cmap', data: [0, 0, 0, 0] },
    { tag: 'glyf', data: [0, 0, 0, 0] },
    { tag: 'head', data: head },
    { tag: 'hhea', data: new Array<number>(36).fill(0) },
    { tag: 'hmtx', data: [0, 0, 0, 0] },
    { tag: 'loca', data: [0, 0, 0, 0] },
    { tag: 'maxp', data: [...u32(0x00010000), ...u16(3)] },
    { tag: 'name', data: name },
  ];
  const out: number[] = [...u32(0x00010000), ...u16(tables.length), 0, 0, 0, 0, 0, 0];
  const body: number[] = [];
  let at = 12 + tables.length * 16;
  for (const t of tables) {
    out.push(...ascii(t.tag), ...u32(0), ...u32(at), ...u32(t.data.length));
    const padded = [...t.data, ...new Array<number>((4 - (t.data.length % 4)) % 4).fill(0)];
    body.push(...padded);
    at += padded.length;
  }
  return Uint8Array.from([...out, ...body]);
}
