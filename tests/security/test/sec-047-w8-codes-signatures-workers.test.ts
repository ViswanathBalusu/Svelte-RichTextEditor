/**
 * SEC-047 criterion 1, the classes still open after lane w3 (lane w8, 2026-11-26): access codes,
 * signed-URL signatures, and the outputs of the workers.
 *
 * - Access codes: a workflow whose participant needs a code (FRW-039). The host registers a canary
 *   code, the participant submits a wrong canary code and then the right one.
 * - Signed-URL signatures: the service runs over the S3-compatible store of the test environment
 *   (project `docedit-test-w8`), so the upload URL of an asset and the download URL of an export
 *   carry a real `X-Amz-Signature`. Every signature the service hands out is a canary.
 * - Workers: the asset worker runs in the process (the real code, unsandboxed) on an upload whose
 *   file name is a canary, and everything the process writes to stdout and stderr is kept. The export
 *   worker's job handler (services/export-worker/src/job.ts, the real code) runs a document whose text
 *   is a canary, once to the end and once with a compile that fails and leaves a log that quotes the
 *   text; the lines it logs for each attempt (`metricsLogFields`) and the error the queue stores are
 *   kept. The compile itself is a stand-in, as in exp-064-log-metric.test.ts, because the worker's
 *   image is not built here.
 *
 * Then every structured log line, the `/metrics` scrape, every request span and the process output
 * are searched for each canary. Controls: the canaries are in the places that are meant to hold them
 * (the stored code row, the stored compile log), so the search can fail.
 */
import { randomBytes } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JobRunner,
  MemoryJobQueue,
  createLogger,
  type JobQueue,
} from '../../../services/document-service/src/index.ts';
import {
  S3ObjectStore,
  type S3Settings,
} from '../../../services/document-service/src/objects/s3.ts';
import { settings } from '../../../services/document-service/test/support/env.ts';
import { unsandboxed } from '../../../services/asset-worker/src/index.ts';
import { createExportHandler } from '../../../services/export-worker/src/job.ts';
import { metricsLogFields } from '../../../services/export-worker/src/metrics-log.ts';
import {
  LIMITS,
  type CompileResult,
  type SandboxOptions,
} from '../../../services/export-worker/src/sandbox.ts';
import { demoDocument } from '../../../services/export-worker/test/documents.ts';
import { TEST_FONTS } from '../../../services/export-worker/test/fonts.ts';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const RUN = randomBytes(5).toString('hex');
const METRICS_TOKEN = `metrics-w8-sec-047-${randomBytes(12).toString('hex')}`;
const CANARY = {
  code: `CANARY_W847_ACCESS_CODE_${RUN}`,
  wrongCode: `CANARY_W847_WRONG_CODE_${RUN}`,
  fileName: `CANARY_W847_FILE_${RUN}.png`,
  workerText: `CANARY_W847_WORKER_TEXT_${RUN}`,
  compileLine: `CANARY_W847_TEX_LINE_${RUN}`,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Everything the process writes to stdout and stderr while a block runs. */
function captureProcessOutput(): { text: () => string; stop: () => void } {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const wrap =
    (real: typeof process.stdout.write) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
  process.stdout.write = wrap(out) as typeof process.stdout.write;
  process.stderr.write = wrap(err) as typeof process.stderr.write;
  return {
    text: () => chunks.join(''),
    stop: () => {
      process.stdout.write = out;
      process.stderr.write = err;
    },
  };
}

const S = settings();
const s3Settings: S3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};
async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).get('tenants/probe-sec-047-w8/none');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

