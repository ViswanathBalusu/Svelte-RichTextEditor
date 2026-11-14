/**
 * Content reads without a room (06 §3 first bullet; 05 §6.2 content; BE-036, PRO-049; 08 §3).
 *
 * A commit is visible only after it is stored, so the head in PostgreSQL is complete: the content
 * at any `seq` is the nearest checkpoint at or before it plus the stored commits after it, replayed
 * in a worker thread (BE-001 criterion 3). Rebuilt content is cached by document, incarnation and
 * `seq`; what is served is cached by those and by the reader's class and the grants revision, and a
 * cached copy is served only after the request's own checks (BE-036 criterion 5; SR-C4; D70).
 */
import { ENGINE, type Connection, type LogCommit } from '@docedit/authority';
import { canonicalize, nodeId, type JsonEnvelope, type JsonNode } from '@docedit/model';
import type {
  CheckpointStore,
  DocRef,
  DocumentStore,
  GrantStore,
  LogStore,
} from '../storage/types.ts';
import { PayloadAbsentError } from '../storage/payload-absent.ts';
import { ApiError } from './problems.ts';
import { projectContent, readerView, type ReaderView, type Views } from './visibility.ts';
import type { WorkerPool } from './workers/pool.ts';

/** What a content read returns: the bytes to send and what they say. */
export interface ContentRead {
  seq: number;
  incarnation: string;
  cdm: number;
  requires: string[];
  doc: JsonNode;
  view: string;
  /** Canonical JSON (RFC 8785) of the response body, so repeated reads are byte-identical. */
  bytes: Buffer;
  /** Combines the incarnation, the `seq` and the view token (05 §6.2; D70). */
  etag: string;
  /** The grants revision the class was derived from (S12 change 3). */
  revision: number;
}

/** A least-recently-used map with a bound on its entries (a setting; ADR 0036). */
export class Lru<V> {
  readonly #max: number;
  readonly #map = new Map<string, V>();

  constructor(max: number) {
    this.#max = Math.max(0, max);
  }

  get(key: string): V | undefined {
    const v = this.#map.get(key);
    if (v !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    if (this.#max === 0) return;
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) this.#map.delete(this.#map.keys().next().value!);
  }

  keys(): string[] {
    return [...this.#map.keys()];
  }

  get size(): number {
    return this.#map.size;
  }
}

export interface ContentReaderOptions {
  logs: LogStore;
  documents: DocumentStore;
  grants: GrantStore;
  checkpoints: CheckpointStore;
  pool: WorkerPool;
  views: Views;
  /** Rebuilt contents kept (a setting). */
  rebuiltEntries: number;
  /** Responses kept (a setting). */
  responseEntries: number;
}

interface Rebuilt {
  seq: number;
  doc: JsonNode;
  cdm: number;
  requires: string[];
}

/** The document as it is created when no content is given: one empty paragraph (D62). */
export function emptyDocument(): JsonEnvelope {
  // The definitions follow the example of 03 §12: A4 portrait with 2.54 cm margins, en-GB.
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [{ type: 'paragraph', attrs: { id: nodeId(), style: 'Normal' } }],
        },
      ],
    } as unknown as JsonNode,
  } as JsonEnvelope;
}

/** The regions of the body in document order: identifier, title and policy (03 §4.2). */
export function regionsOfJson(doc: JsonNode): Array<{ id: string; title: string; policy: string }> {
  const top = (
    doc as {
      content?: Array<{ type: string; attrs?: Record<string, unknown>; content?: unknown[] }>;
    }
  ).content;
  const body = top?.[top.length - 1];
  const out: Array<{ id: string; title: string; policy: string }> = [];
  for (const c of (body?.content ?? []) as Array<{ type: string; attrs?: Record<string, unknown> }>)
    if (c.type === 'region')
      out.push({
        id: String(c.attrs?.['id'] ?? ''),
        title: typeof c.attrs?.['title'] === 'string' ? c.attrs['title'] : '',
        policy: typeof c.attrs?.['policy'] === 'string' ? c.attrs['policy'] : 'inherit',
      });
  return out;
}

/** The region node with identifier `id` among the children of the body, or null. */
export function regionNodeOf(doc: JsonNode, id: string): JsonNode | null {
  const top = (doc as { content?: Array<{ content?: unknown[] }> }).content;
  const body = top?.[top.length - 1];
  for (const c of (body?.content ?? []) as Array<{ type: string; attrs?: Record<string, unknown> }>)
    if (c.type === 'region' && c.attrs?.['id'] === id) return c as unknown as JsonNode;
  return null;
}

const SUGGESTION_MARKS = new Set(['ins', 'del', 'fmt']);

/** Whether the content has unresolved suggestions (05 §6.2 exports: `pending_suggestions`). */
export function hasSuggestions(node: unknown): boolean {
  const stack: unknown[] = [node];
  while (stack.length) {
    const n = stack.pop() as { marks?: Array<{ type?: string }>; content?: unknown[] } | null;
    if (!n || typeof n !== 'object') continue;
    if (n.marks?.some((m) => m && SUGGESTION_MARKS.has(String(m.type)))) return true;
    if (Array.isArray(n.content)) stack.push(...n.content);
  }
  return false;
}

export class ContentReader {
  readonly #o: ContentReaderOptions;
  readonly #rebuilt: Lru<Rebuilt>;
  readonly #responses: Lru<ContentRead>;
  /** Replays run in workers, for the tests of BE-001 criterion 3. */
  replays = 0;

  constructor(opts: ContentReaderOptions) {
    this.#o = opts;
    this.#rebuilt = new Lru(opts.rebuiltEntries);
    this.#responses = new Lru(opts.responseEntries);
  }

