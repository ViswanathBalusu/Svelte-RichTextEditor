/**
 * Content operations of the document API (02 §5.1; 05 §8.1; FE-027): a selection read as a CDM
 * fragment, and a fragment checked and built for insertion at the selection. Plain JSON in and out;
 * no ProseMirror type leaves this module through the core's API.
 *
 * - A fragment carries the blocks as CDM JSON, the open depths of the selection's ends, the style
 *   definitions the blocks refer to (with their `basedOn` and `next` chains, 03 §4.1), and the
 *   document's `requires` list.
 * - Insertion gives every copied node a fresh identifier (03 §9): a foreign identifier is never kept,
 *   even when it does not clash with one in the document.
 * - Insertion never overwrites a style the document already defines; a missing one is added to the
 *   `defs` in the same change (FE-027 criterion 1 and 2).
 */
import { styleTable } from '@docedit/model';
import { CDM1, mayOpen, supportedFeatures } from '@docedit/model/definition';
import { Fragment, type Node as PMNode, type Schema, Slice } from 'prosemirror-model';
import type { CdmFragment, CdmJsonNode } from './api.ts';

/** The attributes of a style definition, as the model's cascade reads them. */
type Attrs = Record<string, unknown>;

export interface BuildOptions {
  /** Node types that declare an `id` (from the CDM definition). */
  types: ReadonlySet<string>;
  /** Identifier source for the copies. */
  generate: () => string;
}

/** A fragment the core cannot take, with the reason for the caller. */
export interface FragmentProblem {
  readonly reason: 'unsupported' | 'invalid';
  readonly message: string;
  readonly missing?: readonly string[];
}

/** An empty fragment: what an empty selection gives (FE-027 criterion 1). */
export function emptyFragment(cdm: number, requires: readonly string[]): CdmFragment {
  return { cdm, requires: [...requires], defs: [], content: [], openStart: 0, openEnd: 0 };
}

/** The style ids a list of CDM nodes refers to, with the default of each paragraph. */
function referencedStyles(content: readonly CdmJsonNode[], defaultStyle: string): Set<string> {
  const out = new Set<string>();
  const visit = (node: CdmJsonNode): void => {
    const style = node.attrs?.['style'];
    if (typeof style === 'string') out.add(style);
    else if (node.type === 'paragraph') out.add(defaultStyle);
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of content) visit(node);
  return out;
}

/**
 * The style definitions a set of ids needs: each one, with the styles it is based on and the style
 * that follows it, in the order the document defines them.
 */
export function styleClosure(doc: PMNode, ids: ReadonlySet<string>): Attrs[] {
  const table = styleTable(doc);
  const needed = new Set<string>();
  const queue = [...ids];
  while (queue.length) {
    const id = queue.pop()!;
    if (needed.has(id)) continue;
    const attrs = table.styles.get(id);
    if (!attrs) continue;
    needed.add(id);
    for (const key of ['basedOn', 'next'] as const) {
      const next = attrs[key];
      if (typeof next === 'string') queue.push(next);
    }
  }
  const out: Attrs[] = [];
  for (const [id, attrs] of table.styles) if (needed.has(id)) out.push(attrs);
  return out;
}

/**
 * The numbering identifiers the copied content and the style closure reference: the `numbering`
 * of each block and of each style (CDM-040, CDM-042). Used so that a pasted list keeps its
 * numbering (FE-050 criterion 3).
 */
function referencedNumberings(
  content: readonly CdmJsonNode[],
  styles: readonly Attrs[],
): Set<string> {
  const out = new Set<string>();
  const add = (numbering: unknown): void => {
    if (typeof numbering !== 'object' || numbering === null) return;
    const id = (numbering as Attrs)['numberingId'];
    if (typeof id === 'string') out.add(id);
  };
  const visit = (node: CdmJsonNode): void => {
    add(node.attrs?.['numbering']);
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of content) visit(node);
  for (const style of styles) add(style['numbering']);
  return out;
}

/** Copies of the document's `numbering_def` nodes whose identifiers are in `ids`, in document order. */
function numberingDefsOf(doc: PMNode, ids: ReadonlySet<string>): Attrs[] {
  const out: Attrs[] = [];
  doc.forEach((top) => {
    if (top.type.name !== 'defs') return;
    top.forEach((def) => {
      const id = def.attrs['id'];
      if (def.type.name === 'numbering_def' && typeof id === 'string' && ids.has(id))
        out.push(structuredClone({ ...def.attrs }) as Attrs);
    });
  });
  return out;
}

/**
 * The fragment of `doc` between `from` and `to` (FE-027 criterion 1). An empty range gives an empty
 * fragment. Nothing is changed.
 */
