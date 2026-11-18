// PRM-052 criterion 4 and PRM-049 criterion 5 (lane w9): a restore of a document and a restore of
// one region are on the audit trail with the scopes they touched, the actor, the document and the
// server time, and the entry holds sequence numbers and no content (07 §14; 08 §8). A refused
// restore records nothing. Over HTTP with the real data plane, memory and PostgreSQL storage.
// The whole-document case is also in ux-081-audit-kinds.test.ts; the region case is new here.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const OPEN = 'rOpen00000000001';

function version(n: number): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(documentWithRegions())) as Record<string, unknown>;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const x = node as { type?: string; attrs?: { id?: string }; content?: unknown[] };
    if (x.type === 'paragraph' && x.attrs?.id === 'pOpen00000000001')
      x.content = [{ type: 'text', text: `Open v${n}` }];
    for (const c of x.content ?? []) walk(c);
  };
  walk(doc['doc']);
  return doc;
}

interface Item {
  kind: string;
  actor: string;
  document: string | null;
  scopes: string[];
  at: string;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`restores are audited with their scopes (${storage}, PRM-052 criterion 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      doc = await h.createDocument({ content: version(0), title: 'Audited restore' });
      for (const n of [1, 2]) {
        const etag = (
          await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
        ).headers.get('etag')!;
        const r = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: version(n),
          headers: { 'If-Match': etag },
        });
        expect(r.status, r.text).toBe(204);
      }
    });
    afterAll(async () => {
      await h?.close();
    });

    const restore = (body: Record<string, unknown>, token: string) =>
      h.call('POST', `/v1/documents/${doc}/restore`, {
        token,
        headers: { 'Idempotency-Key': randomUUID() },
        body,
      });
    const trail = async (): Promise<Item[]> => {
      const page = await h.call('GET', `/v1/audit?kind=document.restored&document=${doc}`, {
        token: h.apiKey,
      });
      expect(page.status, page.text).toBe(200);
      return page.json.items as Item[];
    };

    it.skipIf(skip)(
      'records a region restore with the region as its scope, and a document restore with doc',
      async () => {
        const editor = h.userToken({ [doc]: 'editor' }, { sub: 'erin' });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'olga' });
        expect(await trail()).toEqual([]);

        // A refused restore (a viewer holds no edit) leaves nothing on the trail.
        const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'vic' });
        expect((await restore({ toSeq: 0, region: OPEN }, viewer)).status).toBe(403);
        expect(await trail()).toEqual([]);

        const before = h.now();
        const region = await restore({ toSeq: 0, region: OPEN }, editor);
        expect(region.status, region.text).toBe(200);
        const whole = await restore({ toSeq: 0 }, owner);
        expect(whole.status, whole.text).toBe(200);
        const after = h.now();

        const items = await trail();
        expect(items).toHaveLength(2);
        expect(items.map((i) => i.scopes).sort()).toEqual([[OPEN], ['doc']].sort());
        const byScope = (s: string) => items.find((i) => i.scopes[0] === s)!;
        for (const i of items) {
          expect(i).toMatchObject({ kind: 'document.restored', document: doc });
          expect(i.actor).toMatch(/\S/);
          expect(Date.parse(i.at)).toBeGreaterThanOrEqual(before);
          expect(Date.parse(i.at)).toBeLessThanOrEqual(after);
        }
        // Two different users made the two restores: the entries name them apart.
        expect(byScope(OPEN).actor).not.toBe(byScope('doc').actor);

        // The stored entries hold sequence numbers and scopes, and no text.
        const stored = await h.parts.audit!.query(h.tenant, {
          doc,
          kind: 'document.restored',
          limit: 10,
        });
        expect(stored).toHaveLength(2);
        expect(JSON.stringify(stored.map((e) => e.data))).not.toContain('Open v');
        const regionEntry = stored.find((e) => (e.data['scopes'] as string[])[0] === OPEN)!;
        expect(regionEntry.data).toEqual({
          scopes: [OPEN],
          toSeq: 0,
          seq: region.json.seq,
          preRestoreSeq: region.json.preRestoreSeq,
        });
      },
    );
  });
}
