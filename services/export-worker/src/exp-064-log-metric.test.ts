/**
 * EXP-064 criterion 6: a job that ends records its log size as a metric, and a job that fails
 * records it too (the log of a failed compile matters most). The compile is a stand-in, so this
 * test needs no Podman; the handler runs under the control plane's JobRunner, as in job.test.ts.
 */
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler, type ExportMetrics } from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const INCARNATION = 'inc-064';
const enc = new TextEncoder();

function stores(envelope: CdmEnvelope): ContentStores {
  return {
    logs: {
      head: async () => ({ seq: 0, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async () => ({ seq: 0, content: envelope as never }),
      get: async () => null,
    },
    documents: {
      get: async (ref) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Demo',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

/** A compile that fails, with the log it leaves behind. */
function failingCompile(log: string) {
  return async (_files: unknown, opts: SandboxOptions): Promise<CompileResult> => ({
    ok: false,
    exitCode: 1,
    timedOut: false,
    outputOverflow: false,
    cancelled: false,
    passes: [{ pass: 1, rc: 1, ms: 100 }],
    converged: false,
    pdf: null,
    log,
    layoutRaw: null,
    stderr: '',
    wallMs: 900,
    stdout: new Uint8Array(),
    name: 'docedit-job-064',
    limits: { ...LIMITS, ...opts.limits },
    passTimeoutSeconds: 110,
  });
}

/** A compile that succeeds, with one page of layout. */
function passingCompile(log = 'This is LuaHBTeX\n') {
  return async (files: unknown, opts: SandboxOptions): Promise<CompileResult> => ({
    ...(await failingCompile(log)(files, opts)),
    ok: true,
    exitCode: 0,
    passes: [
      { pass: 1, rc: 0, ms: 100 },
      { pass: 2, rc: 0, ms: 100 },
    ],
    converged: true,
    pdf: enc.encode('%PDF-2.0 test'),
    layoutRaw: JSON.stringify({
      v: 1,
      level: 2,
      pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
      blocks: { '1': [1, 3_000_000, 0] },
      lines: [[1, 0, 1, 3_000_000]],
    }),
  });
}

type Compile = NonNullable<Parameters<typeof createExportHandler>[0]['compile']>;

function harness(
  compile: Compile,
  opts: { onMetrics?: (m: ExportMetrics) => void; leaseMs?: number } = {},
) {
  const metrics: ExportMetrics[] = [];
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: {
      export: createExportHandler({
        stores: stores(demoDocument().envelope),
        outputs: { putExport: async () => {} },
        fonts: async () => TEST_FONTS,
        imageId: async () => `sha256:${'c'.repeat(64)}`,
        onMetrics: (m) => {
          metrics.push(structuredClone(m));
          opts.onMetrics?.(m);
        },
        compile,
      }),
    },
    worker: 'w064',
    leaseMs: opts.leaseMs ?? 60_000,
    idleMs: 10,
    retryAfterMs: 0,
  });
  const tenant = uuid7();
  const doc = uuid7();
  const start = async (payload: Record<string, unknown> = {}) => {
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
        ...payload,
      },
    });
    const done = runner.runOnce().then(async () => (await queue.get(tenant, job.id))!);
    return { id: job.id, done };
  };
  const run = async (payload: Record<string, unknown> = {}): Promise<JobRecord> =>
    (await start(payload)).done;
  return { run, start, metrics, queue, tenant };
}

describe('EXP-064 criterion 6: the log size of every job that ends', () => {
  it('records the log size of a job whose compile failed, with its diagnostics kept', async () => {
    const log = '! Undefined control sequence.\nl.4 \\nosuchcommand\n';
    const h = harness(failingCompile(log));
    const job = await h.run();
    expect(job.state).toBe('failed');
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0]!.logBytes).toBe(enc.encode(log).length);
    expect(h.metrics[0]!.logBytes).toBeGreaterThan(0);
  });

  it('records a zero log size for a job that fails before any compile runs', async () => {
    const h = harness(failingCompile('unused'));
    const job = await h.run({ target: 'rtf' });
    expect(job.state).toBe('failed');
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0]!.logBytes).toBe(0);
    expect(h.metrics[0]!.pdfBytes).toBeNull();
  });

  it('names how each attempt ended: one completed entry for a pdf job, with its stages', async () => {
    const log = 'This is LuaHBTeX\n';
    const h = harness(passingCompile(log));
    const job = await h.run();
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0]).toMatchObject({
      state: 'completed',
      target: 'pdf',
      passMs: [100, 100],
      sandboxMs: 900,
      logBytes: enc.encode(log).length,
      pages: 1,
    });
    expect(h.metrics[0]!.pdfBytes).toBeGreaterThan(0);
    // The result keeps the same metrics, its state included.
    expect((job.result as { metrics: ExportMetrics }).metrics.state).toBe('completed');
  });

  it('records a failed attempt as failed, with the stages it reached', async () => {
    const h = harness(failingCompile('! Emergency stop.\n'));
    await h.run();
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0]!.state).toBe('failed');
    // The compile ran, so its time is kept rather than reported as 0.
    expect(h.metrics[0]!.sandboxMs).toBe(900);
    expect(h.metrics[0]!.passMs).toEqual([100]);
  });

  it.each(['cdm', 'tex'])(
    'records a completed %s job once, with a log size of 0',
    async (target) => {
      let compiled = false;
      const h = harness(async (files, opts) => {
        compiled = true;
        return passingCompile()(files, opts);
      });
      const job = await h.run({ target });
      expect(job.state, JSON.stringify(job.error)).toBe('completed');
      expect(compiled).toBe(false);
      expect(h.metrics).toHaveLength(1);
      expect(h.metrics[0]).toMatchObject({
        state: 'completed',
        target,
        logBytes: 0,
        pdfBytes: null,
      });
    },
  );

  it('records a cancelled attempt as aborted, not as completed', async () => {
    let compiling!: () => void;
    const reached = new Promise<void>((r) => (compiling = r));
    const h = harness(
      async (files, opts) => {
        compiling();
        await new Promise<void>((resolve) =>
          opts.signal!.addEventListener('abort', () => resolve()),
        );
        return { ...(await failingCompile('')(files, opts)), cancelled: true };
      },
      { leaseMs: 300 },
    );
    const { id, done } = await h.start();
    await reached;
    await h.queue.cancel(h.tenant, id);
    const job = await done;
    expect(job.state).toBe('cancelled');
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0]!.state).toBe('aborted');
  });

  it('keeps the job completed, and records one entry, when the metrics sink throws', async () => {
    const h = harness(passingCompile(), {
      onMetrics: () => {
        throw new Error('sink down');
      },
    });
    const job = await h.run();
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0]!.state).toBe('completed');
  });
});
