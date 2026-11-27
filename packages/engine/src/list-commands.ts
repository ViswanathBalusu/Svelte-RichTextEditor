/**
 * Multilevel list commands (FE-130; 03 §4.3, §7; CDM-026, CDM-042).
 *
 * A paragraph in a list carries `numbering: { numberingId, listId, level }`: the numbering
 * definition it uses, the list instance it belongs to, and its level (0 to 8). The labels come from
 * the model's shared computation (`computeLabels`), which counts per list instance, so restarting or
 * continuing numbering means changing the `listId` of paragraphs.
 *
 * - `applyList` puts the selected paragraphs in a list of a numbering definition. It keeps the list
 *   instance the paragraphs already have (so choosing another definition re-labels the same list),
 *   else joins the list of the paragraph before, else starts a new one.
 * - `listLevelUp` and `listLevelDown` change the level within the definition's levels.
 * - `removeList` takes the selected paragraphs out of their lists.
 * - `restartNumbering` gives the paragraph and the run of items after it a new list instance;
 *   `continueNumbering` gives them the list instance of the list before.
 * - `exitEmptyListItem` (Enter in an empty item) takes that item out of its list.
 */
import { nodeId } from '@docedit/model';
import type { Node as PMNode } from 'prosemirror-model';
import { type Command, type EditorState, TextSelection } from 'prosemirror-state';
import type { CommandArgs, CommandName } from './api.ts';
import { selectedParagraphs } from './styles.ts';

/** The highest level a list paragraph may have (CDM-042: nine levels, 0 to 8). */
const MAX_LEVEL = 8;

export type ListCommandName =
  | 'applyList'
  | 'removeList'
  | 'listLevelUp'
  | 'listLevelDown'
  | 'restartNumbering'
  | 'continueNumbering';

export const LIST_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'applyList',
  'removeList',
  'listLevelUp',
  'listLevelDown',
  'restartNumbering',
  'continueNumbering',
]);

export interface ListAttrs {
  numberingId: string;
  listId: string;
  level: number;
}

/** The numbering attribute of a paragraph, when it is in a list. */
function listOf(node: PMNode): ListAttrs | null {
  const n = node.attrs['numbering'] as unknown;
  if (typeof n !== 'object' || n === null) return null;
  const { numberingId, listId, level } = n as Record<string, unknown>;
  if (typeof numberingId !== 'string' || typeof listId !== 'string' || typeof level !== 'number')
    return null;
  return { numberingId, listId, level };
}

/** The number of levels a numbering definition has, or null when the document does not define it. */
function levelCountOf(doc: PMNode, numberingId: string): number | null {
  const defs = doc.firstChild;
  if (!defs) return null;
  for (let i = 0; i < defs.childCount; i++) {
    const child = defs.child(i);
    if (child.type.name !== 'numbering_def' || child.attrs['id'] !== numberingId) continue;
    const levels = child.attrs['levels'];
    const count = Array.isArray(levels) ? levels.length : 0;
    return count > 0 ? count : null;
  }
  return null;
}

/** The highest level a list may use with a definition of `count` levels. */
const topLevel = (count: number): number => Math.min(MAX_LEVEL, count - 1);

/** The paragraph positions of a run of consecutive items with one list instance, from `pos` on. */
function listRun(doc: PMNode, pos: number, listId: string): number[] {
  const out: number[] = [];
  let at = pos;
  for (;;) {
    const node = doc.nodeAt(at);
    if (!node || node.type.name !== 'paragraph') break;
    if (listOf(node)?.listId !== listId) break;
    out.push(at);
    at += node.nodeSize;
  }
  return out;
}

/** The selected paragraphs that the user may change, with their positions. */
function targetsOf(
  state: EditorState,
  writable: (pos: number) => boolean,
): Array<{ node: PMNode; pos: number }> {
  return selectedParagraphs(state).filter(({ pos }) => writable(pos));
}

/** A new list attribute set for a paragraph: the level kept and clamped to the definition. */
function withLevel(list: ListAttrs, level: number, count: number): ListAttrs {
  return { ...list, level: Math.max(0, Math.min(level, topLevel(count))) };
}

