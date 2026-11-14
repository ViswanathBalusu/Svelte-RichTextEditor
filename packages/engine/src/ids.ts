/**
 * Identifier plugin (02 §5.2; 03 §9; ADR 0018). In the editing schema `id` defaults to null,
 * because ProseMirror cannot create or fill nodes with a required attribute. This plugin gives every
 * node that declares an `id` a fresh identifier within the same `state.apply` call as the change
 * that created it, so no state the view, the history or the sync queue sees has a null `id` (I2).
 *
 * Rules (03 §9; ADR 0018, "Node identifiers"):
 * - a null `id` gets a fresh one;
 * - when two nodes share an `id` (a split copies the attributes), the node at the original position
 *   keeps it, except that a split at the start of a paragraph leaves the original empty: then the
 *   part that keeps the content keeps the identifier and the new empty part gets the fresh one;
 * - copies made by pasting or duplicating get fresh identifiers (the parse rules never read them).
 *
 * Remote transactions are left alone: the authority has already checked I2 for them.
 */
import { nodeId } from '@docedit/model';
import { type CdmDefinition, indexDefinition } from '@docedit/model/definition';
import { Mark, type Node as PMNode } from 'prosemirror-model';
import { isHistoryTransaction } from 'prosemirror-history';
import { type EditorState, Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  DocAttrStep,
  Mapping,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from 'prosemirror-transform';
import { INTERNAL, REMOTE } from './meta.ts';

export { REMOTE };

export const identifierKey = new PluginKey('docedit-identifiers');

export interface IdentifierOptions {
  /** Node types that declare an `id` attribute (from the CDM definition). */
  types: ReadonlySet<string>;
  /** Identifier source; defaults to 16 random URL-safe Base64 characters (03 §9). */
  generate?: () => string;
}

/** The node types of a definition that declare an `id`. */
export function idTypesOf(def: CdmDefinition): ReadonlySet<string> {
  return indexDefinition(def).idNodes;
}

interface Occurrence {
  pos: number;
  node: PMNode;
}

/** Whether a step can bring a node with an `id`, or a null `id`, into the document. */
function stepMayIntroduce(step: Step, types: ReadonlySet<string>): boolean {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
    let found = false;
    step.slice.content.descendants((node) => {
      if (types.has(node.type.name)) found = true;
      return !found;
    });
    return found;
  }
  if (step instanceof AttrStep || step instanceof DocAttrStep) return step.attr === 'id';
  // Mark steps never touch identifiers; any other step kind is checked.
  return !(
    step instanceof AddMarkStep ||
    step instanceof RemoveMarkStep ||
    step instanceof AddNodeMarkStep ||
    step instanceof RemoveNodeMarkStep
  );
}

/**
 * Whether a local transaction changes an identifier that is already set (03 §9; FE-031 criterion 5).
 * Setting a null identifier is a fill, not a change, and the fills this plugin makes are internal;
 * undo and redo may take back a step that was accepted when it was made, so they are exempt.
 */
export function changesExistingId(tr: Transaction): boolean {
  if (tr.getMeta(REMOTE) === true || tr.getMeta(INTERNAL) === true) return false;
  if (isHistoryTransaction(tr)) return false;
  let structural = false;
  const attr = tr.steps.some((step, i) => {
    const doc = tr.docs[i];
    if (step instanceof AttrStep) {
      if (step.attr !== 'id') return false;
      const old = doc?.nodeAt(step.pos)?.attrs['id'];
      return typeof old === 'string' && step.value !== old;
    }
    if (
      (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) &&
      doc &&
      !textOnly(step, doc)
    )
      structural = true;
    return false;
  });
  return attr || (structural && replacesExistingId(tr));
}

/** Whether a node type carries an `id` attribute (set or not). */
function hasIdAttr(node: PMNode): boolean {
  return 'id' in node.attrs;
}

/**
 * A replace inside one textblock that brings no node with an `id`: typing, deleting or pasting
 * text. It cannot rewrap or swap a node with an identifier, so the full comparison is skipped.
 */
