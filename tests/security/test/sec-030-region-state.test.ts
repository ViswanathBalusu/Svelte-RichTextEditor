/**
 * SEC-030 criterion 2 (lane U-SEC-017-032): an owner moves an approved region to `draft`, the edit
 * that follows is accepted, and the state change is recorded as a control commit and in the audit
 * trail, and raises `dep.region.state_changed` (10 §3.3; 07 §11; PRM-046, PRM-047).
 *
 * The region is approved first, and an editor's insert into it is refused while approved (the
 * control for the step that follows). Both storages run: memory and PostgreSQL in the shared
 * container. The events are collected by a memory event sink passed to the service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryEventSink } from '../../../services/document-service/src/control-plane/events.ts';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  insertText,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const LEGAL = 'rLegal0000000001';
const PARA = 'pLegal0000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-030 an owner's change to draft is recorded and the edit follows (${storage})`, () => {
    let h: Harness;
    /** The service's event sink (a MemoryEventSink unless the composition chooses another). */
    let events: MemoryEventSink;

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      events = h.service.events as MemoryEventSink;
    }, 60_000);

    afterAll(async () => {
      await h?.close();
    });

    const t = () => (skip ? it.skip : it);

    t()(
      'approve, owner moves to draft, the edit is accepted; control commit, audit and event all recorded',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const ref = { tenant: h.a.id, doc };
        // The editor holds an editor grant on the restricted region (rex).
        const g0 = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
        const grant = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.a.apiKey,
          body: { grants: [{ region: LEGAL, principal: 'user:rex', role: 'editor' }] },
          headers: { 'If-Match': g0.headers.get('etag')! },
        });
        expect(grant.status).toBe(200);

        const token = await h.mintToken(h.a, 'rex', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await c.hello(token);
          await c.open(1, doc);
          const content = (
            await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })
          ).json;
          const pos = posInside(content.doc, PARA);

          const setState = async (state: 'approved' | 'draft') => {
            const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
            return h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
              token: h.a.apiKey,
              body: { state },
              headers: { 'If-Match': g.headers.get('etag')!, 'Content-Type': 'application/json' },
            });
          };

          // 1. The owner approves the region. An edit by the editor is then refused.
          const approved = await setState('approved');
          expect(approved.status).toBe(200);
          const refused = await c.submit(1, {
            id: uuid7(),
            base: (await h.parts.logs.head(ref)).seq,
            steps: [insertText(pos, 'A')],
          });
          expect(refused.t).toBe('sync.reject');
          expect(refused.d?.['code']).toBe('permission_denied');

          // 2. The owner moves the region to draft.
          const auditBefore =
            storage === 'postgres'
              ? (await h.parts.audit!.query(h.a.id, { doc, limit: 1000 })).filter(
                  (e) => e.kind === 'grants.changed',
                ).length
              : 0;
          const eventsBefore = events.of('dep.region.state_changed.v1').length;
          const headBefore = (await h.parts.logs.head(ref)).seq;
          const draft = await setState('draft');
          expect(draft.status).toBe(200);
          const draftRev = (await h.parts.grants.current(ref)).revision;

          // 3. The edit that follows is accepted.
          const ack = await c.submit(1, {
            id: uuid7(),
            base: (await h.parts.logs.head(ref)).seq,
            steps: [insertText(pos, 'D')],
          });
          expect(ack.t).toBe('sync.ack');

          // 4. The state change is a control commit at its revision, in the log.
          const deadline = Date.now() + 5000;
          let control: { seq: number } | undefined;
          while (!control && Date.now() < deadline) {
            control = (await h.parts.logs.read(ref, headBefore + 1))
              .filter((x) => x.kind === 'control' && x.revision === draftRev)
              .map((x) => ({ seq: x.seq }))[0];
            if (!control) await new Promise((r) => setTimeout(r, 25));
          }
          expect(control).toBeDefined();
          expect(control!.seq).toBeGreaterThan(headBefore);

          // 5. The change is in the audit trail. The memory grant store writes no audit rows (only
          // the PostgreSQL store does, in the change's own transaction), so this is PostgreSQL only.
          if (storage === 'postgres') {
            const auditAfter = (await h.parts.audit!.query(h.a.id, { doc, limit: 1000 })).filter(
              (e) => e.kind === 'grants.changed',
            ).length;
            expect(auditAfter).toBeGreaterThan(auditBefore);
          }

          // 6. dep.region.state_changed was raised for draft.
          const raised = events
            .of('dep.region.state_changed.v1')
            .slice(eventsBefore)
            .filter((e) => e.subject === doc && e.data['region'] === LEGAL);
          expect(raised.some((e) => e.data['state'] === 'draft')).toBe(true);
        } finally {
          c.terminate();
        }
      },
      60_000,
    );
  });
}
