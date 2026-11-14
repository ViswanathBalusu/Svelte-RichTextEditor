// Region leases over real HTTP, with in-memory storage and with PostgreSQL (PRO-053 criterion 3 and
// the duration part of criterion 4; 05 section 6.2; 07 sections 10 and 12; PRM-043 to PRM-045).
// Test values only. The lease store is the grant store's `region_leases` table (migration 0003),
// so the PostgreSQL run checks that the lease identifier and its acquisition time survive a
// round trip, which the eight-hour maximum needs.
//
// Not claimed here: the `perm.changed` that the room sends when a lease expires without a
// heartbeat (criterion 4's notice part): the stub data plane runs no expiry timer. Discovery that
// omits `leases` (criterion 5) is the client's behaviour, not this test's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const OPEN = 'rOpen00000000001';
const MIN = 60_000;
const LEASE_MS = 5 * MIN;
const MAX_MS = 8 * 60 * MIN;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`region leases over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A user token for `sub` with `role` on `doc`; a fresh one each call, as tokens expire. */
    const as = (doc: string, role: string, sub: string) => h.userToken({ [doc]: role }, { sub });
    const path = (doc: string) => `/v1/documents/${doc}/regions/${OPEN}/lease`;
    const ref = (doc: string) => ({ tenant: h.tenant, doc });

    it.skipIf(skip)(
      'takes, extends, breaks and ends a lease; refuses a viewer and a second holder (criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });

        const viewer = await h.call('POST', path(doc), { token: as(doc, 'viewer', 'vw-1') });
        expect(viewer.status).toBe(403);

        const first = await h.call('POST', path(doc), { token: as(doc, 'editor', 'ed-1') });
        expect(first.status).toBe(201);
        expect(first.json).toMatchObject({ holder: 'ed-1' });
        expect(typeof first.json.id).toBe('string');
        const etag = first.headers.get('etag');
        expect(etag).toBe(`"${first.json.id}"`);

        const second = await h.call('POST', path(doc), { token: as(doc, 'owner', 'ow-1') });
        expect(second.status).toBe(409);

        // The holder acquiring again keeps the lease it has.
        const again = await h.call('POST', path(doc), { token: as(doc, 'editor', 'ed-1') });
        expect(again.status).toBe(201);
        expect(again.json.id).toBe(first.json.id);

        // A heartbeat needs the current tag: none is 428, a stale one 412.
        const none = await h.call('PUT', path(doc), { token: as(doc, 'editor', 'ed-1') });
        expect(none.status).toBe(428);
        const stale = await h.call('PUT', path(doc), {
          token: as(doc, 'editor', 'ed-1'),
          headers: { 'If-Match': '"not-the-lease"' },
        });
        expect(stale.status).toBe(412);
        const beat = await h.call('PUT', path(doc), {
          token: as(doc, 'editor', 'ed-1'),
          headers: { 'If-Match': etag! },
        });
        expect(beat.status).toBe(200);
        expect(Date.parse(beat.json.expiresAt)).toBeGreaterThanOrEqual(
          Date.parse(first.json.expiresAt),
        );

        // Someone else cannot renew it, even with its tag.
        const other = await h.call('PUT', path(doc), {
          token: as(doc, 'owner', 'ow-1'),
          headers: { 'If-Match': etag! },
        });
        expect(other.status).toBe(403);

        // Only the holder or a user with `manage` ends it: an editor is refused, the owner breaks it.
        const refused = await h.call('DELETE', path(doc), { token: as(doc, 'editor', 'ed-2') });
        expect(refused.status).toBe(403);
        const broke = await h.call('DELETE', path(doc), { token: as(doc, 'owner', 'ow-1') });
        expect(broke.status).toBe(204);
        expect((await h.parts.grants.current(ref(doc))).leases).toEqual([]);

        const taken = await h.call('POST', path(doc), { token: as(doc, 'editor', 'ed-1') });
        expect(taken.status).toBe(201);
        const ended = await h.call('DELETE', path(doc), {
          token: as(doc, 'editor', 'ed-1'),
          headers: { 'If-Match': `"${taken.json.id}"` },
        });
        expect(ended.status).toBe(204);
        expect((await h.parts.grants.current(ref(doc))).leases).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'lets a lease lapse five minutes after its last heartbeat, and then another user takes it (criterion 4, duration)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const first = await h.call('POST', path(doc), { token: as(doc, 'editor', 'ed-1') });
        expect(first.status).toBe(201);
        expect(Date.parse(first.json.expiresAt) - h.now()).toBeLessThanOrEqual(LEASE_MS);

        h.advance(LEASE_MS + 1000);
        const late = await h.call('PUT', path(doc), {
          token: as(doc, 'editor', 'ed-1'),
          headers: { 'If-Match': `"${first.json.id}"` },
        });
        expect(late.status).toBe(404);

        const next = await h.call('POST', path(doc), { token: as(doc, 'owner', 'ow-1') });
        expect(next.status).toBe(201);
        expect(next.json.holder).toBe('ow-1');
      },
    );

    it.skipIf(skip)(
      'extends a lease by heartbeat up to a total of eight hours, then refuses the heartbeat (criterion 4, maximum)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const first = await h.call('POST', path(doc), { token: as(doc, 'editor', 'ed-1') });
        expect(first.status).toBe(201);
        const id = first.json.id as string;
        // The acquisition time: the first expiry is five minutes after it (the server's own clock).
        const acquiredAt = Date.parse(first.json.expiresAt) - LEASE_MS;

        // Heartbeat every four minutes; each renewal keeps the same identifier and stops at the maximum.
        let last: { status: number; json: { expiresAt: string } } | null = null;
        let refusedAt = -1;
        for (let k = 1; k <= 120; k++) {
          h.advance(4 * MIN);
          const beat = await h.call('PUT', path(doc), {
            token: as(doc, 'editor', 'ed-1'),
            headers: { 'If-Match': `"${id}"` },
          });
          if (beat.status !== 200) {
            refusedAt = k;
            break;
          }
          last = beat;
          expect(Date.parse(beat.json.expiresAt)).toBeLessThanOrEqual(acquiredAt + MAX_MS);
        }
        expect(refusedAt).toBe(120);
        expect(last).not.toBeNull();
        // The refusal came at the maximum: no heartbeat after eight hours extends the lease.
        expect(h.now() - acquiredAt).toBeGreaterThanOrEqual(MAX_MS);
        // The stored row lapses at the maximum; nothing is in force after it.
        const stored = (await h.parts.grants.current(ref(doc))).leases;
        expect(stored.every((l) => l.expiresAt <= h.now())).toBe(true);
      },
    );
  });
}