/**
 * The list commands of the core (FE-130). Returns null when the arguments are missing (`applyList`
 * needs a numbering definition the document defines).
 */
export function listCommand(
  name: ListCommandName,
  args: CommandArgs,
  writable: (pos: number) => boolean,
  insertAt: InsertAt,
): Command | null {
  switch (name) {
    case 'applyList':
      if (args.listKind !== undefined) return listKindCommand(args.listKind, writable, insertAt);
      return args.numberingId === undefined ? null : applyList(args.numberingId, writable);
    case 'removeList':
      return removeList(writable);
    case 'listLevelUp':
      return changeLevels(1, writable);
    case 'listLevelDown':
      return changeLevels(-1, writable);
    case 'restartNumbering':
      return restartNumbering(writable);
    case 'continueNumbering':
      return continueNumbering(writable);
  }
}

type ListKind = NonNullable<CommandArgs['listKind']>;

/**
 * Where the document takes a new numbering definition, or null when this user may not add one: it
 * changes the document's definitions and their order, which the guard allows to those who may change
 * structure (07 §7).
 */
export type InsertAt = (doc: PMNode) => number | null;

/** The identifier of the first definition of the document of this kind: its first level is a bullet, or decimal. */
function definitionOfKind(doc: PMNode, kind: ListKind): string | null {
  const wanted = kind === 'bullet' ? 'bullet' : 'decimal';
  let found: string | null = null;
  doc.firstChild?.forEach((def) => {
    const levels = def.attrs['levels'] as ReadonlyArray<{ format?: unknown }> | null;
    if (found === null && def.type.name === 'numbering_def' && levels?.[0]?.format === wanted)
      found = def.attrs['id'] as string;
  });
  return found;
}

/** The definition a document gets with its first list of a kind: nine levels, as a paste makes them. */
function newDefinition(kind: ListKind): Record<string, unknown> {
  const bullets = kind === 'bullet';
  return {
    id: nodeId(),
    levels: Array.from({ length: MAX_LEVEL + 1 }, (_, i) => ({
      format: bullets ? 'bullet' : ['decimal', 'lowerLetter', 'lowerRoman'][i % 3],
      text: bullets ? '' : `%${i + 1}.`,
      start: 1,
      indentLeft: 720 + i * 360,
      hanging: 360,
      ...(bullets ? { bulletChar: '•◦▪'[i % 3] } : {}),
    })),
  };
}

/**
 * A bulleted or a numbered list, as the Home tab's two buttons make it. The paragraphs already in a
 * list of this kind leave it (the button toggles); else they join a definition of the kind that the
 * document has, or the document gets one, in the same transaction.
 */
