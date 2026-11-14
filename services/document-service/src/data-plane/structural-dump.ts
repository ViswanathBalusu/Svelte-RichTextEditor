/**
 * The structural dump of a document for support (06 §11; BE-089), as pure functions over the
 * checkpoint's envelope and the log's steps. Every text run (a CDM node of type `text`, in the
 * document and in the steps' slices) is replaced by filler of the same length, so a failure can be
 * reproduced with the structure, and no text of the customer is in the dump.
 *
 * Decisions (spec silent, see docs/adr/0245-lane-BE-079-091.md): the filler is one code unit
 * repeated, so the lengths in code units, which the steps' positions count, are unchanged; the
 * filler character is the first candidate that occurs in no source text, so no text run of the
 * source can survive in the dump. Attributes that may hold text (field values, alt text, titles,
 * link targets, `latex`) are not text runs and are not replaced (the story's open question).
 *
 * Nothing here logs. `runStructuralDump` records counts and identifiers only, never content.
 */
import type { StepJson } from '@docedit/authority';
import { uuid7, type JsonEnvelope } from '@docedit/model';
import type { AuditStore, DocRef } from '../storage/types.ts';

/** Candidate filler characters, in order; the first one that occurs in no source text is used. */
export const FILLER_CANDIDATES = ['█', '░', '■', '·', '—'] as const;

export interface DumpSource {
  readonly envelope: JsonEnvelope;
  /** The steps of each commit after the envelope, in order; empty for control commits. */
  readonly commits: ReadonlyArray<readonly StepJson[]>;
}

export interface StructuralDump extends DumpSource {
  /** The filler character used for every replaced text run. */
  readonly filler: string;
  /** How many text runs were replaced (in the document and in the steps). */
  readonly runs: number;
}

const isTextNode = (v: unknown): v is { type: 'text'; text: string } =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  (v as { type?: unknown }).type === 'text' &&
  typeof (v as { text?: unknown }).text === 'string';

/** Every text value of the text runs in `value`, in document order. */
export function collectTextRuns(value: unknown, out: string[] = []): string[] {
  if (isTextNode(value)) {
    out.push(value.text);
    return out;
  }
  if (Array.isArray(value)) for (const v of value) collectTextRuns(v, out);
  else if (typeof value === 'object' && value !== null)
    for (const v of Object.values(value)) collectTextRuns(v, out);
  return out;
}

/** The filler character: the first candidate that occurs in none of `runs`. */
export function chooseFiller(runs: readonly string[]): string {
  const used = runs.join('');
  const f = FILLER_CANDIDATES.find((c) => !used.includes(c));
  if (f === undefined) throw new RangeError('no filler character is free of the document text');
  return f;
}

/** A copy of `value` in which every text run is replaced by `filler` repeated to the same length. */
export function fillTextRuns(value: unknown, filler: string): unknown {
  if (isTextNode(value)) return { ...value, text: filler.repeat(value.text.length) };
  if (Array.isArray(value)) return value.map((v) => fillTextRuns(v, filler));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fillTextRuns(v, filler);
    return out;
  }
  return value;
}

/** The dump of a source: the same structure, every text run filler of its length. */
export function dumpStructure(source: DumpSource): StructuralDump {
  const runs = [...collectTextRuns(source.envelope.doc), ...collectTextRuns(source.commits)];
  const filler = chooseFiller(runs);
  return {
    envelope: fillTextRuns(source.envelope, filler) as JsonEnvelope,
    commits: fillTextRuns(source.commits, filler) as ReadonlyArray<readonly StepJson[]>,
    filler,
    runs: runs.length,
  };
}

/** Whether a text of `dump` is a text run of `source` (a run of the source in the dump's text). */
export function containsSourceRun(dump: StructuralDump, source: DumpSource): boolean {
  const dumped = collectTextRuns(dump.envelope.doc)
    .concat(collectTextRuns(dump.commits))
    .join('\n');
  return collectTextRuns(source.envelope.doc)
    .concat(collectTextRuns(source.commits))
    .some((run) => run.length > 0 && dumped.includes(run));
}

export class DumpRefusedError extends Error {
  override name = 'DumpRefusedError';
}

export interface StructuralDumpOptions {
  /** The operator's identity: a per-tenant surrogate or a name, as the audit trail records it. */
  actor: string;
  /**
   * Whether the operator is assigned to a tenant. A document of another tenant is refused. The
   * dump tool passes `OperatorAssignments.isAssigned` (operator-assignments.ts).
   */
  assigned: (tenant: string, actor: string) => boolean | Promise<boolean>;
  audit: AuditStore;
  now?: () => number;
}

/**
 * BE-089 criteria 3 and 4: refuses before reading anything when the operator is not assigned to
 * the document's tenant; otherwise loads the source, dumps it and records the run in the audit
 * trail with the operator, the document and counts (no content).
 */
export async function runStructuralDump(
  ref: DocRef,
  load: (ref: DocRef) => Promise<DumpSource>,
  opts: StructuralDumpOptions,
): Promise<StructuralDump> {
  if (!(await opts.assigned(ref.tenant, opts.actor)))
    throw new DumpRefusedError('the operator is not assigned to the document tenant');
  const dump = dumpStructure(await load(ref));
  await opts.audit.record([
    {
      id: uuid7(),
      tenant: ref.tenant,
      doc: ref.doc,
      actor: opts.actor,
      kind: 'document.structural_dump',
      data: { runs: dump.runs, commits: dump.commits.length },
      at: (opts.now ?? Date.now)(),
    },
  ]);
  return dump;
}
