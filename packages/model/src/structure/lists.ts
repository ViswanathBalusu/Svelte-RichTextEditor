/**
 * List instances (03 §4.3; CDM-026): a list is the set of paragraphs whose `numbering` names one
 * `listId`, in document order, across regions and table cells. Two lists may use one numbering
 * definition and still number independently, and a list survives the deletion of any of its
 * paragraphs, because every paragraph carries its own `listId`. No list container node exists.
 *
 * Paragraphs numbered only through their style (headings) are not listed: which list instance a
 * style's numbering joins is settled with the numbering semantics (CDM-005, CDM-042).
 */
import type { JsonNode } from '../canonical/canonical-form.ts';

export interface ListInstance {
  listId: string;
  numberingId: string;
  /** Paragraph identifiers in document order, with the level of each. */
  items: Array<{ id: string | null; level: number }>;
}

/** The list instances of a document or a subtree, in order of their first paragraph. */
export function listInstances(root: JsonNode): ListInstance[] {
  const lists = new Map<string, ListInstance>();
  const stack: JsonNode[] = [root];
  // Depth-first, children in order: push them reversed.
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'paragraph') {
      const n = node.attrs?.['numbering'];
      if (n && typeof n === 'object' && !Array.isArray(n)) {
        const listId = n['listId'];
        const numberingId = n['numberingId'];
        const level = n['level'];
        if (
          typeof listId === 'string' &&
          typeof numberingId === 'string' &&
          typeof level === 'number'
        ) {
          let list = lists.get(listId);
          if (!list) lists.set(listId, (list = { listId, numberingId, items: [] }));
          const id = node.attrs?.['id'];
          list.items.push({ id: typeof id === 'string' ? id : null, level });
        }
      }
    }
    const content = node.content ?? [];
    for (let i = content.length - 1; i >= 0; i--) stack.push(content[i]!);
  }
  return [...lists.values()];
}
