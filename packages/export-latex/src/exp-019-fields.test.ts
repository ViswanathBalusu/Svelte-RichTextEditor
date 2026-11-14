/**
 * Page, reference, sequence and date fields (Node.js only): EXP-019 criteria 1 to 6. The tests read
 * main.tex of the converter's bundle through `blockLines`, and the house class source for the
 * last-page reference. Nothing compiles: the numbers printed in the PDF are not inspected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dateFieldText } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';

const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');
const MAIN = 'main.tex';
const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

/** An inline field node. */
const field = (attrs: J): J => ({ type: 'field', attrs: { id: nid('f'), ...attrs } });

/** The printed text of a paragraph: its lines of main.tex, joined. */
const printed = (lines: string[]): string => lines.join('\n');

/** A decimal numbering whose level 0 prints `%1.`. */
const numbering = (id: string): J => ({
  type: 'numbering_def',
  attrs: { id, levels: [{ format: 'decimal', text: '%1.', start: 1 }] },
});

/** Counter commands that would print a number from TeX rather than from the shared algorithm. */
const COUNTER =
  /\\(arabic|alph|Alph|roman|Roman|value|the|stepcounter|refstepcounter|setcounter|addtocounter|thepage)\b/;

describe('EXP-019 criterion 1: a page field prints the current page and a pageCount field the last page', () => {
  it('writes \\DEpage for a page field and \\DEpages for a pageCount field', async () => {
    const p = para('Page ', {}, [field({ kind: 'page' })]);
    const q = para('of ', {}, [field({ kind: 'pageCount' })]);
    const bundle = await run(doc([p, q]));
    expect(printed(blockLines(bundle, idOf(p)))).toContain('\\DEpage');
    expect(printed(blockLines(bundle, idOf(q)))).toContain('\\DEpages');
  });

  it('defines \\DEpages as the last-page reference, set after the last page (class audit)', () => {
    expect(CLASS).toMatch(/\\newcommand\*\\DEpages\{\\PreviousTotalPages\}/);
    expect(CLASS).toMatch(/\\AddToHook\{enddocument\/afterlastpage\}/);
  });
});

