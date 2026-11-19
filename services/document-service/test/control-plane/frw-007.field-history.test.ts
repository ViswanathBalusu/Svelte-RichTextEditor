// FRW-007 criterion 4, over real HTTP, with in-memory storage and with PostgreSQL (lane w4).
//
// `GET /documents/{id}/history?field=<id>` returns the commits that touched that field's scope. It
// is answered from the scopes recorded with each commit: the route reads commit metadata
// (`readMeta`) and never the payload (`read`), so the log is not replayed. The grouping and the
// other filters are tested in pro-054-history-list.test.ts. Test values only.
import { type StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const INTRO = 'pIntro0000000001';
const FIELD_A = 'ffName0000000001';
const FIELD_B = 'ffDate0000000002';
const FIELD_NONE = 'ffNone0000000003';

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

type Item = { type: 'group' | 'version'; fromSeq?: number; toSeq?: number; changes?: number };

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the history of one field over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    async function appendAll(doc: string, scopes: string[][]): Promise<void> {
      const ref: DocRef = { tenant: h.tenant, doc };
      const epoch = await h.parts.ownership.claim(ref, 'frw-007-node');
      const pos = inside(documentWithRegions()['doc'], INTRO);
      for (const [i, s] of scopes.entries()) {
        h.advance(1000);
        const head = await h.parts.logs.head(ref);
        const perms = await h.parts.grants.current(ref);
        const commit: StoredCommit = {
          seq: head.seq + 1,
          id: uuid7(),
          kind: 'steps',
          steps: [
            {
              stepType: 'replace',
              from: pos,
              to: pos,
              slice: { content: [{ type: 'text', text: `c${i}` }] },
            },
          ] as StoredCommit['steps'],
          user: 'u-alice',
          session: 'session-alice',
          time: h.now(),
          origin: 'input',
          scopes: s,
          revision: perms.revision,
          cdm: 1,
          engine: 'pm-steps/1',
          retired: [],
          claimed: [],
        };
        const r = await h.parts.logs.append(ref, {
          epoch,
          revision: perms.revision,
          fromSeq: head.seq + 1,
          commits: [commit],
        });
        expect(r.status).toBe('ok');
      }
    }

    it.skipIf(skip)(
      'lists the commits of one field from the recorded scopes, without reading a payload',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        // 1 body, 2 field A, 3 fields A and B, 4 field B, 5 body.
        await appendAll(doc, [
          ['body'],
          [`field:${FIELD_A}`],
          [`field:${FIELD_A}`, `field:${FIELD_B}`],
          [`field:${FIELD_B}`],
          ['body'],
        ]);
        const owner = h.userToken({ [doc]: 'owner' });
        const url = (q: string) => `/v1/documents/${doc}/history${q}`;

        // Reads of the log are counted. The head document is rebuilt once per request for the
        // visibility gate (ADR 0019), whatever the filter; the filter itself reads no payload.
        const logs = h.parts.logs as unknown as {
          read: (...a: unknown[]) => Promise<unknown>;
          readMeta: (...a: unknown[]) => Promise<unknown>;
        };
        const original = { read: logs.read.bind(logs), readMeta: logs.readMeta.bind(logs) };
        const calls = { read: 0, readMeta: 0 };
        logs.read = (...a) => {
          calls.read++;
          return original.read(...a);
        };
        logs.readMeta = (...a) => {
          calls.readMeta++;
          return original.readMeta(...a);
        };
        const measure = async (query: string) => {
          calls.read = 0;
          calls.readMeta = 0;
          const r = await h.call('GET', url(query), { token: owner });
          expect(r.status, r.text).toBe(200);
          return { items: (r.json as { items: Item[] }).items, ...calls };
        };
        try {
          const all = await measure('');
          const a = await measure(`?field=${FIELD_A}`);
          expect(a.items.reduce((n, i) => n + (i.changes ?? 0), 0)).toBe(2);
          // The commits 2 and 3 are in one run, newest first: one group from 2 to 3.
          expect(a.items.map((i) => [i.fromSeq, i.toSeq])).toEqual([[2, 3]]);
          const b = await measure(`?field=${FIELD_B}`);
          expect(b.items.reduce((n, i) => n + (i.changes ?? 0), 0)).toBe(2);
          expect(b.items.map((i) => [i.fromSeq, i.toSeq])).toEqual([[3, 4]]);
          // The commits come from the metadata, and the filter adds no read of the log.
          expect(a.readMeta).toBe(1);
          expect(b.readMeta).toBe(1);
          expect(a.read).toBeLessThanOrEqual(all.read);
          expect(b.read).toBeLessThanOrEqual(all.read);
        } finally {
          logs.read = original.read;
          logs.readMeta = original.readMeta;
        }

        // A field that no commit ever named does not exist for the reader: not_found.
        const none = await h.call('GET', url(`?field=${FIELD_NONE}`), { token: owner });
        expect(none.status).toBe(404);
      },
    );
  });
}

