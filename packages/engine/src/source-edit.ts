/**
 * Adding and changing source definitions, and listing them (UX-103 criteria 1, 2 and 4; CDM-052;
 * 03 §4.1; 07 §4, §5.3).
 *
 * - A source is a `source_def` node in the document's definitions, so adding one is an insertion
 *   there and changing one is a change of its attributes, one step per attribute (concurrent edits
 *   to different CSL variables do not collide). Both leave through the commit log like any change.
 * - Every value is checked against the attribute's grammar of the CDM definition (I11) before a
 *   step is made; a value that fails is reported by attribute and nothing changes.
 * - The definitions are the scope `defs`, which needs `structure` (07 §4). The caller passes the
 *   region guard's answer as `writable`; where it is false the command returns `read-only`.
 * - `listSources` gives each source with the places that cite it, so the sources pane can show
 *   where a source is cited before a deletion is refused (source-delete.ts).
 */
import { CDM1, type JsonValue } from '@docedit/model/definition';
import { checkGrammar } from '@docedit/model/validate';
import type { Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { citationsCiting } from './source-delete.ts';

/** The attributes of a source an author may set; `id` is fixed when the source is made. */
export const SOURCE_FIELDS = [
  'kind',
  'title',
  'authors',
  'editors',
  'issued',
  'accessed',
  'containerTitle',
  'publisher',
  'publisherPlace',
  'edition',
  'volume',
  'issue',
  'pages',
  'number',
  'doi',
  'url',
  'isbn',
  'issn',
  'language',
  'note',
] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];
export type SourceValues = Partial<Record<SourceField, JsonValue>>;

export interface SourceProblem {
  /** The attribute, or `id`. */
  readonly field: string;
  readonly message: string;
}

export type SourceEditResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'read-only' | 'duplicate' | 'not-defined' | 'no-change' }
  | { readonly ok: false; readonly reason: 'invalid'; readonly problems: readonly SourceProblem[] };

/** One change to the sources, as `DocumentCore.editSource` takes it. */
export type SourceEdit =
  | { readonly op: 'add'; readonly id: string; readonly values: SourceValues }
  | { readonly op: 'update'; readonly id: string; readonly values: SourceValues }
  | { readonly op: 'delete'; readonly id: string };

/** What `DocumentCore.editSource` answers: done, or refused with the reason. */
export type SourceEditOutcome =
  | SourceEditResult
  | { readonly ok: false; readonly reason: 'cited'; readonly citedAt: readonly number[] };

export interface SourceEditOptions {
  /** Whether the region guard lets the user change the definitions at a position (07 §4). */
  readonly writable: (pos: number) => boolean;
}

/** One place that cites a source: the position of the citation and the text of its block. */
export interface SourceCitedAt {
  readonly pos: number;
  readonly excerpt: string;
}

export interface SourceInfo {
  readonly id: string;
  readonly values: Readonly<Record<SourceField, JsonValue>>;
  readonly citedAt: readonly SourceCitedAt[];
}

const SOURCE_DEF = CDM1.nodes.find((n) => n.name === 'source_def');
const isField = (name: string): name is SourceField =>
  (SOURCE_FIELDS as readonly string[]).includes(name);

/** The problems of an identifier and of values, by the grammars of `source_def` (I11). */
export function sourceProblems(id: string | null, values: SourceValues): SourceProblem[] {
  const out: SourceProblem[] = [];
  const attrs = SOURCE_DEF?.attrs ?? {};
  if (id !== null) {
    const grammar = attrs['id']?.grammar;
    if (grammar)
      for (const message of checkGrammar(grammar, id, '/id')) out.push({ field: 'id', message });
  }
  for (const [name, value] of Object.entries(values)) {
    const grammar = isField(name) ? attrs[name]?.grammar : undefined;
    if (!grammar) {
      out.push({ field: name, message: 'not an attribute of a source' });
      continue;
    }
    for (const message of checkGrammar(grammar, value, `/${name}`))
      out.push({ field: name, message });
  }
  return out;
}

