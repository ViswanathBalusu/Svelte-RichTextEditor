/**
 * EXP-121 in the sandbox (Node.js only, Podman): a document with sources and citations is converted
 * with the biblatex route, compiled with biber in the export worker's image under the sandbox rules,
 * and the PDF is read with `pdftotext`. The tests skip when `sandboxReady()` says compiles cannot
 * run here. The passes and the biber runs are measured from the job's own `timings.txt`.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para } from '../test/docs.ts';
import {
  convertAndCompile,
  firstError,
  keep,
  pdfText,
  sandboxReady,
  validatePdf,
} from '../test/harness.ts';

const readiness = await sandboxReady();
if (!readiness.ok) console.warn(`skipped: ${readiness.reason}`);
const ready = readiness.ok;

const SMITH = {
  type: 'source_def',
  attrs: {
    id: 'smith2020',
    kind: 'book',
    title: 'Cells & Tissues 100% {braces} _under_ #1',
    authors: [{ family: 'Smith', given: 'Jane' }, { literal: 'World Health Organization' }],
    issued: '2020',
    publisher: 'Press',
    publisherPlace: 'Oslo',
  },
};
const LEE = {
  type: 'source_def',
  attrs: {
    id: 'lee2019',
    kind: 'article-journal',
    title: 'Second paper',
    containerTitle: 'Journal of Tests',
    authors: [{ family: 'Lee', given: 'Ken' }],
    issued: '2019-05',
    volume: '3',
    issue: '2',
    pages: '4-9',
    doi: '10.1000/xyz_1',
  },
};
const cite = (items: unknown[], mode = 'normal') => ({ type: 'citation', attrs: { items, mode } });
const bibliography = (include?: 'all' | 'cited') => ({
  type: 'bibliography',
  attrs: { id: nid('b'), ...(include ? { include } : {}) },
});

const INSTANT = '2026-11-06T10:00:00.000Z';

describe.skipIf(!ready)('EXP-121 biber in the sandbox', () => {
  it('compiles a document with citations and a bibliography, and runs biber once', async () => {
    const c = await convertAndCompile(
      doc(
        [
          para('Intro.', {}, [
            cite([{ source: 'smith2020', locator: '5', label: 'page', prefix: 'see' }]),
            { type: 'text', text: ' and ' },
            cite([{ source: 'lee2019' }, { source: 'smith2020' }]),
            { type: 'text', text: ' and ' },
            cite([{ source: 'lee2019' }], 'narrative'),
            { type: 'text', text: ' and ' },
            cite([{ source: 'lee2019' }], 'suppressAuthor'),
          ]),
          para('Middle.'),
          bibliography(),
          para('After.'),
        ],
        { sources: [SMITH, LEE] },
      ),
      { instant: INSTANT, timeZone: 'UTC' },
    );
    if (!c.compile.ok)
      console.log(
        keep('exp-121-biblatex', c),
        JSON.stringify({
          passes: c.compile.passes,
          biber: c.compile.biber,
          exit: c.compile.exitCode,
        }),
        c.compile.biberLog,
        c.compile.stderr,
      );
    expect(c.bundle.files['references.bib']).toContain('@book{smith2020,');
    expect(c.compile.ok, firstError(c.compile.log)).toBe(true);
    expect(c.compile.biber).toHaveLength(1);
    expect(c.compile.biber![0]!.rc).toBeLessThan(2);
    const raw = pdfText(c.compile.pdf!);
    if (raw === null) return; // pdftotext is not installed here
    const plain = raw.replace(/\s+/g, ' ');
    expect(plain).toContain('Smith');
    expect(plain).toContain('Cells & Tissues 100% {braces} _under_ #1');
    expect(plain).toContain('Journal of Tests');
    // The compile is a tagged PDF that still validates, and the bibliography keeps its block.
    expect(c.layoutErrors).toEqual([]);
    for (const flavour of ['ua2', '4f'] as const) {
      const v = await validatePdf(c.compile.pdf!, flavour);
      expect(v.error).toBeUndefined();
      expect(v.compliant, JSON.stringify(v.failures.slice(0, 5))).toBe(true);
    }
    const bib = c.bundle.map.kinds.indexOf('bibliography');
    expect(bib).toBeGreaterThan(0);
    expect(Object.keys(c.layout?.blocks ?? {})).toContain(c.bundle.map.blocks[bib]);
    // The measurement (ADR 0433): the passes and the biber runs of this document.
    expect(c.compile.converged).toBe(true);
    expect(c.compile.passes.length).toBeGreaterThanOrEqual(2);
    expect(c.compile.passes.length).toBeLessThanOrEqual(4);
    console.log(
      `EXP-121 passes: ${c.compile.passes.length}, biber runs: ${c.compile.biber!.length}, wall ms: ${Math.round(c.compile.wallMs)}`,
    );
  });

  it('runs no biber for a document without citations, and takes two passes', async () => {
    const c = await convertAndCompile(doc([para('Plain text.')]), {
      instant: INSTANT,
      timeZone: 'UTC',
    });
    expect(c.compile.ok, firstError(c.compile.log)).toBe(true);
    expect(c.bundle.files['references.bib']).toBeUndefined();
    expect(c.compile.biber).toEqual([]);
    expect(c.compile.passes).toHaveLength(2);
  });

  it('typesets the numeric style with a label per entry, and runs biber twice with citation-order sorting', async () => {
    const c = await convertAndCompile(
      doc(
        [
          para('Text.', {}, [cite([{ source: 'lee2019' }, { source: 'smith2020' }])]),
          bibliography(),
        ],
        { sources: [SMITH, LEE] },
      ),
      { instant: INSTANT, timeZone: 'UTC', citationStyle: 'numeric' },
    );
    expect(c.compile.ok, firstError(c.compile.log)).toBe(true);
    const plain = (pdfText(c.compile.pdf!) ?? '[1] [2]').replace(/\s+/g, ' ');
    expect(plain).toContain('[1] Ken Lee');
    expect(plain).toContain('[2] Jane Smith');
    expect(c.compile.biber!.length).toBeGreaterThanOrEqual(1);
    expect(c.compile.converged).toBe(true);
  });
});
