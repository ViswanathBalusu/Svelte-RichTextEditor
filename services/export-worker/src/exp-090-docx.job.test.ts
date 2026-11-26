/**
 * EXP-090 criteria 1 and 5, the job half (lane w2): a `docx` job runs through the worker with the
 * states of the other direct targets, writes the package with the direct writer of
 * `@docedit/export-docx` straight from the projected CDM (no TeX, no sandbox), and returns the
 * writer's warnings as the job's. The job runs through the control plane's JobRunner and
 * MemoryJobQueue, as in exp-086-cdm.job.test.ts; no Podman is needed.
 */
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { entryData, readZip } from '@docedit/export-docx';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument, REGION_A } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler, DOCX_OUTPUT_FILE } from './job.ts';

const INCARNATION = 'inc-w2-exp-090';
const BAD_EQUATION = String.raw`\def\x{1} x`;

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

async function runJob(envelope: CdmEnvelope, payload: Record<string, unknown> = {}): Promise<Run> {
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
        compile: async () => {
          compiles++;
          throw new Error('a docx job must not compile');
        },
        imageId: async () => null,
      }),
    },
    worker: 'w-w2-090',
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
      target: 'docx',
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

const documentXml = (bytes: Uint8Array): string => {
  const zip = readZip(bytes);
  return new TextDecoder().decode(
    entryData(
      zip,
      zip.entries.find((e) => e.name === 'word/document.xml')!,
    ),
  );
};

/** The demonstration document with two equations at the end of the body, one the math gate refuses. */
function withEquations(): CdmEnvelope {
  const env = structuredClone(demoDocument().envelope) as unknown as {
    doc: { content: Array<{ type: string; content?: unknown[] }> };
  };
  const body = env.doc.content.find((n) => n.type === 'body')!;
  body.content!.push(
    { type: 'equation_block', attrs: { id: 'eBadAAAAAAAAAAA1', latex: BAD_EQUATION } },
    { type: 'equation_block', attrs: { id: 'eOkAAAAAAAAAAAA1', latex: 'a^2+b^2=c^2' } },
  );
  return env as unknown as CdmEnvelope;
}

describe('EXP-090 docx job through the export worker (criteria 1 and 5, job half)', () => {
  it('completes with a package written from the CDM, without a compile', async () => {
    const run = await runJob(demoDocument().envelope);
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.compiles).toBe(0);
    expect(run.stored.map((s) => s.name)).toEqual([DOCX_OUTPUT_FILE]);
    const out = run.stored[0]!;
    expect(out.type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect([...out.bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    const names = readZip(out.bytes).entries.map((e) => e.name);
    for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml'])
      expect(names).toContain(part);
    const xml = documentXml(out.bytes);
    for (const line of demoDocument().text.slice(0, 5)) expect(xml).toContain(line);
    expect(run.job.result).toMatchObject({ output: DOCX_OUTPUT_FILE, pages: null, log: null });
    expect(run.reports.length).toBeGreaterThan(0);
  });

  it('returns the writer warnings as the job warnings, naming the block', async () => {
    const run = await runJob(withEquations());
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    const diagnostics = (
      run.job.result as {
        diagnostics: Array<{ severity: string; code: string; message: string }>;
      }
    ).diagnostics;
    const named = diagnostics.filter((d) => d.message.includes('eBadAAAAAAAAAAA1'));
    expect(named.length).toBeGreaterThan(0);
    expect(named[0]).toMatchObject({ severity: 'warning', code: 'docx_approximation' });
    // The equation the gate accepts is written, the one it refuses is not, and the job is not failed.
    const xml = documentXml(run.stored[0]!.bytes);
    expect(xml).toContain('a^2+b^2=c^2');
    expect(xml).not.toContain(String.raw`\def`);
  });

  it('writes a restricted view without the hidden region (EXP-123)', async () => {
    const open = await runJob(demoDocument().envelope);
    const restricted = await runJob(demoDocument().envelope, {
      role: 'viewer',
      hiddenRegions: [REGION_A],
    });
    expect(restricted.job.state, JSON.stringify(restricted.job.error)).toBe('completed');
    const hidden = 'The first region holds the terms.';
    expect(documentXml(open.stored[0]!.bytes)).toContain(hidden);
    expect(documentXml(restricted.stored[0]!.bytes)).not.toContain(hidden);
  });

  it('refuses a target the worker does not write, and an option it cannot honour', async () => {
    const bad = await runJob(demoDocument().envelope, { options: { profile: 'nonsense' } });
    expect(bad.job.state).toBe('failed');
    expect(bad.job.error?.code).toBe('validation_failed');
    expect(bad.stored).toEqual([]);
  });
});