function listKindCommand(
  kind: ListKind,
  writable: (pos: number) => boolean,
  insertAt: InsertAt,
): Command {
  return (state, dispatch) => {
    const targets = targetsOf(state, writable);
    if (targets.length === 0) return false;
    const existing = definitionOfKind(state.doc, kind);
    if (existing !== null) {
      const inKind = targets.every(({ node }) => listOf(node)?.numberingId === existing);
      return (inKind ? removeList(writable) : applyList(existing, writable))(state, dispatch);
    }
    const at = insertAt(state.doc);
    if (at === null) return false;
    if (!dispatch) return true;
    const definition = state.schema.nodes['numbering_def']!.create(newDefinition(kind));
    const tr = state.tr.insert(at, definition);
    const listId = nodeId();
    for (const { node, pos } of targets) {
      const level = Math.min(listOf(node)?.level ?? 0, MAX_LEVEL);
      tr.setNodeAttribute(tr.mapping.map(pos), 'numbering', {
        numberingId: definition.attrs['id'] as string,
        listId,
        level,
      });
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

function applyList(numberingId: string, writable: (pos: number) => boolean): Command {
  return (state, dispatch) => {
    const count = levelCountOf(state.doc, numberingId);
    if (count === null) return false;
    const targets = targetsOf(state, writable);
    if (targets.length === 0) return false;
    const first = targets[0]!;
    const current = listOf(first.node);
    let listId = current?.listId ?? null;
    if (listId === null) {
      // Join the list before, when it uses this definition; else start a new list instance.
      const before = state.doc.resolve(first.pos).nodeBefore;
      const prev = before ? listOf(before) : null;
      listId = prev?.numberingId === numberingId ? prev.listId : nodeId();
    }
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { node, pos } of targets) {
      const old = listOf(node);
      const level = old?.level ?? 0;
      const next = withLevel({ numberingId, listId, level }, level, count);
      if (
        old &&
        old.numberingId === next.numberingId &&
        old.listId === next.listId &&
        old.level === next.level
      )
        continue;
      tr.setNodeAttribute(pos, 'numbering', next);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

function removeList(writable: (pos: number) => boolean): Command {
  return (state, dispatch) => {
    const targets = targetsOf(state, writable).filter(({ node }) => listOf(node) !== null);
    if (targets.length === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { pos } of targets) tr.setNodeAttribute(pos, 'numbering', null);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Moves the level of the selected list paragraphs by `delta`, within the definition's levels. */
function changeLevels(delta: 1 | -1, writable: (pos: number) => boolean): Command {
  return (state, dispatch) => {
    const moves: Array<{ pos: number; next: ListAttrs }> = [];
    for (const { node, pos } of targetsOf(state, writable)) {
      const list = listOf(node);
      if (!list) continue;
      const count = levelCountOf(state.doc, list.numberingId);
      if (count === null) continue;
      const next = withLevel(list, list.level + delta, count);
      if (next.level !== list.level) moves.push({ pos, next });
    }
    if (moves.length === 0) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { pos, next } of moves) tr.setNodeAttribute(pos, 'numbering', next);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** The first selected paragraph that is in a list, with its list attributes. */
function firstListTarget(
  state: EditorState,
  writable: (pos: number) => boolean,
): { pos: number; list: ListAttrs } | null {
  for (const { node, pos } of targetsOf(state, writable)) {
    const list = listOf(node);
    if (list) return { pos, list };
  }
  return null;
}

function restartNumbering(writable: (pos: number) => boolean): Command {
  return (state, dispatch) => {
    const target = firstListTarget(state, writable);
    if (!target) return false;
    if (!dispatch) return true;
    const positions = listRun(state.doc, target.pos, target.list.listId);
    const fresh = nodeId();
    const tr = state.tr;
    for (const pos of positions) {
      const node = state.doc.nodeAt(pos)!;
      tr.setNodeAttribute(pos, 'numbering', { ...listOf(node)!, listId: fresh });
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

function continueNumbering(writable: (pos: number) => boolean): Command {
  return (state, dispatch) => {
    const target = firstListTarget(state, writable);
    if (!target) return false;
    const before = state.doc.resolve(target.pos).nodeBefore;
    const prev = before ? listOf(before) : null;
    if (!prev || prev.numberingId !== target.list.numberingId || prev.listId === target.list.listId)
      return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const pos of listRun(state.doc, target.pos, target.list.listId)) {
      const node = state.doc.nodeAt(pos)!;
      tr.setNodeAttribute(pos, 'numbering', { ...listOf(node)!, listId: prev.listId });
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Changes the level of the list item at the caret when the caret is at its start (Tab, Shift+Tab). */
export function listIndentAtStart(delta: 1 | -1): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) return false;
    const $pos = sel.$from;
    const para = $pos.parent;
    if (para.type.name !== 'paragraph' || $pos.parentOffset !== 0) return false;
    const list = listOf(para);
    if (!list) return false;
    const count = levelCountOf(state.doc, list.numberingId);
    if (count === null) return false;
    const next = withLevel(list, list.level + delta, count);
    if (next.level === list.level) return false;
    if (dispatch)
      dispatch(state.tr.setNodeAttribute($pos.before(), 'numbering', next).scrollIntoView());
    return true;
  };
}

/** Enter in an empty list item takes the item out of its list (FE-130 criterion 4). */
export const exitEmptyListItem: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return false;
  const $pos = sel.$from;
  const para = $pos.parent;
  if (para.type.name !== 'paragraph' || para.content.size !== 0 || listOf(para) === null)
    return false;
  if (dispatch)
    dispatch(state.tr.setNodeAttribute($pos.before(), 'numbering', null).scrollIntoView());
  return true;
};
