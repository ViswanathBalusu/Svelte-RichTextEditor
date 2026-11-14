/**
 * EXP-033 criterion 7 (export worker, Node.js only, no sandbox): an export at a `seq` writes the
 * form-field values that the document had at that `seq`, not the newest ones. The content store is
 * a fake with two checkpoints (seq 0 and seq 3) that hold different values for the same field, and
 * the compile is replaced by a fake that records the TeX files it is given. The sandbox is not
 * needed, because the converter's output is what the criterion is about.
 *
 * Lane U-EXP-033-048 (round 2). Owned by this lane; the test file is new.
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

const INCARNATION = 'inc-exp033-seq';
const FIELD_ID = 'fSeq033000000001';

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
        attrs: { id: 'pSeq033000000001', style: 'Normal' },
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
      name: 'docedit-exp033-seq',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  return { compile, seen };
}

/** Runs one export of the document at `seq` and returns the main.tex it compiled. */
async function exportAt(seq: number): Promise<{ job: JobRecord; tex: string }> {
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
    worker: 'w-exp033-seq',
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
      seq,
      incarnation: INCARNATION,
      options: { fields: 'flatten' },
      requester: 'user-1',
      role: 'editor',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
    },
  });
  await runner.runOnce();
  const done = (await queue.get(tenant, job.id)) as JobRecord;
  const tex = probe.seen[0] ?? '';
  return { job: done, tex };
}

describe('EXP-033 criterion 7: the field values are those at the export seq', () => {
  it('writes the value of seq 0 for an export at seq 0', async () => {
    const { job, tex } = await exportAt(0);
    expect(job.state).toBe('completed');
    expect(tex).toContain('Ada');
    expect(tex).not.toContain('Grace');
  });

  it('writes the value of seq 3 for an export at seq 3, not the value of seq 0', async () => {
    const { job, tex } = await exportAt(3);
    expect(job.state).toBe('completed');
    expect(tex).toContain('Grace');
    expect(tex).not.toContain('Ada');
  });
});
