// EXP-099 criterion 1 through the service: the node's importer is the one that runs in the Podman
// sandbox (no network, no credentials; image of services/asset-worker/scripts/build-import-image.ts),
// and a real Word file of the corpus becomes a new document by `POST /documents` with an import
// (EXP-098 criterion 6). Skips when Podman or the image is
// not there (`DOCEDIT_IMPORT_IMAGE` names the image).
import {
  importSandboxReady,
  podmanImportSandbox,
  sandboxedDocxImporter,
} from '@docedit/asset-worker';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { corpusFiles, readFile } from '../../../../packages/export-docx/test/corpus.ts';
import { DOCX_CONTENT_TYPE } from '../../src/control-plane/imports.ts';
import { startHarness, type Harness } from './support.ts';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await importSandboxReady();

describe.skipIf(!ready)('the import job and the new document use the sandboxed importer', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', {
      importer: sandboxedDocxImporter(podmanImportSandbox({ limits: { wallSeconds: 120 } })),
      realDataPlane: true,
      config: { jobIdleMs: 20, jobLeaseMs: 240_000 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  async function stagedAsset(bytes: Uint8Array): Promise<string> {
    const staging = await h.createDocument();
    const asset = uuid7();
    const sha = await h.service.assets.putFinal(h.tenant, bytes, DOCX_CONTENT_TYPE);
    await h.parts.assetRegistry.create(
      h.tenant,
      {
        id: asset,
        doc: staging,
        filename: 'sample.docx',
        mime: DOCX_CONTENT_TYPE,
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
        contentType: DOCX_CONTENT_TYPE,
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

  it('opens a new document with the content a Word file had, imported in the sandbox', async () => {
    const file = corpusFiles().find((f) => f.name === 'poi/sample.docx')!;
    const asset = await stagedAsset(readFile(file));
    const r = await h.call('POST', '/v1/documents', { token: h.apiKey, body: { import: asset } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const content = await h.call('GET', `/v1/documents/${r.json.id}/content`, {
      token: h.apiKey,
    });
    expect(content.json.seq).toBeGreaterThan(0);
    expect(JSON.stringify(content.json.doc)).toContain('"type":"style_def"');
    expect(Array.isArray(r.json.import.warnings)).toBe(true);
  });

  it('refuses a file that is not a Word package, with the importer message, and keeps no document', async () => {
    const asset = await stagedAsset(new TextEncoder().encode('not a zip'));
    const before = (await h.call('GET', '/v1/documents', { token: h.apiKey })).json.items.length;
    const r = await h.call('POST', '/v1/documents', { token: h.apiKey, body: { import: asset } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain('the Word file was refused');
    expect((await h.call('GET', '/v1/documents', { token: h.apiKey })).json.items.length).toBe(
      before,
    );
  });
});
