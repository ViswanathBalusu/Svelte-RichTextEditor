/**
 * PRM-066 criterion 2 — setting or clearing `confidential`, and changing a grant on a confidential
 * region, need `manage`. Each case runs over the wire against the real document service (memory
 * storage; the PostgreSQL variant skips without the integration environment), as a document-level
 * editor who has no `manage`, and checks that the refusal happens and that nothing changes. The
 * owner's own commit and grant change are the controls.
 *
 * The grant refusal answers HTTP 403 from the control plane (the same answer as PRM-057 row 10);
 * the commit refusals answer `sync.reject` with `permission_denied`.
 */
import { AttrStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { at, loadDoc, stepsJson } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

const OPEN = 'rOpen00000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`PRM-066 confidential rights need manage (${storage})`, () => {
    let h: Harness;
    let doc: string;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a, documentWithRegions());
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    /** The stored content, as the service serves it, with its current seq. */
    const current = async () => {
      const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
      expect(r.status).toBe(200);
      return { doc: loadDoc(r.json.doc as unknown), seq: Number(r.json.seq ?? 0) };
    };

    /** Submits one policy change on the open region as `token`, on the current content. */
    const setPolicy = async (token: string, policy: string) => {
      const cur = await current();
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        await c.hello(token);
        await c.open(1, doc);
        return await c.submit(1, {
          id: uuid7(),
          base: cur.seq,
          steps: stepsJson([new AttrStep(at(cur.doc, OPEN), 'policy', policy)]),
        });
      } finally {
        c.terminate();
      }
    };

    /** The grants answer and its ETag, read as the host. */
    const grantsOf = async () => {
      const r = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
      expect(r.status).toBe(200);
      return { etag: r.headers.get('etag')!, json: r.json };
    };

    t()('an editor without manage cannot set confidential on a region', async () => {
      const editor = await h.mintToken(h.a, 'editor-prm066-set', { [doc]: 'editor' });
      const before = await current();
      const r = await setPolicy(editor, 'confidential');
      expect(r.t).toBe('sync.reject');
      expect(r.d?.['code']).toBe('permission_denied');
      expect((await current()).doc.toJSON()).toEqual(before.doc.toJSON());
    });

    t()('an owner can set confidential, the control for the refusals below', async () => {
      const owner = await h.mintToken(h.a, 'owner-prm066', { [doc]: 'owner' });
      const r = await setPolicy(owner, 'confidential');
      expect(r.t).toBe('sync.ack');
      const after = await current();
      expect(after.doc.nodeAt(at(after.doc, OPEN))!.attrs['policy']).toBe('confidential');
    });

    t()('an editor without manage cannot clear confidential', async () => {
      const editor = await h.mintToken(h.a, 'editor-prm066-clear', { [doc]: 'editor' });
      const before = await current();
      const r = await setPolicy(editor, 'inherit');
      expect(r.t).toBe('sync.reject');
      expect(r.d?.['code']).toBe('permission_denied');
      const after = await current();
      expect(after.doc.nodeAt(at(after.doc, OPEN))!.attrs['policy']).toBe('confidential');
      expect(after.doc.toJSON()).toEqual(before.doc.toJSON());
    });

    t()('an editor without manage cannot change a grant on the confidential region', async () => {
      const editor = await h.mintToken(h.a, 'editor-prm066-grant', { [doc]: 'editor' });
      const g = await grantsOf();
      const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: editor,
        headers: { 'If-Match': g.etag },
        body: { grants: [{ region: OPEN, principal: 'user:mallory', role: 'editor' }] },
      });
      expect(r.status).toBe(403);
      // The control plane answers `forbidden`, not `permission_denied`: the criterion's wording is
      // open (see the story's Notes). The commit half above is `permission_denied`.
      expect(r.json?.['code'], r.text).toBe('forbidden');
      const after = await grantsOf();
      expect(JSON.stringify(after.json)).not.toContain('mallory');
    });

    t()(
      'an owner can change a grant on the same region, the control for the refusal above',
      async () => {
        const owner = await h.mintToken(h.a, 'owner-prm066-grant', { [doc]: 'owner' });
        const g = await grantsOf();
        const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: owner,
          headers: { 'If-Match': g.etag },
          body: { grants: [{ region: OPEN, principal: 'user:ophelia', role: 'viewer' }] },
        });
        expect(r.status).toBe(200);
      },
    );
  });
}
