// PRM-043 criterion 6, first part (lane V-PRM-035-051): acquiring and releasing a region lease over
// real HTTP leaves the content of the document unchanged: the same body, the same seq and the same
// incarnation before and after. Memory and PostgreSQL storage. Test values only.
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
  describe(`lease acquire and release leave the content unchanged (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const as = (doc: string, role: string, sub: string) => h.userToken({ [doc]: role }, { sub });
    const lease = (doc: string) => `/v1/documents/${doc}/regions/${OPEN}/lease`;

    it.skipIf(skip)(
      'the content read before and after a lease is taken and released is identical',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const before = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        expect(before.status).toBe(200);

        const taken = await h.call('POST', lease(doc), { token: as(doc, 'editor', 'ed-v35-43') });
        expect(taken.status).toBe(201);
        const during = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        expect(during.status).toBe(200);
        expect(during.json.doc).toEqual(before.json.doc);
        expect(during.json.seq).toBe(before.json.seq);
        expect(during.json.incarnation).toBe(before.json.incarnation);

        const released = await h.call('DELETE', lease(doc), {
          token: as(doc, 'editor', 'ed-v35-43'),
        });
        expect(released.status).toBe(204);
        const after = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        expect(after.status).toBe(200);
        expect(after.json.doc).toEqual(before.json.doc);
        expect(after.json.seq).toBe(before.json.seq);
        expect(after.json.incarnation).toBe(before.json.incarnation);
        expect(after.headers.get('ETag')).toBe(before.headers.get('ETag'));
      },
    );
  });
}
