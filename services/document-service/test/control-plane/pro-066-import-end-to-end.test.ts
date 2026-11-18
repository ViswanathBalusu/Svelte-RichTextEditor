// PRO-066, end to end (lane w5): a Word file of the corpus is imported through the routes of 05 §6.2
// with the real importer and the real data plane, and a client that has the document open sees the
// result. The pieces are tested one by one in src/control-plane/exp-098-import-job.test.ts (the
// routes, the job, the notifications, the refusals) and in src/data-plane/snapshot-reset.test.ts
// (the reset); this file shows that they meet:
//
// 1. `POST /documents/{id}/imports` with a ready asset and `format` `docx` returns a job (202);
// 2. `GET /imports/{jid}` gives its state and, once complete, its warnings;
// 3. the completed job raises `dep.import.completed.v1`;
// 4. the content is stored as one snapshot commit with origin `import`, and the open channel
//    receives `sync.reset` with reason `import` and the `seq` of that commit.
//
// A user token is refused on both routes (07 §12 row 13: the service credential only). Memory
// storage, as exp-098-real-importer.test.ts; the same job on PostgreSQL is in exp-098-import-job.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDocx } from '../../../../packages/export-docx/src/index.ts';
import { corpusFiles, readFile } from '../../../../packages/export-docx/test/corpus.ts';
import { DOCX_CONTENT_TYPE, type DocxImporter } from '../../src/control-plane/imports.ts';
import { DepClient } from '../data-plane/client.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

// A file of the corpus needs preserve (A2): the client announces it for the channel to open.
const FEATURES = ['presence', 'fields', 'regions', 'preserve'];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('PRO-066: import a Word file, end to end (memory)', () => {
  let h: Harness;
  const clients: DepClient[] = [];
  const importer: DocxImporter = async (bytes) => {
    const r = await importDocx(bytes);
    return { envelope: r.envelope, warnings: r.warnings };
  };

  beforeAll(async () => {
    h = await startHarness('memory', {
      importer,
      realDataPlane: true,
      config: {
        jobIdleMs: 20,
        jobLeaseMs: 20_000,
        // A file of the corpus needs preserve (A2): the plane must announce it for a channel to open.
        features: ['presence', 'regions', 'suggest-enforced', 'fields', 'extensions', 'preserve'],
      },
    });
  });
  afterAll(async () => {
    for (const c of clients) c.ws.close();
    await h?.close();
  });

  /** A document that lists the features of the file, and a ready `.docx` asset of the corpus. */
  async function documentWithAsset(): Promise<{ doc: string; asset: string }> {
    const file = corpusFiles().find((f) => f.name === 'poi/sample.docx');
    if (!file) throw new Error('missing corpus file poi/sample.docx');
    const bytes = readFile(file);
    const probe = await importDocx(bytes);
    const doc = await h.createDocument({
      content: { ...documentWithRegions(), requires: probe.envelope.requires },
    });
    const asset = uuid7();
    const sha = await h.service.assets.putFinal(h.tenant, bytes, DOCX_CONTENT_TYPE);
    await h.parts.assetRegistry.create(
      h.tenant,
      {
        id: asset,
        doc,
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
    return { doc, asset };
  }

  it('returns a job, reports it, raises the event, and resets the open channel with reason import', async () => {
    const { doc, asset } = await documentWithAsset();

    // A client has the document open before the import.
    const owner = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    clients.push(owner);
    expect(
      (
        await owner.hello(h.userToken({ [doc]: 'owner' }, { sub: 'u-owner' }), {
          features: FEATURES,
        })
      ).t,
    ).toBe('welcome');
    const opened = await owner.open(1, doc, { features: FEATURES });
    if (opened.t !== 'ch.opened') throw new Error(JSON.stringify(opened.d));
    const before = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    expect(JSON.stringify(before.json.doc)).toContain('Liability');
    const completedBefore = h.events.of('dep.import.completed.v1').length;

    // A user token, even the owner's, is refused on both routes (07 §12 row 13).
    const userToken = h.userToken({ [doc]: 'owner' }, { sub: 'u-owner' });
    const refused = await h.call('POST', `/v1/documents/${doc}/imports`, {
      token: userToken,
      body: { asset, format: 'docx' },
    });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('forbidden');

    // Criterion 1: a ready asset and `docx` give a job.
    const accepted = await h.call('POST', `/v1/documents/${doc}/imports`, {
      token: h.apiKey,
      body: { asset, format: 'docx' },
    });
    expect(accepted.status, accepted.text).toBe(202);
    expect(typeof accepted.json.id).toBe('string');
    const jobPath = `/v1/imports/${accepted.json.id}`;
    const userGet = await h.call('GET', jobPath, { token: userToken });
    expect(userGet.status).toBe(403);

    // Criterion 2: the state, and the warnings once the job is complete.
    let job: Record<string, unknown> = {};
    for (let i = 0; i < 600 && job['state'] !== 'completed' && job['state'] !== 'failed'; i++) {
      job = (await h.call('GET', jobPath, { token: h.apiKey })).json;
      await sleep(25);
    }
    expect(job['error'] ?? null).toBeNull();
    expect(job['state']).toBe('completed');
    expect(Array.isArray(job['warnings'])).toBe(true);
    expect(typeof job['seq']).toBe('number');

    // Criterion 3: the completed job raises its webhook event once.
    expect(h.events.of('dep.import.completed.v1').length).toBe(completedBefore + 1);

    // Criterion 4: one snapshot commit with origin `import`, and `sync.reset` with reason `import`
    // on the open channel, naming that commit's `seq`.
    const reset = await owner.take(
      (m) => m.t === 'sync.reset' && (m.d as { reason?: string }).reason === 'import',
      5000,
      'sync.reset with reason import',
    );
    expect((reset.d as { seq: number }).seq).toBe(job['seq']);
    // The snapshot is the reset point of the commit log (the reset field), not a commit that is replayed.
    const commits = await h.call('GET', `/v1/documents/${doc}/commits?after=0`, {
      token: h.apiKey,
    });
    expect(commits.status, commits.text).toBe(200);
    expect(commits.json.reset).toEqual({ seq: job['seq'] });
    // The history names the origin of that commit.
    const history = await h.call('GET', `/v1/documents/${doc}/history`, { token: h.apiKey });
    expect(history.status, history.text).toBe(200);
    const origins = (history.json.items as Array<{ origins?: string[] }>).flatMap(
      (g) => g.origins ?? [],
    );
    expect(origins).toContain('import');
    const after = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    expect(JSON.stringify(after.json.doc)).not.toContain('Liability');
    expect(after.json.seq).toBe(job['seq']);
  });
});
