/**
 * SEC-029 criterion 4, the event half (10 §3.3 "forging history"; 08 §12; 05 §7): each
 * `dep.document.changed` the service raises for a content change carries the chain head of the
 * log at the `seq` it names.
 *
 * The real service runs with memory storage and with PostgreSQL, and a sink records the events it
 * raises. The content is replaced (`PUT /documents/{id}/content`) and the document is then
 * restored to its first state (`POST /documents/{id}/restore`); the second event of the same
 * document is held by the debounce of 05 §7 and arrives within its window. For each event the
 * chain head is compared with the head the log store reports and, on PostgreSQL, with the `hash`
 * column of the commit row at that `seq`, read by the schema owner; the stored chain verifies.
 *
 * The export half of the criterion is services/export-worker/src/sec-029-manifest-chain-head.pg.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgLogStore } from '@docedit/document-service';
import type {
  DepEvent,
  EventSink,
} from '../../../services/document-service/src/control-plane/events.ts';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const CHANGED = 'dep.document.changed.v1';

/** The document with its first text node replaced, as a host would send new content. */
function edited(text: string): Record<string, unknown> {
  const env = structuredClone(documentWithRegions());
  const walk = (n: unknown): boolean => {
    if (n === null || typeof n !== 'object') return false;
    const o = n as Record<string, unknown>;
    if (typeof o['text'] === 'string') {
      o['text'] = text;
      return true;
    }
    return Object.values(o).some(walk);
  };
  walk(env['doc']);
  return env;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-029 dep.document.changed carries the chain head (${storage})`, () => {
    let h: Harness;
    const events: DepEvent[] = [];
    const sink: EventSink = { emit: (e) => void events.push(structuredClone(e)) };
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { events: sink });
    });
    afterAll(async () => {
      await h?.close();
    });

    (skip ? it.skip : it)(
      'names the head of the stored chain for a replaced content and for a restore',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const ref = { tenant: h.a.id, doc };
        const changes = () => events.filter((e) => e.subject === doc && e.type === CHANGED);
        const content = () => h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
        const first = await content();
        const firstSeq = first.json.seq as number;

        /** Checks one event against the store and, on PostgreSQL, against the commit row. */
        const check = async (event: DepEvent, headSeq: number) => {
          expect(event.tenant).toBe(h.a.id);
          expect(event.data['seq']).toBe(headSeq);
          expect(event.data['chainHead']).toMatch(/^[0-9a-f]{64}$/);
          const state = await h.parts.logs.state!(ref);
          expect(state.seq).toBe(headSeq);
          expect(event.data['chainHead']).toBe(state.chainHead);
          if (h.db) {
            const row = await h.db.admin.query<{ hash: string }>(
              "SELECT encode(hash, 'hex') AS hash FROM doc_commits WHERE doc_id = $1 AND seq = $2",
              [doc, headSeq],
            );
            expect(row.rows).toHaveLength(1);
            expect(event.data['chainHead']).toBe(row.rows[0]!.hash);
          }
        };

        // A replaced content: the event is raised at once.
        const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.a.apiKey,
          body: edited('SEC-029 replaced'),
          headers: { 'If-Match': first.headers.get('etag')! },
        });
        expect(put.status, put.text).toBe(204);
        const afterPut = (await content()).json.seq as number;
        expect(afterPut).toBeGreaterThan(firstSeq);
        expect(changes()).toHaveLength(1);
        await check(changes()[0]!, afterPut);

        // A restore to the first state: a second change of the same document, held by the
        // debounce and raised when its window ends.
        const restore = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: h.a.apiKey,
          body: { toSeq: firstSeq },
        });
        expect(restore.status, restore.text).toBeLessThan(300);
        const afterRestore = (await content()).json.seq as number;
        expect(afterRestore).toBeGreaterThan(afterPut);
        const started = Date.now();
        while (changes().length < 2 && Date.now() - started < 20_000)
          await new Promise((done) => setTimeout(done, 250));
        expect(changes(), 'the change of the restore').toHaveLength(2);
        await check(changes()[1]!, afterRestore);
        expect(changes()[1]!.data['chainHead']).not.toBe(changes()[0]!.data['chainHead']);

        if (h.db) {
          const verdict = await (h.parts.logs as unknown as PgLogStore).verify(ref);
          expect(verdict).toEqual({ ok: true, head: afterRestore });
        }
      },
      60_000,
    );
  });
}
