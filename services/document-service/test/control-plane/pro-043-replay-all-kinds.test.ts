// Idempotency keys on every creating route of 05 §6.1 (PRO-043 criterion 1): a second identical
// POST with the same key returns the first answer and creates nothing, for documents, versions,
// threads, comments, assets, exports, imports and webhooks. Documents and exports are covered by
// `idempotency.test.ts`, assets and webhooks by `pro-043-replay-routes.test.ts`; this file covers
// versions, threads, comments and imports and counts what each route created. In memory and with
// PostgreSQL (PostgreSQL runs when a database is reachable, as in the neighbouring tests).
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCX_CONTENT_TYPE, type DocxImporter } from '../../src/control-plane/imports.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const BLOCK = 'pIntro0000000001';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The content the stand-in importer returns (as the import-job tests do). */
function imported(): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(documentWithRegions())) as {
    doc: { content: Array<{ content: Array<Record<string, unknown>> }> };
  };
  c.doc.content[1]!.content = [
    {
      type: 'paragraph',
      attrs: { id: 'pImport000000001', style: 'Normal' },
      content: [{ type: 'text', text: 'imported' }],
    },
  ];
  return c;
}

const importer: DocxImporter = async () => ({ envelope: imported(), warnings: [] });

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`idempotent creating routes, versions, threads, comments, imports (${storage})`, async () => {
    const skip = await skipReason(storage);
    // `h` has the stub data plane, which records the notices; `hi` runs the import job.
    let h: Harness;
    let hi: Harness;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        hi = await startHarness(storage, {
          importer,
          realDataPlane: true,
          config: { jobIdleMs: 20, jobLeaseMs: 2000 },
        });
      }
    });
    afterAll(async () => {
      await h?.close();
      await hi?.close();
    });

    const key = () => ({ 'Idempotency-Key': `k-${randomUUID()}` });

    it.skipIf(skip)(
      'replays a thread create and a comment create, creating each once',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const token = () => h.userToken({ [doc]: 'editor' }, { sub: 'ed-1' });
        const path = `/v1/documents/${doc}/threads`;
        const body = { target: { block: BLOCK }, comment: { text: 'Is this right?' } };
        const headers = key();
        const first = await h.call('POST', path, { token: token(), body, headers });
        expect(first.status, first.text).toBe(201);
        const second = await h.call('POST', path, { token: token(), body, headers });
        expect(second.status).toBe(201);
        expect(second.json).toEqual(first.json);
        expect(second.headers.get('dep-idempotent-replayed')).toBe('true');
        const listed = await h.call('GET', path, { token: token() });
        expect((listed.json.items as unknown[]).length).toBe(1);

        const tid: string = first.json.id;
        const commentPath = `/v1/threads/${tid}/comments`;
        const commentBody = { text: 'A reply.' };
        const commentHeaders = key();
        const c1 = await h.call('POST', commentPath, {
          token: token(),
          body: commentBody,
          headers: commentHeaders,
        });
        expect(c1.status, c1.text).toBe(201);
        const c2 = await h.call('POST', commentPath, {
          token: token(),
          body: commentBody,
          headers: commentHeaders,
        });
        expect(c2.status).toBe(201);
        expect(c2.json).toEqual(c1.json);
        expect(c2.headers.get('dep-idempotent-replayed')).toBe('true');
        // One `comment.created` for the reply (the opening comment raises `thread.created`): the
        // replay raised nothing and stored nothing.
        const told = h.stub.notices.filter(
          (n) =>
            n.kind === 'notify' &&
            n.notification?.type === 'comment.created' &&
            (n.notification.data as { thread?: string } | undefined)?.thread === tid,
        );
        expect(told).toHaveLength(1);
      },
    );

    it.skipIf(skip)('replays a version create and stores one version', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const token = () => h.userToken({ [doc]: 'editor' });
      const path = `/v1/documents/${doc}/versions`;
      const body = { name: 'Sent to legal' };
      const headers = key();
      const first = await h.call('POST', path, { token: token(), body, headers });
      expect(first.status, first.text).toBe(201);
      const before = h.events.of('dep.version.created.v1').length;
      const second = await h.call('POST', path, { token: token(), body, headers });
      expect(second.status).toBe(201);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('dep-idempotent-replayed')).toBe('true');
      expect(h.events.of('dep.version.created.v1').length).toBe(before);
      const listed = await h.call('GET', path, { token: token() });
      const named = (listed.json.items as Array<{ name?: string }>).filter(
        (v) => v.name === 'Sent to legal',
      );
      expect(named).toHaveLength(1);
    });

    it.skipIf(skip)('replays an import create and queues one job', async () => {
      const doc = await hi.createDocument({ content: documentWithRegions() });
      const asset = uuid7();
      const bytes = new TextEncoder().encode('draft');
      const sha = await hi.service.assets.putFinal(hi.tenant, bytes, DOCX_CONTENT_TYPE);
      await hi.parts.assetRegistry.create(
        hi.tenant,
        {
          id: asset,
          doc,
          filename: 'draft.docx',
          mime: DOCX_CONTENT_TYPE,
          declaredBytes: bytes.length,
          createdBy: 'system',
          uploadExpiresAt: hi.now() + 60_000,
        },
        hi.now(),
      );
      await hi.parts.assetRegistry.settleReady(
        hi.tenant,
        asset,
        {
          sha256: sha,
          bytes: bytes.length,
          contentType: DOCX_CONTENT_TYPE,
          objectKey: `test/${asset}`,
          width: null,
          height: null,
          frames: null,
          renditions: [],
        },
        hi.now(),
      );
      const path = `/v1/documents/${doc}/imports`;
      const body = { asset, format: 'docx' };
      const headers = key();
      const first = await hi.call('POST', path, { token: hi.apiKey, body, headers });
      expect(first.status, first.text).toBe(202);
      const second = await hi.call('POST', path, { token: hi.apiKey, body, headers });
      expect(second.status).toBe(202);
      expect(second.json.id).toBe(first.json.id);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('dep-idempotent-replayed')).toBe('true');
      // The job runs once and ends; a replay after the end still names the same job.
      let state = '';
      for (let i = 0; i < 400 && state !== 'completed' && state !== 'failed'; i++) {
        state = (await hi.call('GET', `/v1/imports/${first.json.id}`, { token: hi.apiKey })).json
          .state;
        await sleep(25);
      }
      expect(state).toBe('completed');
      const third = await hi.call('POST', path, { token: hi.apiKey, body, headers });
      expect(third.json.id).toBe(first.json.id);
    });
  });
}
