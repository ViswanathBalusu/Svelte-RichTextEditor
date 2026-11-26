/**
 * EXP-121 citations and the bibliography on the converter's text route (Node.js only):
 * ibliography: 'text', in which the converter writes the citation texts and the bibliography
 * itself (citations.ts), so the bundle has no .bib file and biber does not run. This is the route
 * before owner decision 16, kept as an option; the default route is biblatex
 * (xp-121-biblatex.test.ts). Nothing here compiles.
 */
import { describe, expect, it } from 'vitest';
import type { Bundle, ConvertOptions } from './bundle.ts';
import {
  blockLines,
  codes,
  decodeStrings,
  doc,
  nid,
  para,
  run as convertWith,
} from '../test/docs.ts';

/** The text route of the converter (the default is biblatex since owner decision 16). */
const run = (
  envelope: Parameters<typeof convertWith>[0],
  options: Partial<ConvertOptions> = {},
): Promise<Bundle> => convertWith(envelope, { bibliography: 'text', ...options });

const SMITH = {
  type: 'source_def',
  attrs: {
    id: 'smith2020',
    kind: 'book',
    title: 'Cells & Tissues 100%',
    authors: [{ family: 'Smith', given: 'Jane' }],
    issued: '2020',
    publisher: 'Press',
  },
};
const LEE = {
  type: 'source_def',
  attrs: {
    id: 'lee2019',
    kind: 'book',
    title: 'Second paper',
    authors: [{ family: 'Lee', given: 'Ken' }],
    issued: '2019',
  },
};

const cite = (items: unknown[], mode = 'normal') => ({ type: 'citation', attrs: { items, mode } });
const bibliography = (include?: 'all' | 'cited') => ({
  type: 'bibliography',
  attrs: { id: nid('b'), ...(include ? { include } : {}) },
});

describe('EXP-121 citations are typeset as text with the bibliography at its position', () => {
  it('prints the citation text and the bibliography entry where the bibliography node is', async () => {
    const b = await run(
      doc(
        [
          para('Intro.', {}, [cite([{ source: 'smith2020' }])]),
          para('Middle.'),
          bibliography(),
          para('After.'),
        ],
        { sources: [SMITH] },
      ),
    );
    expect(b.ok).toBe(true);
    const plain = decodeStrings(b.files['main.tex']!);
    expect(plain).toContain('(Smith 2020)');
    const entry = plain.indexOf('\\DEbibentry{');
    expect(entry).toBeGreaterThan(plain.indexOf('Middle.'));
    expect(entry).toBeLessThan(plain.indexOf('After.'));
    expect(plain.slice(entry)).toContain('Cells \\& Tissues 100\\%');
  });

  it('lists only the cited sources with include cited, and every source with include all', async () => {
    const body = (inc?: 'all' | 'cited') => [
      para('Only Smith.', {}, [cite([{ source: 'smith2020' }])]),
      bibliography(inc),
    ];
    const cited = decodeStrings(
      (await run(doc(body(), { sources: [SMITH, LEE] }))).files['main.tex']!,
    );
    expect(cited).toContain('Cells \\& Tissues 100\\%');
    expect(cited).not.toContain('Second paper');
    const all = decodeStrings(
      (await run(doc(body('all'), { sources: [SMITH, LEE] }))).files['main.tex']!,
    );
    expect(all).toContain('Second paper');
  });

  it('escapes the source strings of the bibliography entry, so no raw special character reaches TeX', async () => {
    const b = await run(
      doc([para('Text.', {}, [cite([{ source: 'smith2020' }])]), bibliography()], {
        sources: [SMITH],
      }),
    );
    const tex = b.files['main.tex']!;
    expect(tex).not.toContain('Cells & Tissues');
    expect(tex).not.toContain('100%');
    expect(tex).toContain('Cells \\& Tissues 100\\%');
  });
});

describe('EXP-121 a missing or malformed citation source gives a diagnostic that names the block', () => {
  it('reports a citation of an undefined source with its block id and prints a neutral mark', async () => {
    const b = await run(
      doc([para('Missing.', { id: 'pMissing0001' }, [cite([{ source: 'nobody1999' }])])], {
        sources: [SMITH],
      }),
    );
    const d = b.diagnostics.find((x) => x.code === 'citation_source_missing');
    expect(d?.severity).toBe('warning');
    expect(d?.blockId).toBe('pMissing0001');
    expect(decodeStrings(b.files['main.tex']!)).toContain('(?)');
  });

  it('reports a citation item with no source string, naming the block', async () => {
    const b = await run(
      doc([para('Malformed.', { id: 'pMalformed01' }, [cite([{ prefix: 'see' }])])], {
        sources: [SMITH],
      }),
    );
    expect(codes(b)).toContain('citation_source_missing');
    expect(b.diagnostics.find((x) => x.code === 'citation_source_missing')?.blockId).toBe(
      'pMalformed01',
    );
  });

  it('reports nothing for a citation of a defined source', async () => {
    const b = await run(
      doc([para('Good.', { id: 'pGood000001' }, [cite([{ source: 'smith2020' }])])], {
        sources: [SMITH],
      }),
    );
    expect(codes(b)).not.toContain('citation_source_missing');
  });
});

describe('EXP-121 the bibliography block emits its entries inside its own block lines', () => {
  it('attributes the bibliography entries to the bibliography block', async () => {
    const bib = bibliography();
    const b = await run(
      doc([para('Cited.', {}, [cite([{ source: 'smith2020' }])]), bib], { sources: [SMITH] }),
    );
    const lines = blockLines(b, (bib.attrs as { id: string }).id).join('\n');
    expect(lines).toContain('\\DEbibentry{');
  });
});
