/**
 * Listing the document's roles (FRW-074; 12 §3.1). The reading half of `role-edit.ts`: the shell
 * lists roles as soon as it draws a role preview, so this stays in the first load, while the
 * editing and its grammar checks load with the roles pane (`./parts.ts`; FND-008).
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import type { Node } from 'prosemirror-model';

/** A form field that names a role as its `assignee`. */
export interface RoleFieldRef {
  readonly id: string;
  readonly key: string;
  readonly label: string;
}

export interface RoleInfo {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  /** Position among the document's roles, in definition order (0 for the first). */
  readonly order: number;
  /** The fields assigned to the role, in document order. */
  readonly fields: readonly RoleFieldRef[];
}

/** The form fields whose `assignee` is the role `id`, in document order. */
export function fieldsOfRole(doc: Node, id: string): RoleFieldRef[] {
  const out: RoleFieldRef[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'form_field') return true;
    if (node.attrs['assignee'] === id) {
      const key = String(node.attrs['key'] ?? '');
      const label = node.attrs['label'];
      out.push({
        id: String(node.attrs['id'] ?? ''),
        key,
        label: typeof label === 'string' && label !== '' ? label : key,
      });
    }
    return false;
  });
  return out;
}

/** The roles of the document in the order of its definitions, each with the fields assigned to it. */
export function listRoles(doc: Node): RoleInfo[] {
  const out: RoleInfo[] = [];
  doc.firstChild?.forEach((child) => {
    if (child.type.name !== 'role_def') return;
    const id = child.attrs['id'];
    if (typeof id !== 'string') return;
    out.push({
      id,
      name: String(child.attrs['name'] ?? ''),
      color: String(child.attrs['color'] ?? ''),
      order: out.length,
      fields: fieldsOfRole(doc, id),
    });
  });
  return out;
}

/** The least `role_<n>` that no role of the document uses. */
export function nextRoleId(doc: Node): string {
  const used = new Set(listRoles(doc).map((r) => r.id));
  for (let n = 1; ; n++) {
    const id = `role_${n}`;
    if (!used.has(id)) return id;
  }
}
