/**
 * The range-based document API for extensions (UX-053; 13 §7.1; ADR 0234 part B, proposed). The
 * public types are in `extension-api-types.ts` and name no ProseMirror type. This module is the
 * implementation: the core builds one per extension through `DocumentCore.extensionApi`.
 *
 * - Ranges are handles the API holds and maps through every transaction the core applies, local or
 *   remote, with the steps' own maps. A range is `stale` once a change touched the content inside it.
 *   A write through a stale or detached range, or one whose text is no longer what it was, gives
 *   `conflict` and changes nothing: a write never lands on a range that moved under it (B2).
 * - Writes are built as an ordinary transaction and given to the core's dispatch, so they meet the
 *   region guard, the lock, the identifier plugin and, in suggestion mode, the recording of the
 *   change as suggestions, exactly as typing does. A scope the user may not change is refused first
 *   with `permission_denied`.
 * - Events are delivered by `later`, never inside the transaction. The transaction only marks that
 *   something happened. The comparison with the document of the last delivery runs inside the
 *   delivery, and only for the kinds of event somebody subscribed to. Changes before one delivery
 *   are reported together (a block added and deleted before it is reported as neither).
 * - Nothing here creates a position of its own: a read says what is in a range now, from scopes the
 *   reader may view (ADR 0019). A hidden scope gives no text, no block and no identifier.
 *
 * Cost: mapping is one pass over the held ranges per step (at most `maxRanges`). The comparison of
 * blocks and suggestions is one pass over the document per delivery. No measurement has been taken.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { canonicalize, utf8 } from '@docedit/model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { CdmFragment } from './cdm-fragment.ts';
import type { InsertResult } from './api.ts';
import { REMOTE } from './meta.ts';
import { nextFrame } from './read-value.ts';
import type {
  ExtBlock,
  ExtBlockChange,
  ExtBlockDraft,
  ExtBlockResult,
  ExtComment,
  ExtEventMap,
  ExtEventName,
  ExtInlineDraft,
  ExtInlineResult,
  ExtMarkRun,
  ExtOrigin,
  ExtRange,
  ExtRangeState,
  ExtSuggestion,
  ExtWriteResult,
  ExtensionApiOptions,
  ExtensionDocumentApi,
} from './extension-api-types.ts';

/** What the API needs of the core. Nothing of it reaches an extension. */
export interface ExtensionApiHost {
  state(): EditorState;
  /** The confirmed `seq` (04 §7). */
  seq(): number;
  /** Whether the reader may view the scope of the position `pos` of `doc` (ADR 0019). */
  canView(doc: PMNode, pos: number): boolean;
  /** Whether the user may change the scope of the position `pos` of `doc`, and the document is not locked. */
  canEdit(doc: PMNode, pos: number): boolean;
  /** Applies a transaction through the guards and suggestion mode; returns whether the document changed and why not. */
  dispatch(tr: Transaction): { readonly changed: boolean; readonly refusal: string | null };
  /** Inserts a fragment in place of `from` to `to` through the guards (the core's `insertContent` for a range). */
  insertFragment(fragment: CdmFragment, from: number, to: number): InsertResult;
  /** The client's copy of each thread's range, mapped through every change. */
  /** A fresh node identifier (03 §9). */
  newId(): string;
  /** Adds a feature to this copy's `requires`, as the room does when the first block of a kind arrives (03 §11.1). */
  requireFeature(feature: string): void;
  /** Called once when the API is disposed. */
  disposed?(): void;
  threads(): readonly {
    readonly id: string;
    readonly from: number;
    readonly to: number;
    readonly detached: boolean;
  }[];
}

interface Entry {
  from: number;
  to: number;
  /** The text of the range when it was made, to check that a write lands on the same content. */
  readonly text: string;
  stale: boolean;
  detached: boolean;
}

type Handler = (event: never) => void;

const SUGGESTION_MARKS = new Set(['ins', 'del', 'fmt']);
/** Marks an extension may not set: they carry other people's suggestions or the preservation layer. */
const PROTECTED_MARKS = new Set(['ins', 'del', 'fmt', 'preserved']);

