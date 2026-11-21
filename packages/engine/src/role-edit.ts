/**
 * Adding, changing and deleting role definitions, and listing them (FRW-074; 12 §3.1, §3.6 I13;
 * 03 §4.1; 07 §4).
 *
 * - A role is a `role_def` node in the document's definitions: `id`, `name` and `color`. Adding one
 *   is an insertion there, renaming or recolouring one is a change of one attribute, one step per
 *   attribute. Each leaves through the commit log like any change.
 * - A value is checked against the attribute's grammar of the CDM definition (I11) before a step
 *   is made; a value that fails is reported by attribute and nothing changes.
 * - A role that a field's `assignee` still names is not deleted (I13): the answer lists the
 *   fields, so the roles manager can show them.
 * - The definitions are the scope `defs`, which needs `structure` (07 §4). The caller passes the
 *   region guard's answer as `writable`; where it is false the command returns `read-only`.
 * - The document must require the feature `fields`, which `role_def` belongs to.
 *
 * The reading half (`listRoles`, `nextRoleId`, `fieldsOfRole`) is in `role-read.ts` and is
 * re-exported here. This module loads with the roles pane (`./parts.ts`; FND-008).
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import { CDM1 } from '@docedit/model/definition';
import { checkGrammar } from '@docedit/model/validate';
import type { Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { type RoleFieldRef, fieldsOfRole } from './role-read.ts';

export { fieldsOfRole, listRoles, nextRoleId } from './role-read.ts';
export type { RoleFieldRef, RoleInfo } from './role-read.ts';

/** The attributes of a role an author may set; `id` is fixed when the role is made. */
export interface RoleValues {
  readonly name?: string;
  readonly color?: string;
}

export interface RoleProblem {
  /** The attribute: `id`, `name` or `color`. */
  readonly field: string;
  readonly message: string;
}

/** One change to the roles, as `DocumentCore.editRole` takes it. */
export type RoleEdit =
  | { readonly op: 'add'; readonly id: string; readonly values: RoleValues }
  | { readonly op: 'update'; readonly id: string; readonly values: RoleValues }
  | { readonly op: 'delete'; readonly id: string };

export type RoleEditOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'read-only' | 'duplicate' | 'not-defined' | 'no-change' | 'no-feature';
    }
  | { readonly ok: false; readonly reason: 'invalid'; readonly problems: readonly RoleProblem[] }
  | { readonly ok: false; readonly reason: 'in-use'; readonly fields: readonly RoleFieldRef[] };

export interface RoleEditOptions {
  /** Whether the region guard lets the user change the definitions at a position (07 §4). */
  readonly writable: (pos: number) => boolean;
  /** Whether the document requires the feature `fields`. */
  readonly formFields: boolean;
}

const ROLE_DEF = CDM1.nodes.find((n) => n.name === 'role_def');

/** The problems of an identifier and of values, by the grammars of `role_def` (I11). */
export function roleProblems(id: string | null, values: RoleValues): RoleProblem[] {
  const out: RoleProblem[] = [];
  const attrs = ROLE_DEF?.attrs ?? {};
  const check = (field: 'id' | 'name' | 'color', value: unknown): void => {
    const grammar = attrs[field]?.grammar;
    if (!grammar) return;
    for (const message of checkGrammar(grammar, value as never, `/${field}`))
      out.push({ field, message });
  };
  if (id !== null) check('id', id);
  if (values.name !== undefined) check('name', values.name);
  if (values.color !== undefined) check('color', values.color);
  return out;
}

function findRole(doc: Node, id: string): { node: Node; pos: number } | null {
  let found: { node: Node; pos: number } | null = null;
  doc.firstChild?.forEach((child, offset) => {
    if (!found && child.type.name === 'role_def' && child.attrs['id'] === id)
      found = { node: child, pos: 1 + offset };
  });
  return found;
}

/** Where a new role goes: after the last role, else after the last page setup (03 §4.1). */
function insertAt(doc: Node): number {
  const defs = doc.firstChild;
  if (!defs) return -1;
  let at = -1;
  defs.forEach((child, offset) => {
    if (child.type.name === 'role_def' || child.type.name === 'page_setup')
      at = 1 + offset + child.nodeSize;
  });
  return at;
}

/** Makes one change to the roles. With `dispatch` absent, only checks. */
export function editRole(
  state: EditorState,
  edit: RoleEdit,
  options: RoleEditOptions,
  dispatch?: (tr: Transaction) => void,
): RoleEditOutcome {
  const type = state.schema.nodes['role_def'];
  if (!type || !options.formFields) return { ok: false, reason: 'no-feature' };

  if (edit.op === 'add') {
    const at = insertAt(state.doc);
    if (at < 0) return { ok: false, reason: 'not-defined' };
    if (!options.writable(at)) return { ok: false, reason: 'read-only' };
    const problems = roleProblems(edit.id, {
      name: edit.values.name ?? '',
      color: edit.values.color ?? '',
    });
    if (problems.length > 0) return { ok: false, reason: 'invalid', problems };
    if (findRole(state.doc, edit.id)) return { ok: false, reason: 'duplicate' };
    if (dispatch)
      dispatch(
        state.tr.insert(
          at,
          type.create({ id: edit.id, name: edit.values.name, color: edit.values.color }),
        ),
      );
    return { ok: true };
  }

  const found = findRole(state.doc, edit.id);
  if (!found) return { ok: false, reason: 'not-defined' };
  if (!options.writable(found.pos)) return { ok: false, reason: 'read-only' };

  if (edit.op === 'update') {
    const problems = roleProblems(null, edit.values);
    if (problems.length > 0) return { ok: false, reason: 'invalid', problems };
    const changed = (['name', 'color'] as const).filter(
      (name) => edit.values[name] !== undefined && edit.values[name] !== found.node.attrs[name],
    );
    if (changed.length === 0) return { ok: false, reason: 'no-change' };
    if (dispatch) {
      const tr = state.tr;
      for (const name of changed) tr.setNodeAttribute(found.pos, name, edit.values[name]);
      dispatch(tr);
    }
    return { ok: true };
  }

  const fields = fieldsOfRole(state.doc, edit.id);
  if (fields.length > 0) return { ok: false, reason: 'in-use', fields };
  if (dispatch) dispatch(state.tr.delete(found.pos, found.pos + found.node.nodeSize));
  return { ok: true };
}
