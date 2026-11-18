// Word import jobs (EXP-098 criteria 1 to 5, and EXP-109 criterion 1): the routes, the job, the
// notifications and webhooks, the version of kind `import`, and the refusals. Runs over the control
// plane's HTTP surface, in memory and on PostgreSQL. The importer is a stand-in that returns CDM
// content (the package of the real importer is not a dependency of this service); the stored
// content, the version and the order of checks are the service's own.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from '../../test/control-plane/support.ts';
import type { DocRef } from '../storage/types.ts';
import { DOCX_CONTENT_TYPE, type DocxImporter } from './imports.ts';

const LEGAL = 'rLegal0000000001';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The content the stand-in importer returns for a file whose bytes are a text. */
function contentFor(text: string, extra: Record<string, unknown>[] = []): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(documentWithRegions())) as {
    doc: { content: Array<{ content: Array<Record<string, unknown>> }> };
  };
  // A body of one paragraph, so that the regions of the fixture are gone.
  c.doc.content[1]!.content = [
    {
      type: 'paragraph',
      attrs: { id: 'pImport000000001', style: 'Normal' },
      content: [{ type: 'text', text }],
    },
    ...extra,
  ];
  return c;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`import jobs (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    /** What the stand-in importer was given, and what it does next. */
    const seen: Uint8Array[] = [];
    let behaviour: 'ok' | 'refuse' | 'invalid' = 'ok';
    /** While set, the importer waits for it. */
    let hold: Promise<void> | null = null;
    const importer: DocxImporter = async (bytes) => {
      seen.push(bytes);
      if (hold) await hold;
      if (behaviour === 'refuse') throw new Error('macro-enabled files are refused');
      const text = new TextDecoder().decode(bytes);
      if (behaviour === 'invalid')
        // Two paragraphs with one identifier break I3.
        return {
          envelope: contentFor(text, [
            {
              type: 'paragraph',
              attrs: { id: 'pImport000000001', style: 'Normal' },
              content: [{ type: 'text', text: 'again' }],
            },
          ]),
          warnings: [],
        };
      return {
        envelope: contentFor(text),
        warnings: ['floating object placed inline', { message: 'font substituted', part: 'fonts' }],
      };
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

    /** A document and a ready `.docx` asset for it, whose bytes are `text`. */
    async function withAsset(
      text: string,
      contentType = DOCX_CONTENT_TYPE,
    ): Promise<{ doc: string; asset: string }> {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const asset = uuid7();
      const bytes = new TextEncoder().encode(text);
      const sha = await h.service.assets.putFinal(h.tenant, bytes, contentType);
      await h.parts.assetRegistry.create(
        h.tenant,
        {
          id: asset,
          doc,
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
      return { doc, asset };
    }

    const post = (doc: string, asset: string, body: Record<string, unknown> = {}) =>
      h.call('POST', `/v1/documents/${doc}/imports`, {
        token: h.apiKey,
        body: { asset, format: 'docx', ...body },
      });

    async function reach(job: string, states: string[]) {
      let last: unknown = null;
      for (let i = 0; i < 300; i++) {
        const r = await h.call('GET', `/v1/imports/${job}`, { token: h.apiKey });
        last = r.json;
        if (states.includes(r.json?.state)) return r;
        await sleep(20);
      }
      throw new Error(
        `import ${job} did not reach ${states.join(' or ')}; last ${JSON.stringify(last)}`,
      );
    }

    const textOf = async (doc: string): Promise<string[]> => {
      const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const texts: string[] = [];
      const walk = (n: { type?: string; text?: string; content?: unknown[] }): void => {
        if (n.type === 'text' && n.text) texts.push(n.text);
        for (const c of n.content ?? []) walk(c as never);
      };
      walk(r.json.doc);
      return texts;
    };

    it.skipIf(skip)(
      'returns a job and reports its state and, once complete, its warnings (EXP-098 criterion 1)',
      async () => {
        behaviour = 'ok';
        const { doc, asset } = await withAsset('Imported text');
        const accepted = await post(doc, asset);
        expect(accepted.status).toBe(202);
        const id = accepted.json.id as string;
        expect(accepted.headers.get('location')).toContain(`/imports/${id}`);
        const done = await reach(id, ['completed']);
        expect(done.json.warnings).toEqual([
          { message: 'floating object placed inline' },
          { message: 'font substituted', part: 'fonts' },
        ]);
        expect(new TextDecoder().decode(seen.at(-1)!)).toBe('Imported text');
        // A user token is no service credential (07 §12): refused before the route runs.
        const user = h.userToken({ [doc]: 'owner' });
        expect(
          (
            await h.call('POST', `/v1/documents/${doc}/imports`, {
              token: user,
              body: { asset, format: 'docx' },
            })
          ).status,
        ).toBe(403);
      },
    );

    it.skipIf(skip)(
      'refuses a request that names no ready Word asset of the document',
      async () => {
        const { doc, asset } = await withAsset('x');
        const other = await withAsset('y');
        expect((await post(doc, other.asset)).status).toBe(404);
        expect((await post(doc, uuid7())).status).toBe(404);
        expect((await post(doc, asset, { format: 'odt' })).status).toBe(400);
        const pdf = await withAsset('z', 'application/pdf');
        expect((await post(pdf.doc, pdf.asset)).status).toBe(400);
      },
    );

    it.skipIf(skip)(
      'stores the content as a commit, adds an import version, and raises the event and webhook (EXP-098 criteria 2 and 3)',
      async () => {
        behaviour = 'ok';
        const { doc, asset } = await withAsset('Stored by the job');
        const permsBefore = await h.parts.grants.current({ tenant: h.tenant, doc });
        const id = (await post(doc, asset)).json.id as string;
        const done = await reach(id, ['completed']);
        const seq = done.json.seq as number;
        expect(seq).toBeGreaterThan(0);
        expect(await textOf(doc)).toEqual(['Stored by the job']);
        const commits = await h.call('GET', `/v1/documents/${doc}/commits?after=0`, {
          token: h.apiKey,
        });
        // A snapshot commit: a reader behind it is sent the reset point, not the commit (05 §6.2).
        expect(commits.json.reset).toEqual({ seq });
        if (h.db) {
          const row = await h.db.admin.query(
            `SELECT kind, origin FROM doc_commits WHERE doc_id = $1 AND seq = $2`,
            [doc, seq],
          );
          expect(row.rows).toEqual([{ kind: 'snapshot', origin: 'import' }]);
        }
        const ref: DocRef = { tenant: h.tenant, doc };
        const versions = await h.parts.versions!.list(ref, { kind: 'import' });
        expect(versions.map((v) => ({ seq: v.seq, kind: v.kind }))).toEqual([
          { seq, kind: 'import' },
        ]);
        for (
          let i = 0;
          i < 100 && !h.events.of('dep.import.completed.v1').some((e) => e.data['job'] === id);
          i++
        )
          await sleep(20);
        expect(
          h.events.of('dep.import.completed.v1').find((e) => e.data['job'] === id),
        ).toMatchObject({
          subject: doc,
          data: { seq, job: id },
        });
        // The import creates no grants and no workflow state (criterion 5).
        expect(await h.parts.grants.current(ref)).toEqual(permsBefore);
      },
    );

    it.skipIf(skip)(
      'fails the job with the reason, stores nothing and raises import.failed and its webhook (EXP-098 criterion 3)',
      async () => {
        behaviour = 'refuse';
        const { doc, asset } = await withAsset('Refused');
        const id = (await post(doc, asset)).json.id as string;
        const failed = await reach(id, ['failed']);
        expect(failed.json.error).toMatchObject({ code: 'validation_failed' });
        expect(failed.json.error.message).toContain('macro-enabled');
        for (
          let i = 0;
          i < 100 && !h.events.of('dep.import.failed.v1').some((e) => e.data['job'] === id);
          i++
        )
          await sleep(20);
        expect(h.events.of('dep.import.failed.v1').find((e) => e.data['job'] === id)).toMatchObject(
          {
            subject: doc,
            data: { job: id, code: 'validation_failed' },
          },
        );
        expect(await textOf(doc)).toContain('Hello');
      },
    );

    it.skipIf(skip)(
      'checks the imported content against the model before the commit and stores nothing when it fails (EXP-109 criterion 1)',
      async () => {
        behaviour = 'invalid';
        const { doc, asset } = await withAsset('Broken');
        const id = (await post(doc, asset)).json.id as string;
        const failed = await reach(id, ['failed']);
        expect(failed.json.error.code).toBe('validation_failed');
        expect(failed.json.error.message).toMatch(/breaks the model/);
        expect(failed.json.error.message).toMatch(/nothing was stored/);
        // The head is still the content the document was created with.
        expect(await textOf(doc)).toContain('Hello');
        const head = await h.parts.logs.head({ tenant: h.tenant, doc });
        expect(head.seq).toBe(0);
        behaviour = 'ok';
      },
    );

    it.skipIf(skip)(
      'refuses an import while a region is approved or a workflow is active, until the state is changed (EXP-098 criterion 4)',
      async () => {
        behaviour = 'ok';
        const { doc, asset } = await withAsset('Replacement');
        const ref: DocRef = { tenant: h.tenant, doc };
        await h.parts.grants.change(
          ref,
          { setRegionStates: [{ region: LEGAL, state: 'approved' }] },
          { actor: 'system' },
        );
        const refused = await post(doc, asset);
        expect(refused.status).toBe(409);
        expect(refused.json.code).toBe('conflict');
        await h.parts.grants.change(
          ref,
          { setRegionStates: [{ region: LEGAL, state: 'draft' }] },
          { actor: 'system' },
        );
        await h.parts.grants.change(ref, { workflowActive: true }, { actor: 'system' });
        expect((await post(doc, asset)).json.code).toBe('workflow_active');
        await h.parts.grants.change(ref, { workflowActive: false }, { actor: 'system' });
        const id = (await post(doc, asset)).json.id as string;
        await reach(id, ['completed']);
        expect(await textOf(doc)).toEqual(['Replacement']);
      },
    );

    it.skipIf(skip)(
      'fails a job whose region became approved after the request (EXP-098 criterion 4)',
      async () => {
        behaviour = 'ok';
        const { doc, asset } = await withAsset('Late');
        const ref: DocRef = { tenant: h.tenant, doc };
        // Held back, so that the state can change between the request and the store.
        let release!: () => void;
        hold = new Promise<void>((resolve) => (release = resolve));
        const accepted = await post(doc, asset);
        expect(accepted.status).toBe(202);
        await h.parts.grants.change(
          ref,
          { setRegionStates: [{ region: LEGAL, state: 'approved' }] },
          { actor: 'system' },
        );
        hold = null;
        release();
        const failed = await reach(accepted.json.id as string, ['failed']);
        expect(failed.json.error.code).toBe('conflict');
        expect(await textOf(doc)).toContain('Hello');
      },
    );
  });
}

// The notifications to the requester's channels need the recording data plane of the harness.
describe('import notifications (memory)', () => {
  let h: Harness;
  let refuse = false;
  const importer: DocxImporter = async (bytes) => {
    if (refuse) throw new Error('the file is damaged');
    return { envelope: contentFor(new TextDecoder().decode(bytes)), warnings: [] };
  };

  beforeAll(async () => {
    h = await startHarness('memory', { importer, config: { jobIdleMs: 20, jobLeaseMs: 2000 } });
    h.stub.replaceContent = async () => ({ seq: 1 });
  });
  afterAll(async () => {
    await h?.close();
  });

  async function runJob(): Promise<string> {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const asset = uuid7();
    const bytes = new TextEncoder().encode('Hello import');
    const sha = await h.service.assets.putFinal(h.tenant, bytes, DOCX_CONTENT_TYPE);
    await h.parts.assetRegistry.create(
      h.tenant,
      {
        id: asset,
        doc,
        filename: 'a.docx',
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
    const accepted = await h.call('POST', `/v1/documents/${doc}/imports`, {
      token: h.apiKey,
      body: { asset, format: 'docx' },
    });
    return accepted.json.id as string;
  }

  const notice = async (job: string, type: string) => {
    for (let i = 0; i < 200; i++) {
      const n = h.stub.notices.find(
        (x) =>
          x.kind === 'notify' &&
          x.notification?.resource === `/imports/${job}` &&
          x.notification.type === type,
      );
      if (n) return n;
      await sleep(20);
    }
    return undefined;
  };

  it('raises import.completed to the requester when the job completes (EXP-098 criterion 3)', async () => {
    refuse = false;
    const job = await runJob();
    expect(await notice(job, 'import.completed')).toMatchObject({
      notification: { data: { state: 'completed', seq: 1 } },
    });
  });

  it('raises import.failed with the code when the job fails (EXP-098 criterion 3)', async () => {
    refuse = true;
    const job = await runJob();
    expect(await notice(job, 'import.failed')).toMatchObject({
      notification: { data: { state: 'failed', code: 'validation_failed' } },
    });
  });
});
