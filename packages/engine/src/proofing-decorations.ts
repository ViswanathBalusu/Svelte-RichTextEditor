/**
 * The proofing findings of the body, drawn as decorations (UX-041 criterion 1; 13 §6.1).
 *
 * The decorations are computed from the findings that hold for the document on every draw, so a
 * finding that no longer holds (its block's text changed) is not drawn. The document is never
 * changed to draw them, and no decoration reaches a commit, a version or the history (criterion 7).
 *
 * Each decorated span carries `data-de-finding` (the finding's identifier) and its kind, so the
 * context menu can tell which finding was clicked. The class names are styled by the element's
 * style sheet. This module imports `prosemirror-view` for `Decoration` only.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { LocatedFinding } from './proofing.ts';

export const PROOF_SPELLING_CLASS = 'de-proof-spelling';
export const PROOF_GRAMMAR_CLASS = 'de-proof-grammar';
/** Another kind a port reports. */
export const PROOF_OTHER_CLASS = 'de-proof-other';
/** The finding the last navigation chose. */
export const PROOF_CURRENT_CLASS = 'de-proof-current';

function classOf(kind: string): string {
  if (kind === 'spelling') return PROOF_SPELLING_CLASS;
  if (kind === 'grammar') return PROOF_GRAMMAR_CLASS;
  return PROOF_OTHER_CLASS;
}

export function proofingDecorations(
  doc: PMNode,
  findings: readonly LocatedFinding[],
  currentId: string | null,
): DecorationSet {
  if (findings.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    findings.map((f) =>
      Decoration.inline(f.from, f.to, {
        class: f.id === currentId ? `${classOf(f.kind)} ${PROOF_CURRENT_CLASS}` : classOf(f.kind),
        'data-de-finding': f.id,
        'data-de-finding-kind': f.kind,
      }),
    ),
  );
}
