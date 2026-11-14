/**
 * Text extraction after checkpoints and a tenant-scoped search index (06 §1 indexer; 05 §6.2
 * `/search`; BE-054; ADR 0019 visibility classes; ADR 0017 preserved content; BE-053 design in
 * docs/adr/0243-lane-BE-053-065.md).
 *
 * The rules this module holds:
 *
 * - Text is taken from a checkpoint's CDM nodes as plain strings. It is never parsed as markup,
 *   never evaluated and never fetched. The module has no network, file or credential access.
 * - Text inside preserved content is not extracted at all (ADR 0017): a `preserved_block` or
 *   `preserved_inline` subtree, a node whose `preserved` attribute is set, and text carrying a
 *   `preserved` mark are all skipped.
 * - Every entry belongs to one tenant, one document and one visibility class (ADR 0019, SR-M5).
 *   The text indexed for a class is the text that class may read, so the caller passes the
 *   projected content for that class. A query names the classes the principal may read, and an
 *   entry of any other class is never returned.
 * - Every key includes the tenant. A purged document leaves the index at once (`purgeDocument`).
 * - Ranking is by the number of occurrences of the query terms, with every term required (AND),
 *   and ties broken by document identifier. One hit per document: its best readable entry.
 *   The hit carries no visibility class, so a result does not reveal which class matched.
 *
 * This is the in-memory index. The PostgreSQL search tables, the indexer job that a checkpoint
 * triggers, the `GET /search` route and the purge pipeline are not built here (see BE-054 Notes).
 */
import type { JsonNode } from '@docedit/model';

/**
 * The text of a checkpoint, as strings in document order. Preserved content is skipped.
 *
 * One string is one run of adjacent text nodes in the same parent, joined without a separator,
 * so a word split across text nodes by a mark ("He" bold, "llo" plain) or by a tracked change
 * stays one word. A run ends at the end of its block and at every other inline node: a `break`,
 * a `tab`, an atom such as an image, field or footnote, and preserved text. The one exception is
 * `anchor`, a zero-width bookmark with no text (03 §4.4), which a Word file may place inside a
 * word; it does not end the run. Text in two blocks is never joined into one string.
 */
export function extractSearchText(root: JsonNode): string[] {
  const out: string[] = [];
  // An explicit stack, so that a deeply nested hostile document cannot exhaust the call stack.
  // An item is a node still to visit, or a string already joined and waiting for its turn.
  const stack: (JsonNode | string)[] = [root];
  while (stack.length > 0) {
    const item = stack.pop() as JsonNode | string;
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (isPreservedNode(item)) continue;
    if (typeof item.text === 'string') {
      // A text node reached on its own: the root, or a run of one (runs are joined below).
      if (!hasPreservedMark(item) && item.text.length > 0) out.push(item.text);
      continue;
    }
    const work = childWork(item.content ?? []);
    // Pushed in reverse, so that the first item is taken first.
    for (let i = work.length - 1; i >= 0; i--) stack.push(work[i] as JsonNode | string);
  }
  return out;
}

/** The children of a node in order, with each run of adjacent text nodes joined into a string. */
function childWork(children: readonly JsonNode[]): (JsonNode | string)[] {
  const work: (JsonNode | string)[] = [];
  let run: string[] = [];
  const flush = (): void => {
    const joined = run.join('');
    if (joined.length > 0) work.push(joined);
    run = [];
  };
  for (const child of children) {
    if (typeof child.text === 'string' && !isPreservedNode(child)) {
      if (hasPreservedMark(child)) flush();
      else run.push(child.text);
    } else if (child.type === 'anchor' && !isPreservedNode(child)) {
      // Zero width and no text: the run goes on across it.
    } else {
      flush();
      work.push(child);
    }
  }
  flush();
  return work;
}

