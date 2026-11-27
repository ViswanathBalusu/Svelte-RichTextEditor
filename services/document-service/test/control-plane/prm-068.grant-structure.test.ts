// The `structure` list of a region grant over HTTP, in memory and in PostgreSQL (PRM-068;
// ADR 0424; owner decision 279): written under If-Match, read back as given, refused with the
// reason when it is wrong, and carried by a client that ignores it as the role alone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
const OPEN = 'rOpen00000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`grants with a structure list over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('stores the list as given and reads it back', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const owner = h.userToken({ [doc]: 'owner' });
      const patch = (grants: unknown[], etag: string) =>
        h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: owner,
          body: { grants },
          headers: { 'If-Match': etag },
        });
      const wanted = [
        {
          region: LEGAL,
          principal: 'user:bob',
          role: 'editor',
          structure: ['defs.add', 'region.retitle'],
        },
        { region: OPEN, principal: 'user:carol', role: 'editor', structure: ['region.retitle'] },
        { region: OPEN, principal: 'user:dan', role: 'editor' },
        { region: OPEN, principal: 'user:erin', role: 'viewer' },
      ];
      const ok = await patch(wanted, '"g1"');
      expect(ok.status).toBe(200);
      expect(ok.headers.get('etag')).toBe('"g2"');
      const read = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      const byPrincipal = new Map(
        (read.json.grants as Array<Record<string, unknown>>).map((g) => [g['principal'], g]),
      );
      // The list is kept in the order it was written; a grant without one carries no member.
      expect(byPrincipal.get('user:bob')?.['structure']).toEqual(['defs.add', 'region.retitle']);
      expect(byPrincipal.get('user:carol')?.['structure']).toEqual(['region.retitle']);
      expect('structure' in (byPrincipal.get('user:dan') ?? {})).toBe(false);
      expect('structure' in (byPrincipal.get('user:erin') ?? {})).toBe(false);
      // An older client that ignores the member still reads the role.
      const older = (read.json.grants as Array<{ role: string }>).map((g) => g.role).sort();
      expect(older).toEqual(['editor', 'editor', 'editor', 'viewer']);

      // Changing the list is a change of the grant; removing it clears it.
      const cleared = await patch(
        [{ region: LEGAL, principal: 'user:bob', role: 'editor', structure: ['defs.add'] }],
        '"g2"',
      );
      expect(cleared.json.grants).toEqual([
        {
          region: LEGAL,
          principal: 'user:bob',
          role: 'editor',
          expiresAt: null,
          structure: ['defs.add'],
        },
      ]);
      const without = await patch(
        [{ region: LEGAL, principal: 'user:bob', role: 'editor' }],
        '"g3"',
      );
      expect(without.json.grants).toEqual([
        { region: LEGAL, principal: 'user:bob', role: 'editor', expiresAt: null },
      ]);
      const stored = await h.parts.grants.current({ tenant: h.tenant, doc });
      expect(stored.grants.every((g) => g.structure === undefined)).toBe(true);
    });

    it.skipIf(skip)('refuses a wrong list with the reason named, and stores nothing', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const owner = h.userToken({ [doc]: 'owner' });
      const bad: Array<[string, unknown, RegExp]> = [
        [
          'a role other than editor',
          { role: 'suggester', structure: ['region.retitle'] },
          /only with the role editor/,
        ],
        [
          'an operation without the flag',
          { role: 'editor', structure: ['region.delete'] },
          /expected one of region.retitle, defs.add/,
        ],
        [
          'a manage operation',
          { role: 'editor', structure: ['grants.change'] },
          /expected one of region.retitle, defs.add/,
        ],
        [
          'an unknown identifier',
          { role: 'editor', structure: ['region.rename'] },
          /expected one of region.retitle, defs.add/,
        ],
        [
          'a duplicate',
          { role: 'editor', structure: ['defs.add', 'defs.add'] },
          /twice|unique|duplicate/,
        ],
        [
          'a value that is not a list',
          { role: 'editor', structure: 'defs.add' },
          /list|array|type/,
        ],
      ];
      for (const [name, extra, reason] of bad) {
        const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: owner,
          body: { grants: [{ region: LEGAL, principal: 'user:bob', ...(extra as object) }] },
          headers: { 'If-Match': '"g1"' },
        });
        expect(r.status, name).toBe(400);
        expect(r.json.code, name).toBe('validation_failed');
        expect(JSON.stringify(r.json), name).toMatch(reason);
      }
      expect((await h.parts.grants.current({ tenant: h.tenant, doc })).revision).toBe(1);
    });
  });
}
