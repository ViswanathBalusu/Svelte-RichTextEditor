/**
 * PRM-051 criterion 3 (lane U-PRM-035-051): a grant change leaves an audit entry with its actor, the
 * document, the regions whose grants changed and the server time. A refused change (412) leaves none.
 * Over PostgreSQL (its own database, created and dropped by the harness):
 * `pnpm vitest run test/control-plane/prm-051.grant-audit.test.ts` in services/document-service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { documentWithRegions, skipReason, startHarness, type Harness } from './support.ts';

const LEGAL = 'rLegal0000000001';

const grantsEvents = async (h: Harness, doc: string) =>
  (await h.parts.audit!.query(h.tenant, { doc, kind: 'grants.changed', limit: 100 })).sort(
    (a, b) => a.at - b.at,
  );

function suite(storage: 'memory' | 'postgres') {
  describe(`grant changes in the audit trail, ${storage} (PRM-051 criterion 3; U-PRM-035-051)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { views: { ...FULL_VIEWS } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'records each stored grant change with actor, document, region scopes and server time; a refused one records nothing',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const ownerA = h.userToken({ [doc]: 'owner' }, { sub: 'owner-a' });
        const ownerB = h.userToken({ [doc]: 'owner' }, { sub: 'owner-b' });
        expect(await grantsEvents(h, doc)).toHaveLength(0);

        const before = h.now();
        const first = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: ownerA,
          body: { grants: [{ region: LEGAL, principal: 'user:bob', role: 'editor' }] },
          headers: { 'If-Match': '"g1"' },
        });
        expect(first.status).toBe(200);
        const after = h.now();

        const one = await grantsEvents(h, doc);
        expect(one).toHaveLength(1);
        expect(one[0]!.tenant).toBe(h.tenant);
        expect(one[0]!.doc).toBe(doc);
        expect(one[0]!.actor).toMatch(/\S/);
        expect(one[0]!.actor).not.toBe('system');
        // The scope of a region is named `region:<id>` (07 §4; the store's changedScopes).
        expect(one[0]!.data).toEqual({ rev: 2, scopes: [`region:${LEGAL}`] });
        expect(one[0]!.at).toBeGreaterThanOrEqual(before);
        expect(one[0]!.at).toBeLessThanOrEqual(after);

        // A second owner's change: the actor is the other owner, and the event is its own.
        const second = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: ownerB,
          body: { grants: [{ region: LEGAL, principal: 'user:bob', role: 'viewer' }] },
          headers: { 'If-Match': '"g2"' },
        });
        expect(second.status).toBe(200);
        const two = await grantsEvents(h, doc);
        expect(two).toHaveLength(2);
        expect(two[1]!.actor).not.toBe(two[0]!.actor);
        expect(two[1]!.data).toEqual({ rev: 3, scopes: [`region:${LEGAL}`] });

        // A change refused for a stale ETag stores nothing and records nothing.
        const refused = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: ownerA,
          body: { grants: [] },
          headers: { 'If-Match': '"g2"' },
        });
        expect(refused.status).toBe(412);
        expect(await grantsEvents(h, doc)).toHaveLength(2);
      },
    );
  });
}

// PostgreSQL only: the PostgreSQL grant store records the change in its own transaction (BE-014
// criterion 3). The in-memory grant store records no audit entry, so the memory run would fail.
suite('postgres');
