/**
 * EXP-085 criterion 1 (lane V-EXP-081-096): a `tex` job runs through the export worker, writes the
 * bundle as one archive with `main.tex`, `styles.tex`, `docedit.cls`, `map.json` and `manifest.json`
 * and the README, and no auxiliary file, log or PDF. No compile runs, so no Podman is needed.
 * The job runs through the control plane's JobRunner and MemoryJobQueue, as in
 * exp-086-cdm.job.test.ts.
 */
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler, TEX_OUTPUT_FILE, type ExportHandlerDeps } from './job.ts';

const INCARNATION = 'inc-v-exp-081-096-085';

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

async function runJob(target: string): Promise<Run> {
  const envelope = demoDocument().envelope;
  const stored: Run['stored'] = [];
  let compiles = 0;
  const queue: JobQueue = new MemoryJobQueue();
  const deps: ExportHandlerDeps = {
    stores: stores(envelope),
    outputs: {
      putExport: async (_t, _j, name, bytes, type) => {
        stored.push({ name, bytes, type });
      },
    },
    fonts: async () => TEST_FONTS,
    // A tex job never compiles; a call here is a failure of the rule.
    compile: async () => {
      compiles++;
      throw new Error('a tex job must not compile');
    },
    imageId: async () => null,
  };
  const runner = new JobRunner({
    queue,
    handlers: { export: createExportHandler(deps) },
    worker: 'w-v-exp-081-096',
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
    },
  });
  await runner.runOnce();
  const job = (await queue.get(tenant, queued.id))!;
  return { job, stored, compiles };
}

/** The member names and bodies of a ustar archive (the format archive.ts writes). */
function readTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let at = 0;
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/s, '');
    const sizeText = dec.decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim();
    const size = parseInt(sizeText, 8);
    at += 512;
    out.set(name, bytes.subarray(at, at + size));
    at += Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('EXP-085 tex job through the export worker (criterion 1)', () => {
  it('completes a tex job with one archive holding the bundle, and no compile', async () => {
    const run = await runJob('tex');
    expect(run.job.state, JSON.stringify(run.job.error)).toBe('completed');
    expect(run.compiles).toBe(0);
    expect(run.stored.map((s) => s.name)).toEqual([TEX_OUTPUT_FILE]);
    expect(run.stored[0]!.type).toBe('application/x-tar');
    expect(run.job.result).toMatchObject({
      output: TEX_OUTPUT_FILE,
      pages: null,
      layout: null,
      log: null,
    });
  });

  it('lists main.tex, styles.tex, docedit.cls, map.json and manifest.json, and no auxiliary file', async () => {
    const run = await runJob('tex');
    expect(run.job.state).toBe('completed');
    const members = readTar(run.stored[0]!.bytes);
    const names = [...members.keys()];
    for (const required of [
      'main.tex',
      'styles.tex',
      'docedit.cls',
      'map.json',
      'manifest.json',
      'README.txt',
    ])
      expect(names).toContain(required);
    for (const name of names) {
      expect(name).not.toMatch(/\.(aux|log|out|toc|pdf)$/);
    }
    const main = new TextDecoder().decode(members.get('main.tex')!);
    expect(main).toContain('\\documentclass');
  });
});
