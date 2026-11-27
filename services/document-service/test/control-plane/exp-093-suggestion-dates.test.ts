// EXP-093 criterion 2, the control plane's half: the date of a tracked change in a `docx` export is
// the server time of the commit that introduced the suggestion's identifier, found through the
// suggestion index. Unit tests of `suggestionDatesAt`, then over HTTP on the memory store and on
// PostgreSQL: a `docx` export with `suggestions: markup` carries the times in the job payload.
// Test values only.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  suggestionDatesAt,
  suggestionIdsOf,
} from '../../src/control-plane/export-suggestion-dates.ts';
import type { Kit } from '../../src/control-plane/kit.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const REF: DocRef = { tenant: uuid7(), doc: uuid7() };
const mark = (type: string, id: string) => ({ type, attrs: { id, user: 'user-0001' } });
const content = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { suggest: [mark('ins', 'sBlockAAAAAAAAA1')] },
      content: [
        { type: 'text', text: 'a', marks: [mark('ins', 'sOneAAAAAAAAAAA1')] },
        { type: 'text', text: 'b', marks: [mark('del', 'sTwoAAAAAAAAAAA2'), mark('bold', 'no')] },
        { type: 'text', text: 'c', marks: [mark('ins', 'sOneAAAAAAAAAAA1')] },
      ],
    },
  ],
};

describe('suggestionIdsOf', () => {
  it('lists each suggestion identifier once, from marks and from block suggestions', () => {
    expect(suggestionIdsOf(content)).toEqual([
      'sBlockAAAAAAAAA1',
      'sOneAAAAAAAAAAA1',
      'sTwoAAAAAAAAAAA2',
    ]);
    expect(suggestionIdsOf(null)).toEqual([]);
  });
});

describe('EXP-093 criterion 2: suggestionDatesAt', () => {
  const T1 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);
  const T2 = Date.UTC(2026, 10, 2, 11, 30, 15, 250);
  function logs(reads: number[]) {
    const introduced: Record<string, number> = {
      sOneAAAAAAAAAAA1: 3,
      sTwoAAAAAAAAAAA2: 3,
      sBlockAAAAAAAAA1: 9,
    };
    const rows: Record<number, number> = { 3: T1, 9: T2 };
    return {
      introducedBy: async (_r: DocRef, id: string) => introduced[id],
      readMeta: async (_r: DocRef, from: number) => {
        reads.push(from);
        return rows[from] === undefined ? [] : [{ seq: from, time: rows[from] }];
      },
    } as unknown as Kit['d']['logs'];
  }

  it('gives the server time of the introducing commit of each suggestion, as a timestamp', async () => {
    const reads: number[] = [];
    const out = await suggestionDatesAt({ logs: logs(reads) }, REF, content);
    expect(out).toEqual({
      sBlockAAAAAAAAA1: '2026-11-02T11:30:15.250Z',
      sOneAAAAAAAAAAA1: '2026-11-01T10:00:00.000Z',
      sTwoAAAAAAAAAAA2: '2026-11-01T10:00:00.000Z',
    });
    // One metadata read for each commit, not for each suggestion.
    expect(reads.sort()).toEqual([3, 9]);
  });

  it('leaves out a suggestion the index does not know and one whose commit row is gone', async () => {
    const l = logs([]);
    const unknown = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x', marks: [mark('ins', 'sNotIndexedAAAA1')] },
            { type: 'text', text: 'y', marks: [mark('ins', 'sOneAAAAAAAAAAA1')] },
          ],
        },
      ],
    };
    expect(await suggestionDatesAt({ logs: l }, REF, unknown)).toEqual({
      sOneAAAAAAAAAAA1: '2026-11-01T10:00:00.000Z',
    });
    const noRow = { ...l, readMeta: async () => [] } as unknown as Kit['d']['logs'];
    expect(await suggestionDatesAt({ logs: noRow }, REF, unknown)).toEqual({});
  });

  it('is empty when the log store keeps no suggestion index', async () => {
    expect(await suggestionDatesAt({ logs: {} as Kit['d']['logs'] }, REF, content)).toEqual({});
  });
});