function isPreservedNode(node: JsonNode): boolean {
  if (node.type === 'preserved_block' || node.type === 'preserved_inline') return true;
  const preserved = node.attrs?.['preserved'];
  return preserved !== undefined && preserved !== null;
}

function hasPreservedMark(node: JsonNode): boolean {
  return (node.marks ?? []).some((m) => m.type === 'preserved');
}

/** The tokens of a text or a query: lower-cased runs of letters and digits. */
export function searchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

export interface CheckpointInput {
  readonly tenant: string;
  readonly doc: string;
  readonly seq: number;
  /** The visibility class of the text (ADR 0019); `full` where nothing is restricted. */
  readonly visibility: string;
  /** The content as the class may read it (projected by the caller). */
  readonly content: JsonNode;
}

export interface SearchQuery {
  /** The classes the principal may read, or `all` for a service credential. */
  readonly readable: 'all' | ReadonlySet<string>;
  /** The most hits returned. Required, because the spec gives no default. */
  readonly limit: number;
}

export interface SearchHit {
  readonly doc: string;
  readonly seq: number;
  readonly score: number;
}

interface Entry {
  readonly tenant: string;
  readonly doc: string;
  readonly seq: number;
  readonly visibility: string;
  /** The occurrences of each token, for the ranking. */
  readonly counts: ReadonlyMap<string, number>;
}

export class SearchIndex {
  readonly #entries = new Map<string, Entry>();

  /**
   * Indexes a checkpoint for one tenant, document and class. A checkpoint with a lower sequence
   * than the one held for that class does not replace it. Returns whether the entry was stored.
   */
  indexCheckpoint(input: CheckpointInput): boolean {
    const key = entryKey(input.tenant, input.doc, input.visibility);
    const held = this.#entries.get(key);
    if (held && held.seq > input.seq) return false;
    const counts = new Map<string, number>();
    for (const text of extractSearchText(input.content))
      for (const token of searchTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    this.#entries.set(key, {
      tenant: input.tenant,
      doc: input.doc,
      seq: input.seq,
      visibility: input.visibility,
      counts,
    });
    return true;
  }

  /** Removes every entry of one document of one tenant. Returns how many were removed. */
  purgeDocument(tenant: string, doc: string): number {
    let removed = 0;
    for (const [key, e] of this.#entries)
      if (e.tenant === tenant && e.doc === doc) {
        this.#entries.delete(key);
        removed++;
      }
    return removed;
  }

  /** The number of entries held for a tenant (for tests and metrics). */
  size(tenant: string): number {
    let n = 0;
    for (const e of this.#entries.values()) if (e.tenant === tenant) n++;
    return n;
  }

  /**
   * Searches one tenant's readable entries. A query with no tokens returns nothing. Throws for a
   * `limit` that is not a positive integer.
   */
  search(tenant: string, q: string, query: SearchQuery): SearchHit[] {
    if (!Number.isInteger(query.limit) || query.limit < 1)
      throw new RangeError('search limit must be a positive integer');
    const terms = [...new Set(searchTokens(q))];
    if (terms.length === 0) return [];

    const best = new Map<string, SearchHit>();
    for (const e of this.#entries.values()) {
      if (e.tenant !== tenant) continue;
      if (query.readable !== 'all' && !query.readable.has(e.visibility)) continue;
      let score = 0;
      let every = true;
      for (const term of terms) {
        const n = e.counts.get(term);
        if (n === undefined) {
          every = false;
          break;
        }
        score += n;
      }
      if (!every) continue;
      const held = best.get(e.doc);
      if (!held || score > held.score || (score === held.score && e.seq > held.seq))
        best.set(e.doc, { doc: e.doc, seq: e.seq, score });
    }

    return [...best.values()]
      .sort((a, b) => b.score - a.score || (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0))
      .slice(0, query.limit);
  }
}

function entryKey(tenant: string, doc: string, visibility: string): string {
  return JSON.stringify([tenant, doc, visibility]);
}
