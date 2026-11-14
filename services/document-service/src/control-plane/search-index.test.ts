// Text extraction after checkpoints and the tenant-scoped index (BE-054 criteria 1 to 4, in the
// in-memory index; criterion 2's route, criterion 1's PostgreSQL tables and criterion 5's job are
// not built here). Property runs use fast-check.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonNode } from '@docedit/model';
import { extractSearchText, SearchIndex, searchTokens } from './search-index.ts';

const WORDS = ['alpha', 'beta', 'gamma', 'budget', 'report', 'quarterly'] as const;
const wordArb = fc.constantFrom(...WORDS);
const phraseArb = fc.array(wordArb, { minLength: 1, maxLength: 6 }).map((ws) => ws.join(' '));

const para = (text: string): JsonNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const docOf = (...texts: string[]): JsonNode => ({
  type: 'doc',
  content: texts.map(para),
});

describe('text is extracted after checkpoints (BE-054 criterion 1 and 4)', () => {
  it('takes one string per block, in document order, however the block is split into text nodes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(phraseArb, fc.array(fc.nat(), { maxLength: 4 })), {
          minLength: 1,
          maxLength: 5,
        }),
        (blocks) => {
          // Each block's text is cut at arbitrary points into text nodes with alternating marks.
          const doc: JsonNode = {
            type: 'doc',
            content: blocks.map(([text, cuts]) => {
              const at = [...new Set(cuts.map((c) => c % text.length))]
                .filter((c) => c > 0)
                .sort((a, b) => a - b);
              const pieces = [0, ...at].map((from, i) => text.slice(from, at[i] ?? text.length));
              return {
                type: 'paragraph',
                content: pieces.map((t, i) =>
                  i % 2 === 1
                    ? { type: 'text', text: t, marks: [{ type: 'bold' }] }
                    : { type: 'text', text: t },
                ),
              };
            }),
          };
          expect(extractSearchText(doc)).toEqual(blocks.map(([text]) => text));
        },
      ),
    );
  });

  it('keeps a word split by a mark or a tracked insertion as one token, and finds it', () => {
    const doc: JsonNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'He', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'llo wor' },
            { type: 'text', text: 'l', marks: [{ type: 'insertion', attrs: { id: 's1' } }] },
            { type: 'text', text: 'd' },
          ],
        },
      ],
    };
    expect(extractSearchText(doc)).toEqual(['Hello world']);
    const idx = new SearchIndex();
    idx.indexCheckpoint({ tenant: 't', doc: 'd', seq: 1, visibility: 'full', content: doc });
    expect(idx.search('t', 'hello', { readable: 'all', limit: 5 })).toEqual([
      { doc: 'd', seq: 1, score: 1 },
    ]);
    expect(idx.search('t', 'world', { readable: 'all', limit: 5 })).toEqual([
      { doc: 'd', seq: 1, score: 1 },
    ]);
    expect(idx.search('t', 'he', { readable: 'all', limit: 5 })).toEqual([]);
    expect(idx.search('t', 'llo', { readable: 'all', limit: 5 })).toEqual([]);
  });

  it('does not merge two paragraphs into one token', () => {
    const doc = docOf('Hel', 'lo');
    expect(extractSearchText(doc)).toEqual(['Hel', 'lo']);
    const idx = new SearchIndex();
    idx.indexCheckpoint({ tenant: 't', doc: 'd', seq: 1, visibility: 'full', content: doc });
    expect(idx.search('t', 'hello', { readable: 'all', limit: 5 })).toEqual([]);
    expect(idx.search('t', 'hel lo', { readable: 'all', limit: 5 }).map((h) => h.doc)).toEqual([
      'd',
    ]);
  });

  it('ends a run at a break, a tab, an atom, a footnote and preserved text, but not at an anchor', () => {
    const text = (t: string): JsonNode => ({ type: 'text', text: t });
    const doc: JsonNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            text('one'),
            { type: 'break', attrs: { kind: 'line' } },
            text('two'),
            { type: 'tab' },
            text('three'),
            { type: 'image', attrs: { src: 'asset:1' } },
            text('four'),
            { type: 'footnote', content: [para('note')] },
            text('fi'),
            { type: 'anchor', attrs: { id: 'b1' } },
            text('ve'),
            { type: 'text', text: 'hidden', marks: [{ type: 'preserved' }] },
            text('six'),
          ],
        },
      ],
    };
    expect(extractSearchText(doc)).toEqual(['one', 'two', 'three', 'four', 'note', 'five', 'six']);
  });

  it('never extracts text inside preserved content (ADR 0017)', () => {
    fc.assert(
      fc.property(phraseArb, (secret) => {
        const doc: JsonNode = {
          type: 'doc',
          content: [
            {
              type: 'preserved_block',
              attrs: { payload: 'x' },
              content: [{ type: 'text', text: secret }],
            },
            {
              type: 'paragraph',
              attrs: { preserved: { k: 1 } },
              content: [{ type: 'text', text: secret }],
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: secret, marks: [{ type: 'preserved' }] }],
            },
            {
              type: 'paragraph',
              content: [
                { type: 'preserved_inline', attrs: {}, content: [{ type: 'text', text: secret }] },
              ],
            },
          ],
        };
        expect(extractSearchText(doc)).toEqual([]);
      }),
    );
  });

  it('keeps hostile text as plain data: nothing is parsed, executed or fetched', () => {
    const hostile = '<img src="http://169.254.169.254/" onerror="alert(1)"> \u0000 {{ $eval }}';
    const out = extractSearchText(docOf(hostile));
    expect(out).toEqual([hostile]);
    // The tokens are letters and digits only; the markup adds nothing to the index.
    expect(searchTokens(hostile)).toEqual([
      'img',
      'src',
      'http',
      '169',
      '254',
      '169',
      '254',
      'onerror',
      'alert',
      '1',
      'eval',
    ]);
  });

  it('walks a deeply nested document without exhausting the stack', () => {
    let node: JsonNode = { type: 'text', text: 'deep' };
    for (let i = 0; i < 20000; i++) node = { type: 'blockquote', content: [node] };
    expect(extractSearchText({ type: 'doc', content: [node] })).toEqual(['deep']);
  });
});

