/**
 * EXP-086 criterion 4 (lane U-EXP-081-096): a `cdm` job runs through the worker with the same
 * states as a `pdf` job, writes the canonical JSON and nothing else, and projects a restricted view
 * as pdf does (EXP-123). The job runs through the control plane's JobRunner and MemoryJobQueue, as in
 * job.test.ts; no compile runs, so no Podman is needed.
 */
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { cdmWriter } from '@docedit/export-latex';
import { sha256HexBytes, uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument, REGION_A } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { CDM_OUTPUT_FILE, createExportHandler, type ExportHandlerDeps } from './job.ts';

const INCARNATION = 'inc-u-exp-081-096-086';

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
  reports: string[];
}

async function runJob(
  target: string,
  payload: Record<string, unknown> = {},
  deps: Partial<ExportHandlerDeps> = {},
): Promise<Run> {
  const envelope = demoDocument().envelope;
  const stored: Run['stored'] = [];
  const reports: string[] = [];
  let compiles = 0;
  class RecordingQueue extends MemoryJobQueue {
    override heartbeat(...args: Parameters<MemoryJobQueue['heartbeat']>) {
      const report = args[3];
      if (report?.stage) reports.push(`${report.stage} ${report.progress}`);
      return super.heartbeat(...args);
    }
  }
  const queue: JobQueue = new RecordingQueue();
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
        // A cdm job never compiles; a call here is a failure of the rule.
        compile: async () => {
          compiles++;
          throw new Error('a cdm job must not compile');
        },
        imageId: async () => null,
        ...deps,
      }),
    },
    worker: 'w-u-exp-081-096',
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
      target,
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
  return { job, stored, compiles, reports };
}

describe('EXP-086 cdm job through the export worker (criterion 4)', () => {
  it('completes a cdm job with the same states as pdf, writing only the canonical JSON', async () => {
    const run = await runJob('cdm');
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.compiles).toBe(0);
    // The stages the worker reports, in order, as the pdf job reports its own.
    expect(run.reports[0]).toBe('converting 5');
    expect(run.reports).toContain('converting 50');
    expect(run.reports.some((r) => r.startsWith('compiling'))).toBe(false);
    // Only the canonical JSON is stored: no PDF, log, layout or manifest.
    expect(run.stored.map((s) => s.name)).toEqual([CDM_OUTPUT_FILE]);
    expect(run.stored[0]!.type).toBe('application/json');
    expect(run.job.result).toMatchObject({
      output: CDM_OUTPUT_FILE,
      pages: null,
      layout: null,
      log: null,
    });
  });

  it('writes the RFC 8785 canonical form, whose hash equals the writer hash for the document', async () => {
    const envelope = demoDocument().envelope;
    const expected = await cdmWriter.write(
      { document: envelope, seq: 0, chainHead: null, fonts: TEST_FONTS, assets: {} },
      {},
    );
    const run = await runJob('cdm');
    expect(run.job.state).toBe('completed');
    const bytes = run.stored[0]!.bytes;
    expect(new TextDecoder().decode(bytes)).toBe(expected.text);
    expect(await sha256HexBytes(bytes)).toBe(expected.sha256);
    // The envelope holds no comments, grants or history (EXP-086 criterion 3).
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['cdm', 'doc', 'requires']);
  });

  it('projects a cdm job for a restricted view, as pdf does (EXP-123), and writes no hidden text', async () => {
    const run = await runJob('cdm', { hiddenRegions: [REGION_A] });
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.compiles).toBe(0);
    expect(run.stored.map((s) => s.name)).toEqual([CDM_OUTPUT_FILE]);
    const body = new TextDecoder().decode(run.stored[0]!.bytes);
    expect(body).not.toContain('holds the terms');
    expect(body).toContain('hidden_region');
  });

  it('refuses a target this worker does not write, with the same code as before', async () => {
    const run = await runJob('rtf');
    expect(run.job.state).toBe('failed');
    expect(run.job.error?.code).toBe('validation_failed');
    expect(run.stored).toEqual([]);
  });
});
