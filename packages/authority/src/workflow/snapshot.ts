/**
 * The document as `resume` compares it (12 §6.2; FRW-032 criterion 4): the body without the values
 * of its fields, the values of the fields by key, and who owns each field. Pure functions over a
 * document in its JSON form (an envelope or the `doc` node).
 *
 * - The body is the canonical JSON of the document with the `value` of every `form_field` taken out,
 *   so a change of a value is a change of a field and a change of anything else, including a
 *   definition, a label or the options of a field, is a change of the body.
 * - A field value is its canonical JSON text; a field with no value, or with a null one, has none.
 * - The owners of a field are the participants who hold the field's assignee role. A field with no
 *   assignee, or whose role no participant holds, has no owner, so a change of its value is treated
 *   as a change of the body (`resumeWorkflow`).
 */
import { canonicalize } from '@docedit/model';
import type { DocumentSnapshot, FieldOwners } from './correction.ts';
import type { WorkflowParticipant } from './lifecycle.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The document node of an envelope, or the node itself. */
function rootOf(input: unknown): unknown {
  return isObj(input) && 'doc' in input ? input['doc'] : input;
}

/**
 * The node with the `value` of every form field removed, and the content of every region in
 * `granted` emptied; the input is not changed.
 */
function withoutValues(node: unknown, granted: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => withoutValues(n, granted));
  if (!isObj(node)) return node;
  const attrs = node['attrs'];
  const emptied =
    node['type'] === 'region' &&
    isObj(attrs) &&
    typeof attrs['id'] === 'string' &&
    granted.has(attrs['id']);
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'attrs' && node['type'] === 'form_field' && isObj(v)) {
      const rest: Obj = { ...v };
      delete rest['value'];
      out[k] = rest;
    } else if (k === 'content' && emptied) out[k] = [];
    else out[k] = withoutValues(v, granted);
  }
  return out;
}

/** The form fields of the document in document order: `attrs` of each `form_field`. */
function fieldsOf(node: unknown, found: Obj[] = []): Obj[] {
  if (Array.isArray(node)) for (const n of node) fieldsOf(n, found);
  else if (isObj(node)) {
    if (node['type'] === 'form_field' && isObj(node['attrs'])) found.push(node['attrs']);
    fieldsOf(node['content'], found);
  }
  return found;
}

/**
 * The body and the field values of a document, as the comparison of `resume` reads them.
 * `grantedRegions` are the identifiers of the regions granted to roles. Their content is not part of
 * the body, because a participant who holds the role may edit it while the workflow runs (07 §4
 * limit 1; FRW-086). The region node and its attributes stay, so adding, removing or renaming the
 * region is still a change of the body, and the values of fields inside it are still compared.
 */
export function snapshotOf(
  input: unknown,
  grantedRegions: ReadonlySet<string> = new Set(),
): DocumentSnapshot {
  const root = rootOf(input);
  const fields: Record<string, string | null> = {};
  for (const attrs of fieldsOf(root)) {
    const key = attrs['key'];
    if (typeof key !== 'string') continue;
    const value = attrs['value'];
    fields[key] = value === undefined || value === null ? null : canonicalize(value);
  }
  return { body: canonicalize(withoutValues(root, grantedRegions)), fields };
}

/**
 * The owners of each field of the document: the participants who hold the field's assignee role.
 * A key that two fields share is owned by the holders of either role.
 */
export function fieldOwnersOf(
  input: unknown,
  participants: readonly Pick<WorkflowParticipant, 'id' | 'roles'>[],
): FieldOwners {
  const owners: Record<string, string[]> = {};
  for (const attrs of fieldsOf(rootOf(input))) {
    const key = attrs['key'];
    const role = attrs['assignee'];
    if (typeof key !== 'string') continue;
    const list = (owners[key] ??= []);
    if (typeof role !== 'string' || role === '') continue;
    for (const p of participants)
      if (p.roles.includes(role) && !list.includes(p.id)) list.push(p.id);
  }
  return owners;
}