function textOnly(step: ReplaceStep | ReplaceAroundStep, doc: PMNode): boolean {
  if (!(step instanceof ReplaceStep)) return false;
  const $from = doc.resolve(step.from);
  const $to = doc.resolve(step.to);
  if (!$from.sameParent($to) || !$from.parent.inlineContent) return false;
  let found = false;
  step.slice.content.descendants((node) => {
    if (hasIdAttr(node)) found = true;
    return !found;
  });
  if (found) return false;
  doc.nodesBetween(step.from, step.to, (node, pos) => {
    if (pos >= step.from && hasIdAttr(node)) found = true;
    return !found;
  });
  return !found;
}

/** Whether two nodes are equal apart from their `id`. */
function sameExceptId(a: PMNode, b: PMNode): boolean {
  if (a.type !== b.type || !a.content.eq(b.content) || !Mark.sameSet(a.marks, b.marks))
    return false;
  for (const key of Object.keys(a.attrs)) {
    if (key === 'id') continue;
    if (JSON.stringify(a.attrs[key]) !== JSON.stringify(b.attrs[key])) return false;
  }
  return true;
}

/**
 * Whether the replace steps of a transaction give a node that had a set identifier another one
 * (FE-031 criterion 5): `setNodeMarkup` and `setBlockType` rewrap a node with new attributes
 * (`ReplaceAroundStep`, or a `ReplaceStep` for a leaf), and a replace can swap a node for an equal
 * one with another identifier. For each identifier of the old document that the new document no
 * longer holds, the node is followed through the mapping:
 * - its content survives, unmoved, as the whole content of one node at the same depth, and that
 *   node's identifier is null, new, or duplicated: the node was rewrapped with another identifier;
 * - or its whole range maps onto a node at the same depth that is equal to it except for the
 *   identifier: the node was swapped.
 * Deleting a node, joining it into a neighbour that keeps its own identifier, lifting the content
 * out of a wrapper and replacing content with new nodes are not changes of an identifier.
 */
function replacesExistingId(tr: Transaction): boolean {
  const before = tr.before;
  const after = tr.doc;
  const oldIds = new Set<string>();
  before.descendants((node) => {
    const id = node.attrs['id'];
    if (typeof id === 'string') oldIds.add(id);
    return true;
  });
  const count = new Map<string, number>();
  after.descendants((node) => {
    const id = node.attrs['id'];
    if (typeof id === 'string') count.set(id, (count.get(id) ?? 0) + 1);
    return true;
  });
  /** Whether `id`, held by the node a set identifier was followed to, is not a kept one. */
  const other = (id: unknown, old: string): boolean =>
    id !== old && (typeof id !== 'string' || !oldIds.has(id) || (count.get(id) ?? 0) > 1);

  let changed = false;
  before.descendants((node, pos) => {
    if (changed) return false;
    const id = node.attrs['id'];
    if (typeof id !== 'string' || count.has(id)) return true;
    const depth = before.resolve(pos).depth;
    const start = tr.mapping.mapResult(pos, -1);
    const end = tr.mapping.mapResult(pos + node.nodeSize, 1);
    if (!node.isLeaf) {
      const inner = tr.mapping.mapResult(pos + 1, 1);
      const innerEnd = tr.mapping.mapResult(pos + node.nodeSize - 1, -1);
      const empty = node.content.size === 0;
      if (empty || (!inner.deleted && !innerEnd.deleted)) {
        const $a = after.resolve(inner.pos);
        const $b = empty ? $a : after.resolve(innerEnd.pos);
        if (
          $a.depth === depth + 1 &&
          $a.sameParent($b) &&
          $a.parentOffset === 0 &&
          $b.parentOffset === $b.parent.content.size &&
          (!empty || $a.before() === start.pos) &&
          other($a.parent.attrs['id'], id)
        ) {
          changed = true;
          return false;
        }
      }
    }
    const swapped = after.nodeAt(start.pos);
    if (
      swapped &&
      start.pos + swapped.nodeSize === end.pos &&
      after.resolve(start.pos).depth === depth &&
      sameExceptId(node, swapped) &&
      other(swapped.attrs['id'], id)
    )
      changed = true;
    return !changed;
  });
  return changed;
}

