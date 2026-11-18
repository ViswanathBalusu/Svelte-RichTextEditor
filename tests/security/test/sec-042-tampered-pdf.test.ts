/**
 * SEC-042: a PDF that one of two compiles changed cannot be sealed (10 section 3.6; 09 section 9.3
 * item 8; 12 section 8.2 step 2).
 *
 * The export worker's real job handler runs through the real `JobRunner` and queue, with a fake
 * compile (as services/export-worker/src/exp-079-sealing.job.test.ts does): a sealing job compiles
 * its bundle twice under two sandbox names, and the test makes one of the two compiles return a PDF
 * with one byte changed, or with one invisible character added. Then:
 * - the comparison fails, the job fails with `seal_pair_differs` and a diagnostic naming the hashes,
 *   and nothing is stored (no output.pdf, no manifest);
 * - `acceptForSealing`, the guard the sealing step must call, refuses what the pair produced and a
 *   look-alike object that `comparePair` did not mark;
 * - the pin of the bundle to `completedSeq` and the chain head refuses a bundle whose manifest does
 *   not match, before anything is compiled.
 *
 * What this does not show: the two compiles are two sandboxes started by one worker, which is what
 * EXP-079 criterion 1 leaves open as "independent"; the sealing step and the signing service do not
 * exist (FRW-052, FRW-053); the control plane does not yet write the `sealing` pin (FRW-049).
 */
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7 } from '@docedit/model';
import { demoDocument } from '../../../services/export-worker/test/documents.ts';
import { TEST_FONTS } from '../../../services/export-worker/test/fonts.ts';
import type { ContentStores } from '../../../services/export-worker/src/content.ts';
import { createExportHandler } from '../../../services/export-worker/src/job.ts';
import {
  acceptForSealing,
  comparePair,
  type SealablePdf,
} from '../../../services/export-worker/src/exp-079-pair.ts';
import {
  LIMITS,
  type CompileResult,
  type SandboxOptions,
} from '../../../services/export-worker/src/sandbox.ts';

const INCARNATION = 'inc-sec042-w8';
const HEAD = 'e'.repeat(64);
const PIN = { completedSeq: 2, chainHead: HEAD };
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

/** `chainHeadAt` is the worker's read of the log's chain head at the seq; `null` leaves it unset. */
function stores(chainHeadAt: ContentStores['chainHeadAt'] | null): ContentStores {
  const envelope = demoDocument().envelope;
  const base: ContentStores = {
    logs: {
      head: async () => ({ seq: 2, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async () => ({ seq: 2, content: envelope }) as never,
      get: async () => null,
    },
    documents: {
      get: async (ref) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Sealed',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
  return chainHeadAt ? { ...base, chainHeadAt } : base;
}

/** The PDF each of the two sandboxes returns, by the suffix of its name (`-a` or `-b`). */
type PdfOf = (side: 'a' | 'b') => Uint8Array;

async function runJob(
  pdfOf: PdfOf,
  opts: { sealing?: unknown; chainHeadAt?: ContentStores['chainHeadAt'] | null } = {},
) {
  const names: string[] = [];
  const compile = async (
    _files: Readonly<Record<string, string | Uint8Array>>,
    o: SandboxOptions,
  ): Promise<CompileResult> => {
    names.push(o.name ?? 'single');
    const n = o.maxPasses ?? 2;
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 100 })),
      converged: n > 1,
      pdf: pdfOf(o.name?.endsWith('-b') ? 'b' : 'a'),
      log: 'This is LuaHBTeX\n',
      layoutRaw: RAW_LAYOUT,
      stderr: '',
      wallMs: 1500,
      stdout: new Uint8Array(),
      name: o.name ?? 'single',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  const stored = new Map<string, Uint8Array>();
  const handler = createExportHandler({
    stores: stores(opts.chainHeadAt === undefined ? async () => HEAD : opts.chainHeadAt),
    outputs: {
      putExport: async (_t: string, _j: string, name: string, bytes: Uint8Array) => {
        stored.set(name, bytes);
      },
    } as never,
    fonts: async () => TEST_FONTS,
    imageId: async () => `sha256:${'d'.repeat(64)}`,
    compile,
  });
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: { export: handler },
    worker: 'w-sec042',
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
      seq: 2,
      incarnation: INCARNATION,
      options: { fields: 'flatten' },
      requester: 'user-1',
      role: 'editor',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
      sealing: opts.sealing === undefined ? PIN : opts.sealing,
    },
  });
  await runner.runOnce();
  const done = (await queue.get(tenant, job.id)) as JobRecord;
  return { job: done, stored, names };
}

interface Diag {
  code: string;
  message?: string;
}

function diagnostics(job: JobRecord): Diag[] {
  return (
    (job.result as { diagnostics?: Diag[] } | null)?.diagnostics ??
    (job.error as { diagnostics?: Diag[] } | null)?.diagnostics ??
    []
  );
}

const header = new TextEncoder().encode('%PDF-2.0\n');
/** A PDF-like byte string: a header, then what the property supplies. */
const pdfBytes = fc
  .uint8Array({ minLength: 16, maxLength: 400 })
  .map((b) => Uint8Array.from([...header, ...b]));

/** Invisible characters in UTF-8: zero-width space, zero-width non-joiner, soft hyphen, BOM. */
const INVISIBLE: ReadonlyArray<readonly number[]> = [
  [0xe2, 0x80, 0x8b],
  [0xe2, 0x80, 0x8c],
  [0xc2, 0xad],
  [0xef, 0xbb, 0xbf],
];

