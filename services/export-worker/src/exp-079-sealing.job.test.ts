/**
 * EXP-079 criteria 1 to 4 in the job handler (lane w2, Node.js only): a job whose payload carries a
 * `sealing` pin compiles its bundle twice, in two sandboxes, after checking the bundle against the
 * pin, and stores a PDF only when both PDFs are equal. The compile is a fake that records its calls;
 * the job runs through the real handler and JobRunner. Real sandboxes are in
 * exp-079-pair.podman.test.ts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7 } from '@docedit/model';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler } from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const INCARNATION = 'inc-exp079-w2';
const HEAD = 'e'.repeat(64);
const PDF = new TextEncoder().encode('%PDF-2.0 sealed');
const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

function stores(): ContentStores {
  const envelope = demoDocument().envelope;
  return {
    logs: {
      head: async () => ({ seq: 2, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async () => ({ seq: 2, content: envelope }) as never,
      get: async () => null,
    },
    documents: {
      get: async (ref) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Sealed',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
    chainHeadAt: async () => HEAD,
  };
}

type Behaviour = (name: string) => Partial<CompileResult>;

function fakeCompile(behaviour: Behaviour = () => ({})) {
  const names: Array<string | undefined> = [];
  const compile = async (
    _files: Readonly<Record<string, string | Uint8Array>>,
    opts: SandboxOptions,
  ): Promise<CompileResult> => {
    names.push(opts.name);
    const n = opts.maxPasses ?? 2;
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 100 })),
      converged: n > 1,
      pdf: PDF,
      log: 'This is LuaHBTeX\n',
      layoutRaw: RAW_LAYOUT,
      stderr: '',
      wallMs: 1500,
      stdout: new Uint8Array(),
      name: opts.name ?? 'single',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
      ...behaviour(opts.name ?? 'single'),
    };
  };
  return { compile, names };
}

async function runJob(sealing: unknown, behaviour?: Behaviour) {
  const probe = fakeCompile(behaviour);
  const stored = new Map<string, Uint8Array>();
  const handler = createExportHandler({
    stores: stores(),
    outputs: {
      putExport: async (_t: string, _j: string, name: string, bytes: Uint8Array) => {
        stored.set(name, bytes);
      },
    } as never,
    fonts: async () => TEST_FONTS,
    imageId: async () => `sha256:${'d'.repeat(64)}`,
    compile: probe.compile,
  });
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: { export: handler },
    worker: 'w-exp079-w2',
    leaseMs: 60_000,
    idleMs: 10,
    retryAfterMs: 0,
  });
  const tenant = uuid7();
  const doc = uuid7();
  const job = await queue.enqueue(tenant, {
    kind: 'export',
    doc,
    createdBy: 'user-1',
    payload: {
      doc,
      target: 'pdf',
      seq: 2,
      incarnation: INCARNATION,
      options: { fields: 'flatten' },
      requester: 'user-1',
      role: 'editor',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
      ...(sealing === undefined ? {} : { sealing }),
    },
  });
  await runner.runOnce();
  const done = (await queue.get(tenant, job.id)) as JobRecord;
  return { job: done, stored, names: probe.names };
}

function codesOf(job: JobRecord): string[] {
  const d =
    (job.result as { diagnostics?: Array<{ code: string }> } | null)?.diagnostics ??
    (job.error as { diagnostics?: Array<{ code: string }> } | null)?.diagnostics ??
    [];
  return d.map((x) => x.code);
}

const PIN = { completedSeq: 2, chainHead: HEAD };
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');

describe('EXP-079 criterion 1: a sealing export is compiled twice in separate sandboxes', () => {
  it('compiles once for an ordinary export and twice, under two names, for a sealing one', async () => {
    const plain = await runJob(undefined);
    expect(plain.job.state).toBe('completed');
    expect(plain.names).toHaveLength(1);
    const sealed = await runJob(PIN);
    expect(sealed.job.state).toBe('completed');
    expect(sealed.names).toHaveLength(2);
    expect(new Set(sealed.names).size).toBe(2);
  });
});

describe('EXP-079 criterion 2: the bundle is pinned to completedSeq and the chain head', () => {
  it('refuses a bundle of another seq before anything is compiled or stored', async () => {
    const run = await runJob({ completedSeq: 3, chainHead: HEAD });
    expect(run.job.state).toBe('failed');
    expect(codesOf(run.job)).toContain('seal_pin_mismatch');
    expect(run.names).toHaveLength(0);
    expect([...run.stored.keys()]).toEqual([]);
  });

  it('refuses a bundle of another chain head', async () => {
    const run = await runJob({ completedSeq: 2, chainHead: 'f'.repeat(64) });
    expect(run.job.state).toBe('failed');
    expect(codesOf(run.job)).toContain('seal_pin_mismatch');
    expect(run.names).toHaveLength(0);
  });

  it('fails a pin that is not { completedSeq, chainHead } without compiling', async () => {
    for (const bad of [{ completedSeq: '2', chainHead: HEAD }, { completedSeq: 2 }, 'yes', []]) {
      const run = await runJob(bad);
      expect(run.job.state).toBe('failed');
      expect(run.names).toHaveLength(0);
    }
  });
});

describe('EXP-079 criterion 3: equal compiles are recorded in the job result', () => {
  it('records both hashes in the result and the manifest, stores the PDF and counts both compiles', async () => {
    const run = await runJob(PIN);
    expect(run.job.state).toBe('completed');
    const result = run.job.result as {
      sealing: { pdfSha256: { a: string; b: string } };
      metrics: { sandboxMs: number };
    };
    expect(result.sealing.pdfSha256).toEqual({ a: PDF_SHA, b: PDF_SHA });
    // Each fake compile took 1500 ms; both count (criterion 7, as the worker's own metric).
    expect(result.metrics.sandboxMs).toBe(3000);
    expect(run.stored.has('output.pdf')).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(run.stored.get('manifest.json')!)) as {
      sealing: { completedSeq: number; chainHead: string; pdfSha256: { a: string; b: string } };
    };
    expect(manifest.sealing.completedSeq).toBe(2);
    expect(manifest.sealing.chainHead).toBe(HEAD);
    expect(manifest.sealing.pdfSha256).toEqual({ a: PDF_SHA, b: PDF_SHA });
  });

  it('records nothing of sealing for an ordinary export', async () => {
    const run = await runJob(undefined);
    expect((run.job.result as Record<string, unknown>)['sealing']).toBeUndefined();
  });
});

describe('EXP-079 criterion 4: compiles that differ fail the job and seal nothing', () => {
  it('fails with seal_pair_differs and stores no PDF', async () => {
    const run = await runJob(PIN, (name) =>
      name.endsWith('-b') ? { pdf: new TextEncoder().encode('%PDF-2.0 other') } : {},
    );
    expect(run.job.state).toBe('failed');
    expect(codesOf(run.job)).toContain('seal_pair_differs');
    expect(run.stored.has('output.pdf')).toBe(false);
    expect(run.stored.has('manifest.json')).toBe(false);
  });

  it('fails the job as a failed compile when one of the two does not compile', async () => {
    const run = await runJob(PIN, (name) =>
      name.endsWith('-b') ? { ok: false, exitCode: 1, pdf: null as never } : {},
    );
    expect(run.job.state).toBe('failed');
    expect(run.stored.has('output.pdf')).toBe(false);
  });
});
