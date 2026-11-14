/**
 * PRM-019 criterion 5: two owners change grants at the same time, and the second request carries
 * the ETag it read before the first change, so it fails with `precondition_failed` (07 §3; D63).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { documentWithRegions, skipReason, startHarness, type Harness } from './support.ts';

const LEGAL = 'rLegal0000000001';

describe('two owners changing grants (PRM-019)', async () => {
  const skip = await skipReason('memory');
  let h: Harness;
  beforeAll(async () => {
    if (!skip) h = await startHarness('memory', { views: { ...FULL_VIEWS } });
  });
  afterAll(async () => {
    await h?.close();
  });

  it.skipIf(skip)(
    'refuses the second of two concurrent grant changes made under the same ETag (PRM-019 criterion 5)',
    async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const ownerA = h.userToken({ [doc]: 'owner' }, { sub: 'owner-a' });
      const ownerB = h.userToken({ [doc]: 'owner' }, { sub: 'owner-b' });

      // Both owners read the grants before either writes: both hold the same ETag.
      const readA = await h.call('GET', `/v1/documents/${doc}/grants`, { token: ownerA });
      const readB = await h.call('GET', `/v1/documents/${doc}/grants`, { token: ownerB });
      const tag = readA.headers.get('etag');
      expect(tag).toBe('"g1"');
      expect(readB.headers.get('etag')).toBe(tag);

      const body = (role: string) => ({
        grants: [{ region: LEGAL, principal: 'user:bob', role }],
      });

      // Owner A's change lands first and moves the revision on.
      const first = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: ownerA,
        body: body('editor'),
        headers: { 'If-Match': tag! },
      });
      expect(first.status).toBe(200);
      expect(first.headers.get('etag')).toBe('"g2"');

      // Owner B's change carries the old ETag: refused, and nothing of B's is stored.
      const second = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: ownerB,
        body: body('viewer'),
        headers: { 'If-Match': tag! },
      });
      expect(second.status).toBe(412);
      expect(second.json.code).toBe('precondition_failed');

      const now = await h.call('GET', `/v1/documents/${doc}/grants`, { token: ownerB });
      expect(now.headers.get('etag')).toBe('"g2"');
      expect(now.json.grants).toEqual([
        expect.objectContaining({ region: LEGAL, principal: 'user:bob', role: 'editor' }),
      ]);

      // Once B has read the new ETag, the same change is accepted.
      const retry = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: ownerB,
        body: body('viewer'),
        headers: { 'If-Match': '"g2"' },
      });
      expect(retry.status).toBe(200);
      expect(retry.headers.get('etag')).toBe('"g3"');
    },
  );
});
