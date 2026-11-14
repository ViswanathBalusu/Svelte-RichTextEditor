/**
 * EXP-003 (Node.js only): the preflight warns about content that will not typeset well, one
 * warning per occurrence with the block identifier and a code. Criteria covered here: the warnings
 * for a table in a multi-column section, a table in a story, a character no face covers, and a
 * picture without alternative text (criterion 1, except the row taller than a page, which the
 * preflight does not detect yet); the same warnings as diagnostics of the converter's job
 * (criterion 5 for the table warning only); no warning for a clean document (criterion 4); and the
 * same result on every run (criterion 2, the converter's half). The documents come from
 * `test/docs.ts`; nothing here compiles.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '@docedit/model';
import { FONTS, doc, nid, para, run, type J } from '../test/docs.ts';
import type { FontManifest } from './bundle.ts';
import { preflight, type PreflightWarning } from './preflight.ts';

/** The manifest of `test/docs.ts` with coverage on every face and on the math face. */
function covered(ranges: Array<readonly [number, number]>): FontManifest {
  const face = <T extends object>(f: T): T & { coverage: Array<readonly [number, number]> } => ({
    ...f,
    coverage: ranges,
  });
  return {
    ...FONTS,
    families: FONTS.families.map((f) => ({
      ...f,
      regular: face(f.regular),
      bold: face(f.bold),
      italic: face(f.italic),
      boldItalic: face(f.boldItalic),
    })),
    math: face(FONTS.math),
  };
}
const BASIC_LATIN = covered([[0x20, 0x7e]]);

const PS_TWO_COLUMNS = { type: 'page_setup', attrs: { id: 'ps2', columns: 2 } };
const TWO_COLUMN_BREAK = { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'ps2' } };

function table(cellId: string, content: J[] = [para('Cell.')]): J {
  return {
    type: 'table',
    attrs: { id: nid('t'), grid: [2880] },
    content: [
      {
        type: 'table_row',
        attrs: { id: nid('r') },
        content: [{ type: 'table_cell', attrs: { id: cellId }, content }],
      },
    ],
  };
}

function figure(alt: string | undefined): J {
  return {
    type: 'figure',
    attrs: {
      id: nid('f'),
      asset: 'pic1',
      width: 1440,
      height: 1440,
      ...(alt === undefined ? {} : { alt }),
    },
  };
}

const byCode = (
  ws: readonly PreflightWarning[],
  code: PreflightWarning['code'],
): PreflightWarning[] => ws.filter((w) => w.code === code);

describe('EXP-003 preflight warnings (criterion 1)', () => {
  it('warns once for a table in a multi-column section, with its block identifier', () => {
    const tid = nid('t');
    const env = doc([TWO_COLUMN_BREAK, { ...table(nid('c')), attrs: { id: tid, grid: [2880] } }], {
      pageSetups: [{ type: 'page_setup', attrs: { id: 'ps1' } }, PS_TWO_COLUMNS],
    });
    const ws = byCode(preflight(env), 'table_cannot_span_pages');
    expect(ws.map((w) => w.blockId)).toEqual([tid]);
  });

  it('does not warn for a table in a single-column section', () => {
    const env = doc([table(nid('c'))]);
    expect(byCode(preflight(env), 'table_cannot_span_pages')).toEqual([]);
  });

  it('warns for a table in a story (a header or a footer), with its block identifier', () => {
    const tid = nid('t');
    const env = doc([para('Body.')], {
      stories: [
        {
          type: 'story',
          attrs: { id: nid('st'), kind: 'header' },
          content: [{ ...table(nid('c')), attrs: { id: tid, grid: [2880] } }],
        },
      ],
    });
    expect(byCode(preflight(env), 'table_cannot_span_pages').map((w) => w.blockId)).toEqual([tid]);
  });

  it('warns once per distinct missing character in a block, with the block identifier and the code point', () => {
    const pid = nid('p');
    const env = doc([
      { type: 'paragraph', attrs: { id: pid }, content: [{ type: 'text', text: 'Café ✓ é' }] },
    ]);
    const ws = byCode(preflight(env, BASIC_LATIN), 'glyph_missing');
    expect(ws.map((w) => [w.blockId, w.codePoint])).toEqual([
      [pid, 0xe9],
      [pid, 0x2713],
    ]);
  });

  it('gives no glyph warning when the manifest gives no coverage', () => {
    const env = doc([para('Café ✓')]);
    expect(byCode(preflight(env, FONTS), 'glyph_missing')).toEqual([]);
  });

  it('warns for a picture without alternative text, and for a whitespace-only alternative text', () => {
    const missing = figure(undefined);
    const blank = figure('   ');
    const env = doc([missing, blank, figure('A picture')]);
    expect(byCode(preflight(env), 'image_without_alt').map((w) => w.blockId)).toEqual([
      (missing.attrs as J)['id'],
      (blank.attrs as J)['id'],
    ]);
  });
});

describe('EXP-003 preflight on a clean document (criterion 4)', () => {
  it('returns no warnings for text in covered characters, tables in one column and pictures with text', () => {
    const env = doc([para('Plain text.'), table(nid('c')), figure('A picture')]);
    expect(preflight(env, BASIC_LATIN)).toEqual([]);
  });

  it('returns no warnings for any printable ASCII paragraph (property)', () => {
    const ascii = fc
      .array(fc.integer({ min: 0x20, max: 0x7e }), { minLength: 1, maxLength: 40 })
      .map((codes) => String.fromCharCode(...codes));
    fc.assert(
      fc.property(ascii, (s) => {
        expect(preflight(doc([para(s)]), BASIC_LATIN)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

describe('EXP-003 preflight is one shared, deterministic check (criterion 2, converter half)', () => {
  it('gives the same warnings on every run for the same document', () => {
    const env: CdmEnvelope = doc(
      [TWO_COLUMN_BREAK, table(nid('c')), figure(undefined), para('Café')],
      {
        pageSetups: [{ type: 'page_setup', attrs: { id: 'ps1' } }, PS_TWO_COLUMNS],
      },
    );
    const a = preflight(structuredClone(env), BASIC_LATIN);
    const b = preflight(structuredClone(env), BASIC_LATIN);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});

describe('EXP-003 the converter reports the preflight warnings in the job (criterion 5, table case)', () => {
  it('puts the table warning into the job diagnostics with the table block identifier', async () => {
    const tid = nid('t');
    const env = doc([TWO_COLUMN_BREAK, { ...table(nid('c')), attrs: { id: tid, grid: [2880] } }], {
      pageSetups: [{ type: 'page_setup', attrs: { id: 'ps1' } }, PS_TWO_COLUMNS],
    });
    const b = await run(env);
    const found = b.diagnostics.filter((d) => d.code === 'table_cannot_span_pages');
    expect(found.map((d) => d.blockId)).toEqual([tid]);
    expect(found[0]!.severity).toBe('warning');
  });
});
