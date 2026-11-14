/**
 * Steps the engine sends (04 §4). prosemirror-transform 1.12.5, the release `pm-steps/1` pins,
 * inverts mark steps exactly: `AddMarkStep.invert(doc)` and `RemoveMarkStep.invert(doc)` return a
 * `markSet` step (the class is not exported) holding the `addMark` and `removeMark` steps that undo
 * the change, or holding none. Undo history uses those inverses, but `markSet` is not on the
 * authority's allow-list, so an undo of formatting would be rejected with `invalid_op`. The core
 * therefore replaces a `markSet` step by its inner steps, applied in order, which is exactly what
 * `markSet` does when it applies (ADR 0038).
 */
import type { Node } from 'prosemirror-model';
import { AttrStep, Mapping, type Step } from 'prosemirror-transform';

/** Whether a step is a `markSet` step of prosemirror-transform 1.12. */
export function isMarkSet(step: Step): boolean {
  return (step.toJSON() as { stepType?: unknown }).stepType === 'markSet';
}

/**
 * The steps without an `id` attribute step whose node a later step of the same change removes:
 * such a step cannot affect the result, and the authority refuses a step that changes an identifier
 * (I2) even when the node then disappears. An undo of Enter carries one (the inverse of the
 * identifier fill, followed by the join). Kept only if the remaining steps reach exactly `end`.
 */
export function withoutLostIdentifierSteps(
  steps: readonly Step[],
  start: Node,
  end: Node,
): readonly Step[] {
  const keep: Step[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step instanceof AttrStep && step.attr === 'id') {
      const later = new Mapping(steps.slice(i + 1).map((s) => s.getMap()));
      if (later.mapResult(step.pos, 1).deleted) continue;
    }
    keep.push(step);
  }
  if (keep.length === steps.length) return steps;
  let doc = start;
  for (const step of keep) {
    const r = step.apply(doc);
    if (!r.doc) return steps;
    doc = r.doc;
  }
  return doc.eq(end) ? keep : steps;
}

/** The steps with every `markSet` step replaced by its inner steps (an empty one by nothing). */
export function flattenSteps(steps: readonly Step[]): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    if (isMarkSet(step)) out.push(...flattenSteps((step as unknown as { steps: Step[] }).steps));
    else out.push(step);
  }
  return out;
}