function workflowDocument(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pSec047000000001' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: 'ff00000000000471',
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: true,
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const pgDown = await postgresUnavailable();
const s3Down = await s3Unavailable();
if (pgDown) console.warn(`PostgreSQL cases skipped: ${pgDown}`);
if (s3Down) console.warn(`S3 cases skipped: ${s3Down}`);

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe.skipIf(storage === 'postgres' && pgDown !== null)(
    `SEC-047 criterion 1: access codes in no log, metric or span (${storage})`,
    () => {
      let h: Harness;
      const spans: unknown[] = [];
      const answers: string[] = [];
      beforeAll(async () => {
        h = await startHarness(storage, {
          env: { DOCEDIT_METRICS_TOKEN: METRICS_TOKEN },
          onSpan: (span) => void spans.push(span),
        });
      }, 60_000);
      afterAll(async () => {
        await h?.close();
      });

      it('the code the host registers and the codes a participant submits appear in no log line, metric or span, or in an answer', async () => {
        const doc = await h.createDocument(h.a, workflowDocument());
        const owner = await h.mintToken(h.a, `owner-w847-${RUN}`, { [doc]: 'owner' });
        const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: {
            id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8d47',
            doc,
            state: 'draft',
            rev: 0,
            timeZone: 'UTC',
            participants: [
              {
                id: 'p1',
                roles: ['tenant'],
                kind: 'filler',
                order: 1,
                sub: 'sub-p1',
                auth: { require: ['access_code'] },
              },
            ],
          },
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);
        expect(
          (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
        ).toBe(200);
        const keep = async (r: ReturnType<Harness['call']>) => {
          const done = await r;
          answers.push(done.text);
          return done;
        };
        const base = `/v1/documents/${doc}/workflow/participants/p1`;
        const registered = await keep(
          h.call('POST', `${base}/access-code`, { token: owner, body: { code: CANARY.code } }),
        );
        expect(registered.status, registered.text).toBe(204);
        const filler = await h.mintToken(h.a, 'sub-p1', { [doc]: 'filler' }, { wfp: 'p1' });
        const wrong = await keep(
          h.call('POST', `${base}/verify`, { token: filler, body: { code: CANARY.wrongCode } }),
        );
        expect(wrong.status, wrong.text).toBe(403);
        const right = await keep(
          h.call('POST', `${base}/verify`, { token: filler, body: { code: CANARY.code } }),
        );
        expect(right.status, right.text).toBe(200);

        const metrics = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
        expect(metrics.status).toBe(200);
        expect(h.logs.length, 'the service logged something').toBeGreaterThan(0);
        expect(spans.length, 'the service recorded request spans').toBeGreaterThan(0);
        const surfaces = [
          { name: 'logs', text: h.logs.join('\n') },
          { name: 'metrics', text: metrics.text },
          { name: 'spans', text: JSON.stringify(spans) },
          { name: 'answers', text: answers.join('\n') },
        ];
        for (const c of [CANARY.code, CANARY.wrongCode])
          for (const s of surfaces) expect(s.text, `${s.name} holds ${c}`).not.toContain(c);
      }, 60_000);
    },
  );
}

