// UX-081 criterion 1 (07 section 14): the events the section lists are on the audit trail and are
// returned by `GET /audit` with actor, document, scopes and server time. This file covers the two
// that nothing recorded before lane w3: a restore (kind `document.restored`) and a workflow
// transition (a `grants.changed` event that carries `workflowActive`). The others have tests of
// their own, named in the story's Evidence: grant changes (prm-051.grant-audit.test.ts), region
// state changes (data-plane/prm-046-state-audit.pg.test.ts), lease breaks
// (data-plane/prm-045-lease-break.pg.test.ts), session revocations (prm-052-revoke-audit.test.ts)
// and the `permission_denied` and `invalid_op` rejections (src/data-plane/audit.test.ts, over a
// WebSocket). The workflow transition is made through the grant store, the path the data plane
// uses (src/data-plane/pro-034-workflow-perm-changed.test.ts): the service has no workflow route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

interface Item {
  id: string;
  kind: string;
  actor: string;
  document: string | null;
  scopes: string[];
  at: string;
}

const audit = async (h: Harness, query: string): Promise<Item[]> => {
  const page = await h.call('GET', `/v1/audit?${query}`, { token: h.apiKey });
  expect(page.status, page.text).toBe(200);
  return page.json.items as Item[];
};

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`audit kinds of 07 section 14 (${storage}, UX-081 criterion 1)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'records a restore with actor, document, scope and time, and no content',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions(), title: 'Audited' });
        const etag = (
          await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
        ).headers.get('etag')!;
        const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: documentWithRegions(),
          headers: { 'If-Match': etag },
        });
        expect(put.status, put.text).toBe(204);
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-r' });
        const before = h.now();
        const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: owner,
          body: { toSeq: 0 },
        });
        expect(r.status, r.text).toBe(200);
        const after = h.now();

        const items = await audit(h, `kind=document.restored&document=${doc}`);
        expect(items).toHaveLength(1);
        const item = items[0]!;
        expect(item).toMatchObject({ kind: 'document.restored', document: doc, scopes: ['doc'] });
        expect(item.actor).toMatch(/\S/);
        expect(Date.parse(item.at)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(item.at)).toBeLessThanOrEqual(after);
        // The stored event holds sequence numbers only.
        const stored = await h.parts.audit!.query(h.tenant, {
          doc,
          kind: 'document.restored',
          limit: 10,
        });
        expect(stored[0]!.data).toEqual({
          scopes: ['doc'],
          toSeq: 0,
          seq: r.json.seq,
          preRestoreSeq: r.json.preRestoreSeq,
        });

        // A restore refused for a missing role records nothing.
        const editor = h.userToken({ [doc]: 'editor' });
        const refused = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: editor,
          body: { toSeq: 0 },
        });
        expect(refused.status).toBe(403);
        expect(await audit(h, `kind=document.restored&document=${doc}`)).toHaveLength(1);
      },
    );

    it.skipIf(skip || storage === 'memory')(
      'records a workflow transition as a grants change on the document scope',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const ref = { tenant: h.tenant, doc };
        await h.parts.grants.change(ref, { workflowActive: true }, { actor: 'wf-actor' });
        await h.parts.grants.change(ref, { workflowActive: false }, { actor: 'wf-actor' });
        const items = await audit(h, `kind=grants.changed&document=${doc}`);
        expect(items.map((i) => i.scopes)).toEqual([['doc'], ['doc']]);
        const stored = await h.parts.audit!.query(h.tenant, {
          doc,
          kind: 'grants.changed',
          limit: 10,
        });
        expect(stored.map((e) => e.data['workflowActive'])).toEqual([true, false]);
        expect(stored.every((e) => e.actor.length > 0 && e.doc === doc)).toBe(true);
      },
    );
  });
}
