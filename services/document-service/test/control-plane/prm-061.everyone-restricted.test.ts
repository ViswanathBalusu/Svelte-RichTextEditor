/**
 * PRM-061: `PATCH /documents/{id}/grants` refuses the principal `everyone` on a `restricted`
 * region (07 §17; owner decision 12 of 2026-11-15, docs/owner-decisions-2026-11-15.md). The
 * refusal is `validation_failed`, names the grant, and stores nothing. On an `inherit` region the
 * same grant is accepted, and a named user is accepted on the restricted one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { documentWithRegions, skipReason, startHarness, type Harness } from './support.ts';

const LEGAL = 'rLegal0000000001'; // policy: restricted
const OPEN = 'rOpen00000000001'; // policy: inherit

describe('everyone on a restricted region over HTTP (PRM-061)', async () => {
  const skip = await skipReason('memory');
  let h: Harness;
  beforeAll(async () => {
    if (!skip) h = await startHarness('memory', { views: { ...FULL_VIEWS } });
  });
  afterAll(async () => {
    await h?.close();
  });

  it.skipIf(skip)('refuses everyone on a restricted region and stores nothing', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-061' });
    const read = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
    const tag = read.headers.get('etag')!;

    const refused = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
      token: owner,
      body: {
        grants: [
          { region: OPEN, principal: 'user:bob', role: 'editor' },
          { region: LEGAL, principal: 'everyone', role: 'editor' },
        ],
      },
      headers: { 'If-Match': tag },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe('validation_failed');
    expect(JSON.stringify(refused.json)).toContain('/grants/1/principal');

    // Nothing was stored: the revision and the grants are as they were.
    const after = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
    expect(after.headers.get('etag')).toBe(tag);
    expect(after.json.grants).toEqual([]);
  });

  it.skipIf(skip)(
    'accepts everyone on an inherit region and a user on a restricted one',
    async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-061b' });
      const read = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      const ok = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: owner,
        body: {
          grants: [
            { region: OPEN, principal: 'everyone', role: 'commenter' },
            { region: LEGAL, principal: 'user:bob', role: 'editor' },
          ],
        },
        headers: { 'If-Match': read.headers.get('etag')! },
      });
      expect(ok.status).toBe(200);
      expect(ok.json.grants).toHaveLength(2);
    },
  );
});
