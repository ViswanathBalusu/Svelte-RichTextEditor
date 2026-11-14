// BE-031 criterion 1 (lane U-BE-029-042): `POST /sessions/revoke` with a service credential and a `sub`
// sets the user's `revoked_before` to the server's current time, stored in PostgreSQL
// (`tenant_users.revoked_before`). Runs against the PostgreSQL of the test environment (Podman) in a
// database of its own; skipped, with the reason, when it is down.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipReason, startHarness, type Harness } from './support.ts';

const skip = await skipReason('postgres');

describe.skipIf(skip !== null)(
  'revocation watermark is stored (BE-031 criterion 1, PostgreSQL)',
  () => {
    let h: Harness;

    beforeAll(async () => {
      h = await startHarness('postgres');
    });

    afterAll(async () => {
      await h?.close();
    });

    it('sets revoked_before of the named sub to the server time, and only for that sub', async () => {
      const other = await h.parts.users.resolve(h.tenant, 'be031-other');
      expect(other.revokedBefore).toBeNull();

      const before = Date.now();
      const r = await h.call('POST', '/v1/sessions/revoke', {
        token: h.apiKey,
        body: { sub: 'be031-zoe' },
      });
      const after = Date.now();
      expect(r.status).toBe(204);

      const zoe = await h.parts.users.resolve(h.tenant, 'be031-zoe');
      expect(zoe.revokedBefore).not.toBeNull();
      // The watermark is the server time to the second (D73), so it lies between the second of the
      // request's start and the second of its end.
      expect(zoe.revokedBefore! % 1000).toBe(0);
      expect(zoe.revokedBefore!).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(zoe.revokedBefore!).toBeLessThanOrEqual(Math.floor(after / 1000) * 1000);
      expect(zoe.documentRevocations.size).toBe(0);

      const stillOther = await h.parts.users.resolve(h.tenant, 'be031-other');
      expect(stillOther.revokedBefore).toBeNull();
    });
  },
);
