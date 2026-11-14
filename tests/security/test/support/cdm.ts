/**
 * Helpers for building commits by hand against the CDM schema, so the bypass, rebase and
 * corruption suites can submit steps the component would never produce (SEC-021, SEC-025, SEC-027).
 * The schema is the same one the authority applies steps against (`@docedit/model/prosemirror`).
 */
import { cdmSchema } from '@docedit/model/prosemirror';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import type { Step } from 'prosemirror-transform';

export const schema = cdmSchema();

export function loadDoc(docJson: unknown): Node {
  return schema.nodeFromJSON(docJson);
}

export function stepsJson(steps: readonly Step[]): Record<string, unknown>[] {
  return steps.map((s) => s.toJSON() as Record<string, unknown>);
}

/** The position just inside the node with `id` (its first content position). */
export function inside(doc: Node, id: string): number {
  let pos = -1;
  doc.descendants((n, p) => {
    if (n.attrs['id'] === id) pos = p + 1;
    return pos < 0;
  });
  if (pos < 0) throw new Error(`no node ${id}`);
  return pos;
}

/** The position of the node with `id` (its opening boundary). */
export function at(doc: Node, id: string): number {
  let pos = -1;
  doc.descendants((n, p) => {
    if (n.attrs['id'] === id) pos = p;
    return pos < 0;
  });
  if (pos < 0) throw new Error(`no node ${id}`);
  return pos;
}

/** The node with `id`. */
export function node(doc: Node, id: string): Node {
  let found: Node | null = null;
  doc.descendants((n) => {
    if (n.attrs['id'] === id) found = n;
    return found === null;
  });
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

export { Fragment, Slice };
export type { Node, Step };
