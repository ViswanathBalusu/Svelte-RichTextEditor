// PRM-032 criterion 3 (lane U-PRM-018-034): the region list carries an ETag; the ETag does not
// change while nothing changes, and it differs once a grant changes or a region is retired. Run with
// memory storage and with PostgreSQL (each run creates and drops its own database, see
// test/support/env.ts). Criteria 1, 2, 4 and 5 are in prm-032.regions-list.test.ts.
import type { StoredCommit, WriteRequest } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';

const LEGAL = 'rLegal0000000001';
const OPEN = 'rOpen00000000001';

function spanOf(doc: unknown, id: string): { before: number; after: number } {
  const root = cdmSchema().nodeFromJSON(doc);
  let found: { before: number; after: number } | null = null;
  root.descendants((n, pos) => {
    if (n.attrs['id'] === id) found = { before: pos, after: pos + n.nodeSize };
    return !found;
  });
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the region list ETag (PRM-032 criterion 3, ${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, {});
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('keeps the ETag while nothing changes, and answers 304 to it', async () => {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'Etag steady' });
      const viewer = h.userToken({ [doc]: 'viewer' });
      const first = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
      expect(first.status).toBe(200);
      const tag = first.headers.get('etag');
      expect(tag).toBeTruthy();
      const again = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
      expect(again.headers.get('etag')).toBe(tag);
      const cached = await h.call('GET', `/v1/documents/${doc}/regions`, {
        token: viewer,
        headers: { 'If-None-Match': tag! },
      });
      expect(cached.status).toBe(304);
    });

    it.skipIf(skip)('changes the ETag when a grant changes, and shows the change', async () => {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'Etag grant' });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-etag' });
      const viewer = h.userToken({ [doc]: 'viewer' });
      const before = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
      const tagBefore = before.headers.get('etag');
      const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
      const patch = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: owner,
        body: { grants: [{ region: LEGAL, principal: 'user:bob', role: 'editor' }] },
        headers: { 'If-Match': grants.headers.get('etag')! },
      });
      expect(patch.status).toBe(200);
      const after = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
      expect(after.headers.get('etag')).not.toBe(tagBefore);
      const legal = (
        after.json.items as Array<{ id: string; editors: { principals: string[] } }>
      ).find((x) => x.id === LEGAL);
      expect(legal!.editors.principals).toEqual(['user:bob']);
    });

    it.skipIf(skip)('changes the ETag when a commit retires a region', async () => {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'Etag retire' });
      const viewer = h.userToken({ [doc]: 'viewer' });
      const before = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
      const tagBefore = before.headers.get('etag');
      const ref = { tenant: h.tenant, doc };
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const span = spanOf(content.json.doc, OPEN);
      const head = await h.parts.logs.head(ref);
      const epoch = await h.parts.ownership.claim(ref, 'node-prm-032-etag');
      const { revision } = await h.parts.grants.current(ref);
      const commit: StoredCommit = {
        seq: head.seq + 1,
        id: uuid7(),
        kind: 'steps',
        steps: [{ stepType: 'replace', from: span.before, to: span.after }],
        user: 'owner',
        session: 's-owner',
        time: h.now(),
        origin: 'input',
        scopes: ['body', `region:${OPEN}`],
        revision,
        cdm: 1,
        engine: 'pm-steps/1',
        retired: [OPEN],
        claimed: [],
      };
      const write: WriteRequest = { epoch, revision, fromSeq: head.seq + 1, commits: [commit] };
      expect(await h.parts.logs.append(ref, write)).toEqual({ status: 'ok' });
      const after = await h.call('GET', `/v1/documents/${doc}/regions`, { token: viewer });
      expect(after.headers.get('etag')).not.toBe(tagBefore);
      expect(after.json.items.map((x: { id: string }) => x.id)).toEqual([LEGAL]);
    });
  });
}