const flipByte = (b: Uint8Array, at: number, xor: number): Uint8Array => {
  const out = b.slice();
  out[at % out.length] = out[at % out.length]! ^ xor;
  return out;
};
const insertInvisible = (b: Uint8Array, at: number, which: number): Uint8Array => {
  const ch = INVISIBLE[which % INVISIBLE.length]!;
  const i = at % (b.length + 1);
  return Uint8Array.from([...b.slice(0, i), ...ch, ...b.slice(i)]);
};

async function expectRefused(a: Uint8Array, b: Uint8Array): Promise<void> {
  const run = await runJob((side) => (side === 'a' ? a : b));
  expect(run.job.state).toBe('failed');
  const d = diagnostics(run.job).find((x) => x.code === 'seal_pair_differs');
  expect(d, 'a seal_pair_differs diagnostic').toBeDefined();
  // The diagnostic names the hash of the first compile (the job cuts the message after about 200
  // characters, so the second hash is not always in it; the job result of an equal pair holds both).
  expect(d!.message).toContain(sha(a));
  expect(run.stored.size, 'nothing is stored').toBe(0);
  expect(run.names).toHaveLength(2);
}

describe('SEC-042 criterion 2: one changed byte in one compile refuses the seal', () => {
  it('control: two equal compiles are stored and the hashes of both are recorded', async () => {
    const pdf = Uint8Array.from([...header, 1, 2, 3]);
    const run = await runJob(() => pdf);
    expect(run.job.state).toBe('completed');
    expect(run.stored.has('output.pdf')).toBe(true);
    const result = run.job.result as { sealing: { pdfSha256: { a: string; b: string } } };
    expect(result.sealing.pdfSha256).toEqual({ a: sha(pdf), b: sha(pdf) });
  });

  it('any single byte changed in the second compile fails the job and stores nothing', async () => {
    await fc.assert(
      fc.asyncProperty(pdfBytes, fc.nat(), fc.integer({ min: 1, max: 255 }), async (pdf, at, x) => {
        await expectRefused(pdf, flipByte(pdf, at, x));
      }),
      { numRuns: 40 },
    );
  });

  it('the same holds when the first compile is the one that changed', async () => {
    await fc.assert(
      fc.asyncProperty(pdfBytes, fc.nat(), fc.integer({ min: 1, max: 255 }), async (pdf, at, x) => {
        await expectRefused(flipByte(pdf, at, x), pdf);
      }),
      { numRuns: 20 },
    );
  });

  it('one invisible character added anywhere in one compile fails the job and stores nothing', async () => {
    await fc.assert(
      fc.asyncProperty(pdfBytes, fc.nat(), fc.nat(), async (pdf, at, which) => {
        await expectRefused(pdf, insertInvisible(pdf, at, which));
      }),
      { numRuns: 40 },
    );
  });

  it('a pair that differs gives no sealable PDF, and the sealing guard refuses it and a look-alike', () => {
    const pdf = Uint8Array.from([...header, 9, 9, 9]);
    const result = (name: string, bytes: Uint8Array): CompileResult =>
      ({ ok: true, pdf: bytes, name, wallMs: 1 }) as unknown as CompileResult;
    const bad = comparePair(result('x-a', pdf), result('x-b', flipByte(pdf, 3, 1)));
    expect(bad.ok).toBe(false);
    expect(bad.sealable).toBeNull();
    expect(() => acceptForSealing(bad.sealable)).toThrow(/equal pair/);
    // An object with the same shape as a sealable PDF, built by hand, is not accepted.
    const forged: SealablePdf = {
      pdf: flipByte(pdf, 3, 1),
      hashes: { a: sha(pdf), b: sha(pdf) },
      containers: ['x-a', 'x-b'],
    };
    expect(() => acceptForSealing(forged)).toThrow(/equal pair/);
    // The same two compiles in one container are not independent: refused as well.
    expect(comparePair(result('x-a', pdf), result('x-a', pdf)).ok).toBe(false);
    // An equal pair from two containers is accepted, and gives the bytes.
    const good = comparePair(result('x-a', pdf), result('x-b', pdf));
    expect(good.ok).toBe(true);
    expect(acceptForSealing(good.sealable)).toEqual(pdf);
  });
});

describe('SEC-042 criterion 1 (worker side): a bundle that does not match its pin is refused before compiling', () => {
  const pdf = Uint8Array.from([...header, 7]);
  const refusedBeforeCompile = async (
    sealing: unknown,
    chainHeadAt?: ContentStores['chainHeadAt'] | null,
  ): Promise<void> => {
    const run = await runJob(() => pdf, {
      sealing,
      ...(chainHeadAt !== undefined ? { chainHeadAt } : {}),
    });
    expect(run.job.state).toBe('failed');
    expect(diagnostics(run.job).map((d) => d.code)).toContain('seal_pin_mismatch');
    expect(run.names).toHaveLength(0);
    expect(run.stored.size).toBe(0);
  };

  it('a pin of another seq, or of another chain head, is refused', async () => {
    await refusedBeforeCompile({ completedSeq: 3, chainHead: HEAD });
    await refusedBeforeCompile({ completedSeq: 2, chainHead: 'f'.repeat(64) });
  });

  it('a log whose chain head at the seq is not the pinned one is refused (a history that moved or was forked)', async () => {
    await refusedBeforeCompile(PIN, async () => '0'.repeat(64));
  });

  it('a bundle with no chain head at all (the log gives none) is refused against any pin', async () => {
    await refusedBeforeCompile(PIN, async () => null);
    await refusedBeforeCompile(PIN, null);
  });

  it('the bundle that matches its pin is compiled twice (control)', async () => {
    const run = await runJob(() => pdf);
    expect(run.job.state).toBe('completed');
    expect(run.names).toHaveLength(2);
  });
});
