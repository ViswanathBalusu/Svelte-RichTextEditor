// PRM-046 criterion 1 (lane U-PRM-035-051): `PUT /documents/{id}/regions/{rid}/state` over HTTP.
// A caller with `manage` sets `draft`, `in_review` or `approved`, and the state is stored with the
// actor and the time of the change (PostgreSQL: the region_states row). A caller without `manage`
// is refused with `forbidden`, and nothing is stored. Runs with memory storage and with PostgreSQL
// (each run creates and drops its own database, see test/support/env.ts). Start PostgreSQL first:
//   pwsh -NoProfile -File infra/test-env.ps1 up
//   pnpm vitest run test/control-plane/prm-046-region-state-route.test.ts   (in services/document-service)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';

const LEGAL = 'rLegal0000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the region state route (PRM-046 criterion 1, ${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, {});
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'stores an approval for a caller with manage, and says so in the response',
      async () => {
        const doc = await h.createDocument({
          content: documentWithRegions(),
          title: 'State owner',
        });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-046' });
        const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        expect(grants.status).toBe(200);
        const before = Date.now();
        const put = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
          token: owner,
          body: { state: 'approved' },
          headers: { 'If-Match': grants.headers.get('etag')! },
        });
        const after = Date.now();
        expect(put.status).toBe(200);
        expect(put.json.state ?? put.json.region?.state).toBe('approved');
        // The grants ETag moves with the state change: a later write must name the new revision.
        const next = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        expect(next.headers.get('etag')).not.toBe(grants.headers.get('etag'));
        // PRM-046 criterion 7 (over HTTP): the change raises dep.region.state_changed for the document.
        const raised = h.events.events.filter(
          (e) => e.type.startsWith('dep.region.state_changed') && e.subject === doc,
        );
        expect(raised).toHaveLength(1);
        expect(raised[0]!.data).toMatchObject({ region: LEGAL, state: 'approved' });

        if (storage === 'postgres') {
          const stored = (
            await h.db!.admin.query<{ state: string; changed_by: string; changed_at: Date }>(
              'SELECT state, changed_by, changed_at FROM region_states WHERE doc_id = $1 AND region_id = $2',
              [doc, LEGAL],
            )
          ).rows;
          expect(stored).toHaveLength(1);
          expect(stored[0]!.state).toBe('approved');
          // The actor is the caller's identifier in the tenant (not the host's `sub`): the audit row
          // of the same change names the same actor.
          expect(stored[0]!.changed_by).toMatch(/^[0-9a-f-]{36}$/);
          const audit = (
            await h.db!.admin.query<{ actor: string }>(
              "SELECT actor FROM audit_events WHERE doc_id = $1 AND kind = 'grants.changed'",
              [doc],
            )
          ).rows;
          expect(audit.map((r) => r.actor)).toContain(stored[0]!.changed_by);
          expect(stored[0]!.changed_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
          expect(stored[0]!.changed_at.getTime()).toBeLessThanOrEqual(after + 1000);
        }
      },
    );

    it.skipIf(skip)('refuses a caller without manage, and stores nothing', async () => {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'State editor' });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-046b' });
      const editor = h.userToken({ [doc]: 'editor' }, { sub: 'editor-046' });
      const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      const put = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
        token: editor,
        body: { state: 'approved' },
        headers: { 'If-Match': grants.headers.get('etag')! },
      });
      expect(put.status).toBe(403);
      expect(put.json.code).toBe('forbidden');
      expect(
        h.events.events.filter(
          (e) => e.subject === doc && e.type.startsWith('dep.region.state_changed'),
        ),
      ).toHaveLength(0);

      if (storage === 'postgres') {
        const stored = (
          await h.db!.admin.query(
            'SELECT state FROM region_states WHERE doc_id = $1 AND region_id = $2',
            [doc, LEGAL],
          )
        ).rows;
        expect(stored).toHaveLength(0);
      }
      // The grants are unchanged: the same ETag still answers 200 to a read.
      const again = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      expect(again.headers.get('etag')).toBe(grants.headers.get('etag'));
    });
  });
}
