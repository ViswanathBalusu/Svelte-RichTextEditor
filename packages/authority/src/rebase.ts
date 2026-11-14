/**
 * Rebase and apply (04 §6; SYN-010, SYN-011). One procedure serves the authority and clients:
 *
 * - `reject` mode (the authority): a step that cannot be mapped or fails to apply rejects the whole
 *   commit with `rebase_failed`.
 * - `drop` mode (a client, as in prosemirror-collab): such steps are dropped.
 *
 * The mapping is the commit's own inverted maps, in reverse order, followed by the maps of every
 * step accepted after the base. Each step is mapped through the slice after its own inverse, and
 * once applied its map is appended with the inverse as mirror, so that later steps map through it
 * exactly. This is `rebaseSteps` of prosemirror-collab without the need for the base document.
 */
import type { Node } from 'prosemirror-model';
import { Mapping, type Step, type StepMap } from 'prosemirror-transform';
import { type Result, fail, ok } from './codes.ts';

export interface Rebased {
  /** The mapped steps that were applied, in order. */
  steps: Step[];
  /** The document after the mapped steps. */
  doc: Node;
  /** Indices (in the input) of steps that were dropped (drop mode only). */
  dropped: number[];
  /** For each input step, its index in `steps`, or -1 when dropped. */
  positions: number[];
}

/**
 * Maps `steps` (made on some base) over `over` (the maps of everything accepted after that base,
 * in order) and applies them to `doc`, which must be the base with `over` applied.
 */
export function rebaseOver(
  steps: readonly Step[],
  over: readonly StepMap[],
  doc: Node,
  mode: 'reject' | 'drop',
): Result<Rebased> {
  const n = steps.length;
  const mapping = new Mapping();
  for (let i = n - 1; i >= 0; i--) mapping.appendMap(steps[i]!.getMap().invert());
  for (const m of over) mapping.appendMap(m);

  let current = doc;
  let mapFrom = n;
  const mapped: Step[] = [];
  const dropped: number[] = [];
  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    // Mapping or applying a crafted step can throw inside prosemirror-transform (for example a
    // mark step mapped past the end of the document): that is a failed step, never a crash.
    let m: Step | null;
    let result: ReturnType<Step['apply']> | null;
    try {
      m = steps[i]!.map(mapping.slice(mapFrom));
      result = m ? m.apply(current) : null;
    } catch {
      m = null;
      result = null;
    }
    mapFrom--;
    if (!m || !result || result.failed || !result.doc) {
      if (mode === 'reject')
        return fail(
          'rebase_failed',
          `step ${i} ${m ? `failed to apply: ${result?.failed}` : 'maps to nothing'}`,
        );
      dropped.push(i);
      positions.push(-1);
      continue;
    }
    current = result.doc;
    mapping.appendMap(m.getMap(), mapFrom);
    positions.push(mapped.length);
    mapped.push(m);
  }
  return ok({ steps: mapped, doc: current, dropped, positions });
}

/** Applies steps in order; the first failure rejects with `invalid_op` (04 §5 step 5). */
export function applySteps(doc: Node, steps: readonly Step[]): Result<{ doc: Node; docs: Node[] }> {
  let current = doc;
  const docs: Node[] = [];
  for (let i = 0; i < steps.length; i++) {
    let result;
    try {
      result = steps[i]!.apply(current);
    } catch (e) {
      return fail('invalid_op', `step ${i} threw: ${(e as Error).message}`);
    }
    if (result.failed || !result.doc)
      return fail('invalid_op', `step ${i} failed: ${result.failed}`);
    docs.push(current);
    current = result.doc;
  }
  return ok({ doc: current, docs });
}

/** The maps of a step list. */
export function mapsOf(steps: readonly Step[]): StepMap[] {
  return steps.map((s) => s.getMap());
}

/** The inverse maps of a step list, in reverse order: undoing the list as a sequence of maps. */
export function inverseMapsOf(steps: readonly Step[]): StepMap[] {
  const out: StepMap[] = [];
  for (let i = steps.length - 1; i >= 0; i--) out.push(steps[i]!.getMap().invert());
  return out;
}
