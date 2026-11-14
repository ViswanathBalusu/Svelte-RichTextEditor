/**
 * EXP-004 criterion 7 (lane V-EXP-001-016): an export at a `seq` older than the head is built from
 * the content at that `seq`, and the manifest records it. The head here is seq 3 and the export is
 * at seq 2, a checkpoint of its own, so no commit has to be replayed. Node.js only: the compile is
 * a fake, and the job runs through the real handler and JobRunner.
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

const INCARNATION = 'inc-exp004-v-exp-001-016';
const FIELD_ID = 'fSeq004000000001';

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

function withFieldValue(value: string): CdmEnvelope {
  const base = demoDocument().envelope as unknown as { doc: { content: unknown[] } };
  const defs = base.doc.content[0];
  const body = {
    type: 'body',
    attrs: { pageSetup: 'ps1' },
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'pSeq004000000001', style: 'Normal' },
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

/** Checkpoints at seq 0, 2 and 3; the head is seq 3, so seq 2 is older than the head. */
function stores(): ContentStores {
  const checkpoints = [
    { seq: 0, content: withFieldValue('Ada') },
    { seq: 2, content: withFieldValue('Byron') },
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
  const bundleManifests: string[] = [];
  const compile = async (
    files: Readonly<Record<string, string | Uint8Array>>,
    opts: SandboxOptions,
  ): Promise<CompileResult> => {
    const tex = files['main.tex'];
    seen.push(typeof tex === 'string' ? tex : new TextDecoder().decode(tex ?? new Uint8Array()));
    const bm = files['manifest.json'];
    bundleManifests.push(
      typeof bm === 'string' ? bm : new TextDecoder().decode(bm ?? new Uint8Array()),
    );
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
      name: 'docedit-exp004-v-exp-001-016',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  return { compile, seen, bundleManifests };
}

interface Run {
  job: JobRecord;
  tex: string;
  bundleManifest: Record<string, unknown> | null;
  resultManifest: Record<string, unknown> | null;
}

async function exportAt(seq: number): Promise<Run> {
  const probe = fakeCompile();
  const stored = new Map<string, Uint8Array>();
  const handler = createExportHandler({
    stores: stores(),
    outputs: {
      putExport: async (_tenant: string, _job: string, name: string, bytes: Uint8Array) => {
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
    worker: 'w-exp004-v-exp-001-016',
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
  const parse = (text: string | Uint8Array | undefined): Record<string, unknown> | null =>
    text === undefined
      ? null
      : (JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(text)) as Record<
          string,
          unknown
        >);
  return {
    job: done,
    tex: probe.seen[0] ?? '',
    bundleManifest: parse(probe.bundleManifests[0]),
    resultManifest: parse(stored.get('manifest.json')),
  };
}

describe('EXP-004 criterion 7: an export below the head is built from its seq and records it', () => {
  it('builds the bundle from the content at seq 2, not from the head at seq 3', async () => {
    const run = await exportAt(2);
    expect(run.job.state).toBe('completed');
    expect(run.tex).toContain('Byron');
    expect(run.tex).not.toContain('Grace');
    expect(run.tex).not.toContain('Ada');
  });

  it('records seq 2 in the bundle manifest and in the stored result manifest', async () => {
    const run = await exportAt(2);
    expect(run.bundleManifest?.['seq']).toBe(2);
    expect(run.resultManifest).not.toBeNull();
    expect(run.resultManifest?.['seq']).toBe(2);
    expect(run.resultManifest?.['target']).toBe('pdf');
  });
});
