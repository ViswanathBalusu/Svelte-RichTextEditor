/**
 * HIS-034 criterion 3 (lane V-HIS-033-046): an export's manifest names the `seq` and the chain head
 * of the exported state. The head here is seq 3 and the export is at seq 2, so the chain head must
 * be the hash of the commit at seq 2, not the head's. Node.js only: the compile is a fake, and the
 * job runs through the real handler and JobRunner. The PostgreSQL half of the lookup is in
 * services/document-service/test/postgres/his-034-chain-head.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7 } from '@docedit/model';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler } from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const INCARNATION = 'inc-his034-v-his-033-046';
const HASH_AT_2 = 'b'.repeat(64);
const HASH_AT_3 = 'c'.repeat(64);

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

/** The stores of a head at seq 3 with checkpoints at 0, 2 and 3; `chainHeadAt` is optional. */
function stores(chainHeadAt?: ContentStores['chainHeadAt']): ContentStores {
  const envelope = demoDocument().envelope;
  const checkpoints = [0, 2, 3].map((seq) => ({ seq, content: envelope }));
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
          title: 'Chain',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
    ...(chainHeadAt ? { chainHeadAt } : {}),
  };
}

function fakeCompile() {
  const bundleManifests: string[] = [];
  const compile = async (
    files: Readonly<Record<string, string | Uint8Array>>,
    opts: SandboxOptions,
  ): Promise<CompileResult> => {
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
      name: 'docedit-his034-v-his-033-046',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  return { compile, bundleManifests };
}

interface Run {
  job: JobRecord;
  bundleManifest: Record<string, unknown> | null;
  resultManifest: Record<string, unknown> | null;
}

async function exportAt(seq: number, contentStores: ContentStores): Promise<Run> {
  const probe = fakeCompile();
  const stored = new Map<string, Uint8Array>();
  const handler = createExportHandler({
    stores: contentStores,
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
    worker: 'w-his034-v-his-033-046',
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
    bundleManifest: parse(probe.bundleManifests[0]),
    resultManifest: parse(stored.get('manifest.json')),
  };
}

describe('HIS-034 criterion 3: the export manifest names the seq and the chain head of its state', () => {
  it('names the chain head of the exported seq, not the head', async () => {
    const seen: number[] = [];
    const run = await exportAt(
      2,
      stores(async (_ref, seq) => {
        seen.push(seq);
        return seq === 2 ? HASH_AT_2 : seq === 3 ? HASH_AT_3 : null;
      }),
    );
    expect(run.job.state).toBe('completed');
    expect(seen).toEqual([2]);
    expect(run.bundleManifest?.['seq']).toBe(2);
    expect(run.bundleManifest?.['chainHead']).toBe(HASH_AT_2);
    expect(run.resultManifest?.['seq']).toBe(2);
    expect(run.resultManifest?.['chainHead']).toBe(HASH_AT_2);
  });

  it('records null when the stores offer no chain head, as before (no invented hash)', async () => {
    const run = await exportAt(2, stores());
    expect(run.job.state).toBe('completed');
    expect(run.bundleManifest?.['chainHead']).toBeNull();
    expect(run.resultManifest?.['chainHead']).toBeNull();
  });
});
