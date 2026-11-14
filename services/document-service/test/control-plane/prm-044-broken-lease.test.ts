// PRM-044 criterion 4 (lane V-PRM-035-051): a former holder whose lease was broken by a manager
// sends a heartbeat, and the heartbeat is refused with a problem that says they no longer hold the
// lease. Real HTTP, in-memory and PostgreSQL storage. Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const OPEN = 'rOpen00000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`broken lease heartbeat over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const as = (doc: string, role: string, sub: string) => h.userToken({ [doc]: role }, { sub });
    const path = (doc: string) => `/v1/documents/${doc}/regions/${OPEN}/lease`;

    it.skipIf(skip)(
      'refuses the heartbeat of a former holder whose lease was broken, and says they no longer hold it',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const first = await h.call('POST', path(doc), { token: as(doc, 'editor', 'ed-v35') });
        expect(first.status).toBe(201);
        const id = first.json.id as string;

        const broke = await h.call('DELETE', path(doc), { token: as(doc, 'owner', 'ow-v35') });
        expect(broke.status).toBe(204);

        const beat = await h.call('PUT', path(doc), {
          token: as(doc, 'editor', 'ed-v35'),
          headers: { 'If-Match': `"${id}"` },
        });
        expect(beat.status).toBe(404);
        expect(JSON.stringify(beat.json)).toContain('you no longer hold this lease');

        // The refused heartbeat stores nothing: the region has no lease in force.
        expect((await h.parts.grants.current({ tenant: h.tenant, doc })).leases).toEqual([]);
      },
    );
  });
}
