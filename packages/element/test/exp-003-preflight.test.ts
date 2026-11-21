// EXP-003 criterion 2: the editor and the converter run one shared preflight and get the same
// results. The editor's side is `exportPreflight` (src/export-preflight.ts), called through the
// export service as the export dialog calls it, on the document the editor holds and the font set
// the service publishes at `GET /fonts`. The converter's side is `preflight()` of
// `@docedit/export-latex` on the same envelope with the font set's own manifest, and the
// diagnostics of the bundle `convert()` writes from them. Node.js; nothing is compiled.
import { convert, preflight, type FontManifest } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';
import type { Backend, ExportsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { converterFonts, exportPreflight } from '../src/export-preflight.ts';
import { exportService } from '../src/export-service.ts';

const BASIC_LATIN: Array<[number, number]> = [[0x20, 0x7e]];
const hash = (c: string): string => c.repeat(64);
const face = (c: string, ext = 'ttf') => ({
  file: `${hash(c)}.${ext}`,
  sha256: hash(c),
  coverage: BASIC_LATIN,
});

/** The font set's own manifest, as the worker's converter reads it (with coverage; EXP-026). */
const MANIFEST: FontManifest = {
  version: 1,
  families: [
    {
      name: 'Noto Serif',
      lineHeight: 1362,
      regular: face('a'),
      bold: face('b'),
      italic: face('c'),
      boldItalic: face('d'),
      licence: 'OFL-1.1',
    },
  ],
  math: { ...face('9', 'otf'), name: 'STIX Two Math', licence: 'OFL-1.1' },
  defaultFamily: 'Noto Serif',
};

/**
 * The body of `GET /fonts` for a font set, in the shape the document service publishes
 * (`FontManifestBody` of services/document-service, fonts.ts): a family per text family, one for
 * the math face and one for each fallback face, each face with its URL, hash and coverage.
 */
function published(m: FontManifest, base = 'https://docs.example/fonts'): unknown {
  const styles = [
    ['regular', 400, false],
    ['bold', 700, false],
    ['italic', 400, true],
    ['boldItalic', 700, true],
  ] as const;
  const one = (
    f: { file: string; sha256: string; coverage?: unknown },
    style: string,
    weight: number,
    italic: boolean,
  ) => ({
    style,
    weight,
    italic,
    url: `${base}/${f.file}`,
    sha256: f.sha256,
    bytes: 1000,
    format: f.file.endsWith('.otf') ? 'opentype' : 'truetype',
    ...(f.coverage ? { coverage: f.coverage } : {}),
  });
  return {
    version: 'v',
    defaultFamily: m.defaultFamily,
    families: [
      ...m.families.map((f) => ({
        family: f.name,
        role: 'text',
        licence: f.licence,
        lineHeight: f.lineHeight,
        faces: styles.map(([style, weight, italic]) => one(f[style], style, weight, italic)),
      })),
      {
        family: m.math.name,
        role: 'math',
        licence: m.math.licence,
        lineHeight: null,
        faces: [one(m.math, 'regular', 400, false)],
      },
      ...(m.fallback ?? []).map((f) => ({
        family: f.name,
        role: 'fallback',
        licence: f.licence,
        lineHeight: null,
        faces: [one(f, 'regular', 400, false)],
      })),
    ],
  };
}

const IDS = {
  plain: 'pPlain0000000001',
  glyphs: 'pGlyphs000000001',
  picture: 'pPicture00000001',
  figure: 'fFigure000000001',
  table: 'tTable0000000001',
  row: 'rRow000000000001',
  cell: 'cCell00000000001',
  cellText: 'pCell00000000001',
  twoColumns: 'sTwoCols00000001',
} as const;

const text = (t: string) => ({ type: 'text', text: t });

/** A table in a two-column section, two characters no face covers, and two pictures without text. */
function documentWithFindings(): CdmEnvelope {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
            { type: 'page_setup', attrs: { id: 'ps2', columns: 2 } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            { type: 'paragraph', attrs: { id: IDS.plain }, content: [text('Plain text.')] },
            { type: 'paragraph', attrs: { id: IDS.glyphs }, content: [text('Café ✓')] },
            {
              type: 'paragraph',
              attrs: { id: IDS.picture },
              content: [
                text('A picture: '),
                {
                  type: 'image',
                  attrs: { asset: '0190d5a4-7c3e-7d2a-9a1b-00000000000a', width: 600, height: 400 },
                },
              ],
            },
            {
              type: 'figure',
              attrs: {
                id: IDS.figure,
                asset: '0190d5a4-7c3e-7d2a-9a1b-00000000000b',
                width: 1440,
                height: 1440,
              },
            },
            { type: 'section_break', attrs: { id: IDS.twoColumns, pageSetup: 'ps2' } },
            {
              type: 'table',
              attrs: { id: IDS.table, grid: [2880] },
              content: [
                {
                  type: 'table_row',
                  attrs: { id: IDS.row },
                  content: [
                    {
                      type: 'table_cell',
                      attrs: { id: IDS.cell },
                      content: [
                        {
                          type: 'paragraph',
                          attrs: { id: IDS.cellText },
                          content: [text('Cell.')],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

/** The editor's run: the service the export dialog asks, over the document and the `/fonts` body. */
function editorService(envelope: CdmEnvelope, fontsBody: unknown) {
  const port: ExportsPort = {
    async request() {
      throw new Error('the preflight creates no job');
    },
    async get() {
      throw new Error('not used');
    },
    async cancel() {},
  };
  const backend = { exports: port, features: new Set(['exports']) } as unknown as Backend;
  return exportService({
    source: () => ({ docId: 'doc-1', backend, access: null }),
    preflight: (target, options) =>
      exportPreflight(target, options, {
        content: () => envelope,
        fonts: async () => fontsBody,
      }),
  });
}

const CLASS_FILES = { 'docedit.cls': '% class\n', 'docedit.lua': '-- lua\n' };
const PREFLIGHT_CODES = ['table_cannot_span_pages', 'glyph_missing', 'image_without_alt'];

describe('EXP-003 the font set of GET /fonts is the converter manifest again', () => {
  it('gives back the families, the math face, the default family and the coverage', () => {
    expect(converterFonts(published(MANIFEST))).toEqual(MANIFEST);
  });

  it('keeps the fallback chain when the set has one, in its order', () => {
    const withChain: FontManifest = {
      ...MANIFEST,
      fallback: [
        { ...face('e'), name: 'Noto Sans Symbols', licence: 'OFL-1.1' },
        { ...face('f'), name: 'Noto Sans CJK', licence: 'OFL-1.1' },
      ],
    };
    expect(converterFonts(published(withChain))).toEqual(withChain);
  });

  it('carries no coverage when the service publishes none, and drops one that is not ranges', () => {
    const bare = structuredClone(MANIFEST) as FontManifest;
    for (const f of bare.families)
      for (const s of ['regular', 'bold', 'italic', 'boldItalic'] as const) delete f[s].coverage;
    delete bare.math.coverage;
    expect(converterFonts(published(bare))).toEqual(bare);
    const body = published(MANIFEST) as {
      families: Array<{ faces: Array<{ coverage: unknown }> }>;
    };
    body.families[0]!.faces[0]!.coverage = [[65, 'Z']];
    expect(converterFonts(body)?.families[0]!.regular.coverage).toBeUndefined();
  });

  it('gives no fonts for a body that is not a manifest, has no text family or no math face', () => {
    expect(converterFonts(null)).toBeNull();
    expect(converterFonts({ families: 'none' })).toBeNull();
    const body = published(MANIFEST) as { families: Array<{ role: string }> };
    expect(
      converterFonts({ ...body, families: body.families.filter((f) => f.role !== 'math') }),
    ).toBeNull();
    expect(
      converterFonts({ ...body, families: body.families.filter((f) => f.role !== 'text') }),
    ).toBeNull();
  });

  it('leaves out a family that lacks a face or names a face by something that is not a hash', () => {
    const body = published(MANIFEST) as {
      families: Array<{ role: string; faces: Array<{ sha256: string }> }>;
    };
    body.families[0]!.faces[3]!.sha256 = 'not-a-hash';
    expect(converterFonts(body)).toBeNull();
  });

  it('names no default family when the service publishes none', () => {
    const body = { ...(published(MANIFEST) as object), defaultFamily: null };
    expect(converterFonts(body)?.defaultFamily).toBe('');
  });
});

describe('EXP-003 the editor and the converter get the same preflight results (criterion 2)', () => {
  it('returns in the editor exactly what the shared implementation returns for the converter', async () => {
    const envelope = documentWithFindings();
    const service = editorService(envelope, published(MANIFEST));
    const editor = await service.preflight!('pdf', { profile: 'preview' });
    const shared = preflight(structuredClone(envelope), MANIFEST);

    expect(editor.map((w) => [w.code, w.blockId, w.message])).toEqual(
      shared.map((w) => [w.code, w.blockId, w.message]),
    );
    // One warning for each occurrence, with its block and its code (criterion 1, the three kinds
    // the preflight detects today).
    expect(editor.map((w) => [w.code, w.blockId])).toEqual([
      ['glyph_missing', IDS.glyphs],
      ['glyph_missing', IDS.glyphs],
      ['image_without_alt', IDS.picture],
      ['image_without_alt', IDS.figure],
      ['table_cannot_span_pages', IDS.table],
    ]);
    expect(editor.every((w) => w.severity === 'warning')).toBe(true);
  });

  it('matches the diagnostics of the job the converter writes from the same document', async () => {
    const envelope = documentWithFindings();
    const service = editorService(envelope, published(MANIFEST));
    for (const profile of ['preview', 'final'] as const) {
      const editor = await service.preflight!('pdf', { profile });
      const bundle = await convert(structuredClone(envelope), {
        fonts: MANIFEST,
        classFiles: CLASS_FILES,
        profile,
      });
      const job = bundle.diagnostics.filter((d) => PREFLIGHT_CODES.includes(d.code));
      const key = (d: { severity: string; code: string; blockId: string | null }) =>
        `${d.severity} ${d.code} ${d.blockId}`;
      expect(job.map(key).sort()).toEqual(editor.map(key).sort());
      // The findings the converter takes from the preflight carry the same words; the table's is
      // written by the table writer, with the same code and block (ADR 0115, item 18).
      for (const d of job.filter((x) => x.code !== 'table_cannot_span_pages'))
        expect(editor).toContainEqual(d);
      // A character no font covers stops a final export and only warns in a preview (09 §3.2).
      const glyph = editor.filter((w) => w.code === 'glyph_missing').map((w) => w.severity);
      expect(glyph).toEqual(profile === 'final' ? ['error', 'error'] : ['warning', 'warning']);
    }
  });

  it('makes no character check without coverage, in the editor as in the converter', async () => {
    const bare = structuredClone(MANIFEST) as FontManifest;
    for (const f of bare.families)
      for (const s of ['regular', 'bold', 'italic', 'boldItalic'] as const) delete f[s].coverage;
    delete bare.math.coverage;
    const envelope = documentWithFindings();
    const editor = await editorService(envelope, published(bare)).preflight!('pdf', {});
    const shared = preflight(envelope, bare);
    expect(editor.map((w) => [w.code, w.blockId])).toEqual(shared.map((w) => [w.code, w.blockId]));
    expect(editor.some((w) => w.code === 'glyph_missing')).toBe(false);
  });

  it('gives no warning for a document with none of these constructs', async () => {
    const clean = documentWithFindings() as unknown as {
      doc: { content: Array<{ type: string; content: unknown[] }> };
    };
    const body = clean.doc.content.find((c) => c.type === 'body')!;
    body.content = body.content.slice(0, 1);
    const service = editorService(clean as unknown as CdmEnvelope, published(MANIFEST));
    expect(await service.preflight!('pdf', { profile: 'final' })).toEqual([]);
  });
});

describe('EXP-003 the preflight in the export service', () => {
  it('checks the targets the converter writes, and no other', async () => {
    const service = editorService(documentWithFindings(), published(MANIFEST));
    expect((await service.preflight!('tex', {})).length).toBe(5);
    for (const target of ['docx', 'cdm', 'html', 'md'] as const)
      expect(await service.preflight!(target, {})).toEqual([]);
  });

  it('is absent when the element cannot run it, so the dialog creates the job at once', () => {
    const service = exportService({ source: () => null });
    expect(service.preflight).toBeUndefined();
  });

  it('still checks tables and pictures when the font manifest cannot be read', async () => {
    const found = await exportPreflight(
      'pdf',
      { profile: 'preview' },
      {
        content: () => documentWithFindings(),
        fonts: () => Promise.reject(new Error('offline')),
      },
    );
    expect(found.map((w) => w.code)).toEqual([
      'image_without_alt',
      'image_without_alt',
      'table_cannot_span_pages',
    ]);
  });

  it('gives nothing when no document is loaded', async () => {
    expect(await exportPreflight('pdf', {}, { content: () => null })).toEqual([]);
  });
});