export function fragmentOf(
  doc: PMNode,
  from: number,
  to: number,
  cdm: number,
  requires: readonly string[],
): CdmFragment {
  if (from === to) return emptyFragment(cdm, requires);
  const slice = doc.slice(from, to);
  const content = (slice.content.toJSON() ?? []) as CdmJsonNode[];
  const table = styleTable(doc);
  const styles = styleClosure(doc, referencedStyles(content, table.defaultParagraphStyle));
  const numberings = numberingDefsOf(doc, referencedNumberings(content, styles));
  return {
    cdm,
    requires: [...requires],
    defs: [
      ...styles.map((attrs) => ({ type: 'style_def', attrs: { ...attrs } })),
      ...numberings.map((attrs) => ({ type: 'numbering_def', attrs })),
    ],
    content: structuredClone(content),
    openStart: slice.openStart,
    openEnd: slice.openEnd,
  };
}

/**
 * Whether a fragment can be taken by a document of CDM `cdm` that lists `requires` (FE-027
 * criterion 4): the CDM version, the features this build supports, and every feature the fragment
 * needs being listed by the document. Returns null when it can.
 */
export function fragmentProblem(
  fragment: CdmFragment,
  cdm: number,
  requires: readonly string[],
): FragmentProblem | null {
  if (fragment.cdm !== cdm)
    return {
      reason: 'unsupported',
      message: `the fragment uses CDM version ${String(fragment.cdm)}; this editor supports version ${cdm}`,
    };
  const decision = mayOpen(fragment.requires as string[], supportedFeatures(CDM1));
  if (!decision.ok)
    return {
      reason: 'unsupported',
      message: `the fragment needs features this editor does not support: ${decision.missing.join(', ')}`,
      missing: decision.missing,
    };
  const missing = fragment.requires.filter((f) => !requires.includes(f));
  if (missing.length > 0)
    return {
      reason: 'unsupported',
      message: `the fragment needs features the document does not list in requires: ${missing.join(', ')}`,
      missing,
    };
  return null;
}

/** A copy of `content` with a fresh identifier on every node that declares one (03 §9). */
function withFreshIds(content: readonly CdmJsonNode[], options: BuildOptions): CdmJsonNode[] {
  const copy = (node: CdmJsonNode): CdmJsonNode => {
    const out: CdmJsonNode = { ...node };
    if (node.attrs) out.attrs = { ...node.attrs };
    if (options.types.has(node.type) && out.attrs && 'id' in out.attrs)
      out.attrs['id'] = options.generate();
    if (node.content) out.content = node.content.map(copy);
    return out;
  };
  return content.map(copy);
}

/**
 * The result of building a fragment: the slice for the body, the style definitions to add and the
 * numbering definitions to add (FE-050 criterion 3).
 */
export interface BuiltFragment {
  readonly slice: Slice;
  readonly defs: PMNode[];
  readonly numberings: PMNode[];
}

/** The identifiers of the document's `numbering_def` nodes. */
function numberingIdsOf(doc: PMNode): Set<string> {
  const out = new Set<string>();
  doc.forEach((top) => {
    if (top.type.name !== 'defs') return;
    top.forEach((def) => {
      const id = def.attrs['id'];
      if (def.type.name === 'numbering_def' && typeof id === 'string') out.add(id);
    });
  });
  return out;
}

/**
 * Builds a fragment against `schema`: fresh identifiers, a checked slice, and the style and
 * numbering definitions that the document in `doc` does not define yet. A definition whose
 * identifier the document already has is skipped: the pasted content then uses the document's own.
 * Returns a problem when the content fails the schema.
 */
export function buildFragment(
  fragment: CdmFragment,
  schema: Schema,
  doc: PMNode,
  options: BuildOptions,
): BuiltFragment | FragmentProblem {
  const existingStyles = styleTable(doc).styles;
  const existingNumberings = numberingIdsOf(doc);
  const defs: PMNode[] = [];
  const numberings: PMNode[] = [];
  const seen = new Set<string>();
  try {
    for (const def of fragment.defs) {
      const id = def.attrs?.['id'];
      if ((def.type !== 'style_def' && def.type !== 'numbering_def') || typeof id !== 'string')
        return {
          reason: 'invalid',
          message: 'a definition is not a style_def or a numbering_def with an id',
        };
      const key = `${def.type}:${id}`;
      const existing = def.type === 'style_def' ? existingStyles : existingNumberings;
      if (existing.has(id) || seen.has(key)) continue;
      seen.add(key);
      const node = schema.nodeFromJSON({ type: def.type, attrs: def.attrs });
      node.check();
      (def.type === 'style_def' ? defs : numberings).push(node);
    }
    const nodes = withFreshIds(fragment.content, options).map((n) => schema.nodeFromJSON(n));
    for (const n of nodes) n.check();
    const slice = new Slice(Fragment.fromArray(nodes), fragment.openStart, fragment.openEnd);
    return { slice, defs, numberings };
  } catch (e) {
    return {
      reason: 'invalid',
      message: `the fragment does not fit the schema: ${(e as Error).message}`,
    };
  }
}

/** Whether a built result is a problem rather than a fragment. */
export function isFragmentProblem(x: BuiltFragment | FragmentProblem): x is FragmentProblem {
  return 'reason' in x;
}