function mayIntroduce(trs: readonly Transaction[], types: ReadonlySet<string>): boolean {
  return trs.some((tr) => tr.docChanged && tr.steps.some((s) => stepMayIntroduce(s, types)));
}

function collect(doc: PMNode, types: ReadonlySet<string>, visit: (o: Occurrence) => void): void {
  doc.descendants((node, pos) => {
    if (types.has(node.type.name)) visit({ pos, node });
    return true;
  });
}

/** Of several nodes sharing an identifier, the one that keeps it. */
function keeper(
  id: string,
  list: readonly Occurrence[],
  oldPositions: ReadonlyMap<string, number>,
  mapping: Mapping,
): Occurrence {
  let original: Occurrence | undefined;
  const old = oldPositions.get(id);
  if (old !== undefined) {
    const mapped = mapping.mapResult(old, 1);
    if (!mapped.deleted) original = list.find((o) => o.pos === mapped.pos);
  }
  original ??= list[0]!;
  // Enter at the start of a paragraph: the original is now the empty first half and the content
  // moved to the copy right after it (03 §9).
  if (original.node.content.size === 0) {
    const end = original.pos + original.node.nodeSize;
    const moved = list.find((o) => o.pos === end && o.node.content.size > 0);
    if (moved) return moved;
  }
  return original;
}

/**
 * Builds the transaction that fills missing and duplicated identifiers after `trs`, or null when
 * there is nothing to do. Exported for the tests and for the sub-editors.
 */
export function fillIdentifiers(
  trs: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  options: IdentifierOptions,
): Transaction | null {
  const { types } = options;
  const generate = options.generate ?? nodeId;
  if (!mayIntroduce(trs, types)) return null;

  const missing: Occurrence[] = [];
  const byId = new Map<string, Occurrence[]>();
  collect(newState.doc, types, (o) => {
    const id = o.node.attrs['id'];
    if (typeof id !== 'string') return void missing.push(o);
    const list = byId.get(id);
    if (list) list.push(o);
    else byId.set(id, [o]);
  });

  const fresh = [...missing];
  let oldPositions: Map<string, number> | undefined;
  let mapping: Mapping | undefined;
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    if (!oldPositions || !mapping) {
      oldPositions = new Map();
      const positions = oldPositions;
      collect(oldState.doc, types, (o) => {
        const oldId = o.node.attrs['id'];
        if (typeof oldId === 'string') positions.set(oldId, o.pos);
      });
      mapping = new Mapping();
      for (const tr of trs) mapping.appendMapping(tr.mapping);
    }
    const keep = keeper(id, list, oldPositions, mapping);
    for (const o of list) if (o !== keep) fresh.push(o);
  }
  if (fresh.length === 0) return null;

  const tr = newState.tr;
  for (const o of fresh) {
    let id = generate();
    while (byId.has(id)) id = generate();
    byId.set(id, [o]);
    // AttrStep: positions do not move, so the collected positions stay valid.
    tr.setNodeAttribute(o.pos, 'id', id);
  }
  // The guard checked the change this completes; identifiers never change which scopes it touches.
  return tr.setMeta(identifierKey, fresh.length).setMeta(INTERNAL, true);
}

/** The plugin. Install it on the main editor; sub-editors forward their steps to it (FE-056). */
export function identifierPlugin(options: IdentifierOptions): Plugin {
  return new Plugin({
    key: identifierKey,
    // A local change of an identifier that is set is refused before it reaches the state (FE-031).
    filterTransaction: (tr) => !changesExistingId(tr),
    appendTransaction(trs, oldState, newState) {
      if (trs.every((tr) => tr.getMeta(REMOTE) === true)) return null;
      return fillIdentifiers(trs, oldState, newState, options);
    },
  });
}