describe('EXP-019 criterion 2: a ref field prints a page reference or the literal label, as its format says', () => {
  it('prints the literal label of a numbered target when the format is not a page format', async () => {
    const target = para('Introduction', { numbering: { numberingId: 'n', level: 0, listId: 'L' } });
    const ref = para('See ', {}, [
      field({ kind: 'ref', target: `node:${idOf(target)}`, format: 'label' }),
    ]);
    const bundle = await run(doc([target, ref], { numberings: [numbering('n')] }));
    const lines = printed(blockLines(bundle, idOf(ref)));
    expect(lines).toMatch(/\\DEa\{\d+\}\{1\.\}%/);
    expect(lines).not.toContain('\\DEpref');
  });

  it('prints the label of the block that holds a bookmark, and a page reference for a page format', async () => {
    const target = para(
      'Introduction',
      { numbering: { numberingId: 'n', level: 0, listId: 'L' } },
      [{ type: 'anchor', attrs: { id: nid('a'), name: 'bm1' } }],
    );
    const ref = para('See ', {}, [field({ kind: 'ref', target: 'bookmark:bm1', format: 'label' })]);
    const pageRef = para('On page ', {}, [
      field({ kind: 'ref', target: 'bookmark:bm1', format: 'pageNumber' }),
    ]);
    const bundle = await run(doc([target, ref, pageRef], { numberings: [numbering('n')] }));
    expect(printed(blockLines(bundle, idOf(ref)))).toMatch(/\\DEr\{\d+\}\{See \}/);
    expect(printed(blockLines(bundle, idOf(ref)))).toMatch(
      /\\DEr\{\d+\}\{See \}%\n\\DEa\{\d+\}\{1\.\}%/,
    );
    expect(printed(blockLines(bundle, idOf(pageRef)))).toMatch(/\\DEpref\{[^}]+\}/);
  });

  it('prints a page reference through \\DEpref when the format names a page', async () => {
    const target = para('Introduction', { numbering: { numberingId: 'n', level: 0, listId: 'L' } });
    const ref = para('On page ', {}, [
      field({ kind: 'ref', target: `node:${idOf(target)}`, format: 'pageNumber' }),
    ]);
    const bundle = await run(doc([target, ref], { numberings: [numbering('n')] }));
    expect(printed(blockLines(bundle, idOf(ref)))).toMatch(/\\DEpref\{[^}]+\}/);
  });

  it('prints the literal label of a numbered heading, and a page reference for a page format', async () => {
    // A heading style (outline level 1) numbered through its style: "Chapter 1", "Chapter 2".
    const h1: J = {
      type: 'style_def',
      attrs: {
        id: 'H1',
        kind: 'paragraph',
        name: 'Heading 1',
        builtIn: true,
        outlineLevel: 1,
        numbering: { numberingId: 'hn', level: 0, listId: 'hl' },
      },
    };
    const chapters: J = {
      type: 'numbering_def',
      attrs: { id: 'hn', levels: [{ format: 'decimal', text: 'Chapter %1', start: 1 }] },
    };
    const first = para('Introduction', { style: 'H1' });
    const second = para('Method', { style: 'H1' });
    const ref = para('See ', {}, [
      field({ kind: 'ref', target: `node:${idOf(second)}`, format: 'label' }),
    ]);
    const pageRef = para('On page ', {}, [
      field({ kind: 'ref', target: `node:${idOf(second)}`, format: 'pageNumber' }),
    ]);
    const bundle = await run(
      doc([first, second, ref, pageRef], { styles: [h1], numberings: [chapters] }),
    );
    // The target is set as a heading (\DEh), so this is a ref to a heading, not to a list item.
    expect(printed(blockLines(bundle, idOf(second)))).toMatch(/^\\DEh\{/);
    expect(printed(blockLines(bundle, idOf(ref)))).toMatch(
      /\\DEr\{\d+\}\{See \}%\n\\DEa\{\d+\}\{Chapter 2\}%/,
    );
    expect(printed(blockLines(bundle, idOf(pageRef)))).toMatch(/\\DEpref\{[^}]+\}/);
    expect(printed(blockLines(bundle, idOf(pageRef)))).not.toContain('Chapter 2');
  });

  it('prints the literal number of a caption sequence, the second caption printing 2', async () => {
    const first = para('Figure ', {}, [field({ kind: 'seq', name: 'Figure' })]);
    const second = para('Figure ', {}, [field({ kind: 'seq', name: 'Figure' })]);
    const ref = para('See ', {}, [
      field({ kind: 'ref', target: `node:${idOf(second)}`, format: 'label' }),
    ]);
    const bundle = await run(doc([first, second, ref]));
    expect(printed(blockLines(bundle, idOf(ref)))).toMatch(
      /\\DEr\{\d+\}\{See \}%\n\\DEa\{\d+\}\{2\}%/,
    );
    expect(bundle.diagnostics.map((d) => d.code)).not.toContain('ref_unresolved');
  });

  it('prints the number of a labelled equation, the second numbered equation printing 2', async () => {
    const eq = (label: string): J => ({
      type: 'equation_block',
      attrs: { id: nid('e'), latex: 'x^2', numbered: true, label },
    });
    const ref = para('See ', {}, [field({ kind: 'ref', target: 'eq:second', format: 'label' })]);
    const bundle = await run(doc([eq('first'), eq('second'), ref]));
    expect(printed(blockLines(bundle, idOf(ref)))).toMatch(
      /\\DEr\{\d+\}\{See \}%\n\\DEa\{\d+\}\{2\}%/,
    );
  });
});

