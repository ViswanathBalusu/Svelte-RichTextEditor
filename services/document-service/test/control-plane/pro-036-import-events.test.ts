// PRO-036 criterion 5: an import job that ends sends `import.completed` or `import.failed` with the
// job as `resource`. The real importer and the real data plane run behind the routes of 05 §6.2, and
// a client that has the document open (as the user who asked for the import) reads the event from
// its channel. Another user's channel gets nothing. Memory storage; the job itself on PostgreSQL is
// in src/control-plane/exp-098-import-job.test.ts.
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

describe('PRO-036: import events reach the requester (memory)', () => {
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
        features: ['presence', 'regions', 'suggest-enforced', 'fields', 'extensions', 'preserve'],
      },
    });
  });
  afterAll(async () => {
    for (const c of clients) c.ws.close();
    await h?.close();
  });

  /** A document that lists the features of the file, and a ready asset holding `bytes`. */
  async function documentWithAsset(bytes: Uint8Array, requires: string[]) {
    const doc = await h.createDocument({ content: { ...documentWithRegions(), requires } });
    const asset = uuid7();
    const sha = await h.service.assets.putFinal(h.tenant, bytes, DOCX_CONTENT_TYPE);
    await h.parts.assetRegistry.create(
      h.tenant,
      {
        id: asset,
        doc,
        filename: 'file.docx',
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

  async function open(doc: string, sub: string): Promise<DepClient> {
    const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    clients.push(c);
    expect(
      (await c.hello(h.userToken({ [doc]: 'owner' }, { sub }), { features: FEATURES })).t,
    ).toBe('welcome');
    const opened = await c.open(1, doc, { features: FEATURES });
    if (opened.t !== 'ch.opened') throw new Error(JSON.stringify(opened.d));
    return c;
  }

  /** Starts the import as the service credential acting for `sub`, and returns the job. */
  async function start(doc: string, asset: string, sub: string): Promise<string> {
    const accepted = await h.call('POST', `/v1/documents/${doc}/imports`, {
      token: h.apiKey,
      headers: { 'dep-actor': sub },
      body: { asset, format: 'docx' },
    });
    expect(accepted.status, accepted.text).toBe(202);
    return accepted.json.id as string;
  }

  const events = (c: DepClient, type: string) =>
    c.all('event', 1).filter((m) => (m.d as { type?: string }).type === type);

  it('sends import.completed with the job as resource to the requester only', async () => {
    const file = corpusFiles().find((f) => f.name === 'poi/sample.docx');
    if (!file) throw new Error('missing corpus file poi/sample.docx');
    const bytes = readFile(file);
    const { doc, asset } = await documentWithAsset(
      bytes,
      (await importDocx(bytes)).envelope.requires,
    );
    const requester = await open(doc, 'u-requester');
    const other = await open(doc, 'u-other');

    const job = await start(doc, asset, 'u-requester');

    const got = await requester.take(
      (m) => m.t === 'event' && (m.d as { type?: string }).type === 'import.completed',
      10_000,
      'import.completed',
    );
    expect(got.d).toMatchObject({ type: 'import.completed', resource: `/imports/${job}` });
    expect((got.d as { data: { state: string } }).data.state).toBe('completed');
    await sleep(100);
    expect(events(other, 'import.completed')).toHaveLength(0);
    expect(events(requester, 'import.failed')).toHaveLength(0);
  });

  it('sends import.failed with the job as resource when the file cannot be read', async () => {
    const { doc, asset } = await documentWithAsset(new TextEncoder().encode('not a zip file'), []);
    const requester = await open(doc, 'u-requester');
    const other = await open(doc, 'u-other');

    const job = await start(doc, asset, 'u-requester');

    const got = await requester.take(
      (m) => m.t === 'event' && (m.d as { type?: string }).type === 'import.failed',
      10_000,
      'import.failed',
    );
    expect(got.d).toMatchObject({ type: 'import.failed', resource: `/imports/${job}` });
    expect((got.d as { data: { state: string } }).data.state).toBe('failed');
    await sleep(100);
    expect(events(other, 'import.failed')).toHaveLength(0);
    expect(events(requester, 'import.completed')).toHaveLength(0);
  });
});
