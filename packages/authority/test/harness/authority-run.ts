/**
 * The four pure functions of the authority (SYN-001) run on plain data alone: step JSON, a base
 * document as JSON and ranges as numbers. The result is plain data too. The same function runs in
 * the test process and in a worker thread (`authority-worker.ts`), so a test can compare the two
 * (SYN-001 criterion 5; SYN-039). It needs nothing of the room.
 */
import { canonicalNodeText, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { mapRanges } from '../../src/ranges.ts';
import { applySteps, mapsOf, rebaseOver } from '../../src/rebase.ts';
import { checkInvariants } from '../../src/invariants.ts';
import { DEFAULT_LIMITS, type Limits } from '../../src/codes.ts';
import { parseSteps, stepsToJson, type StepJson } from '../../src/steps.ts';

export interface AuthorityRunInput {
  base: unknown;
  /** The client's steps, as JSON. */
  mine: StepJson[];
  /** Steps accepted after the client's base, as JSON. */
  over: StepJson[];
  ranges: Array<{ from: number; to: number }>;
  limits?: Limits;
}

export type Verdict = { ok: true } | { ok: false; code: string };

export interface AuthorityRunOutput {
  parsedMine: Verdict;
  parsedOver: Verdict;
  /** The base with `over` applied. */
  overText: string | null;
  /** `mine` rebased over `over` in reject mode. */
  rebase:
    | { ok: true; text: string; steps: StepJson[]; positions: number[]; dropped: number[] }
    | { ok: false; code: string };
  /** `mine` applied directly to the base. */
  apply: { ok: true; text: string } | { ok: false; code: string };
  /** The invariant check of the directly applied commit. */
  invariants: { ok: true } | { ok: false; code: string };
  ranges: Array<{ from: number; to: number; collapsed: boolean }>;
}

const schema = cdmSchema();

const textOf = (doc: { toJSON(): unknown }): string => canonicalNodeText(doc.toJSON() as JsonNode);

/** Runs every function on the input and returns plain data. It never throws. */
export function runAuthority(input: AuthorityRunInput): AuthorityRunOutput {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const base = schema.nodeFromJSON(input.base);
  const mine = parseSteps(schema, input.mine, limits);
  const over = parseSteps(schema, input.over, limits);
  const parsedMine: Verdict = mine.ok ? { ok: true } : { ok: false, code: mine.code };
  const parsedOver: Verdict = over.ok ? { ok: true } : { ok: false, code: over.code };

  let overText: string | null = null;
  let rebase: AuthorityRunOutput['rebase'] = { ok: false, code: 'not_run' };
  let apply: AuthorityRunOutput['apply'] = { ok: false, code: 'not_run' };
  let invariants: AuthorityRunOutput['invariants'] = { ok: false, code: 'not_run' };
  let ranges: AuthorityRunOutput['ranges'] = input.ranges.map((r) => ({
    from: r.from,
    to: r.to,
    collapsed: r.to <= r.from,
  }));

  if (over.ok) {
    const overApplied = applySteps(base, over.value);
    if (overApplied.ok) {
      overText = textOf(overApplied.value.doc);
      if (mine.ok) {
        const r = rebaseOver(mine.value, mapsOf(over.value), overApplied.value.doc, 'reject');
        rebase = r.ok
          ? {
              ok: true,
              text: textOf(r.value.doc),
              steps: stepsToJson(r.value.steps),
              positions: [...r.value.positions],
              dropped: [...r.value.dropped],
            }
          : { ok: false, code: r.code };
      }
    } else {
      overText = null;
    }
  }

  if (mine.ok) {
    const applied = applySteps(base, mine.value);
    if (applied.ok) {
      apply = { ok: true, text: textOf(applied.value.doc) };
      const checked = checkInvariants(base, applied.value.doc, mine.value, applied.value.docs, {
        // The base document holds a form field, so the document requires the fields feature.
        requires: ['fields'],
        retiredRegionIds: new Set(),
      });
      invariants = checked.ok ? { ok: true } : { ok: false, code: checked.code };
    } else {
      apply = { ok: false, code: applied.code };
    }
    ranges = mapRanges(input.ranges, mapsOf(mine.value)).map((m) => ({
      from: m.from,
      to: m.to,
      collapsed: m.collapsed,
    }));
  }

  return { parsedMine, parsedOver, overText, rebase, apply, invariants, ranges };
}
