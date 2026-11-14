/**
 * The navigation pane's tree (UX-020, criterion 1, the nesting part; criterion 4 is the ARIA
 * tree in the pane). The tree is built from the core's flat `outline()` list. These properties
 * check that the tree keeps every heading, in document order, nests each one under the nearest
 * earlier heading of a lower level, and numbers siblings for aria-posinset and aria-setsize.
 * They do not check that choosing a heading moves the caret or scrolls it into view: that is the
 * core's and is not tested here.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { OutlineItem } from '../src/core-api.ts';
import { outlineTree, type TreeNode } from '../src/shell/outline.ts';

/** A flat list of headings with unique identifiers, levels 1 to 9 (03 section 4.1). */
const outlineArb = fc
  .array(fc.integer({ min: 1, max: 9 }), { maxLength: 40 })
  .map((levels) =>
    levels.map((level, i): OutlineItem => ({ id: `h${i}`, level, text: `Heading ${i}` })),
  );

/** Every node in document order, by walking the children from the roots. */
function walk(roots: readonly TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      visit(n.children);
    }
  };
  visit(roots);
  return out;
}

/** The nearest earlier item with a lower level, or null: the parent the tree must give. */
function expectedParentId(items: readonly OutlineItem[], index: number): string | null {
  const level = items[index]!.level;
  for (let j = index - 1; j >= 0; j--) {
    if (items[j]!.level < level) return items[j]!.id;
  }
  return null;
}

describe('the navigation tree keeps every heading (UX-020, criterion 1)', () => {
  it('lists every heading once, in document order, in the flat list and on a walk of the tree (property)', () => {
    fc.assert(
      fc.property(outlineArb, (items) => {
        const { roots, flat } = outlineTree(items);
        expect(flat.map((n) => n.item)).toEqual(items);
        expect(walk(roots).map((n) => n.item)).toEqual(items);
      }),
    );
  });

  it('nests each heading under the nearest earlier heading of a lower level, or at the top (property)', () => {
    fc.assert(
      fc.property(outlineArb, (items) => {
        const { flat } = outlineTree(items);
        flat.forEach((node, index) => {
          const parentId = expectedParentId(items, index);
          const actualParent = node.ancestors[node.ancestors.length - 1] ?? null;
          expect(actualParent).toBe(parentId);
        });
      }),
    );
  });

  it('gives a child a deeper level than its parent, and a depth equal to its number of ancestors (property)', () => {
    fc.assert(
      fc.property(outlineArb, (items) => {
        const { flat } = outlineTree(items);
        for (const node of flat) {
          expect(node.depth).toBe(node.ancestors.length);
          for (const child of node.children) {
            expect(child.item.level).toBeGreaterThan(node.item.level);
            expect(child.depth).toBe(node.depth + 1);
          }
        }
      }),
    );
  });

  it('numbers siblings from 1 with their count, for aria-posinset and aria-setsize (property)', () => {
    fc.assert(
      fc.property(outlineArb, (items) => {
        const { roots, flat } = outlineTree(items);
        const check = (siblings: readonly TreeNode[]) => {
          siblings.forEach((n, i) => {
            expect(n.position).toBe(i + 1);
            expect(n.setSize).toBe(siblings.length);
          });
        };
        check(roots);
        for (const node of flat) check(node.children);
      }),
    );
  });

  it('nests a heading that skips a level one step under the last heading above it', () => {
    const { roots, flat } = outlineTree([
      { id: 'a', level: 1, text: 'A' },
      { id: 'b', level: 3, text: 'B' },
      { id: 'c', level: 2, text: 'C' },
    ]);
    expect(roots.map((n) => n.item.id)).toEqual(['a']);
    expect(flat.find((n) => n.item.id === 'b')).toMatchObject({ depth: 1, ancestors: ['a'] });
    expect(flat.find((n) => n.item.id === 'c')).toMatchObject({ depth: 1, ancestors: ['a'] });
  });

  it('makes a heading of the same level a sibling, not a child (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 12 }),
        (level, count) => {
          const items: OutlineItem[] = Array.from({ length: count }, (_, i) => ({
            id: `s${i}`,
            level,
            text: `Same ${i}`,
          }));
          const { roots, flat } = outlineTree(items);
          expect(roots.length).toBe(count);
          expect(flat.every((n) => n.children.length === 0 && n.depth === 0)).toBe(true);
        },
      ),
    );
  });
});
