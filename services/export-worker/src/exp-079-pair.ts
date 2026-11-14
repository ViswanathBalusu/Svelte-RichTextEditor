/**
 * EXP-079 (lane V-EXP-065-080): a final PDF that is to be sealed is compiled twice, each compile in
 * its own single-use sandbox, and the two PDFs are compared. Only a PDF from an equal pair can be
 * handed to the sealing step: `acceptForSealing` refuses anything that `comparePair` did not mark.
 * Pinning the bundle to `completedSeq` and the chain head (criterion 2) is the sealing service's
 * check and is not made here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { compileInSandbox, type CompileResult, type SandboxOptions } from './sandbox.ts';

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
): Promise<PairOutcome> {
  const tag = randomBytes(6).toString('hex');
  const base = opts.name ?? `docedit-v-exp-065-080-seal-${tag}`;
  const [a, b] = await Promise.all([
    compileInSandbox(files, { ...opts, name: `${base}-a` }),
    compileInSandbox(files, { ...opts, name: `${base}-b` }),
  ]);
  return comparePair(a, b);
}
