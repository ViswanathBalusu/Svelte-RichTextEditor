/**
 * `fmt` suggestions and unverifiable marks in the settled export (EXP-081 criteria 1, 2 and 4;
 * Node.js only). Nothing here compiles: the main.tex of the converter is compared with the main.tex
 * of the same document written by hand, with the suggestion settled. The definition of a mark that
 * "cannot be verified" is proposed in docs/adr/0370-w2-exp-081-unverifiable-suggestion-marks.md.
 */
import { describe, expect, it } from 'vitest';
import { doc, para, run, type J } from '../test/docs.ts';
import { delMark, markedPara, printed, tableOf, text } from '../test/suggestions.ts';
import { settleSuggestions } from './suggestions.ts';

const P1 = 'pAAAAAAAAAAAAAAA';
const P2 = 'pBBBBBBBBBBBBBBB';

function fmtMark(n: number, before: J | null): J {
  return {
    type: 'fmt',
    attrs: { id: `sTestFmt${String(n).padStart(8, '0')}`, user: 'alice', before },
  };
}

type Mode = 'accept' | 'reject' | 'markup';

const mainTex = async (body: J[], suggestions?: Mode): Promise<string | undefined> =>
  (await run(doc(structuredClone(body)), suggestions ? { suggestions } : {})).files['main.tex'];

/** A paragraph with one bold run: the bold is suggested, and the text had no mark before. */
const suggestedBold = (): J[] => [
  para('', { id: P1 }, [
    text('Plain '),
    text('suggested bold', [{ type: 'bold' }, fmtMark(1, { marks: [] })]),
    text(' and more.'),
  ]),
];

const children = (node: unknown): J[] => (node as { content: J[] }).content;

describe('EXP-081 fmt suggestions of text', () => {
  it('accept shows the suggested formatting; reject gives back the recorded formatting', async () => {
    const accepted = await mainTex(suggestedBold(), 'accept');
    const rejected = await mainTex(suggestedBold(), 'reject');
    const bold = await mainTex([
      para('', { id: P1 }, [
        text('Plain '),
        text('suggested bold', [{ type: 'bold' }]),
        text(' and more.'),
      ]),
    ]);
    const plain = await mainTex([
      para('', { id: P1 }, [text('Plain '), text('suggested bold'), text(' and more.')]),
    ]);
    expect(accepted).toBe(bold);
    expect(rejected).toBe(plain);
    expect(rejected).not.toBe(accepted);
  });

  it('reject puts the recorded marks in place of the formatting marks and keeps the link', () => {
    const body: J[] = [
      para('', { id: P1 }, [
        text('x', [
          { type: 'bold' },
          { type: 'link', attrs: { href: 'https://example.org/' } },
          fmtMark(2, { marks: [{ type: 'italic' }] }),
        ]),
      ]),
    ];
    const out = settleSuggestions(doc(body).doc as never, 'reject', []);
    const body0 = children(out).find((n) => n.type === 'body')!;
    const marks = (children(children(body0)[0])[0] as unknown as { marks: J[] }).marks;
    const types = marks.map((m) => m['type']);
    expect(types).toContain('italic');
    expect(types).toContain('link');
    expect(types).not.toContain('bold');
    expect(types).not.toContain('fmt');
  });

  it('accept and markup leave the marks as they are', () => {
    const src = doc(suggestedBold()).doc as never;
    expect(settleSuggestions(src, 'accept', [])).toBe(src);
    expect(settleSuggestions(src, 'markup', [])).toBe(src);
  });

  it('a fmt that records no before is left as it is under reject', () => {
    const body: J[] = [para('', { id: P1 }, [text('x', [{ type: 'bold' }, fmtMark(3, null)])])];
    const src = doc(body).doc as never;
    expect(settleSuggestions(src, 'reject', [])).toBe(src);
  });

  it('does not change the document it reads', () => {
    const env = doc(suggestedBold());
    const before = JSON.stringify(env);
    settleSuggestions(env.doc as never, 'reject', []);
    expect(JSON.stringify(env)).toBe(before);
  });
});

describe('EXP-081 fmt suggestions of blocks', () => {
  const aligned = (align: string, marks: J[] = []): J[] => [
    { ...para('Centred or not.', { id: P2, align }), ...(marks.length ? { marks } : {}) },
  ];

  it('reject gives back the recorded alignment; accept keeps the suggested one', async () => {
    const suggested = aligned('center', [fmtMark(4, { attrs: { align: 'start' } })]);
    const rejected = await mainTex(suggested, 'reject');
    const accepted = await mainTex(suggested, 'accept');
    expect(rejected).toBe(await mainTex(aligned('start')));
    expect(accepted).toBe(await mainTex(aligned('center')));
    expect(rejected).not.toBe(accepted);
  });

  it('reject drops the settled fmt from a table row and gives back its recorded attributes', () => {
    const t = tableOf([{ cells: ['a'], marks: [fmtMark(5, { attrs: { style: null } })] }]);
    const out = settleSuggestions(doc([t]).doc as never, 'reject', []);
    const table = children(out).find((n) => n.type === 'body') ?? children(out)[0];
    const row = children(children(table)[0])[0]! as unknown as J;
    expect(row['marks']).toBeUndefined();
  });
});

describe('EXP-081 a mark that cannot be verified', () => {
  /** A deletion mark with no author. */
  const noAuthor: J = { type: 'del', attrs: { id: 'sTestDel00000099' } };
  const noId: J = { type: 'del', attrs: { user: 'alice' } };

  it('keeps a paragraph whose deletion has no author under accept, and names the block', async () => {
    const unverified = { ...markedPara('Unverified struck paragraph.', [noAuthor]) } as J;
    unverified['attrs'] = { id: P2, suggest: [noAuthor] };
    const body = [para('Before.'), unverified, markedPara('Verified struck.', [delMark(6)])];
    const bundle = await run(doc(body), { suggestions: 'accept' });
    expect(printed(bundle)).toContain('Unverified struck paragraph.');
    expect(printed(bundle)).not.toContain('Verified struck.');
    const d = bundle.diagnostics.find((x) => x.code === 'suggestion_unverified');
    expect(d?.severity).toBe('warning');
    expect(d?.blockId).toBe(P2);
  });

  it('keeps a run, a row and a table with such a mark, and an insertion under reject', async () => {
    const noUserIns: J = { type: 'ins', attrs: { id: 'sTestIns00000098' } };
    const body = [
      para('', { id: P1 }, [text('kept run', [noId]), text(' gone', [delMark(1)])]),
      tableOf([
        { cells: ['row kept'], marks: [noId] },
        { cells: ['row gone'], marks: [delMark(2)] },
      ]),
      tableOf([{ cells: ['table kept'] }], [noId]),
      markedPara('Inserted, unverified.', [noUserIns]),
    ];
    const accepted = await run(doc(structuredClone(body)), { suggestions: 'accept' });
    const text1 = printed(accepted);
    expect(text1).toContain('kept run');
    expect(text1).not.toContain(' gone');
    expect(text1).toContain('row kept');
    expect(text1).not.toContain('row gone');
    expect(text1).toContain('table kept');
    expect(accepted.diagnostics.filter((x) => x.code === 'suggestion_unverified').length).toBe(4);
    const rejected = await run(doc(structuredClone(body)), { suggestions: 'reject' });
    expect(printed(rejected)).toContain('Inserted, unverified.');
  });
});
