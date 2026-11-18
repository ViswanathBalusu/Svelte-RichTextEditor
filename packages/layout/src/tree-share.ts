/**
 * Structural sharing between two layout trees (02 §9.2, §9.5; FE-078 criterion 4). A layout pass
 * builds a whole new tree, so a node of the new tree is never the object a node of the old tree was,
 * even when nothing about it changed. `shareSubtrees` gives the new tree the old tree's objects for
 * every part that is the same: a page, a fragment, a row, a cell or a line (or any array of them)
 * whose content is equal to a part of the previous tree is that part, so that a painter (FE-092)
 * can tell by identity (`===`) what to skip.
 *
 * "Equal" is exact: the same kind, the same block identifier and offsets, the same position and size
 * in points. A block that only moved because an earlier block grew has a new fragment, and the
 * lines inside it, which are placed relative to it, are shared. A block that did not change and did
 * not move is the very same object, and so is every page that holds only such blocks.
 *
 * The result is a new tree of the new tree's values, in the new tree's order. Nothing in either
 * input is changed.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import { freezeTree, type LayoutTree } from './tree.ts';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** The objects and arrays of a tree, by the identity number of their content. */
class Pool {
  readonly #ids = new Map<string, number>();
  /** The number of each object already numbered, so that no part is numbered twice. */
  readonly #memo = new WeakMap<object, number>();
  /** The first object seen for each identity number. */
  readonly objects = new Map<number, object>();

  #id(key: string): number {
    let id = this.#ids.get(key);
    if (id === undefined) {
      id = this.#ids.size;
      this.#ids.set(key, id);
    }
    return id;
  }

  /**
   * The identity number of a value: equal content, equal number. Each object and array is looked up
   * by the numbers of its children, so the cost is linear in the size of the tree.
   */
  number(value: Json): number {
    if (value === null || typeof value !== 'object') return this.#id(`p${JSON.stringify(value)}`);
    const seen = this.#memo.get(value);
    if (seen !== undefined) return seen;
    let id: number;
    if (Array.isArray(value)) {
      id = this.#id(`[${(value as readonly Json[]).map((v) => this.number(v)).join(',')}]`);
    } else {
      const record = value as { readonly [key: string]: Json };
      // Keys are sorted, so that two objects with the same entries in another order are equal.
      const keys = Object.keys(record).sort();
      id = this.#id(
        `{${keys.map((k) => `${JSON.stringify(k)}:${this.number(record[k]!)}`).join(',')}}`,
      );
    }
    this.#memo.set(value, id);
    return id;
  }

  /** Registers `value` and all its parts, so that a later tree can take them. */
  register(value: Json): void {
    if (value === null || typeof value !== 'object') return;
    const id = this.number(value);
    if (!this.objects.has(id)) this.objects.set(id, value);
    if (Array.isArray(value)) for (const v of value as readonly Json[]) this.register(v);
    else for (const v of Object.values(value as { readonly [key: string]: Json })) this.register(v);
  }

  /**
   * `value` with every object and array replaced by the one this pool holds for its content: the
   * registered one when there is one, else a copy, which the pool then holds. Equal parts of one
   * tree therefore become one object, and a part equal to a registered one is that object.
   */
  intern<T extends Json>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    const id = this.number(value);
    const known = this.objects.get(id);
    if (known) return known as T;
    let copy: object;
    if (Array.isArray(value)) copy = (value as readonly Json[]).map((v) => this.intern(v));
    else {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(value as { readonly [key: string]: Json }))
        out[k] = this.intern(v);
      copy = out;
    }
    this.#memo.set(copy, id);
    this.objects.set(id, copy);
    return copy as T;
  }
}

/**
 * `next` with the objects of `previous` wherever they are equal (see the module comment). Equal
 * parts of `next` itself become one object too, so that a tree this function returned can be the
 * `previous` of the next call and every unchanged part is then the same object in both. With no
 * previous tree it still makes the parts of `next` unique. The result is frozen.
 *
 * If `previous` holds two equal parts as different objects (it did not come from this function),
 * the first of them in page order is the one `next` takes.
 */
export function shareSubtrees(previous: LayoutTree | null, next: LayoutTree): LayoutTree {
  const pool = new Pool();
  if (previous !== null) pool.register(previous as unknown as Json);
  return freezeTree(pool.intern(next as unknown as Json) as unknown as LayoutTree);
}
