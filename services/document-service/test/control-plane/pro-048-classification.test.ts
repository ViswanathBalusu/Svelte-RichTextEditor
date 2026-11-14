// A classification label on the document resource (PRO-048 criterion 1; 05 §6.2). PATCH sets the
// label with a current If-Match, GET returns it, and a PATCH that clears it makes GET return none.
// Runs over HTTP with the harness of test/control-plane, in memory and on PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`classification label on the document resource (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const read = (doc: string) => h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey });
    const patch = async (doc: string, body: Record<string, unknown>) => {
      const etag = (await read(doc)).headers.get('etag')!;
      return h.call('PATCH', `/v1/documents/${doc}`, {
        token: h.apiKey,
        body,
        headers: { 'If-Match': etag },
      });
    };

    it.skipIf(skip)(
      'sets a classification label with If-Match, returns it on GET, and returns none once cleared (PRO-048 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });

        // A new document has no label.
        expect((await read(doc)).json.classification).toBeNull();

        const set = await patch(doc, { classification: 'Confidential' });
        expect(set.status).toBe(200);
        expect((await read(doc)).json.classification).toBe('Confidential');

        // A stale If-Match is refused and the label does not change.
        const stale = await h.call('PATCH', `/v1/documents/${doc}`, {
          token: h.apiKey,
          body: { classification: 'Public' },
          headers: { 'If-Match': '"stale"' },
        });
        expect(stale.status).toBe(412);
        expect((await read(doc)).json.classification).toBe('Confidential');

        // Clearing the label: GET then returns none.
        const cleared = await patch(doc, { classification: null });
        expect(cleared.status).toBe(200);
        expect((await read(doc)).json.classification).toBeNull();
      },
    );
  });
}
