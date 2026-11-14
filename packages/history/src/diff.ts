/**
 * A shortest edit script between two token lists (Myers, "An O(ND) difference algorithm and its
 * variations", 1986), after the common prefix and suffix are taken off. Past `maxCost` edits the
 * middle is reported as one deletion and one insertion, so that a block rewritten from scratch
 * costs a bounded amount of work.
 */

export interface Edit {
  op: 'equal' | 'delete' | 'insert';
  /** Index of the first token in the old list (for `equal` and `delete`). */
  a: number;
  /** Index of the first token in the new list (for `equal` and `insert`). */
  b: number;
  /** Number of tokens. */
  n: number;
}

/** Default bound on the number of edits searched for one block. */
export const DEFAULT_MAX_COST = 2000;

export function diffTokens(
  a: readonly string[],
  b: readonly string[],
  maxCost: number = DEFAULT_MAX_COST,
): Edit[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const out: Edit[] = [];
  if (pre) out.push({ op: 'equal', a: 0, b: 0, n: pre });
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  for (const e of middle(midA, midB, maxCost)) out.push({ ...e, a: e.a + pre, b: e.b + pre });
  if (suf) out.push({ op: 'equal', a: a.length - suf, b: b.length - suf, n: suf });
  return merge(out);
}

function middle(a: readonly string[], b: readonly string[], maxCost: number): Edit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ op: 'insert', a: 0, b: 0, n: m }];
  if (m === 0) return [{ op: 'delete', a: 0, b: 0, n }];
  const max = Math.min(n + m, maxCost);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v for k from -d-1 to d+1 as it was before round d.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) {
    // Too many edits: one deletion and one insertion.
    return [
      { op: 'delete', a: 0, b: 0, n },
      { op: 'insert', a: n, b: 0, n: m },
    ];
  }
  // Walk back through the trace.
  const rev: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d]!;
    const at = (k: number) => vd[k + d + 1]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rev.push({ op: 'equal', a: x, b: y, n: 1 });
    }
    if (x === prevX) rev.push({ op: 'insert', a: x, b: prevY, n: 1 });
    else rev.push({ op: 'delete', a: prevX, b: y, n: 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    rev.push({ op: 'equal', a: x, b: y, n: 1 });
  }
  return rev.reverse();
}

/** Joins adjacent edits of the same kind; deletions come before insertions between equal runs. */
function merge(edits: readonly Edit[]): Edit[] {
  const out: Edit[] = [];
  let i = 0;
  while (i < edits.length) {
    const e = edits[i]!;
    if (e.op === 'equal') {
      const last = out[out.length - 1];
      if (last?.op === 'equal' && last.a + last.n === e.a && last.b + last.n === e.b) last.n += e.n;
      else out.push({ ...e });
      i++;
      continue;
    }
    // A run of deletions and insertions between two equal runs.
    let del: Edit | null = null;
    let ins: Edit | null = null;
    while (i < edits.length && edits[i]!.op !== 'equal') {
      const c = edits[i]!;
      if (c.op === 'delete') {
        if (del && del.a + del.n === c.a) del.n += c.n;
        else if (!del) del = { ...c };
        else {
          out.push(del);
          del = { ...c };
        }
      } else if (ins && ins.b + ins.n === c.b) ins.n += c.n;
      else if (!ins) ins = { ...c };
      else {
        out.push(ins);
        ins = { ...c };
      }
      i++;
    }
    if (del) out.push(del);
    if (ins) out.push(ins);
  }
  return out;
}
