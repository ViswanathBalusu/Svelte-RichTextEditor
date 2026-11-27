/**
 * Structural comparison for incremental pagination (02 §9.5; FE-088). `sameValue` compares two
 * values of the layout tree by content, with the identity of an object as a shortcut: a block that
 * was not re-measured keeps its objects, so most comparisons end at the first test. `diffItems`
 * finds the items that changed between two runs: the unchanged prefix and the unchanged suffix.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */

/** Whether two values are equal by content. Functions are equal when they are the same function. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a !== a && b !== b;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !sameValue(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (a instanceof Map || b instanceof Map || b instanceof Set) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.hasOwn(rb, k) || !sameValue(ra[k], rb[k])) return false;
  }
  return true;
}

/** The result of `diffItems`. */
export interface ItemDiff {
  /** True when the two lists are equal item by item. */
  readonly same: boolean;
  /** Items at the start that are equal in both lists: the first changed item sits at this index. */
  readonly prefix: number;
  /** Items at the end that are equal in both lists, not counting any in the prefix. */
  readonly suffix: number;
}

/** Compares two item lists from both ends. */
export function diffItems(before: readonly unknown[], after: readonly unknown[]): ItemDiff {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && sameValue(before[prefix], after[prefix])) prefix++;
  if (prefix === before.length && prefix === after.length) return { same: true, prefix, suffix: 0 };
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    sameValue(before[before.length - 1 - suffix], after[after.length - 1 - suffix])
  )
    suffix++;
  return { same: false, prefix, suffix };
}
