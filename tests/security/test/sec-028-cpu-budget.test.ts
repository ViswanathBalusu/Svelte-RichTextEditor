/**
 * SEC-028 criterion 2 (10 §3.3 "stalling or crashing a process that hosts many rooms"; 04 §12): a
 * connection whose CPU budget is spent has its next commit rejected `rate_limited` before steps 2
 * to 7 of the algorithm run.
 *
 * The real document service runs in process with memory storage and with the admission budgets of
 * the data plane set small for this file (`admission` in the data-plane settings; the service sets
 * none by default, since the spec gives no figure). A connection's budget holds 20 cost units and
 * regains two a second; a one-step commit at the head costs 2 units (`defaultCost`).
 *
 * That the rejection comes before steps 2 to 7 is shown by what a later step would have answered.
 * Each probe is first sent by a connection with budget left, and gets the answer of its step: a
 * resent stored commit is acknowledged again (step 2, deduplication), a base beyond the head and a
 * step that does not apply are `invalid_op` (steps 3 and 5), and an edit inside a region the
 * editor may not edit is `permission_denied` (step 7). The same probes from the connection whose
 * budget is spent are all answered `rate_limited` with action `retry` and a `retryAfterMs`, and
 * the document's head does not move.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { documentWithRegions, insertText, startHarness, type Harness } from './support/harness.ts';
import { inside, loadDoc } from './support/cdm.ts';
import { WireClient, type Received } from './support/wire.ts';

const CONNECTION = { capacity: 20, refillPerSecond: 2 };
/**
 * Each probe has this many steps, so that its cost is at least the capacity of a connection's
 * budget: only a full bucket admits it, and the time the test takes between the refusal and the
 * probes (the budget regains two units a second) cannot admit it by chance.
 */
const PROBE_STEPS = 20;
const repeat = (step: () => unknown): unknown[] => Array.from({ length: PROBE_STEPS }, step);

const codeOf = (r: Received): string =>
  r.t === 'sync.ack' ? 'ack' : String((r.d as { code?: unknown }).code);

describe('SEC-028 criterion 2: a spent CPU budget rejects before steps 2 to 7', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', { dataPlane: { admission: { connection: CONNECTION } } });
  });
  afterAll(async () => {
    await h?.close();
  });

  const content = async (doc: string) =>
    (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })).json as {
      doc: unknown;
      seq: number;
    };

  it('answers rate_limited whatever a later step would have answered', async () => {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const first = await content(doc);
    const d = loadDoc(first.doc as never);
    const intro = inside(d, 'pIntro0000000001');

    const spender = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    const other = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      await spender.hello(await h.mintToken(h.a, 'sam', { [doc]: 'editor' }));
      await other.hello(await h.mintToken(h.a, 'olga', { [doc]: 'editor' }));
      expect((await spender.open(1, doc)).t).toBe('ch.opened');
      expect((await other.open(1, doc)).t).toBe('ch.opened');

      // The spender commits until its budget is spent. The first commit is kept for the
      // deduplication probe.
      let base = first.seq;
      let stored: { id: string; base: number; steps: unknown[] } | null = null;
      let acked = 0;
      let refusal: Received | null = null;
      for (let i = 0; i < 40 && !refusal; i++) {
        const commit = { id: uuid7(), base, steps: [insertText(intro, 'a')] };
        const r = await spender.submit(1, commit);
        if (r.t === 'sync.ack') {
          acked++;
          stored ??= commit;
          base = (r.d as { seq: number }).seq;
        } else refusal = r;
      }
      expect(acked, 'commits acknowledged before the budget was spent').toBeGreaterThan(0);
      expect(acked).toBeLessThanOrEqual(CONNECTION.capacity);
      expect(refusal, 'the budget was never spent').not.toBeNull();
      const refused = refusal!.d as { code: string; action?: string; retryAfterMs?: number };
      expect(refused.code).toBe('rate_limited');
      expect(refused.action).toBe('retry');
      expect(refused.retryAfterMs).toBeGreaterThan(0);

      const now = await content(doc);
      const head = now.seq;
      expect(head).toBe(base);
      // The spender's insertions moved the restricted paragraph: its position is read again.
      const legal = inside(loadDoc(now.doc as never), 'pLegal0000000001');

      // The probes, each with the answer of the step that judges it.
      const probes = (): {
        name: string;
        commit: { id: string; base: number; steps: unknown[] };
      }[] => [
        { name: 'step 2: a stored commit resent', commit: stored! },
        {
          name: 'step 3: a base beyond the head',
          commit: { id: uuid7(), base: head + 1000, steps: repeat(() => insertText(intro, 'x')) },
        },
        {
          name: 'step 5: a step that does not apply',
          commit: { id: uuid7(), base: head, steps: repeat(() => insertText(10_000_000, 'x')) },
        },
        {
          name: 'step 7: an edit in a region the editor may not edit',
          commit: { id: uuid7(), base: head, steps: repeat(() => insertText(legal, 'x')) },
        },
      ];

      // From the connection whose budget is spent: all refused at step 1.
      for (const p of probes()) {
        const r = await spender.submit(1, p.commit);
        expect(codeOf(r), `${p.name}, budget spent`).toBe('rate_limited');
        expect((r.d as { retryAfterMs?: number }).retryAfterMs, p.name).toBeGreaterThan(0);
      }
      expect((await content(doc)).seq, 'the head after the refused probes').toBe(head);

      // From a connection with budget left, the later steps answer. The resent commit is the
      // spender's own, so it is the spender's deduplication that is compared; the other
      // connection shows steps 3, 5 and 7.
      const answers: Record<string, string> = {};
      // Each probe costs a whole budget, so each goes on a connection of its own.
      for (const p of probes().slice(1)) {
        const fresh = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await fresh.hello(await h.mintToken(h.a, 'olga', { [doc]: 'editor' }));
          expect((await fresh.open(1, doc)).t).toBe('ch.opened');
          answers[p.name] = codeOf(await fresh.submit(1, p.commit));
        } finally {
          fresh.terminate();
        }
      }
      expect(answers['step 3: a base beyond the head']).toBe('invalid_op');
      expect(answers['step 5: a step that does not apply']).toBe('invalid_op');
      expect(answers['step 7: an edit in a region the editor may not edit']).toBe(
        'permission_denied',
      );

      // The other connection still writes: the budget is the connection's, not the room's.
      const ok = await other.submit(1, {
        id: uuid7(),
        base: head,
        steps: [insertText(intro, 'o')],
      });
      expect(ok.t, JSON.stringify(ok.d)).toBe('sync.ack');

      // After the wait the server named, the spender is admitted again, and its resent stored
      // commit gets the answer of step 2: the acknowledgement of the commit already stored.
      // The resent commit is charged for its rebase distance, so the wait is the one its own
      // refusal names.
      let again = await spender.submit(1, stored!);
      for (let i = 0; i < 3 && again.t !== 'sync.ack'; i++) {
        expect(codeOf(again)).toBe('rate_limited');
        const wait = Number((again.d as { retryAfterMs?: number }).retryAfterMs);
        expect(wait).toBeLessThan(30_000);
        await new Promise((done) => setTimeout(done, wait + 50));
        again = await spender.submit(1, stored!);
      }
      expect(again.t, JSON.stringify(again.d)).toBe('sync.ack');
      expect((again.d as { seq: number }).seq).toBe(first.seq + 1);
    } finally {
      spender.terminate();
      other.terminate();
    }
  }, 60_000);
});
