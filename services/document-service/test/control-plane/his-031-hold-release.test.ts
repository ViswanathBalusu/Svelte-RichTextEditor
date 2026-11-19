// HIS-031: the release of a legal hold, through the administration API (lane w7, 2026-11-18; owner
// decision 85 in docs/owner-decisions-2026-11-15.md: a release operation is added and audited as the
// placement is, and the pending erasures then run). Memory and PostgreSQL.
//
// Criteria covered: 3 (after the release the hold is out of force: the list, the document and the
// held set no longer count it), 4 (set and released are audited with the actor and the time, and the
// document resource shows whether a hold is in force) and 5 (an erasure that waited for the hold
// runs at the release, and the delay is audited). Test values only.
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient, insertText } from '../data-plane/client.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function textPosition(doc: unknown): number {
  let found = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (found < 0 && n.isTextblock) found = pos + 1;
      return found < 0;
    });
  if (found < 0) throw new Error('no text block');
  return found;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`releasing a legal hold (${storage}; HIS-031)`, async () => {
    const skip = await skipReason(storage);
    if (skip) console.warn(`skipped: ${skip}`);
    let h: Harness;
    const clients: DepClient[] = [];
    const writerSub = `w7-writer-${unique()}@example.test`;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const place = (doc: string, reason = 'Matter 2026-55') =>
      h.call('POST', `/v1/documents/${doc}/holds`, { token: h.apiKey, body: { reason } });
    const release = (doc: string, hold: string, token?: string) =>
      h.call('DELETE', `/v1/documents/${doc}/holds/${hold}`, { token: token ?? h.apiKey });
    const legalHold = async (doc: string) =>
      (await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey })).json.legalHold;
    const audit = async (kind: string, doc: string) =>
      (
        (
          await h.call('GET', `/v1/audit?kind=${kind}&document=${doc}&limit=50`, {
            token: h.apiKey,
          })
        ).json as { items: Array<{ actor: string; at: string; document: string; data?: unknown }> }
      ).items;

    it.skipIf(skip)(
      'takes the hold out of force, audits the release with its actor and time, and lists no more',
      async () => {
        const doc = await h.createDocument();
        const other = await h.createDocument();
        const a = (await place(doc, 'first')).json as { id: string };
        const b = (await place(doc, 'second')).json as { id: string };
        await place(other);
        expect(await legalHold(doc)).toBe(true);

        const before = Date.now() - 1_000;
        const r = await release(doc, a.id);
        expect(r.status, r.text).toBe(200);
        const after = Date.now() + 1_000;
        expect(r.json).toMatchObject({ id: a.id, document: doc, reason: 'first' });
        // Another hold still stands on the document.
        expect(await legalHold(doc)).toBe(true);
        const listed = (await h.call('GET', '/v1/holds?limit=200', { token: h.apiKey })).json as {
          items: Array<{ id: string }>;
        };
        expect(listed.items.map((x) => x.id)).not.toContain(a.id);
        expect(listed.items.map((x) => x.id)).toContain(b.id);

        expect((await release(doc, b.id)).status).toBe(200);
        expect(await legalHold(doc)).toBe(false);
        // The document that was not released is still held.
        expect(await legalHold(other)).toBe(true);
        expect(await h.parts.holds!.heldDocuments(h.tenant)).not.toContain(doc);
        expect(await h.parts.holds!.heldDocuments(h.tenant)).toContain(other);

        const events = (await audit('hold.released', doc)).filter((e) => e.document === doc);
        expect(events).toHaveLength(2);
        for (const e of events) {
          expect(e.actor).toBe('system'); // the service credential
          expect(Date.parse(e.at)).toBeGreaterThanOrEqual(before);
          expect(Date.parse(e.at)).toBeLessThanOrEqual(after + 5_000);
        }
        const stored = await h.parts.audit!.query(h.tenant, { kind: 'hold.released', limit: 50 });
        expect(
          stored
            .filter((e) => e.doc === doc)
            .map((e) => (e.data as { hold: string }).hold)
            .sort(),
        ).toEqual([a.id, b.id].sort());
        expect((await audit('hold.placed', doc)).length).toBeGreaterThanOrEqual(2);
      },
    );

    it.skipIf(skip)(
      'refuses a user token, and answers not_found for a hold twice released, unknown, or of another document',
      async () => {
        const doc = await h.createDocument();
        const other = await h.createDocument();
        const hold = (await place(doc)).json as { id: string };
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `w7-owner-${unique()}` });
        const asUser = await release(doc, hold.id, owner);
        expect(asUser.status, asUser.text).toBe(403);
        expect(await legalHold(doc)).toBe(true);

        // A hold named under another document is not found, and stays in force.
        expect((await release(other, hold.id)).status).toBe(404);
        expect(await legalHold(doc)).toBe(true);
        expect((await release(doc, uuid7())).status).toBe(404);
        expect((await release(doc, 'not-an-id')).status).toBe(404);

        expect((await release(doc, hold.id)).status).toBe(200);
        const again = await release(doc, hold.id);
        expect(again.status, again.text).toBe(404);
        expect((await audit('hold.released', doc)).length).toBe(1);
      },
    );

    it.skipIf(skip)(
      'runs the erasure that waited for the hold when the hold is released, and audits the delay (criterion 5)',
      async () => {
        const doc = await h.createDocument({ title: 'w7 HIS-031 release' });
        const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const pos = textPosition(content.json.doc);
        const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(c);
        const token = h.userToken(
          { [doc]: 'editor' },
          { sub: writerSub, name: 'Writer Example', jti: uuid7() },
        );
        expect((await c.hello(token)).t).toBe('welcome');
        expect((await c.open(1, doc)).t).toBe('ch.opened');
        const ack = await c.submit(1, { base: 0, steps: [insertText(pos, 'W')] });
        expect(ack.t, JSON.stringify(ack.d)).toBe('sync.ack');
        const surrogate = (await h.parts.users.resolve(h.tenant, writerSub)).surrogate;

        const hold = (await place(doc)).json as { id: string };
        const erase = await h.call('POST', '/v1/users/erase', {
          token: h.apiKey,
          body: { sub: writerSub },
        });
        expect(erase.status, erase.text).toBe(200);
        expect(erase.json).toEqual({ outcome: 'deferred' });
        // The hold wins: the person is still mapped.
        expect(await h.parts.users.surrogateOf(h.tenant, writerSub)).toBe(surrogate);

        const r = await release(doc, hold.id);
        expect(r.status, r.text).toBe(200);
        expect(await h.parts.users.surrogateOf(h.tenant, writerSub)).toBeNull();
        const run = await h.parts.audit!.query(h.tenant, { kind: 'erasure.run', limit: 50 });
        const ours = run.filter((e) => (e.data as { person?: string }).person === surrogate);
        expect(ours).toHaveLength(1);
        expect(typeof (ours[0]!.data as { delayMs?: number }).delayMs).toBe('number');
        const deferred = await h.parts.audit!.query(h.tenant, {
          kind: 'erasure.deferred',
          limit: 50,
        });
        expect(deferred.some((e) => (e.data as { person?: string }).person === surrogate)).toBe(
          true,
        );
      },
    );
  });
}