const SUGGESTION = 'sSugg00000000004';

/** A document with one insertion by 'alice', as in exp-082-pending-suggestions.test.ts. */
function withSuggestion(): Record<string, unknown> {
  const c = documentWithRegions() as {
    doc: { content: Array<{ content: Array<{ content?: unknown[] }> }> };
  };
  c.doc.content[1]!.content[0]!.content = [
    { type: 'text', text: 'Hello' },
    {
      type: 'text',
      text: ' there',
      marks: [{ type: 'ins', attrs: { id: SUGGESTION, user: 'alice' } }],
    },
  ];
  return c;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`EXP-093 criterion 2 over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { config: { exportTargets: ['pdf', 'docx'] } });
    });
    afterAll(async () => {
      await h?.close();
    });

    /** Appends a commit at server time `time` that claims the suggestion, as a room would. */
    async function introduce(doc: string, time: number): Promise<number> {
      const ref: DocRef = { tenant: h.tenant, doc };
      const epoch = await h.parts.ownership.claim(ref, 'test-node');
      const head = await h.parts.logs.head(ref);
      const perms = await h.parts.grants.current(ref);
      const r = await h.parts.logs.append(ref, {
        epoch,
        revision: perms.revision,
        fromSeq: head.seq + 1,
        commits: [
          {
            seq: head.seq + 1,
            id: uuid7(),
            kind: 'steps' as const,
            steps: [] as never,
            user: 'alice',
            session: 'session-test',
            time,
            origin: 'input',
            scopes: ['body'],
            revision: perms.revision,
            cdm: 1,
            engine: 'pm-steps/1',
            retired: [],
            claimed: [SUGGESTION],
          },
        ],
      });
      if (r.status !== 'ok') throw new Error(`append refused: ${r.status}`);
      return head.seq + 1;
    }

    const exportOf = async (doc: string, target: string, suggestions: string) => {
      const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
        token: h.userToken({ [doc]: 'viewer' }),
        body: { target, options: { suggestions } },
      });
      expect(r.status, r.text).toBe(202);
      return (await h.parts.queue.get(h.tenant, r.json.id as string))!;
    };

    it.skipIf(skip)(
      'carries the server time of the introducing commit for a docx export with markup',
      async () => {
        const doc = await h.createDocument({ content: withSuggestion() });
        await introduce(doc, Date.UTC(2026, 10, 3, 9, 15, 30, 500));
        const job = await exportOf(doc, 'docx', 'markup');
        expect(job.payload['suggestionDates']).toEqual({
          [SUGGESTION]: '2026-11-03T09:15:30.500Z',
        });
      },
    );

    it.skipIf(skip)('does not carry dates for accept, reject or another target', async () => {
      const doc = await h.createDocument({ content: withSuggestion() });
      await introduce(doc, Date.UTC(2026, 10, 3));
      for (const [target, suggestions] of [
        ['docx', 'accept'],
        ['docx', 'reject'],
        ['pdf', 'markup'],
      ] as const)
        expect((await exportOf(doc, target, suggestions)).payload).not.toHaveProperty(
          'suggestionDates',
        );
    });

    it.skipIf(skip)('carries no dates for a document without suggestions', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      expect((await exportOf(doc, 'docx', 'markup')).payload).not.toHaveProperty('suggestionDates');
    });

    it.skipIf(skip)('gives another time for a suggestion introduced at another time', async () => {
      const a = await h.createDocument({ content: withSuggestion() });
      const b = await h.createDocument({ content: withSuggestion() });
      await introduce(a, Date.UTC(2026, 10, 3));
      await introduce(b, Date.UTC(2026, 10, 4));
      const ja = await exportOf(a, 'docx', 'markup');
      const jb = await exportOf(b, 'docx', 'markup');
      expect(ja.payload['suggestionDates']).not.toEqual(jb.payload['suggestionDates']);
    });
  });
}
