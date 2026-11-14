// UX-040 criterion 1, service half: a person whose access carries `no-export` is refused a direct
// export request to the control plane (05 §3.1 `restrict`; 07 §12 row 12). The editor's own
// refusal of `requestExport` is UX-040's client half and is not covered here. Runs over the HTTP
// surface of the test harness, in memory and in PostgreSQL (when the test environment answers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`UX-040 no-export refusal (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'refuses a direct export request from a person with no-export, and accepts one without it',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const restricted = h.userToken({ [doc]: 'editor' }, { restrict: ['no-export'] });
        const open = h.userToken({ [doc]: 'editor' });

        const refused = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: restricted,
          body: { target: 'pdf', options: { profile: 'final' } },
        });
        expect(refused.status).toBe(403);
        expect(refused.json?.type ?? refused.json?.code).toBeTruthy();

        const accepted = await h.call('POST', `/v1/documents/${doc}/exports`, {
          token: open,
          body: { target: 'pdf', options: { profile: 'final' } },
        });
        expect(accepted.status).toBe(202);
      },
    );
  });
}