describe.skipIf(s3Down !== null)(
  'SEC-047 criterion 1: signed-URL signatures and the asset worker, over the S3-compatible store',
  () => {
    let h: Harness;
    const spans: unknown[] = [];
    let output: { text: () => string; stop: () => void };
    beforeAll(async () => {
      output = captureProcessOutput();
      h = await startHarness('memory', {
        env: { DOCEDIT_METRICS_TOKEN: METRICS_TOKEN, DOCEDIT_JOB_IDLE_MS: '20' },
        onSpan: (span) => void spans.push(span),
        parts: { objects: new S3ObjectStore(s3Settings) },
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        jobHandlers: {
          export: async (job, ctx) => {
            await ctx.report('compiling', 50);
            await h.service.assets.putExport(
              job.tenant,
              job.id,
              'output.pdf',
              Buffer.from('%PDF-1.7 test'),
              'application/pdf',
            );
            return {
              output: 'output.pdf',
              pages: 1,
              layout: null,
              converged: true,
              log: null,
              diagnostics: [],
            };
          },
        },
      });
    }, 60_000);
    afterAll(async () => {
      output?.stop();
      await h?.close();
    });

    it('every signature the service hands out, and the file name of an upload, appear in no log line, metric, span or process output', async () => {
      const doc = await h.createDocument(h.a, documentWithRegions());
      const editor = await h.mintToken(h.a, `editor-w847-${RUN}`, { [doc]: 'editor' });
      const answers: string[] = [];
      const note = (text: string) => answers.push(text);

      // The upload URL of an asset (a pre-signed PUT), then the check by the asset worker.
      const up = await h.call('POST', `/v1/documents/${doc}/assets`, {
        token: editor,
        body: { filename: CANARY.fileName, mime: 'image/png', size: PNG.length },
      });
      expect(up.status, up.text).toBe(201);
      note(up.text);
      const asset = up.json.asset as string;
      await h.service.assets.putQuarantined(h.a.id, asset, PNG);
      const done = await h.call('POST', `/v1/assets/${asset}/complete`, { token: editor });
      expect(done.status, done.text).toBe(202);
      let row = await h.parts.assetRegistry.get(h.a.id, asset);
      for (let i = 0; i < 300 && row?.state !== 'ready' && row?.state !== 'failed'; i++) {
        await sleep(20);
        row = await h.parts.assetRegistry.get(h.a.id, asset);
      }
      expect(row?.state).toBe('ready');
      // The URL of the ready asset.
      const resolved = await h.call('POST', `/v1/documents/${doc}/assets/resolve`, {
        token: editor,
        body: { assets: [asset] },
      });
      expect(resolved.status, resolved.text).toBe(200);
      note(resolved.text);

      // An export, run to the end, and its download URL.
      const made = await h.call('POST', `/v1/documents/${doc}/exports`, {
        token: editor,
        body: { target: 'pdf', options: { profile: 'final' } },
      });
      expect(made.status, made.text).toBeLessThan(300);
      note(made.text);
      for (let i = 0; i < 300; i++) {
        const r = await h.call('GET', `/v1/exports/${made.json.id}`, { token: editor });
        note(r.text);
        if (r.json?.state === 'completed') break;
        expect(r.json?.state).not.toBe('failed');
        await sleep(20);
      }

      // The signatures the service handed out: every `X-Amz-Signature` of every answer.
      const signatures = new Set(
        answers.flatMap((t) =>
          [...t.matchAll(/X-Amz-Signature=([0-9a-f]{64})/gi)].map((m) => m[1]!),
        ),
      );
      expect(signatures.size, 'the service handed out signed URLs').toBeGreaterThanOrEqual(2);

      const metrics = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
      expect(metrics.status).toBe(200);
      expect(h.logs.length).toBeGreaterThan(0);
      expect(spans.length).toBeGreaterThan(0);
      const surfaces = [
        { name: 'logs', text: h.logs.join('\n') },
        { name: 'metrics', text: metrics.text },
        { name: 'spans', text: JSON.stringify(spans) },
        { name: 'process output', text: output.text() },
      ];
      for (const c of [...signatures, CANARY.fileName])
        for (const s of surfaces) expect(s.text, `${s.name} holds ${c}`).not.toContain(c);
      // Control: the file name is where it is meant to be (the registry row), so the search can fail.
      expect(JSON.stringify(row)).toContain(CANARY.fileName);
    }, 120_000);
  },
);