type Kind = 'blocks' | 'suggestions' | 'comments' | 'selection';

const kindOf = (event: ExtEventName): Kind =>
  event.startsWith('blocks.') ? 'blocks' : (event.split('.')[0] as Kind);

export class ExtensionApi implements ExtensionDocumentApi {
  readonly #host: ExtensionApiHost;
  readonly #options: ExtensionApiOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #handlers = new Map<ExtEventName, Set<Handler>>();
  #nextRange = 0;
  #disposed = false;

  // Delivery state.
  #scheduled = false;
  #sawLocal = false;
  #sawRemote = false;
  #lastSeq = 0;
  #noted = new Set<string>();
  #blocks: Map<string, PMNode> | null = null;
  #suggestions: Map<string, string> | null = null;
  #comments: Map<string, boolean> | null = null;
  #selection: { anchor: number; head: number } | null = null;

  constructor(host: ExtensionApiHost, options: ExtensionApiOptions) {
    if (!Number.isInteger(options.maxRanges) || options.maxRanges < 1)
      throw new RangeError('maxRanges must be a positive integer');
    this.#host = host;
    this.#options = options;
  }

  // --- Ranges --------------------------------------------------------------------------------

  range(from: number, to: number): ExtRange {
    this.#assertLive();
    const doc = this.#host.state().doc;
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from ||
      to > doc.content.size
    )
      throw new RangeError(`the range ${from} to ${to} is not in the document`);
    if (this.#entries.size >= this.#options.maxRanges)
      throw new RangeError(`the API already holds ${this.#options.maxRanges} ranges`);
    const id = `r${++this.#nextRange}`;
    this.#entries.set(id, {
      from,
      to,
      text: rawText(doc, from, to),
      stale: false,
      detached: false,
    });
    return { id, from, to };
  }

  selection(): ExtRange {
    const { from, to } = this.#host.state().selection;
    return this.range(from, to);
  }

  current(range: ExtRange): ExtRangeState | null {
    const e = this.#entries.get(range.id);
    return e ? { from: e.from, to: e.to, stale: e.stale, detached: e.detached } : null;
  }

  release(range: ExtRange): void {
    this.#entries.delete(range.id);
  }

  // --- Reads ---------------------------------------------------------------------------------

  blocks(range: ExtRange): readonly ExtBlock[] {
    const e = this.#entries.get(range.id);
    if (!e) return [];
    const doc = this.#host.state().doc;
    const out: ExtBlock[] = [];
    doc.nodesBetween(e.from, e.to, (node, pos) => {
      if (node.type.name === 'defs') return false;
      const id = node.attrs['id'];
      if (!node.isBlock || typeof id !== 'string') return true;
      if (!this.#host.canView(doc, pos)) return false;
      out.push({
        id,
        type: node.type.name,
        from: pos,
        to: pos + node.nodeSize,
        text: this.#visibleText(doc, pos, pos + node.nodeSize),
      });
      return true;
    });
    return out;
  }

  text(range: ExtRange): string {
    const e = this.#entries.get(range.id);
    return e ? this.#visibleText(this.#host.state().doc, e.from, e.to) : '';
  }

  marks(range: ExtRange): readonly ExtMarkRun[] {
    const e = this.#entries.get(range.id);
    if (!e) return [];
    const doc = this.#host.state().doc;
    const out: ExtMarkRun[] = [];
    doc.nodesBetween(e.from, e.to, (node, pos) => {
      if (node.type.name === 'defs') return false;
      if (!node.isInline || node.marks.length === 0) return true;
      if (!this.#host.canView(doc, pos)) return false;
      out.push({
        from: Math.max(pos, e.from),
        to: Math.min(pos + node.nodeSize, e.to),
        marks: node.marks.map((m) => ({ type: m.type.name, attrs: plain(m.attrs) })),
      });
      return true;
    });
    return out;
  }

  comments(range: ExtRange): readonly ExtComment[] {
    const e = this.#entries.get(range.id);
    if (!e) return [];
    const doc = this.#host.state().doc;
    return this.#host
      .threads()
      .filter(
        (t) =>
          this.#host.canView(doc, Math.min(t.from, doc.content.size)) &&
          (t.from === t.to
            ? t.from >= e.from && t.from <= e.to
            : t.from < Math.max(e.to, e.from + 1) && t.to > e.from),
      )
      .map((t) => ({ id: t.id, detached: t.detached }));
  }

  suggestions(range: ExtRange): readonly ExtSuggestion[] {
    const e = this.#entries.get(range.id);
    if (!e) return [];
    const doc = this.#host.state().doc;
    const found = new Map<string, ExtSuggestion>();
    doc.nodesBetween(e.from, e.to, (node, pos) => {
      if (node.type.name === 'defs') return false;
      if (!node.isInline) return true;
      if (!this.#host.canView(doc, pos)) return false;
      for (const m of node.marks) {
        if (!SUGGESTION_MARKS.has(m.type.name)) continue;
        const id = String(m.attrs['id']);
        if (!found.has(id))
          found.set(id, {
            id,
            kind: m.type.name as ExtSuggestion['kind'],
            author: typeof m.attrs['user'] === 'string' ? m.attrs['user'] : null,
          });
      }
      return true;
    });
    return [...found.values()];
  }

  // --- Writes --------------------------------------------------------------------------------

  insertBlocks(at: ExtRange, content: CdmFragment): ExtWriteResult {
    const held = this.#writable(at);
    if ('ok' in held) return held;
    const result = this.#host.insertFragment(content, held.from, held.to);
    if (result.ok) return { ok: true };
    return {
      ok: false,
      reason:
        result.reason === 'unsupported'
          ? 'unsupported'
          : result.reason === 'invalid'
            ? 'invalid'
            : 'refused',
      message: result.message,
    };
  }

  replaceRange(range: ExtRange, text: string): ExtWriteResult {
    if (typeof text !== 'string')
      return { ok: false, reason: 'invalid', message: 'the text is not a string' };
    const held = this.#writable(range);
    if ('ok' in held) return held;
    const state = this.#host.state();
    if (text === '' && held.from === held.to) return { ok: true };
    return this.#apply(
      text === ''
        ? state.tr.delete(held.from, held.to)
        : state.tr.insertText(text, held.from, held.to),
    );
  }

  deleteRange(range: ExtRange): ExtWriteResult {
    const held = this.#writable(range);
    if ('ok' in held) return held;
    if (held.from === held.to) return { ok: true };
    return this.#apply(this.#host.state().tr.delete(held.from, held.to));
  }

  setMark(
    range: ExtRange,
    type: string,
    attrs: Readonly<Record<string, unknown>> = {},
  ): ExtWriteResult {
    const held = this.#writable(range);
    if ('ok' in held) return held;
    const state = this.#host.state();
    const markType = state.schema.marks[type];
    if (!markType || PROTECTED_MARKS.has(type))
      return { ok: false, reason: 'invalid', message: `the mark "${type}" cannot be set` };
    if (held.from === held.to) return { ok: true };
    let mark: Mark;
    try {
      mark = markType.create({ ...attrs });
    } catch (error) {
      return { ok: false, reason: 'invalid', message: describe(error) };
    }
    return this.#apply(state.tr.addMark(held.from, held.to, mark));
  }

  insertExtensionBlock(at: ExtRange, draft: ExtBlockDraft): ExtBlockResult {
    const problem = checkBlock(
      draft.extension,
      draft.payload,
      draft.fallbackAsset,
      draft.fallbackText,
    );
    if (problem) return problem;
    const held = this.#writable(at);
    if ('ok' in held) return held as ExtBlockResult;
    const state = this.#host.state();
    const type = state.schema.nodes['extension_block'];
    if (!type)
      return { ok: false, reason: 'unsupported', message: 'this build has no custom blocks' };
    const id = this.#host.newId();
    let node: PMNode;
    try {
      node = type.create({
        id,
        extension: draft.extension,
        payload: draft.payload ?? null,
        fallbackAsset: blank(draft.fallbackAsset) ? null : draft.fallbackAsset,
        fallbackText: blank(draft.fallbackText) ? null : draft.fallbackText,
      });
    } catch (error) {
      return { ok: false, reason: 'invalid', message: describe(error) };
    }
    const result = this.#apply(state.tr.replaceRangeWith(held.from, held.to, node));
    if (!result.ok) return result;
    // The room adds `extensions` to `requires` with the first block (03 §11.1); this copy follows.
    this.#host.requireFeature('extensions');
    return { ok: true, id };
  }

  insertExtensionInline(at: ExtRange, draft: ExtInlineDraft): ExtInlineResult {
    const problem = checkBlock(
      draft.extension,
      draft.payload,
      null,
      draft.fallbackText,
      INLINE_PAYLOAD_LIMIT_BYTES,
      'the inline content needs fallback text',
    );
    if (problem) return problem;
    const held = this.#writable(at);
    if ('ok' in held) return held;
    const state = this.#host.state();
    const type = state.schema.nodes['extension_inline'];
    if (!type)
      return { ok: false, reason: 'unsupported', message: 'this build has no inline custom content' };
    let node: PMNode;
    try {
      node = type.create({
        extension: draft.extension,
        payload: draft.payload ?? null,
        fallbackText: draft.fallbackText,
      });
    } catch (error) {
      return { ok: false, reason: 'invalid', message: describe(error) };
    }
    const result = this.#apply(state.tr.replaceRangeWith(held.from, held.to, node));
    if (!result.ok) return result;
    // As for a block: the room adds `extensions` to `requires` with the first node (03 §11.1).
    this.#host.requireFeature('extensions');
    return { ok: true };
  }

  updateExtensionBlock(id: string, change: ExtBlockChange): ExtBlockResult {
    if (this.#disposed) return { ok: false, reason: 'invalid', message: 'the API was disposed' };
    const state = this.#host.state();
    let found: { node: PMNode; pos: number } | null = null;
    state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type.name === 'extension_block' && node.attrs['id'] === id) found = { node, pos };
      return found === null;
    });
    const hit = found as { node: PMNode; pos: number } | null;
    if (!hit || !this.#host.canView(state.doc, hit.pos))
      return { ok: false, reason: 'invalid', message: 'there is no such custom block' };
    const attrs = hit.node.attrs;
    const next = {
      payload: 'payload' in change ? change.payload : attrs['payload'],
      fallbackAsset: 'fallbackAsset' in change ? change.fallbackAsset : attrs['fallbackAsset'],
      fallbackText: 'fallbackText' in change ? change.fallbackText : attrs['fallbackText'],
    };
    const problem = checkBlock(
      String(attrs['extension']),
      next.payload,
      next.fallbackAsset as string | null | undefined,
      next.fallbackText as string | null | undefined,
    );
    if (problem) return problem;
    if (!this.#host.canEdit(state.doc, hit.pos))
      return {
        ok: false,
        reason: 'permission_denied',
        message: 'the user may not change this part of the document',
      };
    const tr = state.tr;
    for (const key of ['payload', 'fallbackAsset', 'fallbackText'] as const) {
      if (!(key in change)) continue;
      const value =
        key === 'payload' ? (change.payload ?? null) : blank(change[key]) ? null : change[key];
      tr.setNodeAttribute(hit.pos, key, value);
    }
    if (!tr.docChanged) return { ok: true, id };
    const result = this.#apply(tr);
    return result.ok ? { ok: true, id } : result;
  }

  // --- Events --------------------------------------------------------------------------------

  on<E extends ExtEventName>(event: E, handler: (event: ExtEventMap[E]) => void): () => void {
    this.#assertLive();
    this.#baseline(kindOf(event));
    let set = this.#handlers.get(event);
    if (!set) this.#handlers.set(event, (set = new Set()));
    set.add(handler as Handler);
    return () => {
      const handlers = this.#handlers.get(event);
      if (!handlers?.delete(handler as Handler)) return;
      if (handlers.size === 0) this.#handlers.delete(event);
      this.#dropBaseline(kindOf(event));
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#entries.clear();
    this.#handlers.clear();
    this.#blocks = this.#suggestions = this.#comments = this.#selection = null;
    this.#host.disposed?.();
  }

  // --- Called by the core --------------------------------------------------------------------

  /**
   * One applied change, with every transaction it produced (the core calls this from its dispatch,
   * before the views). It maps the held ranges and marks that a delivery is due. It reads nothing
   * of the document beyond the step maps.
   */
  applied(transactions: readonly Transaction[], root: Transaction): void {
    if (this.#disposed) return;
    for (const t of transactions) {
      if (!t.docChanged) continue;
      for (const map of t.mapping.maps) this.#mapEntries(map);
    }
    if (root.getMeta(REMOTE) === true) this.#sawRemote = true;
    else this.#sawLocal = true;
    this.#lastSeq = this.#host.seq();
    this.#schedule();
  }

  /** A thread's range was set or removed by the service (FE-048). */
  commentNoted(id: string): void {
    if (this.#disposed || !this.#comments) return;
    this.#noted.add(id);
    this.#schedule();
  }

  // --- Mapping -------------------------------------------------------------------------------

  #mapEntries(map: {
    forEach(f: (oldStart: number, oldEnd: number, newStart: number, newEnd: number) => void): void;
    map(pos: number, assoc?: number): number;
  }): void {
    for (const e of this.#entries.values()) {
      if (!e.stale) {
        const collapsed = e.from === e.to;
        map.forEach((oldStart, oldEnd) => {
          if (
            collapsed ? oldStart <= e.from && e.from <= oldEnd : oldStart < e.to && oldEnd > e.from
          )
            e.stale = true;
        });
      }
      const was = e.from < e.to;
      const from = map.map(e.from, 1);
      const to = map.map(e.to, -1);
      if (to <= from) {
        // A range that covered text and now covers none lost its content; an empty one stays a point.
        e.from = e.to = from;
        if (was) e.detached = true;
      } else {
        e.from = from;
        e.to = to;
      }
    }
  }

  // --- Writes: shared steps ------------------------------------------------------------------

  /** The held range when a write may go on, else the result to give back. */
  #writable(range: ExtRange): { from: number; to: number } | ExtWriteResult {
    if (this.#disposed) return { ok: false, reason: 'invalid', message: 'the API was disposed' };
    const e = this.#entries.get(range.id);
    if (!e) return { ok: false, reason: 'invalid', message: 'the range is not held by this API' };
    const doc = this.#host.state().doc;
    if (e.stale || e.detached || rawText(doc, e.from, e.to) !== e.text)
      return {
        ok: false,
        reason: 'conflict',
        message: 'the content of the range changed since it was read; read it again',
      };
    if (!this.#host.canEdit(doc, e.from) || !this.#host.canEdit(doc, e.to))
      return {
        ok: false,
        reason: 'permission_denied',
        message: 'the user may not change this part of the document',
      };
    return { from: e.from, to: e.to };
  }

  #apply(tr: Transaction): ExtWriteResult {
    try {
      const outcome = this.#host.dispatch(tr);
      if (outcome.changed) return { ok: true };
      return {
        ok: false,
        reason: 'refused',
        message: outcome.refusal
          ? `the guard refused the change: ${outcome.refusal}`
          : 'the change did not apply',
      };
    } catch (error) {
      return { ok: false, reason: 'invalid', message: describe(error) };
    }
  }

  #visibleText(doc: PMNode, from: number, to: number): string {
    let out = '';
    let first = true;
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.type.name === 'defs') return false;
      if (node.isTextblock) {
        if (!this.#host.canView(doc, pos)) return false;
        if (!first) out += '\n';
        first = false;
        const start = Math.max(pos + 1, from);
        const end = Math.min(pos + node.nodeSize - 1, to);
        if (end > start) out += doc.textBetween(start, end, '', '￼');
        return false;
      }
      return true;
    });
    return out;
  }

  // --- Delivery ------------------------------------------------------------------------------

  #assertLive(): void {
    if (this.#disposed) throw new Error('the extension API was disposed');
  }

  #schedule(): void {
    if (this.#scheduled || this.#handlers.size === 0) return;
    this.#scheduled = true;
    (this.#options.later ?? nextFrame)(() => this.#deliver());
  }

  #baseline(kind: Kind): void {
    const state = this.#host.state();
    if (kind === 'blocks' && !this.#blocks) this.#blocks = this.#blockMap(state.doc);
    if (kind === 'suggestions' && !this.#suggestions)
      this.#suggestions = this.#suggestionMap(state.doc);
    if (kind === 'comments' && !this.#comments) this.#comments = this.#commentMap();
    if (kind === 'selection' && !this.#selection)
      this.#selection = { anchor: state.selection.anchor, head: state.selection.head };
  }

  #dropBaseline(kind: Kind): void {
    for (const name of this.#handlers.keys()) if (kindOf(name) === kind) return;
    if (kind === 'blocks') this.#blocks = null;
    if (kind === 'suggestions') this.#suggestions = null;
    if (kind === 'comments') this.#comments = null;
    if (kind === 'selection') this.#selection = null;
  }

  #deliver(): void {
    this.#scheduled = false;
    if (this.#disposed) return;
    const state = this.#host.state();
    const origin: ExtOrigin =
      this.#sawLocal && this.#sawRemote ? 'both' : this.#sawRemote ? 'remote' : 'local';
    const seq = this.#lastSeq;
    this.#sawLocal = this.#sawRemote = false;
    const noted = this.#noted;
    this.#noted = new Set();
    const send = <E extends ExtEventName>(
      name: E,
      payload: Omit<ExtEventMap[E], 'seq' | 'origin'>,
    ) => {
      const event = { ...payload, seq, origin } as unknown as ExtEventMap[E];
      for (const handler of [...(this.#handlers.get(name) ?? [])]) {
        try {
          (handler as (e: ExtEventMap[E]) => void)(event);
        } catch (error) {
          try {
            this.#options.onError?.(error, name);
          } catch {
            // An error sink that throws is ignored: delivery never reaches the editor.
          }
        }
      }
    };

    if (this.#blocks) {
      const next = this.#blockMap(state.doc);
      const added: string[] = [];
      const changed: string[] = [];
      const deleted: string[] = [];
      for (const [id, node] of next) {
        const was = this.#blocks.get(id);
        if (!was) added.push(id);
        else if (was !== node && !was.eq(node)) changed.push(id);
      }
      for (const id of this.#blocks.keys()) if (!next.has(id)) deleted.push(id);
      this.#blocks = next;
      if (added.length) send('blocks.added', { ids: added });
      if (changed.length) send('blocks.changed', { ids: changed });
      if (deleted.length) send('blocks.deleted', { ids: deleted });
    }
    if (this.#suggestions) {
      const next = this.#suggestionMap(state.doc);
      const ids = diffMaps(this.#suggestions, next);
      this.#suggestions = next;
      if (ids.length) send('suggestions.changed', { ids });
    }
    if (this.#comments) {
      const next = this.#commentMap();
      const ids = new Set(diffMaps(this.#comments, next));
      for (const id of noted) ids.add(id);
      this.#comments = next;
      if (ids.size) send('comments.changed', { ids: [...ids].sort() });
    }
    if (this.#selection) {
      const { anchor, head } = state.selection;
      if (anchor !== this.#selection.anchor || head !== this.#selection.head) {
        this.#selection = { anchor, head };
        send('selection.changed', { anchor, head });
      }
    }
  }

  /** Every block with an identifier that the reader may view, outside the definitions. */
  #blockMap(doc: PMNode): Map<string, PMNode> {
    const out = new Map<string, PMNode>();
    doc.descendants((node, pos) => {
      if (node.type.name === 'defs') return false;
      const id = node.attrs['id'];
      if (!node.isBlock || typeof id !== 'string') return true;
      if (!this.#host.canView(doc, pos)) return false;
      out.set(id, node);
      return true;
    });
    return out;
  }

  /** Each suggestion's signature: its kind, author and how much text it covers. */
  #suggestionMap(doc: PMNode): Map<string, string> {
    const sizes = new Map<string, { kind: string; user: string; size: number }>();
    doc.descendants((node, pos) => {
      if (node.type.name === 'defs') return false;
      if (!node.isInline) return true;
      const marks = node.marks.filter((m) => SUGGESTION_MARKS.has(m.type.name));
      if (marks.length === 0) return true;
      if (!this.#host.canView(doc, pos)) return false;
      for (const m of marks) {
        const id = String(m.attrs['id']);
        const entry = sizes.get(id) ?? {
          kind: m.type.name,
          user: String(m.attrs['user'] ?? ''),
          size: 0,
        };
        entry.size += node.nodeSize;
        sizes.set(id, entry);
      }
      return true;
    });
    return new Map([...sizes].map(([id, s]) => [id, `${s.kind}|${s.user}|${s.size}`]));
  }

  #commentMap(): Map<string, boolean> {
    const doc = this.#host.state().doc;
    const out = new Map<string, boolean>();
    for (const t of this.#host.threads())
      if (this.#host.canView(doc, Math.min(t.from, doc.content.size))) out.set(t.id, t.detached);
    return out;
  }
}

/** The most bytes a custom block's payload may hold: 16 KiB (03 §4.3; I12). */
const BLOCK_PAYLOAD_LIMIT_BYTES = 16384;
/** The model's limit for inline content (03 §4.4, CDM-002); the owner has not set another (decision 176). */
const INLINE_PAYLOAD_LIMIT_BYTES = 4096;

const blank = (v: string | null | undefined): boolean =>
  v === null || v === undefined || v.trim() === '';

/**
 * The checks that refuse a custom block before it is sent (UX-056 criteria 1 and 2): an extension
 * name, a payload that is JSON and at most 16 KiB (the canonical form's UTF-8 bytes, as the
 * authority measures it), and at least one fallback. Null when the block may go on.
 */
function checkBlock(
  extension: string,
  payload: unknown,
  asset: string | null | undefined,
  text: string | null | undefined,
  limit: number = BLOCK_PAYLOAD_LIMIT_BYTES,
  noFallback = 'the block needs a fallback picture or fallback text',
): {
  ok: false;
  reason: 'no_extension' | 'no_fallback' | 'payload_too_large' | 'payload_not_json';
  message: string;
} | null {
  if (typeof extension !== 'string' || extension.trim() === '')
    return { ok: false, reason: 'no_extension', message: 'the block has no extension identifier' };
  let bytes: number;
  try {
    const json = JSON.stringify(payload ?? null);
    if (json === undefined) throw new Error('no JSON form');
    bytes = utf8(canonicalize(JSON.parse(json))).length;
  } catch {
    return { ok: false, reason: 'payload_not_json', message: 'the payload is not JSON' };
  }
  if (blank(asset) && blank(text))
    return {
      ok: false,
      reason: 'no_fallback',
      message: noFallback,
    };
  if (bytes > limit)
    return {
      ok: false,
      reason: 'payload_too_large',
      message: `the payload is ${bytes} bytes; the limit is ${limit}`,
    };
  return null;
}

function rawText(doc: PMNode, from: number, to: number): string {
  return from === to ? '' : doc.textBetween(from, to, '\n', '￼');
}

function plain(attrs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(attrs)) as Record<string, unknown>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The keys added, removed or with another value, sorted. */
function diffMaps<V>(before: ReadonlyMap<string, V>, after: ReadonlyMap<string, V>): string[] {
  const ids: string[] = [];
  for (const [id, v] of after) if (!before.has(id) || before.get(id) !== v) ids.push(id);
  for (const id of before.keys()) if (!after.has(id)) ids.push(id);
  return ids.sort();
}
