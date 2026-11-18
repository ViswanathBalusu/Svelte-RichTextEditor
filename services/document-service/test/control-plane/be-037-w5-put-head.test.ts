// BE-037 and BE-039 (lane w5): `PUT /documents/{id}/content` hands the data plane the ETag it
// matched as the head it replaces, so that the commit identifier is derived from the request and
// the same PUT again is the same commit (see test/data-plane/be-039-w5-replace-commit-id.test.ts).
// The data plane is the harness's stand-in, which records what it is given.
import { describe, expect, it } from 'vitest';
import { documentWithRegions, startHarness } from './support.ts';

describe('PUT /documents/{id}/content names the head it replaces (BE-039 criterion 1)', () => {
  it('passes the matched ETag to the data plane, and the same ETag again when the PUT is repeated', async () => {
    const h = await startHarness('memory');
    try {
      const heads: Array<string | undefined> = [];
      h.stub.replaceContent = async (_ref, _content, _actor, opts) => {
        heads.push(opts?.head);
        return { seq: 1 };
      };
      const doc = await h.createDocument({ content: documentWithRegions() });
      const etag = (
        await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
      ).headers.get('etag')!;
      for (let i = 0; i < 2; i++) {
        const r = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: JSON.parse(JSON.stringify(documentWithRegions())),
          headers: { 'If-Match': etag },
        });
        expect(r.status).toBe(204);
      }
      expect(heads).toEqual([etag, etag]);
    } finally {
      await h.close();
    }
  });
});
