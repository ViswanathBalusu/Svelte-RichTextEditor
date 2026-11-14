/**
 * Steps (04 §4): the JSON of prosemirror-transform's Step.toJSON(). The authority accepts only the
 * step types on the allow-list and refuses everything else, `docAttr` included.
 */
import { canonicalize, utf8 } from '@docedit/model';
import type { Schema } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { type Limits, type Result, fail, ok } from './codes.ts';

export const ALLOWED_STEP_TYPES: readonly string[] = [
  'replace',
  'replaceAround',
  'addMark',
  'removeMark',
  'addNodeMark',
  'removeNodeMark',
  'attr',
];

export type StepJson = Record<string, unknown> & { stepType: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses the steps of a commit (04 §3.1, §4); malformed input is `invalid_op` or `too_large`. */
export function parseSteps(schema: Schema, json: unknown, limits: Limits): Result<Step[]> {
  if (!Array.isArray(json)) return fail('invalid_op', 'steps must be an array');
  if (json.length === 0) return fail('invalid_op', 'a step commit carries at least one step');
  if (json.length > limits.maxStepsPerCommit)
    return fail('too_large', `more than ${limits.maxStepsPerCommit} steps`);
  const steps: Step[] = [];
  for (let i = 0; i < json.length; i++) {
    const s: unknown = json[i];
    if (!isObject(s) || typeof s['stepType'] !== 'string')
      return fail('invalid_op', `step ${i} has no stepType`);
    if (!ALLOWED_STEP_TYPES.includes(s['stepType']))
      return fail('invalid_op', `step type "${s['stepType']}" is not allowed`);
    try {
      steps.push(Step.fromJSON(schema, s));
    } catch (e) {
      return fail('invalid_op', `step ${i} is malformed: ${(e as Error).message}`);
    }
  }
  return ok(steps);
}

export function stepsToJson(steps: readonly Step[]): StepJson[] {
  return steps.map((s) => s.toJSON() as StepJson);
}

/**
 * Replaces each `markSet` step (prosemirror-transform 1.12: the inverse of a mark step over inline
 * atoms, as an undo of formatting produces) with the `addMark` and `removeMark` steps it holds, in
 * order (ADR 0050 item 10). Mark steps move no positions, so the expansion maps and applies exactly
 * as the composite does. `markSet` is not on the allow-list of 04 §4: a client expands it before it
 * sends a commit; the authority refuses it with `invalid_op`.
 */
export function expandMarkSets(steps: readonly Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    const inner = (s as unknown as { steps?: unknown }).steps;
    if ((s.toJSON() as { stepType?: unknown }).stepType === 'markSet' && Array.isArray(inner))
      out.push(...expandMarkSets(inner as Step[]));
    else out.push(s);
  }
  return out;
}

/** Two step lists are equal when their canonical JSON is equal (04 §7). */
export function stepsEqual(a: readonly Step[], b: readonly Step[]): boolean {
  return a.length === b.length && canonicalize(stepsToJson(a)) === canonicalize(stepsToJson(b));
}

/** Size of a commit in bytes as serialised for the limit check (04 §3.1). */
export function commitBytes(commit: unknown): number {
  try {
    return utf8(JSON.stringify(commit)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
