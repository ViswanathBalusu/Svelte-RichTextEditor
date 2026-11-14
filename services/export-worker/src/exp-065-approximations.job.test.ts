/**
 * EXP-065 criterion 2 (export worker, Node.js only, no sandbox): when the converter approximates a
 * construct, the job's result carries a warning for it, naming the block it came from. The compile
 * is replaced by a fake, so these tests need no Podman. The document is in
 * test/approximations.ts. Split rows have no warning in the converter, so that case is not here
 * (see the story Notes).
 */
import { JobRunner, MemoryJobQueue, type JobRecord } from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { approximatingDocument, EXPECTED } from '../test/approximations.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler } from './job.ts';
import { LIMITS, type CompileResult } from './sandbox.ts';

const INCARNATION = 'inc-approx';

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0], '2': [1, 4_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

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
          title: 'Approximations',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

/** A compile that succeeds and returns a one-page layout; nothing is typeset. */
const fakeCompile = async (): Promise<CompileResult> => ({
  ok: true,
  exitCode: 0,
  timedOut: false,
  outputOverflow: false,
  cancelled: false,
  passes: [
    { pass: 1, rc: 0, ms: 100 },
    { pass: 2, rc: 0, ms: 100 },
  ],
  converged: true,
  pdf: new TextEncoder().encode('%PDF-2.0 test'),
  log: 'This is LuaHBTeX\n',
  layoutRaw: RAW_LAYOUT,
  stderr: '',
  wallMs: 1500,
  stdout: new Uint8Array(),
  name: 'docedit-approx-test',
  limits: { ...LIMITS },
  passTimeoutSeconds: 110,
});

/** Runs one final PDF export job of `envelope` through the control plane's runner. */
async function runExport(envelope: CdmEnvelope): Promise<JobRecord> {
  const handler = createExportHandler({
    stores: stores(envelope),
    outputs: { putExport: async () => {} },
    fonts: async () => TEST_FONTS,
    imageId: async () => `sha256:${'b'.repeat(64)}`,
    compile: fakeCompile,
  });
  const queue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: { export: handler },
    worker: 'w1',
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
  return (await queue.get(tenant, job.id))!;
}

interface Diag {
  severity: string;
  code: string;
  blockId: string | null;
  message: string;
}

describe('EXP-065 criterion 2: every approximated construct has a warning in the job result', () => {
  it('completes the job and reports one warning per approximated construct, naming its block', async () => {
    const job = await runExport(approximatingDocument());
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    const diagnostics = (job.result as { diagnostics: Diag[] }).diagnostics;
    for (const want of EXPECTED) {
      const found = diagnostics.filter((d) => d.code === want.code);
      expect(found.length, `a ${want.code} warning`).toBeGreaterThan(0);
      expect(
        found.map((d) => d.blockId),
        want.code,
      ).toContain(want.blockId);
      for (const d of found) expect(d.severity).toBe('warning');
    }
  });
});
