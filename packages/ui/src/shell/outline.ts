/**
 * The outline as a tree (UX-020 criterion 4): a heading's children are the headings after it with
 * a deeper level, up to the next heading at its level or above. A skipped level (a level 3 after a
 * level 1) nests one step, so every item has a parent it can be reached from.
 */
import type { OutlineItem } from '../core-api.ts';

export interface TreeNode {
  readonly item: OutlineItem;
  /** Nesting depth, from 0. */
  readonly depth: number;
  readonly children: TreeNode[];
  /** Identifiers of the ancestors, outermost first. */
  readonly ancestors: readonly string[];
  /** Position among its siblings, from 1, and their number (aria-posinset, aria-setsize). */
  position: number;
  setSize: number;
}

export function outlineTree(items: readonly OutlineItem[]): {
  roots: TreeNode[];
  flat: TreeNode[];
} {
  const roots: TreeNode[] = [];
  const flat: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const item of items) {
    while (stack.length && stack[stack.length - 1]!.item.level >= item.level) stack.pop();
    const parent = stack[stack.length - 1];
    const node: TreeNode = {
      item,
      depth: stack.length,
      children: [],
      ancestors: parent ? [...parent.ancestors, parent.item.id] : [],
      position: 0,
      setSize: 0,
    };
    (parent ? parent.children : roots).push(node);
    flat.push(node);
    stack.push(node);
  }
  const number = (list: TreeNode[]) => {
    list.forEach((n, i) => {
      n.position = i + 1;
      n.setSize = list.length;
      number(n.children);
    });
  };
  number(roots);
  return { roots, flat };
}
