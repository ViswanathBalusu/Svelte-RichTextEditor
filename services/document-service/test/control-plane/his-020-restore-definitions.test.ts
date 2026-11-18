// HIS-020 criterion 4 over HTTP (lane w7; 08 section 8; 07 section 13): a region restore whose old
// content needs a style that no longer exists. A caller with `structure` gets the style recreated;
// a caller without it (a viewer who holds an editor grant on the region only) gets the default
// style, and in both cases the answer tells the person what was recreated or replaced. A restore
// that needed no definition carries no `notes`. Memory and PostgreSQL. Test values only.
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
const PARA = 'pOpen00000000001';

interface Node {
  type?: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: Node[];
}

/** The fixture; `withQuote` adds the style `LegalQuote` and uses it in the open region. */
function version(text: string, withQuote: boolean): Record<string, unknown> {
  const env = JSON.parse(JSON.stringify(documentWithRegions())) as {
    doc: Node;
  };
  const walk = (n: Node): void => {
    if (n.type === 'defs' && withQuote)
      n.content!.splice(2, 0, {
        type: 'style_def',
        attrs: { id: 'LegalQuote', kind: 'paragraph', name: 'Legal quote', builtIn: false },
      });
    if (n.type === 'paragraph' && n.attrs?.['id'] === PARA) {
      n.content = [{ type: 'text', text }];
      n.attrs['style'] = withQuote ? 'LegalQuote' : 'Normal';
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(env.doc);
  return env as unknown as Record<string, unknown>;
}

const findNode = (n: Node, pred: (n: Node) => boolean): Node | undefined => {
  if (pred(n)) return n;
  for (const c of n.content ?? []) {
    const f = findNode(c, pred);
    if (f) return f;
  }
  return undefined;
};

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a region restore tells the person about definitions (${storage}, HIS-020)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    let owner: string;
    let vera: string;

    const content = async () =>
      await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const put = async (body: Record<string, unknown>) => {
      const r = await h.call('PUT', `/v1/documents/${doc}/content`, {
        token: h.apiKey,
        body,
        headers: { 'If-Match': (await content()).headers.get('etag')! },
      });
      expect(r.status, r.text).toBe(204);
    };
    const restore = (token: string) =>
      h.call('POST', `/v1/documents/${doc}/restore`, {
        token,
        headers: { 'Idempotency-Key': randomUUID() },
        body: { toSeq: 0, region: OPEN },
      });

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      doc = await h.createDocument({ content: version('Quoted', true), title: 'Definitions' });
      await put(version('Plain', false));
      owner = h.userToken({ [doc]: 'owner' });
      // A viewer of the document who holds an editor grant on the open region only: `edit` in the
      // region (so the restore is allowed) and no `structure` (so no definition may be recreated).
      vera = h.userToken({ [doc]: 'viewer' }, { sub: 'vera' });
      const ref = { tenant: h.tenant, doc };
      const veraId = (await h.parts.users.resolve(h.tenant, 'vera')).surrogate;
      const actor = (await h.parts.users.resolve(h.tenant, 'erin')).surrogate;
      await h.parts.grants.change(
        ref,
        {
          putGrants: [
            { region: OPEN, principal: `user:${veraId}`, role: 'editor', expiresAt: null },
          ],
        },
        { actor },
      );
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'replaces the missing style with the default for a caller without structure, and says so',
      async () => {
        const r = await restore(vera);
        expect(r.status, r.text).toBe(200);
        expect(r.json.notes).toEqual({ recreated: [], replaced: ['style_def/LegalQuote'] });
        const now = (await content()).json.doc as Node;
        expect(findNode(now, (n) => n.attrs?.['id'] === 'LegalQuote')).toBeUndefined();
        const para = findNode(now, (n) => n.attrs?.['id'] === PARA)!;
        expect(para.content?.[0]).toMatchObject({ text: 'Quoted' });
        expect(para.attrs?.['style'] ?? null).not.toBe('LegalQuote');
      },
    );

    it.skipIf(skip)(
      'recreates the missing style for a caller with structure, and says so',
      async () => {
        await put(version('Plain again', false));
        const r = await restore(owner);
        expect(r.status, r.text).toBe(200);
        expect(r.json.notes).toEqual({ recreated: ['style_def/LegalQuote'], replaced: [] });
        const now = (await content()).json.doc as Node;
        expect(findNode(now, (n) => n.attrs?.['id'] === 'LegalQuote')?.type).toBe('style_def');
        expect(findNode(now, (n) => n.attrs?.['id'] === PARA)!.attrs?.['style']).toBe('LegalQuote');
      },
    );

    it.skipIf(skip)('a restore that needs no definition carries no notes', async () => {
      // The style exists now, so the same restore changes nothing about definitions.
      await put(version('Third', true));
      const r = await restore(owner);
      expect(r.status, r.text).toBe(200);
      expect(r.json).not.toHaveProperty('notes');
    });
  });
}
