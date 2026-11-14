// Reading a document's metadata, properties and state with its ETag (PRO-047 criterion 1). The
// state moves through active, locked and archived through PATCH with If-Match; each change must
// show on the next GET and change the ETag. Runs over HTTP with the harness of test/control-plane,
// in memory and on PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`document metadata and state on read (${storage})`, async () => {
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
      'returns metadata, properties and state with an ETag, and the ETag changes with each state (PRO-047 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });

        const fresh = await read(doc);
        expect(fresh.status).toBe(200);
        expect(fresh.json).toMatchObject({ id: doc, state: 'active' });
        expect(fresh.json).toHaveProperty('title');
        expect(fresh.json).toHaveProperty('properties');
        const activeEtag = fresh.headers.get('etag');
        expect(activeEtag).toBeTruthy();

        // A properties change is stored and read back as the same object.
        const props = { matter: 'M-1042', reviewers: ['a', 'b'] };
        expect((await patch(doc, { properties: props })).status).toBe(200);
        expect((await read(doc)).json.properties).toEqual(props);

        const states = ['locked', 'archived', 'active'] as const;
        let previous = (await read(doc)).headers.get('etag');
        for (const state of states) {
          const changed = await patch(doc, { state });
          expect(changed.status).toBe(200);
          expect(changed.json.state).toBe(state);

          const after = await read(doc);
          expect(after.json.state).toBe(state);
          expect(after.json.properties).toEqual(props);
          const etag = after.headers.get('etag');
          expect(etag).toBeTruthy();
          expect(etag).not.toBe(previous);
          previous = etag;
        }

        // A stale ETag is refused, so a state that changed under the reader is not overwritten.
        const stale = await h.call('PATCH', `/v1/documents/${doc}`, {
          token: h.apiKey,
          body: { state: 'locked' },
          headers: { 'If-Match': activeEtag! },
        });
        expect(stale.status).toBe(412);
        expect(stale.json.code).toBe('precondition_failed');
        expect((await read(doc)).json.state).toBe('active');
      },
    );
  });
}