interface Found {
  readonly node: Node;
  /** Position of the node in the document. */
  readonly pos: number;
}

function findSource(doc: Node, id: string): Found | null {
  const defs = doc.firstChild;
  let found: Found | null = null;
  defs?.forEach((child, offset) => {
    if (!found && child.type.name === 'source_def' && child.attrs['id'] === id)
      found = { node: child, pos: 1 + offset };
  });
  return found;
}

/** Where a new source goes: after the last source, or before the first `preserved_def`, or last. */
function insertAt(doc: Node): number {
  const defs = doc.firstChild;
  if (!defs) return -1;
  let at = 1 + defs.content.size;
  let seenPreserved = false;
  defs.forEach((child, offset) => {
    if (child.type.name === 'source_def') at = 1 + offset + child.nodeSize;
    else if (child.type.name === 'preserved_def' && !seenPreserved) {
      seenPreserved = true;
      at = 1 + offset;
    }
  });
  // The definitions keep their order (sources, then preserved trees), so both rules give one place.
  return at;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Adds the source `id` with `values`. With `dispatch` absent, only checks. */
export function addSource(
  state: EditorState,
  id: string,
  values: SourceValues,
  options: SourceEditOptions,
  dispatch?: (tr: Transaction) => void,
): SourceEditResult {
  const type = state.schema.nodes['source_def'];
  const at = insertAt(state.doc);
  if (!type || at < 0) return { ok: false, reason: 'not-defined' };
  if (!options.writable(at)) return { ok: false, reason: 'read-only' };
  const problems = sourceProblems(id, values);
  if (problems.length > 0) return { ok: false, reason: 'invalid', problems };
  if (findSource(state.doc, id)) return { ok: false, reason: 'duplicate' };
  if (dispatch) dispatch(state.tr.insert(at, type.create({ ...values, id })));
  return { ok: true };
}

/** Changes attributes of the source `id`, one step per attribute. With `dispatch` absent, only checks. */
export function updateSource(
  state: EditorState,
  id: string,
  changes: SourceValues,
  options: SourceEditOptions,
  dispatch?: (tr: Transaction) => void,
): SourceEditResult {
  const found = findSource(state.doc, id);
  if (!found) return { ok: false, reason: 'not-defined' };
  if (!options.writable(found.pos)) return { ok: false, reason: 'read-only' };
  const problems = sourceProblems(null, changes);
  if (problems.length > 0) return { ok: false, reason: 'invalid', problems };
  const changed = Object.entries(changes).filter(
    ([name, value]) => !same(found.node.attrs[name], value),
  );
  if (changed.length === 0) return { ok: false, reason: 'no-change' };
  if (dispatch) {
    const tr = state.tr;
    for (const [name, value] of changed) tr.setNodeAttribute(found.pos, name, value);
    dispatch(tr);
  }
  return { ok: true };
}

/** The text of the block that holds position `pos`, shortened; citations show as nothing. */
function excerptAt(doc: Node, pos: number): string {
  const $pos = doc.resolve(pos);
  const text = $pos.parent.textContent.replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** The sources of the document in the order of its definitions, each with where it is cited. */
export function listSources(doc: Node): SourceInfo[] {
  const out: SourceInfo[] = [];
  doc.firstChild?.forEach((child) => {
    if (child.type.name !== 'source_def') return;
    const id = child.attrs['id'];
    if (typeof id !== 'string') return;
    const values = {} as Record<SourceField, JsonValue>;
    for (const field of SOURCE_FIELDS) values[field] = child.attrs[field] as JsonValue;
    out.push({
      id,
      values,
      citedAt: citationsCiting(doc, id).map((pos) => ({ pos, excerpt: excerptAt(doc, pos) })),
    });
  });
  return out;
}
