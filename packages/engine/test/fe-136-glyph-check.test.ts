/**
 * FE-136 criterion 4: a character the current font lacks is flagged before export (09 §3.2). The
 * host hands the core the coverage of the fonts; the core flags a symbol inserted in a font that
 * lacks it and lists the characters of the body that their fonts lack. The family of a run is the
 * one the style cascade gives it: a mark, a character style or the paragraph's style chain.
 */
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../src/api.ts';
import { type GlyphCoverage, DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { layoutEnvelope } from './layout-doc.ts';
import { caret, microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const OWNER: Access = {
  rev: 1,
  asOfSeq: 0,
  docRole: 'owner',
  caps: [...EDIT, 'structure', 'manage'],
  scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT] },
  leases: {},
  fill: null,
  restrictions: [],
};

const MARKED = 'pMarked00000001';
const STYLED = 'pStyled0000001';
const PLAIN = 'pPlain00000001';

/** Basic Latin only, as a font with a small character map would have. */
const LATIN: readonly (readonly [number, number])[] = [[0x20, 0x7e]];
/** Basic Latin and the Greek small letters. */
const GREEK: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0x3b1, 0x3c9],
];

/** `Alpha` has Latin only; the default face (null) has Greek too; `Mystery` is not known. */
const coverage: GlyphCoverage = (family) => {
  if (family === 'Alpha') return LATIN;
  if (family === null) return GREEK;
  return null;
};

function core(): DocumentCore {
  const doc = layoutEnvelope() as unknown as {
    content: Array<{ type: string; content: Array<Record<string, unknown>> }>;
  };
  const defs = doc.content.find((n) => n.type === 'defs')!;
  defs.content.splice(2, 0, {
    type: 'style_def',
    attrs: {
      id: 'AlphaPara',
      kind: 'paragraph',
      name: 'Alpha paragraph',
      basedOn: 'Normal',
      fontFamily: 'Alpha',
    },
  });
  const body = doc.content.find((n) => n.type === 'body')!;
  const text = (t: string, marks?: unknown[]) => ({
    type: 'text',
    text: t,
    ...(marks ? { marks } : {}),
  });
  body.content.push(
    {
      type: 'paragraph',
      attrs: { id: MARKED, style: null },
      content: [text('Marked ', [{ type: 'fontFamily', attrs: { value: 'Alpha' } }])],
    },
    { type: 'paragraph', attrs: { id: STYLED, style: 'AlphaPara' }, content: [text('Styled é')] },
    { type: 'paragraph', attrs: { id: PLAIN, style: null }, content: [text('Plain é ω')] },
  );
  const envelope: CdmEnvelope = { cdm: 1, requires: [], doc: doc as unknown as CdmJsonNode };
  return new DocumentCore({ doc: envelope, access: OWNER, schedule: microtask });
}

describe('a symbol the font lacks is flagged when it is inserted (FE-136 criterion 4)', () => {
  it('flags a Greek letter in a run set in a font that has Latin only, with the family', () => {
    const c = core();
    c.setGlyphCoverage(coverage);
    caret(c, MARKED, 6);
    expect(c.exec('insertSymbol', { symbol: 'ω' })).toBe(true);
    expect(c.glyphNotice.get()).toEqual({ n: 1, char: 'ω', family: 'Alpha' });
  });

  it('flags through the paragraph style chain when no mark names the font', () => {
    const c = core();
    c.setGlyphCoverage(coverage);
    caret(c, STYLED, 3);
    expect(c.exec('insertSymbol', { symbol: 'ω' })).toBe(true);
    expect(c.glyphNotice.get()).toMatchObject({ char: 'ω', family: 'Alpha' });
  });

  it('does not flag a character the font has, a font that is not known, or no coverage at all', () => {
    const c = core();
    caret(c, MARKED, 6);
    // No coverage given yet.
    expect(c.exec('insertSymbol', { symbol: 'ω' })).toBe(true);
    expect(c.glyphNotice.get()).toBeNull();
    c.setGlyphCoverage(coverage);
    // The default face has Greek, so the letter is fine in a plain paragraph.
    caret(c, PLAIN, 2);
    expect(c.exec('insertSymbol', { symbol: 'ω' })).toBe(true);
    // A Latin letter in the font with Latin only.
    caret(c, MARKED, 2);
    expect(c.exec('insertSymbol', { symbol: 'Z' })).toBe(true);
    // A family the coverage does not know is never flagged.
    c.setGlyphCoverage((family) => (family === 'Alpha' ? null : LATIN));
    caret(c, MARKED, 2);
    expect(c.exec('insertSymbol', { symbol: 'ω' })).toBe(true);
    expect(c.glyphNotice.get()).toBeNull();
  });

  it('counts each notice, so the same symbol twice is flagged twice', () => {
    const c = core();
    c.setGlyphCoverage(coverage);
    caret(c, MARKED, 6);
    c.exec('insertSymbol', { symbol: 'ω' });
    caret(c, MARKED, 6);
    c.exec('insertSymbol', { symbol: 'ω' });
    expect(c.glyphNotice.get()?.n).toBe(2);
  });
});

describe('the characters of the body that their font lacks (FE-136 criterion 4)', () => {
  it('lists each missing character once for each paragraph, with its family and block', () => {
    const c = core();
    expect(c.missingGlyphs()).toEqual([]);
    c.setGlyphCoverage(coverage);
    const missing = c.missingGlyphs().map((m) => [m.blockId, m.char, m.family]);
    // `é` is outside Latin only in `Alpha` (the styled paragraph); the default face is Greek and Latin only.
    expect(missing).toEqual([
      [STYLED, 'é', 'Alpha'],
      [PLAIN, 'é', null],
    ]);
  });

  it('points at the character in the document', () => {
    const c = core();
    c.setGlyphCoverage(coverage);
    for (const hit of c.missingGlyphs()) {
      expect(internals(c).state.doc.textBetween(hit.pos, hit.pos + hit.char.length)).toBe(hit.char);
    }
  });
});
