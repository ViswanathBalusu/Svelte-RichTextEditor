// HIS-019 criterion 1 over HTTP (lane V-HIS-017-032): `POST /v1/documents/{id}/restore` for a whole
// document. The real data plane stands behind the route (not the stub), so the restore is a snapshot
// commit with reason `restore` in the log; memory and PostgreSQL storage (docedit-test-postgres).
// Steps:
//   seq 0 the fixture; seq 1 and seq 2 are two replacements made with PUT /content (import);
//   the owner restores to seq 0: pre-restore version at 2, snapshot commit at 3 with reason restore,
//   restore version at 3, and the content read back is the content of seq 0.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

/** The fixture with its first text run replaced, so that a replacement is a different content. */
function edited(text: string): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(documentWithRegions())) as Record<string, unknown>;
  const walk = (n: unknown): boolean => {
    if (!n || typeof n !== 'object') return false;
    const node = n as { type?: unknown; text?: unknown; content?: unknown[] };
    if (node.type === 'text' && typeof node.text === 'string') {
      node.text = text;
      return true;
    }
    for (const c of node.content ?? []) if (walk(c)) return true;
    return false;
  };
  if (!walk(doc['doc'])) throw new Error('the fixture has no text run');
  return doc;
}

/** The node types and the text runs of a document, in order. */
function blocksOf(doc: unknown): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { type?: unknown; text?: unknown; content?: unknown[] };
    if (typeof node.type === 'string')
      out.push([node.type, typeof node.text === 'string' ? node.text : null]);
    for (const c of node.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`restore the whole document over HTTP (${storage}, HIS-019 criterion 1)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    let original: unknown;

    /** The current etag of the content, for PUT /content. */
    const etag = async () =>
      (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).headers.get(
        'etag',
      );

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      doc = await h.createDocument({ content: documentWithRegions(), title: 'Restore' });
      original = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).json
        .doc;
      // seq 1 and seq 2: two replacements by the service credential (origin import).
      const first = await h.call('PUT', `/v1/documents/${doc}/content`, {
        token: h.apiKey,
        body: edited('First replacement'),
        headers: { 'If-Match': (await etag())! },
      });
      expect(first.status).toBe(204);
      const second = await h.call('PUT', `/v1/documents/${doc}/content`, {
        token: h.apiKey,
        body: edited('Second replacement'),
        headers: { 'If-Match': (await etag())! },
      });
      expect(second.status).toBe(204);
    });

    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'refuses a user without manage with forbidden, and changes nothing',
      async () => {
        const editor = h.userToken({ [doc]: 'editor' });
        const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: editor,
          body: { toSeq: 0 },
        });
        expect(r.status).toBe(403);
        expect(r.json.code).toBe('forbidden');
        const head = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        expect(head.json.seq).toBe(2);
      },
    );

    it.skipIf(skip)('refuses a seq above the head as not_found', async () => {
      const owner = h.userToken({ [doc]: 'owner' });
      const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
        token: owner,
        body: { toSeq: 9 },
      });
      expect(r.status).toBe(404);
      expect(r.json.code).toBe('not_found');
    });

    it.skipIf(skip)('refuses a body without a valid toSeq as validation_failed', async () => {
      const owner = h.userToken({ [doc]: 'owner' });
      const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
        token: owner,
        body: { toSeq: -1 },
      });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('validation_failed');
    });

    it.skipIf(skip)(
      'records a pre-restore version, a snapshot with reason restore and a restore version (criterion 1)',
      async () => {
        const owner = h.userToken({ [doc]: 'owner' });
        const r = await h.call('POST', `/v1/documents/${doc}/restore`, {
          token: owner,
          body: { toSeq: 0 },
        });
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ seq: 3, toSeq: 0, preRestoreSeq: 2 });

        // The content is the content of seq 0 again.
        const head = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        expect(head.json.seq).toBe(3);
        // The restored content has the block types and the text of seq 0. The stored snapshot is the
        // minimal form of the content (defaults and empty attributes are not kept), so the whole
        // object is not compared: that is a difference of representation, not of content.
        expect(blocksOf(head.json.doc)).toEqual(blocksOf(original));
        expect(blocksOf(head.json.doc).length).toBeGreaterThan(3);

        // The snapshot commit at seq 3 carries reason restore; the earlier commits are untouched.
        const ref: DocRef = { tenant: h.tenant, doc };
        const [commit] = await h.parts.logs.read(ref, 3, 3);
        expect(commit).toMatchObject({ seq: 3, kind: 'snapshot', origin: 'restore' });
        const earlier = await h.parts.logs.read(ref, 1, 2);
        expect(earlier.map((c) => c.seq)).toEqual([1, 2]);

        // The two versions are recorded: pre-restore at the head before, restore at the new seq.
        const pre = await h.parts.versions!.list(ref, { kind: 'pre-restore' });
        expect(pre.map((v) => v.seq)).toEqual([2]);
        const restored = await h.parts.versions!.list(ref, { kind: 'restore' });
        expect(restored.map((v) => v.seq)).toEqual([3]);
      },
    );
  });
}
