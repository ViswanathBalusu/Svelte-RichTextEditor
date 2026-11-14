/**
 * Rule P3 (07 §5.2; PRM-011): a step may not remove or insert exactly one of a region's two
 * boundaries; structural changes are whole-node operations.
 *
 * ADR 0009 made a region a container node, so its boundaries are the node's opening and closing
 * tokens, and ProseMirror never lets a step leave one without the other: a step that takes away
 * one token either fails to apply or rebuilds the tree so that content crosses into or out of the
 * region. The outcome check already sees that as a change to both scopes. P3 refuses the step shape
 * as well, so that splitting, merging and moving regions are always whole-node operations whose
 * identity the outcome check can follow (ADR 0033):
 *
 * - a `replace` step removes the tokens in [from, to);
 * - a `replaceAround` step removes those in [from, gapFrom) and [gapTo, to), keeping the gap;
 * - removing both tokens of a region (deleting or unwrapping it) is a whole-node operation;
 * - inserting tokens never removes an existing region's: a slice that opens or closes a region
 *   joins it to the region at its edge, which is a split, and the new region is a new scope.
 *
 * This is the only permission rule that looks at steps. It runs with the invariants (04 §5 step 6)
 * and refuses with `invalid_op`, as P5 does.
 */
import type { Node } from 'prosemirror-model';
import { ReplaceAroundStep, ReplaceStep, type Step } from 'prosemirror-transform';

export interface BoundaryViolation {
  step: number;
  region: string;
}

/** Ranges of the document before a step that the step removes. */
function removedRanges(step: Step): Array<[number, number]> {
  if (step instanceof ReplaceAroundStep)
    return [
      [step.from, step.gapFrom],
      [step.gapTo, step.to],
    ];
  if (step instanceof ReplaceStep) return [[step.from, step.to]];
  return [];
}

/**
 * The first step that removes exactly one boundary token of a region, or null.
 *
 * @param docs the document before each step, as returned by `applySteps`.
 */
export function regionBoundaryViolation(
  steps: readonly Step[],
  docs: readonly Node[],
): BoundaryViolation | null {
  for (let i = 0; i < steps.length; i++) {
    const ranges = removedRanges(steps[i]!).filter(([a, b]) => b > a);
    const doc = docs[i];
    if (!ranges.length || !doc) continue;
    const covered = (pos: number) => ranges.some(([a, b]) => a <= pos && pos + 1 <= b);
    const body = doc.child(doc.childCount - 1);
    let pos = doc.content.size - body.nodeSize + 1;
    let found: string | null = null;
    body.forEach((child) => {
      const start = pos;
      const end = pos + child.nodeSize;
      pos = end;
      if (found !== null || child.type.name !== 'region') return;
      // Only regions that overlap a removed range can lose a token.
      if (!ranges.some(([a, b]) => a < end && b > start)) return;
      if (covered(start) !== covered(end - 1)) found = String(child.attrs['id']);
    });
    if (found !== null) return { step: i, region: found };
  }
  return null;
}