describe('the index is tenant scoped and holds classes apart (BE-054 criterion 2 in the index)', () => {
  it('returns only the tenant’s documents, whatever the tenants hold', () => {
    fc.assert(
      fc.property(phraseArb, phraseArb, (a, b) => {
        const idx = new SearchIndex();
        idx.indexCheckpoint({
          tenant: 't1',
          doc: 'd-a',
          seq: 1,
          visibility: 'full',
          content: docOf(a),
        });
        idx.indexCheckpoint({
          tenant: 't2',
          doc: 'd-b',
          seq: 1,
          visibility: 'full',
          content: docOf(a, b),
        });
        const hits = idx.search('t1', a, { readable: 'all', limit: 10 });
        expect(hits.map((h) => h.doc)).toEqual(['d-a']);
        expect(
          idx.search('t1', b, { readable: 'all', limit: 10 }).every((h) => h.doc !== 'd-b'),
        ).toBe(true);
      }),
    );
  });

  it('returns a document only through a class the principal may read (ADR 0019, SR-M5)', () => {
    fc.assert(
      fc.property(phraseArb, fc.boolean(), (text, canReadRestricted) => {
        const idx = new SearchIndex();
        idx.indexCheckpoint({
          tenant: 't',
          doc: 'd',
          seq: 3,
          visibility: 'hidden-region-a',
          content: docOf(text),
        });
        idx.indexCheckpoint({
          tenant: 't',
          doc: 'd',
          seq: 3,
          visibility: 'full',
          content: docOf('public note'),
        });
        const readable = canReadRestricted
          ? new Set(['hidden-region-a', 'full'])
          : new Set(['full']);
        const hits = idx.search('t', text, { readable, limit: 5 });
        expect(hits.length === 1).toBe(canReadRestricted);
        if (!canReadRestricted) expect(hits).toEqual([]);
      }),
    );
  });

  it('does not let a lower sequence replace a higher one for the same class', () => {
    const idx = new SearchIndex();
    expect(
      idx.indexCheckpoint({
        tenant: 't',
        doc: 'd',
        seq: 5,
        visibility: 'full',
        content: docOf('newer'),
      }),
    ).toBe(true);
    expect(
      idx.indexCheckpoint({
        tenant: 't',
        doc: 'd',
        seq: 4,
        visibility: 'full',
        content: docOf('older'),
      }),
    ).toBe(false);
    expect(idx.search('t', 'newer', { readable: 'all', limit: 1 })).toEqual([
      { doc: 'd', seq: 5, score: 1 },
    ]);
    expect(idx.search('t', 'older', { readable: 'all', limit: 1 })).toEqual([]);
  });
});

