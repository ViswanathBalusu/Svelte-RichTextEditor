/**
 * Features a change adds to a document's `requires` (03 §11.1; CDM-047; UX-107). The room derives
 * the grown list from the content a commit uses and accepts the commit only when every attached
 * client announced the feature. The engine does the same on its side, so that the copy it holds
 * says what it uses: after a step that brings in a node of a feature (the first form field, a role
 * or a rule), `requires` has the feature, as the room will have it once it stores the commit.
 *
 * Only the nodes a step inserts are looked at, so a change in a document that already uses the
 * feature costs nothing and a change elsewhere costs a walk over its own slice, not the document.
 */
import { featureRegistry } from '@docedit/model/definition';
import { Slice, type Node as PMNode } from 'prosemirror-model';
import type { Step } from 'prosemirror-transform';

/** What the author is told when the room refuses the first form field (UX-107 criterion 2). */
export const FIELDS_REFUSED_MESSAGE =
  'Someone in this document cannot yet work with forms, so the form field was not added. Try again when they have left.';

let nodeNames: ReadonlyMap<string, string> | null = null;

/** Node type name → the feature that lets a document contain it. */
function featureOfNode(): ReadonlyMap<string, string> {
  if (nodeNames) return nodeNames;
  const m = new Map<string, string>();
  for (const f of featureRegistry()) for (const n of f.nodes) m.set(n, f.name);
  nodeNames = m;
  return m;
}

/** Whether `feature` gates the node `name`. */
export function nodeNeedsFeature(name: string, feature: string): boolean {
  return featureOfNode().get(name) === feature;
}

/** Whether any of the steps inserts a node that needs `feature`. */
export function stepsInsertFeature(steps: readonly Step[], feature: string): boolean {
  const names = featureOfNode();
  for (const s of steps) {
    const slice = (s as { slice?: unknown }).slice;
    if (!(slice instanceof Slice)) continue;
    let hit = false;
    slice.content.descendants((n: PMNode) => {
      if (names.get(n.type.name) === feature) hit = true;
      return !hit;
    });
    if (hit) return true;
  }
  return false;
}

/** Whether the document holds a node that needs `feature`. */
export function docUsesFeature(doc: PMNode, feature: string): boolean {
  let hit = false;
  doc.descendants((n) => {
    if (nodeNeedsFeature(n.type.name, feature)) hit = true;
    return !hit;
  });
  return hit;
}

/** `requires` with `feature`, sorted (03 §2; invariant I1). */
export function withFeature(requires: readonly string[], feature: string): string[] {
  return requires.includes(feature) ? [...requires] : [...requires, feature].sort();
}
