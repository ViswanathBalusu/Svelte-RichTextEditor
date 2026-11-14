/**
 * Keyed repaint (FE-092, criterion 2): paints a layout tree into a root that already holds the
 * previous paint, and touches only what changed. A page whose painted content is the same keeps
 * its element; within a page, a line whose painted markup is the same keeps its element; the DOM is
 * changed only where a line or a page differs. Built on `paintTree` (painter.ts), so the markup of
 * a line is the one `paintTree` writes.
 *
 * Comparison is by the painted `outerHTML` of each line, which holds the position, the text and
 * the justification, so two lines with the same markup are interchangeable. This is a DOM package
 * (`packages/painter`, 01 §6).
 */
import type { LayoutTree } from '../../layout/src/tree.ts';
import { paintTree, type PaintOptions, type PaintResult, type PaintSource } from './painter.ts';

type Container = HTMLElement | ShadowRoot;

const isPage = (el: Element): boolean => el.classList.contains('de-page');
const always = (): boolean => true;

/** The next child of `target` after `el` that `owns` accepts. */
function nextOwned(el: Element, owns: (e: Element) => boolean): Element | null {
  let n = el.nextElementSibling;
  while (n && !owns(n)) n = n.nextElementSibling;
  return n;
}

/**
 * Makes the children of `target` that `owns` accepts be `desired`, in order. A child whose markup
 * equals a desired element's is kept, and the desired one is dropped. Nothing is moved when the
 * order already holds, and children `owns` does not accept are left alone.
 */
function reconcile(
  target: Container,
  desired: readonly Element[],
  owns: (e: Element) => boolean = always,
): void {
  const owned = Array.from(target.children).filter(owns);
  const pool = new Map<string, Element[]>();
  for (const child of owned) {
    const key = child.outerHTML;
    const list = pool.get(key);
    if (list) list.push(child);
    else pool.set(key, [child]);
  }
  const final = desired.map((d) => pool.get(d.outerHTML)?.shift() ?? d);
  const keep = new Set(final);
  for (const child of owned) if (!keep.has(child)) child.remove();

  let cursor: Element | null = Array.from(target.children).find(owns) ?? null;
  for (const node of final) {
    if (node === cursor) cursor = nextOwned(cursor, owns);
    else target.insertBefore(node, cursor);
  }
}

/**
 * Paints `tree` into `root`, keeping what is already there when it is unchanged. Unlike
 * `paintTree`, the caller does not clear `root`; pages it no longer has are removed.
 */
export function repaintTree(
  root: Container,
  tree: LayoutTree,
  source: PaintSource,
  options: PaintOptions = {},
): PaintResult {
  const doc = root.ownerDocument as Document;
  const existing = new Map<string, Element>();
  for (const child of Array.from(root.children)) {
    if (isPage(child)) existing.set((child as HTMLElement).dataset['page'] ?? '', child);
  }

  const pages: HTMLElement[] = [];
  let lineCount = 0;
  let controlCount = 0;
  for (const page of tree.pages) {
    // Each page is painted on its own, into a scratch element that is dropped afterwards.
    const scratch = doc.createElement('div');
    const fresh = paintTree(scratch, { ...tree, pages: [page] }, source, options);
    lineCount += fresh.lineCount;
    controlCount += fresh.controlCount;
    const built = fresh.pages[0]!;
    const old = existing.get(String(page.index));
    if (old instanceof HTMLElement) {
      const style = built.getAttribute('style') ?? '';
      if (old.getAttribute('style') !== style) old.setAttribute('style', style);
      reconcile(old, Array.from(built.children));
      pages.push(old);
    } else {
      pages.push(built);
    }
  }
  reconcile(root, pages, isPage);
  return { pages, lineCount, controlCount };
}