describe('EXP-019 criterion 3: sequence labels are the literal shared text, with no TeX counter', () => {
  it('prints the seq labels of a caption paragraph in order and uses no counter command', async () => {
    const caption = para('Figure ', {}, [
      field({ kind: 'seq', name: 'Figure' }),
      field({ kind: 'seq', name: 'Figure' }),
    ]);
    const ref = para('See ', {}, [
      field({ kind: 'ref', target: `node:${idOf(caption)}`, format: 'label' }),
    ]);
    const bundle = await run(doc([caption, ref]));
    const cap = printed(blockLines(bundle, idOf(caption)));
    // Each seq field prints its own label as literal text, in order (\DEa{offset}{label}).
    expect(cap).toMatch(/\\DEa\{\d+\}\{1\}%\n\\DEa\{\d+\}\{2\}%/);
    expect(cap).not.toMatch(/\\DEa\{\d+\}\{[^}]*\\/);
    expect(printed(blockLines(bundle, idOf(ref)))).toMatch(/\\DEr\{\d+\}\{See \}/);
    expect(bundle.files[MAIN]!).not.toMatch(COUNTER);
  });
});

describe('EXP-019 criterion 4: a date field prints the server date at job creation in the job time zone', () => {
  it('prints the date of the job instant in the job time zone, not the one in the local clock', async () => {
    // 23:30 UTC on 13 November is already 14 November in Tokyo and still 13 November in New York.
    const instant = '2026-11-13T23:30:00.000Z';
    const tokyo = await run(doc([para('Date ', {}, [field({ kind: 'date' })])]), {
      instant,
      timeZone: 'Asia/Tokyo',
    });
    const newYork = await run(doc([para('Date ', {}, [field({ kind: 'date' })])]), {
      instant,
      timeZone: 'America/New_York',
    });
    // Without a format the model's default, yyyy-MM-dd, is printed.
    const tokyoText = dateFieldText({ instant, timeZone: 'Asia/Tokyo' });
    const nyText = dateFieldText({ instant, timeZone: 'America/New_York' });
    expect(tokyoText).toBe('2026-11-14');
    expect(nyText).toBe('2026-11-13');
    expect(tokyoText).not.toBe(nyText);
    expect(tokyo.files[MAIN]!).toContain(tokyoText);
    expect(newYork.files[MAIN]!).toContain(nyText);
  });

  it('refuses to print a date field without a job instant (no date is invented)', async () => {
    const bundle = await run(doc([para('Date ', {}, [field({ kind: 'date' })])]));
    expect(bundle.diagnostics.map((d) => d.code)).toContain('date_without_job_time');
  });
});

describe('EXP-019 criterion 5: a cached date from the request or the stored value is never printed', () => {
  it('prints the server date and ignores a cached date that differs from it', async () => {
    const instant = '2026-11-13T12:00:00.000Z';
    const cached = '1999-01-01';
    const p = para('Date ', {}, [field({ kind: 'date', cached })]);
    const bundle = await run(doc([p]), { instant, timeZone: 'UTC' });
    const expected = dateFieldText({ instant, timeZone: 'UTC' });
    expect(expected).toBe('2026-11-13');
    expect(printed(blockLines(bundle, idOf(p)))).toContain(expected);
    expect(bundle.files[MAIN]!).not.toContain(cached);
  });
});

describe('EXP-019 criterion 6: a field the converter can compute ignores its cached text', () => {
  it('prints the computed page field and never the cached text', async () => {
    const p = para('Page ', {}, [field({ kind: 'page', cached: 'STALE-PAGE-9' })]);
    const bundle = await run(doc([p]));
    const lines = printed(blockLines(bundle, idOf(p)));
    expect(lines).toContain('\\DEpage');
    expect(bundle.files[MAIN]!).not.toContain('STALE-PAGE-9');
  });

  it('prints the computed label of a ref field and never the cached text', async () => {
    const target = para('Intro', { numbering: { numberingId: 'n', level: 0, listId: 'L' } });
    const ref = para('See ', {}, [
      field({ kind: 'ref', target: `node:${idOf(target)}`, format: 'label', cached: 'STALE-REF' }),
    ]);
    const bundle = await run(doc([target, ref], { numberings: [numbering('n')] }));
    expect(printed(blockLines(bundle, idOf(ref)))).toContain('1.');
    expect(bundle.files[MAIN]!).not.toContain('STALE-REF');
  });
});
