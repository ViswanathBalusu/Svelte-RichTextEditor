/**
 * EXP-079 (lane V-EXP-065-080): a final PDF that is to be sealed is compiled twice, each compile in
 * its own single-use sandbox, and the two PDFs are compared. Only a PDF from an equal pair can be
 * handed to the sealing step: `acceptForSealing` refuses anything that `comparePair` did not mark.
 * The pin of the bundle to `completedSeq` and the chain head (criterion 2) is `pinProblem`; the job
 * handler (job.ts) applies it before the pair is compiled.
 */
import { createHash, randomBytes } from 'node:crypto';
import { compileInSandbox, type CompileResult, type SandboxOptions } from './sandbox.ts';

/** The compile of one sandbox; the job handler passes its own, and tests replace it. */
export type CompileFn = (
  files: Readonly<Record<string, string | Uint8Array>>,
  opts: SandboxOptions,
) => Promise<CompileResult>;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface PairHashes {
  readonly a: string;
  readonly b: string;
}

/** A PDF that came from an equal pair. Only `comparePair` creates one; the registry is private. */
export interface SealablePdf {
  readonly pdf: Uint8Array;
  readonly hashes: PairHashes;
  readonly containers: readonly [string, string];
}

export type PairOutcome =
  | {
      ok: true;
      sealable: SealablePdf;
      hashes: PairHashes;
      containers: readonly [string, string];
      compileMs: readonly [number, number];
    }
  | {
      ok: false;
      sealable: null;
      hashes: PairHashes | null;
      diagnostic: string;
      containers: readonly [string, string];
      compileMs: readonly [number, number];
    };

const SEALABLE = new WeakSet<SealablePdf>();

/**
 * Compares two compiles of one bundle. Equal only when both succeeded, both produced a PDF, the two
 * compiles ran in different containers, and the PDFs are byte-identical. A failed or unequal pair
 * yields no sealable PDF and a diagnostic the job should fail with (criterion 4).
 */
export function comparePair(a: CompileResult, b: CompileResult): PairOutcome {
  const containers = [a.name, b.name] as const;
  const compileMs = [a.wallMs, b.wallMs] as const;
  const fail = (diagnostic: string, hashes: PairHashes | null): PairOutcome => ({
    ok: false,
    sealable: null,
    hashes,
    diagnostic,
    containers,
    compileMs,
  });
  if (a.name === b.name) return fail('EXP-079: both compiles ran in the same container', null);
  if (!a.ok || !b.ok) {
    const which = [!a.ok ? 'first' : null, !b.ok ? 'second' : null].filter(Boolean).join(' and ');
    return fail(`EXP-079: the ${which} compile failed, nothing is sealed`, null);
  }
  if (!a.pdf || !b.pdf) return fail('EXP-079: a compile produced no PDF, nothing is sealed', null);
  const hashes: PairHashes = { a: sha256Hex(a.pdf), b: sha256Hex(b.pdf) };
  if (hashes.a !== hashes.b) {
    return fail(
      `EXP-079: the two compiles differ (${hashes.a} and ${hashes.b}), nothing is sealed`,
      hashes,
    );
  }
  const sealable: SealablePdf = { pdf: a.pdf, hashes, containers };
  SEALABLE.add(sealable);
  return { ok: true, sealable, hashes, containers, compileMs };
}

/** The PDF of a sealable pair. Throws for anything `comparePair` did not mark as equal. */
export function acceptForSealing(candidate: unknown): Uint8Array {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !SEALABLE.has(candidate as SealablePdf)
  )
    throw new Error('EXP-079: only a PDF from an equal pair may be sealed');
  return (candidate as SealablePdf).pdf;
}

/**
 * Compiles the same bundle on two independent sandboxes at once, each with its own container name,
 * and compares them. The caller counts both compiles against the tenant's compile minutes
 * (criterion 7; `compileMs` gives the wall time of each).
 */
export async function compileSealingPair(
  files: Readonly<Record<string, string | Uint8Array>>,
  opts: SandboxOptions = {},
  compile: CompileFn = compileInSandbox,
): Promise<PairOutcome> {
  const [a, b] = await compileBoth(files, opts, compile);
  return comparePair(a, b);
}

/** The two compiles of `compileSealingPair`, before they are compared: two sandboxes, two names. */
export async function compileBoth(
  files: Readonly<Record<string, string | Uint8Array>>,
  opts: SandboxOptions = {},
  compile: CompileFn = compileInSandbox,
): Promise<[CompileResult, CompileResult]> {
  const tag = randomBytes(6).toString('hex');
  const base = opts.name ?? `docedit-v-exp-065-080-seal-${tag}`;
  return Promise.all([
    compile(files, { ...opts, name: `${base}-a` }),
    compile(files, { ...opts, name: `${base}-b` }),
  ]);
}

/**
 * What a sealing export is pinned to (EXP-079 criterion 2): the `seq` the workflow completed at and
 * the chain head of the history at that `seq`. The control plane writes it into the job's payload
 * as `sealing`; a job without it is an ordinary export.
 */
export interface SealingPin {
  readonly completedSeq: number;
  readonly chainHead: string;
}

/** The pin of a job payload member: null when absent, `invalid` when it is not `{ completedSeq, chainHead }`. */
export function readSealingPin(v: unknown): SealingPin | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const { completedSeq, chainHead } = v as Record<string, unknown>;
  if (!Number.isSafeInteger(completedSeq) || (completedSeq as number) < 0) return 'invalid';
  if (typeof chainHead !== 'string' || chainHead.length === 0) return 'invalid';
  return { completedSeq: completedSeq as number, chainHead };
}

/**
 * Why a bundle does not match its pin, or null when it does. The bundle's own manifest is compared:
 * its `seq` and its chain head are what the converter wrote into the files that would be compiled.
 */
export function pinProblem(
  bundle: { readonly seq: number | null; readonly chainHead: string | null },
  pin: SealingPin,
): string | null {
  if (bundle.seq !== pin.completedSeq)
    return `the bundle is of seq ${bundle.seq ?? 'none'}, the pin is seq ${pin.completedSeq}`;
  if (bundle.chainHead !== pin.chainHead)
    return `the bundle's chain head is ${bundle.chainHead ?? 'none'}, the pin's is ${pin.chainHead}`;
  return null;
}