  /**
   * The content of `ref` at `seq` (default the head) as `conn` may see it; `conn` null is a
   * service credential. Not found: the document is missing or deleted, or `seq` is above the head.
   */
  async read(ref: DocRef, opts: { seq?: number; conn: Connection | null }): Promise<ContentRead> {
    const record = await this.#o.documents.get(ref);
    if (!record || record.deletedAt !== null)
      throw new ApiError('not_found', `no document ${ref.doc}`);
    const head = await this.#o.logs.head(ref);
    const seq = opts.seq ?? head.seq;
    if (seq > head.seq)
      throw new ApiError('not_found', `no content at seq ${seq}; the head is ${head.seq}`);
    // The class comes from the permission data in storage now, never from a cache (S12 change 3).
    const perms = await this.#o.grants.current(ref);
    const full = await this.rebuild(ref, head.incarnation, seq);
    const view: ReaderView = readerView(this.#o.views, opts.conn, full.doc, perms);
    const key = `${ref.tenant}/${ref.doc}/${head.incarnation}/${seq}/${view.token}/${perms.revision}`;
    const cached = this.#responses.get(key);
    if (cached) return cached;
    const doc = projectContent(view, full.doc);
    const body = {
      seq,
      incarnation: head.incarnation,
      cdm: full.cdm,
      requires: full.requires,
      doc,
      view: view.token,
    };
    const read: ContentRead = {
      ...body,
      bytes: Buffer.from(canonicalize(body), 'utf8'),
      etag: `"${head.incarnation}.${seq}.${view.token}"`,
      revision: perms.revision,
    };
    this.#responses.set(key, read);
    return read;
  }

  /**
   * The commits from `from` to `to` for a rebuild. A payload that is not in the log table (thinned,
   * or moved to a cold segment; HIS-032 criterion 4) is answered as `not_found`, with the reason, so
   * the rebuild does not fail as an internal error.
   */
  async #readCommits(ref: DocRef, from: number, to: number): Promise<LogCommit[]> {
    try {
      return await this.#o.logs.read(ref, from, to);
    } catch (e) {
      if (e instanceof PayloadAbsentError)
        throw new ApiError(
          'not_found',
          `the detail of seq ${e.seq} of ${ref.doc} is no longer available (its payload was thinned or moved; 08 §11)`,
        );
      throw e;
    }
  }

  /** The full content at `seq` (no projection): for checks inside the service only. */
  async rebuild(ref: DocRef, incarnation: string, seq: number): Promise<Rebuilt> {
    const base = `${ref.tenant}/${ref.doc}/${incarnation}/`;
    const hit = this.#rebuilt.get(base + seq);
    if (hit) return hit;
    // Start from the newest rebuilt content or checkpoint at or before `seq`.
    let from: Rebuilt | null = null;
    for (const k of this.#rebuilt.keys()) {
      if (!k.startsWith(base)) continue;
      const s = Number(k.slice(base.length));
      if (s <= seq && (!from || s > from.seq)) from = this.#rebuilt.get(k) ?? null;
    }
    if (!from) {
      const cp = await this.#o.checkpoints.latest(ref, seq);
      if (!cp) throw new ApiError('internal', `document ${ref.doc} has no content at seq 0`);
      from = {
        seq: cp.seq,
        doc: cp.content.doc as JsonNode,
        cdm: cp.content.cdm,
        requires: [...cp.content.requires],
      };
    }
    let out = from;
    if (from.seq < seq) {
      const commits = await this.#readCommits(ref, from.seq + 1, seq);
      if (commits.length !== seq - from.seq || commits.some((c, i) => c.seq !== from.seq + 1 + i))
        throw new ApiError('internal', `the log of ${ref.doc} has a gap below seq ${seq}`);
      // A snapshot commit replaces the content (04 §3.2; BE-037): never replay across one, start
      // again from its content, which the data plane writes as the checkpoint at its seq.
      let start = from;
      let rest = commits;
      let last = -1;
      commits.forEach((c, i) => {
        if (c.kind === 'snapshot') last = i;
      });
      if (last >= 0) {
        const s = commits[last]!.seq;
        const env =
          (await this.#o.checkpoints.get(ref, s)) ??
          (await this.#o.logs.snapshotContent?.(ref, s)) ??
          null;
        if (!env)
          throw new ApiError(
            'internal',
            `the content of snapshot commit ${s} of ${ref.doc} is missing`,
          );
        start = { seq: s, doc: env.doc as JsonNode, cdm: env.cdm, requires: [...env.requires] };
        rest = commits.slice(last + 1);
      }
      out = start;
      // The replay worker holds the CDM 1 schema and the `pm-steps/1` engine only. A steps commit
      // made under another engine or CDM major version has no replayer here, so it is refused
      // rather than replayed with the wrong one (HIS-005 criterion 5; 05 §6.2).
      for (const c of rest)
        if (c.kind === 'steps' && (c.engine !== ENGINE || c.cdm !== 1))
          throw new ApiError(
            'internal',
            `no replayer for engine ${c.engine} and CDM ${c.cdm} (commit ${c.seq} of ${ref.doc})`,
          );
      if (rest.length) {
        this.replays++;
        const r = await this.#o.pool.run<{ doc: JsonNode }>('materialise', {
          doc: start.doc,
          commits: rest.map((c) => c.steps),
        });
        out = { seq, doc: r.doc, cdm: start.cdm, requires: start.requires };
      }
    }
    this.#rebuilt.set(base + seq, out);
    return out;
  }
}
