/**
 * EXP-088 criteria 1 and 3 (lane w2): an `md` job runs through the worker with the states of an
 * `html` job, writes the Markdown and nothing else (no compile, no sandbox), carries the writer's
 * diagnostics into the job's result, and projects a restricted view as pdf does (EXP-123). The job
 * runs through the control plane's JobRunner and MemoryJobQueue, as in exp-087-html.job.test.ts; no
 * Podman is needed.
 */
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument, REGION_A } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler, MD_OUTPUT_FILE } from './job.ts';

const INCARNATION = 'inc-w2-exp-088';

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

interface Run {
  job: JobRecord;
  stored: Array<{ name: string; bytes: Uint8Array; type: string }>;
  compiles: number;
}

type Node = { type?: string; content?: Node[] } & Record<string, unknown>;

/** The demonstration document with a text that carries underline, which Markdown cannot express. */
function withUnderline(): CdmEnvelope {
  const envelope = structuredClone(demoDocument().envelope);
  const body = (envelope.doc as Node).content!.find((c) => c.type === 'body')!;
  const first = body.content!.find((c) => c.type === 'paragraph')!;
  first.content = [{ type: 'text', text: 'Under_lined *text*.', marks: [{ type: 'underline' }] }];
  return envelope;
}

async function runJob(
  payload: Record<string, unknown> = {},
  envelope: CdmEnvelope = demoDocument().envelope,
): Promise<Run> {
  const stored: Run['stored'] = [];
  let compiles = 0;
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: {
      export: createExportHandler({
        stores: stores(envelope),
        outputs: {
          putExport: async (_t, _j, name, bytes, type) => {
            stored.push({ name, bytes, type });
          },
        },
        fonts: async () => TEST_FONTS,
        compile: async () => {
          compiles++;
          throw new Error('an md job must not compile');
        },
        imageId: async () => null,
      }),
    },
    worker: 'w-w2-088',
    leaseMs: 60_000,
    idleMs: 10,
    retryAfterMs: 0,
  });
  const tenant = uuid7();
  const doc = uuid7();
  const queued = await queue.enqueue(tenant, {
    kind: 'export',
    doc,
    createdBy: 'user-1',
    payload: {
      doc,
      target: 'md',
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
  await runner.runOnce();
  const job = (await queue.get(tenant, queued.id))!;
  return { job, stored, compiles };
}

const text = (r: Run): string => new TextDecoder().decode(r.stored[0]!.bytes);
const codesOf = (r: Run): string[] =>
  ((r.job.result as { diagnostics?: Array<{ code: string }> }).diagnostics ?? []).map(
    (d) => d.code,
  );

describe('EXP-088 md job through the export worker (criteria 1 and 3)', () => {
  it('completes an md job, storing only the Markdown, with no compile', async () => {
    const run = await runJob();
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.compiles).toBe(0);
    expect(run.stored.map((s) => s.name)).toEqual([MD_OUTPUT_FILE]);
    expect(run.stored[0]!.type).toBe('text/markdown; charset=utf-8');
    expect(run.job.result).toMatchObject({
      output: MD_OUTPUT_FILE,
      pages: null,
      layout: null,
      log: null,
    });
    expect(text(run).length).toBeGreaterThan(0);
    // Markdown, not HTML: no document element is written.
    expect(text(run)).not.toContain('<body>');
  });

  it('writes the headings of the document in Markdown', async () => {
    const run = await runJob();
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(text(run)).toMatch(/^#{1,6} /m);
  });

  it('escapes Markdown-special characters in the typed text and names underline in the warnings', async () => {
    const run = await runJob({}, withUnderline());
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(text(run)).toContain('Under\\_lined \\*text\\*.');
    const diagnostics = (
      run.job.result as { diagnostics?: Array<{ code: string; severity: string }> }
    ).diagnostics!;
    const underline = diagnostics.filter((d) => d.code.includes('underline'));
    expect(underline.length).toBeGreaterThan(0);
    expect(underline.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('names a page setup the Markdown cannot express in the result diagnostics', async () => {
    const run = await runJob();
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(codesOf(run)).toContain('page_setup_omitted');
  });

  it('writes the text of a restricted view without the hidden region (EXP-123)', async () => {
    const full = text(await runJob());
    const restricted = await runJob({ hiddenRegions: [REGION_A] });
    expect(restricted.job.state, JSON.stringify(restricted.job.error)).toBe('completed');
    expect(text(restricted).length).toBeLessThan(full.length);
    expect(text(restricted)).not.toContain('holds the terms');
  });

  it('refuses unresolved suggestions without a mode, as pdf does, and accepts a mode', async () => {
    const envelope = structuredClone(demoDocument().envelope);
    const body = (envelope.doc as Node).content!.find((c) => c.type === 'body')!;
    const first = body.content!.find((c) => c.type === 'paragraph')!;
    first.content = [
      {
        type: 'text',
        text: 'Proposed.',
        marks: [{ type: 'ins', attrs: { id: 'sIns088w200000001', user: 'alice' } }],
      },
    ];
    const refused = await runJob({}, envelope);
    expect(refused.job.state).toBe('failed');
    expect(JSON.stringify(refused.job.error)).toContain('unsupported_feature');
    const accepted = await runJob({ options: { suggestions: 'accept' } }, envelope);
    expect(accepted.job.state, JSON.stringify(accepted.job.error)).toBe('completed');
    expect(text(accepted)).toContain('Proposed.');
  });
});
