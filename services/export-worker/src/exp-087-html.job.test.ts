/**
 * EXP-087 criterion 4 (lane w2): an `html` job runs through the worker with the states of a `cdm`
 * job, writes the HTML and nothing else (no compile, no sandbox), carries the writer's diagnostics
 * into the job's result, and projects a restricted view as pdf does (EXP-123). The job runs through
 * the control plane's JobRunner and MemoryJobQueue, as in exp-086-cdm.job.test.ts; no Podman is
 * needed.
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
import { createExportHandler, HTML_OUTPUT_FILE } from './job.ts';

const INCARNATION = 'inc-w2-exp-087';

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
          title: 'Demo & <title>',
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

/** The demonstration document with a paragraph that has tab stops, which HTML cannot express. */
function withTabStops(): CdmEnvelope {
  const envelope = structuredClone(demoDocument().envelope);
  const body = (envelope.doc as Node).content!.find((c) => c.type === 'body')!;
  const first = body.content!.find((c) => c.type === 'paragraph')!;
  first['attrs'] = {
    ...(first['attrs'] as object),
    tabs: [{ pos: 2880, kind: 'left', leader: 'none' }],
  };
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
          throw new Error('an html job must not compile');
        },
        imageId: async () => null,
      }),
    },
    worker: 'w-w2-087',
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
      target: 'html',
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

describe('EXP-087 html job through the export worker (criterion 4)', () => {
  it('completes an html job, storing only the HTML, with no compile', async () => {
    const run = await runJob();
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.compiles).toBe(0);
    expect(run.stored.map((s) => s.name)).toEqual([HTML_OUTPUT_FILE]);
    expect(run.stored[0]!.type).toBe('text/html; charset=utf-8');
    expect(run.job.result).toMatchObject({
      output: HTML_OUTPUT_FILE,
      pages: null,
      layout: null,
      log: null,
    });
    const html = text(run);
    expect(html).toContain('<body>');
    expect(html).toContain('<title>Demo &amp; &lt;title&gt;</title>');
  });

  it('names a construct HTML cannot express in the result diagnostics', async () => {
    const run = await runJob({}, withTabStops());
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    const codes = (
      (run.job.result as { diagnostics?: Array<{ code: string }> }).diagnostics ?? []
    ).map((d) => d.code);
    expect(codes).toContain('paragraph_layout_omitted');
    expect(codes).toContain('page_setup_omitted');
    const severities = (
      (run.job.result as { diagnostics?: Array<{ code: string; severity: string }> }).diagnostics ??
      []
    ).filter((d) => d.code === 'page_setup_omitted' || d.code === 'paragraph_layout_omitted');
    expect(severities.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('writes the text of a restricted view without the hidden region (EXP-123)', async () => {
    const full = text(await runJob());
    const restricted = await runJob({ hiddenRegions: [REGION_A] });
    expect(restricted.job.state, JSON.stringify(restricted.job.error)).toBe('completed');
    expect(text(restricted).length).toBeLessThan(full.length);
  });

  it('refuses unresolved suggestions without a mode, as pdf does, and accepts a mode', async () => {
    const envelope = structuredClone(demoDocument().envelope);
    const body = (envelope.doc as Node).content!.find((c) => c.type === 'body')!;
    const first = body.content!.find((c) => c.type === 'paragraph')!;
    first.content = [
      {
        type: 'text',
        text: 'Proposed.',
        marks: [{ type: 'ins', attrs: { id: 'sIns087w200000001', user: 'alice' } }],
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
