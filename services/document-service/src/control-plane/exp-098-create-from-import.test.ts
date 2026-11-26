// EXP-098 criterion 6 (owner decision 108): `POST /documents` with an import. The file is read, the
// document is created, the source file is attached to it, and the content is written as an import
// snapshot; a failed import leaves no document. The importer is a stand-in (see
// exp-098-import-job.test.ts); the document, asset record, commit and removal are the service's own.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';
import { DOCX_CONTENT_TYPE, type DocxImporter } from './imports.ts';

type Content = {
  requires: string[];
  doc: { content: Array<{ content: Array<Record<string, unknown>> }> };
};

function contentFor(text: string, requires: string[] = []): Content {
  const c = JSON.parse(JSON.stringify(documentWithRegions())) as Content;
  c.requires = requires;
  c.doc.content[1]!.content = [
    {
      type: 'paragraph',
      attrs: { id: 'pImport000000001', style: 'Normal' },
      content: [{ type: 'text', text }],
    },
  ];
  return c;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a new document from an import (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const importer: DocxImporter = async (bytes) => {
      const text = new TextDecoder().decode(bytes);
      if (text === 'refuse') throw new Error('macro-enabled files are refused');
      if (text === 'invalid') {
        // Two paragraphs with one identifier break I3.
        const bad = contentFor(text);
        bad.doc.content[1]!.content.push(bad.doc.content[1]!.content[0]!);
        return { envelope: bad, warnings: [] };
      }
      return { envelope: contentFor(text), warnings: ['floating object placed inline'] };
    };

    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          importer,
          realDataPlane: true,
          config: { jobIdleMs: 20, jobLeaseMs: 2000 },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A ready `.docx` asset of the tenant, uploaded for a staging document. */
    async function stagedAsset(text: string, contentType = DOCX_CONTENT_TYPE): Promise<string> {
      const staging = await h.createDocument({ content: documentWithRegions() });
      const asset = uuid7();
      const bytes = new TextEncoder().encode(text);
      const sha = await h.service.assets.putFinal(h.tenant, bytes, contentType);
      await h.parts.assetRegistry.create(
        h.tenant,
        {
          id: asset,
          doc: staging,
          filename: 'draft.docx',
          mime: contentType,
          declaredBytes: bytes.length,
          createdBy: 'system',
          uploadExpiresAt: h.now() + 60_000,
        },
        h.now(),
      );
      await h.parts.assetRegistry.settleReady(
        h.tenant,
        asset,
        {
          sha256: sha,
          bytes: bytes.length,
          contentType,
          objectKey: `test/${asset}`,
          width: null,
          height: null,
          frames: null,
          renditions: [],
        },
        h.now(),
      );
      return asset;
    }

    const create = (body: Record<string, unknown>) =>
      h.call('POST', '/v1/documents', { token: h.apiKey, body });

    const liveIds = async (): Promise<string[]> => {
      const r = await h.call('GET', '/v1/documents', { token: h.apiKey });
      return (r.json.items as Array<{ id: string }>).map((i) => i.id);
    };

    it.skipIf(skip)('opens the new document with the imported content', async () => {
      const asset = await stagedAsset('Imported at creation');
      const r = await create({ import: asset, title: 'From Word' });
      expect(r.status).toBe(201);
      const id = r.json.id as string;
      expect(r.json.title).toBe('From Word');
      expect(r.json.import.warnings).toEqual([{ message: 'floating object placed inline' }]);
      const content = await h.call('GET', `/v1/documents/${id}/content`, { token: h.apiKey });
      expect(content.status).toBe(200);
      expect(JSON.stringify(content.json.doc)).toContain('Imported at creation');
      expect(content.json.seq).toBeGreaterThan(0);
      // The source file is attached to the new document, over the same stored bytes.
      const attached = await h.parts.assetRegistry.readyFor(h.tenant, id);
      expect(attached.map((a) => a.id)).toEqual([r.json.import.asset]);
      expect(attached[0]!.sha256).toBe((await h.parts.assetRegistry.get(h.tenant, asset))!.sha256);
      // The content is a snapshot commit with origin `import`.
      const commits = await h.call('GET', `/v1/documents/${id}/commits?after=0`, {
        token: h.apiKey,
      });
      expect(commits.json.reset).toEqual({ seq: content.json.seq });
      if (h.db) {
        const row = await h.db.admin.query(
          'SELECT kind, origin FROM doc_commits WHERE doc_id = $1 AND seq = $2',
          [id, content.json.seq],
        );
        expect(row.rows).toEqual([{ kind: 'snapshot', origin: 'import' }]);
      }
    });

    it.skipIf(skip)('refuses a file the importer refuses, and leaves no document', async () => {
      const asset = await stagedAsset('refuse');
      const before = await liveIds();
      const r = await create({ import: asset });
      expect(r.status).toBe(400);
      expect(await liveIds()).toEqual(before);
    });

    it.skipIf(skip)('removes the new document when the content breaks the model', async () => {
      const asset = await stagedAsset('invalid');
      const before = await liveIds();
      const r = await create({ import: asset });
      expect(r.status).toBe(400);
      expect(await liveIds()).toEqual(before);
    });

    it.skipIf(skip)(
      'refuses an asset that is missing or not a Word file, and two sources',
      async () => {
        expect((await create({ import: uuid7() })).status).toBe(404);
        const pdf = await stagedAsset('z', 'application/pdf');
        expect((await create({ import: pdf })).status).toBe(400);
        const both = await create({
          import: await stagedAsset('x'),
          content: documentWithRegions(),
        });
        expect(both.status).toBe(400);
      },
    );
  });
}
