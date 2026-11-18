/**
 * Deletion of a referenced target (FE-134 criterion 4, FE-133 criterion 4; invariant I4 of 03 §8:
 * every reference resolves, and a definition that is still referenced cannot be deleted).
 *
 * A `ref` field names its target as `node:<id>`, `bookmark:<name>` or `eq:<label>` (the forms of
 * `TARGET_FORMS` in the model's validator). An `eq:` target resolves, as the validator resolves it,
 * to an `equation_block` whose `label` is the text after the first colon. A transaction that removes
 * the target while a `ref` still names it would leave that reference unresolved, so the filter
 * refuses the whole transaction. Changing an equation's label away from a name a `ref` uses counts
 * as removing it. A transaction that removes the reference together with its target is allowed,
 * because nothing names the target afterwards. Remote and internal transactions pass, as the region
 * guard lets them: the authority decides those.
 *
 * The refusal is reported to the core, which records it as a `referenced` refusal for the shell to
 * explain, and `referencePositions` finds the references to show (FE-133 criterion 5). `style:` and `field:` targets belong to `styleRef` and `formValue` fields,
 * not to `ref`, and are not checked here.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { INTERNAL, REMOTE } from './meta.ts';

export const referencedTargetKey = new PluginKey('docedit-referenced-targets');

/** The target schemes a `ref` field takes, and that this guard checks. */
const REF_SCHEMES = ['node:', 'bookmark:', 'eq:'] as const;

/** The `node:`, `bookmark:` and `eq:` targets that `ref` fields name in a document. */
function namedTargets(doc: PMNode): Set<string> {
  const out = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === 'field' && node.attrs['kind'] === 'ref') {
      const target = node.attrs['target'];
      if (typeof target === 'string' && REF_SCHEMES.some((s) => target.startsWith(s))) {
        out.add(target);
      }
    }
    return true;
  });
  return out;
}

/** The `node:`, `bookmark:` and `eq:` targets that a document can resolve. */
function resolvable(doc: PMNode): Set<string> {
  const out = new Set<string>();
  doc.descendants((node) => {
    const id = node.attrs['id'];
    if (typeof id === 'string' && id !== '') out.add(`node:${id}`);
    if (node.type.name === 'anchor' && typeof node.attrs['name'] === 'string') {
      out.add(`bookmark:${node.attrs['name']}`);
    }
    const label = node.attrs['label'];
    if (node.type.name === 'equation_block' && typeof label === 'string' && label !== '') {
      out.add(`eq:${label}`);
    }
    return true;
  });
  return out;
}

/**
 * The targets that the change removes while a reference in the result still names them, sorted. An
 * empty list means the change leaves every reference that it keeps resolvable.
 */
export function removedReferencedTargets(before: PMNode, after: PMNode): string[] {
  const named = namedTargets(after);
  if (named.size === 0) return [];
  const had = resolvable(before);
  const has = resolvable(after);
  const out: string[] = [];
  for (const target of named) {
    if (had.has(target) && !has.has(target)) out.push(target);
  }
  return out.sort();
}

/** The `ref` fields of a document that name one of `targets`, as positions in document order. */
export function referencePositions(doc: PMNode, targets: readonly string[]): number[] {
  const out: number[] = [];
  const wanted = new Set(targets);
  doc.descendants((node, pos) => {
    if (node.type.name === 'field' && node.attrs['kind'] === 'ref') {
      const target = node.attrs['target'];
      if (typeof target === 'string' && wanted.has(target)) out.push(pos);
    }
    return true;
  });
  return out;
}

/**
 * Refuses a local transaction that removes a target which a remaining reference names (I4). The
 * refusal is reported to `refused` with the targets, so that the shell can explain it and offer to
 * show the references (FE-133 criterion 5).
 */
export function referenceGuardPlugin(refused?: (targets: readonly string[]) => void): Plugin {
  return new Plugin({
    key: referencedTargetKey,
    filterTransaction(tr, state) {
      if (!tr.docChanged) return true;
      if (tr.getMeta(REMOTE) === true || tr.getMeta(INTERNAL) === true) return true;
      const removed = removedReferencedTargets(state.doc, tr.doc);
      if (removed.length === 0) return true;
      refused?.(removed);
      return false;
    },
  });
}
