/**
 * The document of the EXP-015 criterion 1 compile (lane U-EXP-001-016): the kitchen-sink fixture
 * (packages/model/fixtures/kitchen-sink.json, read and not changed) with its landscape page setup
 * set to two columns, and six paragraphs added after the section break, so that `multicol` sets a
 * balanced two-column section. With the kitchen sink's own content, every package `docedit.cls`
 * loads is then used by the compile (`CLASS_PACKAGE_USE` names what uses each one).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import type { AssetInput } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';

const KITCHEN_SINK = fileURLToPath(
  new URL('../../../packages/model/fixtures/kitchen-sink.json', import.meta.url),
);

type J = { type: string; attrs?: Record<string, unknown>; content?: J[]; text?: string };

/** The paragraphs of the two-column section, in order. */
export const COLUMN_PARAGRAPHS = [1, 2, 3, 4, 5, 6].map((i) => `pColumns0000000${i}`);

const LOREM =
  'Column text that runs over several lines, so that the balanced section has lines in both columns. ';

export function packagesDocument(): CdmEnvelope {
  const env = JSON.parse(readFileSync(KITCHEN_SINK, 'utf8')) as CdmEnvelope;
  const doc = env.doc as unknown as J;
  const defs = doc.content!.find((n) => n.type === 'defs')!;
  const landscape = defs.content!.find(
    (n) => n.type === 'page_setup' && n.attrs?.['id'] === 'psLandscape00001',
  )!;
  landscape.attrs = { ...landscape.attrs, columns: 2, columnGap: 720 };
  const body = doc.content!.find((n) => n.type === 'body')!;
  const at = body.content!.findIndex((n) => n.type === 'section_break');
  if (at < 0) throw new Error('the kitchen-sink fixture has no section break');
  body.content!.splice(
    at + 1,
    0,
    ...COLUMN_PARAGRAPHS.map((id, i) => ({
      type: 'paragraph',
      attrs: { id },
      content: [{ type: 'text', text: `${i + 1}. ${LOREM.repeat(3)}` }],
    })),
  );
  return env;
}

/** A PNG of `w` by `h` pixels, 8-bit RGB without alpha, in two colours (PDF/A allows it as is). */
export function png(w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head, data])));
    return Buffer.concat([len, head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++)
      rows.push(...((x + y) % 2 ? [0x1f, 0x4e, 0x79] : [0xd9, 0xe2, 0xf3]));
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.from(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** The kitchen sink's assets (two pictures and a fallback picture), as ready PNG files. */
export function packagesAssets(): Record<string, AssetInput> {
  const bytes = png(16, 16);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ids = [
    '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
    '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a11',
    '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a13',
  ];
  return Object.fromEntries(
    ids.map((id) => [id, { sha256, mediaType: 'image/png', status: 'ready', bytes }]),
  );
}

/**
 * Each package the class loads (docedit.cls, `\RequirePackage`) and what in the converter's output
 * (main.tex and styles.tex) reaches it through the class's macros. `null` for the packages every
 * compile uses whatever the content (fonts, the colour model, the tagging and link hooks).
 */
export const CLASS_PACKAGE_USE: Readonly<Record<string, RegExp | null>> = {
  fontspec: /\\DEdeffamily\{/,
  amsmath: /\\DEmath\{/,
  'unicode-math': /\\DEmathfont\{/,
  xcolor: /\\DEc\{[0-9A-F]{6}\}/,
  luacolor: /\\DEhl\{/,
  geometry: /\\DEgeometry\{/,
  'lua-ul': /\\DEuld\{|\\DEhl\{/,
  array: /\\DEtbl\{/,
  longtable: /\\DEtbl\{/,
  colortbl: /\\cellcolor\[HTML\]/,
  // The setup of the section break: two columns (the third argument); the class opens multicols.
  multicol: /\\DEdefsetupb\{1\}\{[^}]*\}\{2\}/,
  graphicx: /\\DEimg\{/,
  hyperref: /\\DEhref\{/,
  babel: /\\DEbabel\{|\\DEdeflang\{/,
};

/**
 * The TeX Live the worker image is pinned to, as services/export-worker/Containerfile records it:
 * the release year of `FROM ... TeX Live 2026`, and the versions on its `created` line.
 */
export function pinnedTexLive(containerfile: string): {
  release: string;
  luahbtex: string;
  latex: string;
  tagpdf: string;
} {
  const release = /TeX Live (\d{4}), pinned by digest/.exec(containerfile)?.[1];
  const line = /created\s+\S+; LuaHBTeX (\S+); LaTeX (\S+); tagpdf (\S+);/.exec(containerfile);
  if (!release || !line) throw new Error('the Containerfile records no TeX Live pin');
  return { release, luahbtex: line[1]!, latex: line[2]!, tagpdf: line[3]! };
}
