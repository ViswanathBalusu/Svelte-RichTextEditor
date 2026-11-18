/**
 * FRW-050 (export worker, Node.js only, no sandbox): a job whose payload carries the certificate
 * facts that the control plane wrote compiles a main.tex with the certificate after the body; a job
 * without them compiles none; a payload member that is not the shape the control plane writes fails
 * the job. The compile is replaced by a fake that records the TeX files it is given, as in
 * exp-033-seq.job.test.ts. No real compile is run (the certificate pages are not checked in a PDF
 * here).
 */
import { describe, expect, it } from 'vitest';
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler } from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const INCARNATION = 'inc-frw050';
const FIELD_ID = 'fFrw050000000001';

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

/** A document whose one paragraph holds a text form field with the given value. */
function withFieldValue(value: string): CdmEnvelope {
  const base = demoDocument().envelope as unknown as { doc: { content: unknown[] } };
  const defs = base.doc.content[0];
  const body = {
    type: 'body',
    attrs: { pageSetup: 'ps1' },
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'pFrw050000000001', style: 'Normal' },
        content: [
          { type: 'text', text: 'Name: ' },
          {
            type: 'form_field',
            attrs: { id: FIELD_ID, key: 'name', kind: 'text', label: 'Name', width: 2880, value },
          },
        ],
      },
    ],
  };
  return {
    ...demoDocument().envelope,
    doc: { type: 'doc', content: [defs, body] },
  } as unknown as CdmEnvelope;
}

/**
 * Two checkpoints of one document: `Ada` at seq 0 and `Grace` at seq 3. The head is seq 3, so
 * both seqs are readable and each one reads its own checkpoint (no commits lie between them).
 */
function stores(): ContentStores {
  const checkpoints = [
    { seq: 0, content: withFieldValue('Ada') },
    { seq: 3, content: withFieldValue('Grace') },
  ];
  return {
    logs: {
      head: async () => ({ seq: 3, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async (_ref, at: number) => {
        const usable = checkpoints.filter((c) => c.seq <= at);
        return (usable[usable.length - 1] ?? null) as never;
      },
      get: async () => null,
    },
    documents: {
      get: async (ref) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Form',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

function fakeCompile() {
  const seen: string[] = [];
  const compile = async (
    files: Readonly<Record<string, string | Uint8Array>>,
    opts: SandboxOptions,
  ): Promise<CompileResult> => {
    const tex = files['main.tex'];
    seen.push(typeof tex === 'string' ? tex : new TextDecoder().decode(tex ?? new Uint8Array()));
    const n = opts.maxPasses ?? 2;
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 100 })),
      converged: n > 1,
      pdf: new TextEncoder().encode('%PDF-2.0 test'),
      log: 'This is LuaHBTeX\n',
      layoutRaw: RAW_LAYOUT,
      stderr: '',
      wallMs: 1500,
      stdout: new Uint8Array(),
      name: 'docedit-frw050',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  return { compile, seen };
}

/** Runs one export with `extra` members added to the payload; returns the job and the TeX. */
async function exportWith(
  extra: Record<string, unknown>,
  options: Record<string, unknown> = { fields: 'flatten', certificate: true },
): Promise<{ job: JobRecord; tex: string }> {
  const probe = fakeCompile();
  const handler = createExportHandler({
    stores: stores(),
    outputs: { putExport: async () => {} },
    fonts: async () => TEST_FONTS,
    imageId: async () => `sha256:${'c'.repeat(64)}`,
    compile: probe.compile,
  });
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: { export: handler },
    worker: 'w-frw050',
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
    maxAttempts: 1,
    payload: {
      doc,
      target: 'pdf',
      seq: 3,
      incarnation: INCARNATION,
      options,
      requester: 'user-1',
      role: 'service',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
      ...extra,
    },
  });
  await runner.runOnce();
  return { job: (await queue.get(tenant, job.id)) as JobRecord, tex: probe.seen[0] ?? '' };
}

const FACTS = {
  documentId: 'doc-frw050',
  workflowId: 'wf-frw050',
  sentSeq: 1,
  completedSeq: 3,
  chainHeadHash: 'ef'.repeat(32),
  participants: [
    {
      id: 'p1',
      label: 'Ada Lovelace',
      events: [{ kind: 'completed', serverTimeMs: Date.UTC(2026, 10, 6, 10, 3, 0) }],
    },
  ],
  networkIdentityIncluded: false,
  statement: ['A fixed sentence of the certificate.'],
};

describe('FRW-050: the worker prints the certificate facts the control plane wrote', () => {
  it('appends the certificate after the body', async () => {
    const { job, tex } = await exportWith({ certificate: FACTS });
    expect(job.state).toBe('completed');
    const decoded = tex.replace(/\DEstr{([0-9A-F]*)}/g, (_m, hex: string) =>
      new TextDecoder().decode(
        new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16))),
      ),
    );
    expect(decoded).toContain('Certificate of completion');
    expect(decoded).toContain('Ada Lovelace');
    expect(decoded).toContain('Completed at sequence number 3');
    expect(decoded).toContain('ef'.repeat(32));
    // After the body: the body's field value comes first.
    expect(decoded.indexOf('Grace')).toBeGreaterThan(-1);
    expect(decoded.indexOf('Certificate of completion')).toBeGreaterThan(decoded.indexOf('Grace'));
  });

  it('refuses certificate: true when the payload carries no facts (a client cannot ask for one)', async () => {
    const { job, tex } = await exportWith({});
    expect(job.state).toBe('failed');
    expect(tex).toBe('');
  });

  it('prints no certificate for a job that does not ask for one', async () => {
    const { job, tex } = await exportWith({}, { fields: 'flatten', certificate: false });
    expect(job.state).toBe('completed');
    expect(tex).not.toContain('Certificate');
  });

  it('fails the job for facts that are not the shape the control plane writes', async () => {
    const { job, tex } = await exportWith({
      certificate: { ...FACTS, chainHeadHash: 'not a hash' },
    });
    expect(job.state).toBe('failed');
    expect(tex).toBe('');
  });
});
