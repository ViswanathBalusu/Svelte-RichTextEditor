/**
 * EXP-123 criterion 1 at the worker (Node.js, the compile replaced): a projected export builds its
 * bundle from the requester's projection. The hidden region's text and title never reach the
 * converter's files, the cdm target writes the projected envelope, and the manifest lists the
 * redaction. The sandbox run is not needed for these checks: the bundle is what the worker sends.
 */
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument, REGION_A, REGION_TITLES } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler, type ExportHandlerDeps } from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const INCARNATION = 'inc-exp-123';
const HIDDEN_TEXT = 'holds the terms';
const SHOWN_TEXT = 'holds the prices';
const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0], '2': [1, 4_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

type Files = Readonly<Record<string, string | Uint8Array>>;

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
          title: 'Projected',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

function fakeCompile() {
  const calls: Array<{ files: Files; opts: SandboxOptions }> = [];
  const compile = async (files: Files, opts: SandboxOptions): Promise<CompileResult> => {
    calls.push({ files, opts });
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: [{ pass: 1, rc: 0, ms: 100 }],
      converged: true,
      pdf: new TextEncoder().encode('%PDF-2.0 test'),
      log: 'This is LuaHBTeX\n',
      layoutRaw: RAW_LAYOUT,
      stderr: '',
      wallMs: 100,
      stdout: new Uint8Array(),
      name: 'docedit-job-exp-123',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  return { compile, calls };
}

async function runJob(
  target: 'pdf' | 'cdm',
  hidden: { regions?: string[]; values?: string[] } = {},
) {
  const { compile, calls } = fakeCompile();
  const stored: Array<{ name: string; bytes: Uint8Array }> = [];
  const doc = demoDocument();
  const deps: ExportHandlerDeps = {
    stores: stores(doc.envelope),
    outputs: {
      putExport: async (_t, _j, name, bytes) => {
        stored.push({ name, bytes });
      },
    },
    fonts: async () => TEST_FONTS,
    imageId: async () => `sha256:${'b'.repeat(64)}`,
    compile,
    sealKey: new Uint8Array(32).fill(5),
  };
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: { export: createExportHandler(deps) },
    worker: 'w-exp-123',
    leaseMs: 60_000,
    idleMs: 10,
    retryAfterMs: 0,
  });
  const tenant = uuid7();
  const docId = uuid7();
  const job = await queue.enqueue(tenant, {
    kind: 'export',
    doc: docId,
    createdBy: 'user-1',
    payload: {
      doc: docId,
      target,
      seq: 0,
      incarnation: INCARNATION,
      options: {},
      requester: 'user-1',
      role: 'manager',
      view: 'v',
      hiddenRegions: hidden.regions ?? [],
      hiddenValues: hidden.values ?? [],
    },
  });
  await runner.runOnce();
  const done = (await queue.get(tenant, job.id)) as JobRecord;
  return { job: done, calls, stored };
}

const text = (bytes: string | Uint8Array | undefined) =>
  typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);

describe('EXP-123 criterion 1: the worker builds a projected export from the projection', () => {
  it('does not refuse a restricted view, and the bundle holds no hidden text or title', async () => {
    const run = await runJob('pdf', { regions: [REGION_A] });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    const main = text(run.calls[0]!.files['main.tex']);
    expect(main).not.toContain(HIDDEN_TEXT);
    expect(main).not.toContain(REGION_TITLES[0]);
    expect(main).toContain(SHOWN_TEXT);
  });

  it('lists the redaction in the manifest the converter writes', async () => {
    const run = await runJob('pdf', { regions: [REGION_A] });
    const manifest = JSON.parse(text(run.calls[0]!.files['manifest.json'])) as {
      redactions?: unknown;
    };
    expect(manifest.redactions).toEqual([{ kind: 'region', id: REGION_A }]);
  });

  it('a full export without hidden content still carries the region text', async () => {
    const run = await runJob('pdf');
    expect(run.job.state).toBe('completed');
    expect(text(run.calls[0]!.files['main.tex'])).toContain(HIDDEN_TEXT);
  });

  it('the cdm target writes the projected envelope, not the stored content', async () => {
    const run = await runJob('cdm', { regions: [REGION_A] });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    const out = run.stored.find((s) => s.name === 'output.json');
    expect(out).toBeDefined();
    const body = text(out!.bytes);
    expect(body).not.toContain(HIDDEN_TEXT);
    expect(body).not.toContain(REGION_TITLES[0]);
    expect(body).toContain('hidden_region');
    expect(body).toContain(SHOWN_TEXT);
  });
});
