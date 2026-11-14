// EXP-082: an export that would ship unreviewed suggestions is refused before a job exists, and
// the refusal is an RFC 9457 problem with the code `pending_suggestions` (09 §10; 05 §5.8, §6.2).
// Lane U-EXP-081-096. Runs over real HTTP on the memory store and on PostgreSQL (the job count is
// read from the `jobs` table of the test database, with the schema owner's pool).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** A document with one insertion, so that it has an unresolved suggestion. */
function withSuggestion(): Record<string, unknown> {
  const c = documentWithRegions() as {
    doc: { content: Array<{ content: Array<{ content?: unknown[] }> }> };
  };
  c.doc.content[1]!.content[0]!.content = [
    { type: 'text', text: 'Hello' },
    {
      type: 'text',
      text: ' there',
      marks: [{ type: 'ins', attrs: { id: 'sSugg00000000004', user: 'alice' } }],
    },
  ];
  return c;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`EXP-082 pending suggestions refusal (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { views: FULL_VIEWS });
    });
    afterAll(async () => {
      await h?.close();
    });

    /** Export jobs of one document, read from the PostgreSQL `jobs` table (memory: not counted). */
    async function exportJobCount(doc: string): Promise<number | null> {
      if (!h.db) return null;
      const r = await h.db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND doc_id = $2 AND kind = $3`,
        [h.tenant, doc, 'export'],
      );
      return r.rows[0]!.n;
    }

    it.skipIf(skip)(
      'refuses an undecided export with pending_suggestions as an RFC 9457 problem, and creates no job (EXP-082 criteria 1 and 4)',
      async () => {
        const doc = await h.createDocument({ content: withSuggestion() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const before = await exportJobCount(doc);
        const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: viewer,
          body: { target: 'pdf' },
        });
        expect(r.status).toBe(409);
        expect(r.headers.get('content-type')).toContain('application/problem+json');
        expect(r.json).toMatchObject({
          type: 'about:blank',
          title: expect.any(String),
          status: 409,
          code: 'pending_suggestions',
        });
        expect(typeof r.json.detail).toBe('string');
        const after = await exportJobCount(doc);
        if (before !== null) expect(after).toBe(before);
      },
    );

    it.skipIf(skip)(
      'accepts an export of a document without unresolved suggestions when options.suggestions is missing (EXP-082 criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: viewer,
          body: { target: 'pdf' },
        });
        expect(r.status).toBe(202);
        expect(r.json).toMatchObject({ doc, state: 'queued' });
      },
    );

    it.skipIf(skip)(
      'accepts the decisions accept, reject and markup for the same document (EXP-082 criterion 2)',
      async () => {
        const doc = await h.createDocument({ content: withSuggestion() });
        const viewer = h.userToken({ [doc]: 'viewer' });
        for (const suggestions of ['accept', 'reject', 'markup']) {
          const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
            token: viewer,
            body: { target: 'pdf', options: { suggestions } },
          });
          expect(r.status, suggestions).toBe(202);
        }
      },
    );
  });
}