describe('purged documents leave the index (BE-054 criterion 3, in the index)', () => {
  it('removes every entry of the purged document and no other', () => {
    fc.assert(
      fc.property(phraseArb, fc.boolean(), (a, twoClasses) => {
        const idx = new SearchIndex();
        const classes = twoClasses ? ['full', 'restricted'] : ['full'];
        for (const visibility of classes) {
          idx.indexCheckpoint({ tenant: 't', doc: 'gone', seq: 1, visibility, content: docOf(a) });
        }
        // The kept document holds a word that no generated phrase contains.
        idx.indexCheckpoint({
          tenant: 't',
          doc: 'kept',
          seq: 1,
          visibility: 'full',
          content: docOf('zulu'),
        });
        expect(idx.purgeDocument('t', 'gone')).toBe(classes.length);
        expect(idx.search('t', a, { readable: 'all', limit: 5 })).toEqual([]);
        expect(idx.search('t', 'zulu', { readable: 'all', limit: 5 }).map((h) => h.doc)).toEqual([
          'kept',
        ]);
      }),
    );
  });

  it('does not purge another tenant’s document of the same identifier', () => {
    const idx = new SearchIndex();
    idx.indexCheckpoint({
      tenant: 't1',
      doc: 'same',
      seq: 1,
      visibility: 'full',
      content: docOf('shared word'),
    });
    idx.indexCheckpoint({
      tenant: 't2',
      doc: 'same',
      seq: 1,
      visibility: 'full',
      content: docOf('shared word'),
    });
    idx.purgeDocument('t1', 'same');
    expect(idx.search('t1', 'shared', { readable: 'all', limit: 5 })).toEqual([]);
    expect(idx.search('t2', 'shared', { readable: 'all', limit: 5 }).map((h) => h.doc)).toEqual([
      'same',
    ]);
  });
});

describe('ranking is by occurrences, every term required (BE-054, ranking test)', () => {
  it('ranks by occurrence count, ties by document identifier, and requires every term', () => {
    const idx = new SearchIndex();
    idx.indexCheckpoint({
      tenant: 't',
      doc: 'b',
      seq: 1,
      visibility: 'full',
      content: docOf('budget budget report'),
    });
    idx.indexCheckpoint({
      tenant: 't',
      doc: 'a',
      seq: 1,
      visibility: 'full',
      content: docOf('budget report'),
    });
    idx.indexCheckpoint({
      tenant: 't',
      doc: 'c',
      seq: 1,
      visibility: 'full',
      content: docOf('budget only'),
    });
    const hits = idx.search('t', 'budget report', { readable: 'all', limit: 10 });
    expect(hits.map((h) => h.doc)).toEqual(['b', 'a']);
    expect(hits[0]?.score).toBe(3);
  });

  it('returns at most the limit, and throws for a limit that is not a positive integer', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (limit) => {
        const idx = new SearchIndex();
        for (let i = 0; i < 6; i++)
          idx.indexCheckpoint({
            tenant: 't',
            doc: `d${i}`,
            seq: 1,
            visibility: 'full',
            content: docOf('budget'),
          });
        expect(idx.search('t', 'budget', { readable: 'all', limit })).toHaveLength(limit);
      }),
    );
    const idx = new SearchIndex();
    expect(() => idx.search('t', 'budget', { readable: 'all', limit: 0 })).toThrow(RangeError);
    expect(() => idx.search('t', 'budget', { readable: 'all', limit: 1.5 })).toThrow(RangeError);
  });

  it('a query with no tokens returns nothing', () => {
    const idx = new SearchIndex();
    idx.indexCheckpoint({
      tenant: 't',
      doc: 'd',
      seq: 1,
      visibility: 'full',
      content: docOf('budget'),
    });
    expect(idx.search('t', ' !! ', { readable: 'all', limit: 5 })).toEqual([]);
  });
});
