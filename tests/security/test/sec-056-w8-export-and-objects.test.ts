/**
 * SEC-056 criterion 1, the parts the table sweep leaves out (lane w8, 2026-11-27): the export a
 * real export handler writes, and every object of the store.
 *
 * A host `sub` that looks like an e-mail address goes through a scenario on the real document
 * service: the user mints a token, commits over the WebSocket, opens a thread with a comment, and
 * requests exports. The export jobs run through `createExportHandler` of the export worker with its
 * real converter, over the service's own log, checkpoint and document stores: the whole bundle the
 * handler hands to the compile (the LaTeX source, the styles, the manifest, the layout) is what
 * the typesetter would read, so it is scanned as the export file. Only the typesetting is a
 * stand-in (the compile returns a fixed PDF header), because the question is what the converter
 * writes; the sub is not in a PDF stream that a byte search could see anyway. Then every key of the
 * object store is listed and every object read, and the sub is searched in the bytes, and in the
 * keys.
 *
 * Positive control: the bundle must hold the document text, so a scan that reads nothing cannot pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { ObjectCheckpointStore } from '../../../services/document-service/src/objects/checkpoints.ts';
import type { JobHandler } from '../../../services/document-service/src/control-plane/jobs/runner.ts';
import { createExportHandler } from '../../../services/export-worker/src/job.ts';
import {
  LIMITS,
  type CompileResult,
  type SandboxOptions,
} from '../../../services/export-worker/src/sandbox.ts';
import { TEST_FONTS } from '../../../services/export-worker/test/fonts.ts';
import {
  documentWithRegions,
  insertText,
  posInside,
  startHarness,
  type Harness,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const SUB = `sec056.export+${uuid7()}@example.test`;
const NAME = 'Export Person SEC-056';
const PARA = 'pIntro0000000001';
const TEXT = ' SEC-056 export text.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

describe('SEC-056 criterion 1: the sub is in no export bundle and no object', () => {
  let h: Harness;
  const bundles: Array<Record<string, string | Uint8Array>> = [];

  beforeAll(async () => {
    // The handler needs the service's own stores, which exist after the harness starts: the job
    // handler looks them up when the first job runs.
    const handler: JobHandler = (job, ctx) =>
      createExportHandler({
        stores: {
          logs: h.parts.logs,
          checkpoints: new ObjectCheckpointStore(h.parts.objects),
          documents: h.parts.documents,
        },
        outputs: h.service.assets,
        fonts: async () => TEST_FONTS,
        imageId: async () => `sha256:${'c'.repeat(64)}`,
        compile: async (
          files: Readonly<Record<string, string | Uint8Array>>,
          opts: SandboxOptions,
        ): Promise<CompileResult> => {
          bundles.push({ ...files });
          const n = opts.maxPasses ?? 2;
          return {
            ok: true,
            exitCode: 0,
            timedOut: false,
            outputOverflow: false,
            cancelled: false,
            passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 10 })),
            converged: n > 1,
            pdf: new TextEncoder().encode('%PDF-2.0 stand-in'),
            log: 'This is LuaHBTeX\n',
            layoutRaw: RAW_LAYOUT,
            stderr: '',
            wallMs: 10,
            stdout: new Uint8Array(),
            name: 'docedit-sec056',
            limits: { ...LIMITS },
            passTimeoutSeconds: 110,
          };
        },
      })(job, ctx);
    h = await startHarness('memory', {
      jobHandlers: { export: handler },
      env: { DOCEDIT_JOB_IDLE_MS: '20' },
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('keeps the sub out of the bundle of an export and out of every object and key', async () => {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const token = await h.mintToken(h.a, SUB, { [doc]: 'owner' }, { name: NAME });

    // A commit by the user over the wire.
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      expect((await c.hello(token)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      const cur = await h.call('GET', `/v1/documents/${doc}/content`, { token });
      const ack = await c.submit(1, {
        id: uuid7(),
        base: Number(cur.json.seq ?? 0),
        steps: [insertText(posInside(cur.json.doc, PARA), TEXT)],
      });
      expect(ack.t, JSON.stringify(ack.d)).toBe('sync.ack');
    } finally {
      c.terminate();
    }
    // A thread with a comment by the user.
    const thread = await h.call('POST', `/v1/documents/${doc}/threads`, {
      token,
      body: {
        target: { block: PARA },
        comment: { body: [{ type: 'text', text: 'A note by the user.' }] },
      },
    });
    expect(thread.status, thread.text).toBe(201);

    // Exports as the user, run to the end by the real handler.
    const done: string[] = [];
    for (const options of [{ profile: 'final' }, { profile: 'review' }]) {
      const made = await h.call('POST', `/v1/documents/${doc}/exports`, {
        token,
        headers: { 'Idempotency-Key': uuid7() },
        body: { target: 'pdf', options },
      });
      if (made.status >= 300) {
        // A profile the service does not offer to this user is not part of the scenario; the
        // first (final) must be accepted.
        expect(options.profile, made.text).not.toBe('final');
        continue;
      }
      let state = 'queued';
      for (let i = 0; i < 400 && state !== 'completed' && state !== 'failed'; i++) {
        state = String((await h.call('GET', `/v1/exports/${made.json.id}`, { token })).json?.state);
        if (state !== 'completed' && state !== 'failed') await sleep(25);
      }
      expect(state, `${options.profile} export`).toBe('completed');
      done.push(options.profile);
    }
    expect(done).toContain('final');
    expect(bundles.length).toBeGreaterThanOrEqual(done.length);

    // The export file: every file of every bundle the handler gave the typesetter.
    const decoder = new TextDecoder();
    const corpus: Array<{ what: string; text: string }> = [];
    bundles.forEach((files, i) => {
      for (const [name, body] of Object.entries(files))
        corpus.push({
          what: `bundle ${i} ${name}`,
          text: typeof body === 'string' ? body : decoder.decode(body),
        });
    });
    expect(
      corpus.some((e) => e.text.includes('SEC-056 export text')),
      'the bundle holds the document text, so the scan reads real converter output',
    ).toBe(true);

    // The object store: every key, and every object's bytes.
    const keys = await h.parts.objects.list('');
    expect(keys.length, 'the scenario wrote objects').toBeGreaterThan(0);
    for (const key of keys) {
      corpus.push({ what: `key ${key}`, text: key });
      const body = await h.parts.objects.get(key);
      if (body) corpus.push({ what: `object ${key}`, text: decoder.decode(body) });
    }
    const exportKeys = keys.filter((k) => k.includes('/exports/'));
    expect(exportKeys.length, 'the export outputs are among the objects').toBeGreaterThan(0);

    // The service's log and the answers of the thread.
    corpus.push({ what: 'service log', text: h.logs.join('\n') });
    corpus.push({ what: 'thread answer', text: thread.text });

    for (const entry of corpus)
      expect(entry.text.includes(SUB), `${entry.what} must not carry the sub`).toBe(false);
  }, 120_000);
});
