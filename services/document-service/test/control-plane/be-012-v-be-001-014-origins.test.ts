// BE-012 criterion 3 (lane V-BE-001-014): an allowed origin added or removed applies at the next
// request, without a restart, in memory and in PostgreSQL. The request pipeline reads the tenant's
// origins on each request (src/control-plane/pipeline.ts), so a preflight from an origin shows the
// current registration. The WebSocket check at connection time is not covered here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, skipReason, startHarness, type Storage } from './support.ts';

const ADDED = 'https://added-v-be-001-014.example.test';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`origins take effect without a restart (${storage}, BE-012 V-BE-001-014)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const preflight = (origin: string) =>
      h.call('OPTIONS', '/v1/documents/x', {
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      });

    it.skipIf(skip)(
      'an origin is refused until it is added, allowed after, and refused again once removed',
      async () => {
        const before = await preflight(ADDED);
        expect(before.status).toBe(403);

        await h.parts.registry.addOrigin(h.tenant, ADDED);
        const added = await preflight(ADDED);
        expect(added.status).toBe(204);
        expect(added.headers.get('access-control-allow-origin')).toBe(ADDED);

        expect(await h.parts.registry.removeOrigin(h.tenant, ADDED)).toBe(true);
        const removed = await preflight(ADDED);
        expect(removed.status).toBe(403);
        expect(removed.headers.get('access-control-allow-origin')).toBeNull();

        // The origin that was seeded with the tenant is unaffected by the change.
        const seeded = await preflight('https://app.example.test');
        expect(seeded.status).toBe(204);
      },
    );
  });
}
