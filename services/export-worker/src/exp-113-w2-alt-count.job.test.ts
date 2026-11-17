/**
 * EXP-113 criterion 2 (lane w2): the result a job stores holds the count of images and figures
 * without alternative text, one per occurrence. Two pictures of one paragraph give two equal
 * diagnostics, which the job joins into one entry of `diagnostics`; the count still says two.
 * Node.js only: the compile is a fake, and the job runs through the real handler and JobRunner.
 */
import { describe, expect, it } from 'vitest';
import {
  JobRunner,
  MemoryJobQueue,
  type ExportOutputs,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler } from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const INCARNATION = 'inc-exp113-w2';
const PARAGRAPH = 'pAlt113000000001';
const FIGURE = 'gAlt113000000001';
const HASH = 'd'.repeat(64);

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

const image = (alt?: string): Record<string, unknown> => ({
  type: 'image',
  attrs: { asset: HASH, width: 1440, height: 1440, ...(alt !== undefined ? { alt } : {}) },
});

/** `pictures` says which pictures the body has: two inline without `alt`, one figure without. */
function envelope(pictures: 'three-without' | 'all-with'): CdmEnvelope {
  const base = demoDocument().envelope as unknown as { doc: { content: unknown[] } };
  const defs = base.doc.content[0];
  const alt = pictures === 'all-with' ? 'A drawing.' : undefined;
  const body = {
    type: 'body',
    attrs: { pageSetup: 'ps1' },
    content: [
      {
        type: 'paragraph',
        attrs: { id: PARAGRAPH, style: 'Normal' },
        content: [{ type: 'text', text: 'Two pictures: ' }, image(alt), image(alt)],
      },
      {
        type: 'figure',
        attrs: {
          id: FIGURE,
          asset: HASH,
          width: 1440,
          height: 1440,
          ...(alt !== undefined ? { alt } : {}),
        },
      },
    ],
  };
  return {
    ...demoDocument().envelope,
    doc: { type: 'doc', content: [defs, body] },
  } as unknown as CdmEnvelope;
}

function stores(content: CdmEnvelope): ContentStores {
  return {
    logs: {
      head: async () => ({ seq: 0, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async () => ({ seq: 0, content }) as never,
      get: async () => null,
    },
    documents: {
      get: async (ref) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Pictures',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

const compile = async (
  _files: Readonly<Record<string, string | Uint8Array>>,
  opts: SandboxOptions,
): Promise<CompileResult> => {
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
    name: 'docedit-exp113-w2',
    limits: { ...LIMITS },
    passTimeoutSeconds: 110,
  };
};

async function run(
  target: 'pdf' | 'tex' | 'cdm',
  pictures: 'three-without' | 'all-with',
): Promise<JobRecord> {
  const handler = createExportHandler({
    stores: stores(envelope(pictures)),
    outputs: { putExport: async () => {} } as never,
    fonts: async () => TEST_FONTS,
    imageId: async () => `sha256:${'d'.repeat(64)}`,
    compile,
  });
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: { export: handler },
    worker: 'w-exp113-w2',
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
      target,
      seq: 0,
      incarnation: INCARNATION,
      options: { profile: 'preview' },
      requester: 'user-1',
      role: 'editor',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
    },
  });
  await runner.runOnce();
  return (await queue.get(tenant, job.id)) as JobRecord;
}

describe('EXP-113 criterion 2: the job result holds the count of images without alternative text', () => {
  for (const target of ['pdf', 'tex'] as const) {
    it(`counts each occurrence in a ${target} job, also two in one block`, async () => {
      const job = await run(target, 'three-without');
      expect(job.state, JSON.stringify(job.error)).toBe('completed');
      const out = job.result as unknown as ExportOutputs;
      expect(out.imagesWithoutAlt).toBe(3);
      const listed = (out.diagnostics ?? []).filter((d) => d.code === 'image_without_alt');
      // The list names both blocks; the two pictures of the paragraph are one entry of it.
      expect(new Set(listed.map((d) => d.blockId))).toEqual(new Set([PARAGRAPH, FIGURE]));
      expect(listed.length).toBeLessThanOrEqual(3);
    });
  }

  it('reports zero when every picture has alternative text', async () => {
    const job = await run('pdf', 'all-with');
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    const out = job.result as unknown as ExportOutputs;
    expect(out.imagesWithoutAlt).toBe(0);
    expect((out.diagnostics ?? []).some((d) => d.code === 'image_without_alt')).toBe(false);
  });

  it('gives no count for a target that is not typeset (cdm)', async () => {
    const job = await run('cdm', 'three-without');
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    expect((job.result as unknown as ExportOutputs).imagesWithoutAlt).toBeUndefined();
  });
});