describe('SEC-047 criterion 1: the export worker, its log lines and the error the queue stores', () => {
  const enc = new TextEncoder();
  const INCARNATION = 'inc-w847';

  /** A document whose first paragraph holds the canary text. */
  function envelopeWithCanary() {
    const envelope = structuredClone(demoDocument().envelope) as unknown as {
      doc: unknown;
    };
    let swapped = false;
    const walk = (n: unknown): void => {
      if (n === null || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      if (!swapped && o['type'] === 'text' && typeof o['text'] === 'string') {
        o['text'] = CANARY.workerText;
        swapped = true;
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(envelope.doc);
    expect(swapped).toBe(true);
    return envelope;
  }

  const stores = (envelope: unknown) => ({
    logs: {
      head: async () => ({ seq: 0, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async () => ({ seq: 0, content: envelope as never }),
      get: async () => null,
    },
    documents: {
      get: async (ref: { doc: string; tenant: string }) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Demo',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  });

  const compile =
    (ok: boolean, log: string) =>
    async (_files: unknown, opts: SandboxOptions): Promise<CompileResult> => ({
      ok,
      exitCode: ok ? 0 : 1,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: [{ pass: 1, rc: ok ? 0 : 1, ms: 100 }],
      converged: ok,
      pdf: ok ? enc.encode('%PDF-2.0 test') : null,
      log,
      layoutRaw: ok
        ? JSON.stringify({
            v: 1,
            level: 2,
            pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
            blocks: { '1': [1, 3_000_000, 0] },
            lines: [[1, 0, 1, 3_000_000]],
          })
        : null,
      stderr: '',
      wallMs: 900,
      stdout: new Uint8Array(),
      name: 'docedit-job-w847',
      limits: { ...LIMITS, ...opts.limits },
      passTimeoutSeconds: 110,
    });

  it('the log line of each attempt, a completed one and a failed one, and the stored job hold no canary, while the stored compile log does', async () => {
    const lines: string[] = [];
    const logger = createLogger((l) => lines.push(typeof l === 'string' ? l : JSON.stringify(l)));
    const stored = new Map<string, string>();
    const queue: JobQueue = new MemoryJobQueue();
    let nextOk = true;
    const runner = new JobRunner({
      queue,
      handlers: {
        export: createExportHandler({
          stores: stores(envelopeWithCanary()),
          outputs: {
            putExport: async (_t: string, _j: string, name: string, bytes: Uint8Array) => {
              stored.set(name, Buffer.from(bytes).toString('utf8'));
            },
          },
          fonts: async () => TEST_FONTS,
          imageId: async () => `sha256:${'c'.repeat(64)}`,
          onMetrics: (m, job) => logger.info(metricsLogFields(m, job)),
          compile: (files, opts) =>
            compile(
              nextOk,
              `This is LuaHBTeX\n! Undefined control sequence.\nl.7 ${CANARY.workerText} ${CANARY.compileLine}\n`,
            )(files, opts),
        }),
      },
      worker: 'w847',
      leaseMs: 60_000,
      idleMs: 10,
      retryAfterMs: 0,
      // The error line of the worker's main.ts, by name and code and never by message.
      onError: (e, job) =>
        logger.error({
          event: 'export.failed',
          tenant: job.tenant,
          job: job.id,
          error: e instanceof Error ? e.name : typeof e,
          ...(e instanceof Error && 'code' in e && typeof e.code === 'string'
            ? { code: e.code }
            : {}),
        }),
    });

    const tenant = uuid7();
    const doc = uuid7();
    const ids: string[] = [];
    for (const ok of [true, false]) {
      nextOk = ok;
      const job = await queue.enqueue(tenant, {
        kind: 'export',
        doc,
        createdBy: 'user-1',
        payload: {
          doc,
          target: 'pdf',
          seq: 0,
          incarnation: INCARNATION,
          options: {},
          requester: 'user-1',
          role: 'editor',
          view: 'v',
          hiddenRegions: [],
          hiddenValues: [],
        },
      });
      ids.push(job.id);
      await runner.runOnce();
    }
    const records = await Promise.all(ids.map((id) => queue.get(tenant, id)));
    expect(records.map((r) => r?.state)).toEqual(['completed', 'failed']);
    expect(lines.length, 'the worker logged each attempt').toBeGreaterThanOrEqual(2);
    const surfaces = [
      { name: 'log lines', text: lines.join('\n') },
      { name: 'stored job records', text: JSON.stringify(records) },
    ];
    for (const c of [CANARY.workerText, CANARY.compileLine])
      for (const s of surfaces) expect(s.text, `${s.name} holds ${c}`).not.toContain(c);
    // Control: the compile log is stored with the export, where it is meant to be.
    expect([...stored.values()].join('\n')).toContain(CANARY.compileLine);
  }, 60_000);
});
