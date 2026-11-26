/**
 * The proofing controller (UX-041, UX-042; 13 section 6.1), the code the core loads when proofing is
 * first used (UX-070 criterion 2). Its types and constants stay in `proofing.ts`, which the core
 * imports at start; the contract of the controller is described there.
 */
import type { CancelSignal, ProofingBlock } from '@docedit/protocol';
import type { Node as PMNode } from 'prosemirror-model';
import {
  DEFAULT_DEBOUNCE_MS,
  UNDETERMINED,
  supportsDictionary,
  type BlockSnapshot,
  type DictionaryEntry,
  type DictionaryScope,
  type LocatedFinding,
  type ProofingClock,
  type ProofingFindingInfo,
  type ProofingHost,
  type ProofingInfo,
  type ProofingPort,
  type ProofingState,
} from './proofing.ts';
import { regionAt } from './regions.ts';

/**
 * The blocks of the body that can be proofed: each textblock with an identifier, in a body scope
 * (`body` or a region). The language is the one over most of the text: a `lang` mark's value, or
 * the document default where no mark covers the text, or `und`. A block whose text does not line up
 * with its positions (an inline node that is not one position wide) is left out.
 */
export function proofingBlocks(doc: PMNode, fallback: string | null): BlockSnapshot[] {
  const out: BlockSnapshot[] = [];
  const body = doc.lastChild;
  if (!body || body.type.name !== 'body') return out;
  const bodyStart = doc.content.size - body.nodeSize + 1;
  body.descendants((node, offset) => {
    if (!node.isTextblock) return true;
    const id = node.attrs['id'];
    if (typeof id === 'string' && node.content.size > 0) {
      const pos = bodyStart + offset;
      const text = node.textBetween(0, node.content.size, undefined, ' ');
      if (text.length === node.content.size) {
        const region = regionAt(doc.resolve(pos + 1));
        out.push({
          id,
          scope: region?.id ? `region:${region.id}` : 'body',
          text,
          lang: languageOf(node, fallback),
          start: pos + 1,
        });
      }
    }
    return false;
  });
  return out;
}

function languageOf(block: PMNode, fallback: string | null): string {
  const counts = new Map<string, number>();
  block.forEach((child) => {
    const mark = child.marks.find((m) => m.type.name === 'lang');
    const value = mark ? mark.attrs['value'] : null;
    const lang = typeof value === 'string' && value.trim() !== '' ? value.trim() : (fallback ?? '');
    counts.set(lang, (counts.get(lang) ?? 0) + child.nodeSize);
  });
  let best = '';
  let most = -1;
  for (const [lang, n] of counts)
    if (n > most) {
      best = lang;
      most = n;
    }
  return best === '' ? UNDETERMINED : best;
}

class Cancel implements CancelSignal {
  cancelled = false;
  readonly #callbacks = new Set<() => void>();

  onCancel(cb: () => void): () => void {
    if (this.cancelled) {
      cb();
      return () => {};
    }
    this.#callbacks.add(cb);
    return () => {
      this.#callbacks.delete(cb);
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const cb of this.#callbacks) cb();
    this.#callbacks.clear();
  }
}

interface Entry {
  readonly text: string;
  readonly lang: string;
  readonly findings: readonly RawFinding[];
}

interface RawFinding {
  readonly from: number;
  readonly to: number;
  readonly kind: string;
  readonly message: string;
  readonly suggestions: readonly string[];
}

export interface ProofingOptions {
  readonly clock: ProofingClock;
  readonly debounceMs?: number;
}

export class ProofingController {
  readonly #host: ProofingHost;
  readonly #port: ProofingPort;
  readonly #clock: ProofingClock;
  readonly #debounceMs: number;
  readonly #entries = new Map<string, Entry>();
  readonly #ignoredOnce = new Set<string>();
  readonly #ignoredEverywhere = new Set<string>();
  #timer: unknown = null;
  #run: Cancel | null = null;
  #state: ProofingState = 'idle';
  #omitted = 0;
  #version = 0;
  #currentId: string | null = null;
  #cache: { doc: PMNode; version: number; found: LocatedFinding[] } | null = null;
  #disposed = false;

  constructor(host: ProofingHost, port: ProofingPort, options: ProofingOptions) {
    this.#host = host;
    this.#port = port;
    this.#clock = options.clock;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  get state(): ProofingState {
    return this.#state;
  }

  get omitted(): number {
    return this.#omitted;
  }

  get dictionary(): boolean {
    return supportsDictionary(this.#port);
  }

  /** Checks the whole body now (the document has opened). */
  start(): void {
    this.#check(false);
  }

  /** The text may have changed: checks the changed blocks after a pause in typing. */
  textChanged(): void {
    if (this.#disposed) return;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#check(false);
    }, this.#debounceMs);
  }

  /** The access or the scopes changed: what is shown and what is sent follow at once. */
  accessChanged(): void {
    this.#version++;
    this.#check(false);
    this.#host.changed();
  }

  /** Forgets every result and checks the body again (the dictionary or a language changed). */
  recheck(): void {
    this.#entries.clear();
    this.#version++;
    this.#check(true);
    this.#host.changed();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#run?.cancel();
    this.#run = null;
  }

  #check(force: boolean): void {
    if (this.#disposed) return;
    const doc = this.#host.doc();
    const send: BlockSnapshot[] = [];
    const present = new Set<string>();
    let omitted = 0;
    for (const b of proofingBlocks(doc, this.#host.defaultLang())) {
      present.add(b.id);
      if (!this.#host.canView(b.scope)) {
        omitted++;
        continue;
      }
      const e = this.#entries.get(b.id);
      if (!force && e && e.text === b.text && e.lang === b.lang) continue;
      send.push(b);
    }
    for (const id of [...this.#entries.keys()]) if (!present.has(id)) this.#entries.delete(id);
    this.#omitted = omitted;
    if (send.length === 0) {
      this.#set('idle');
      return;
    }
    this.#run?.cancel();
    const run = new Cancel();
    this.#run = run;
    this.#set('checking');
    const blocks: ProofingBlock[] = send.map((b) => ({
      blockId: b.id,
      scope: b.scope,
      text: b.text,
      lang: b.lang,
    }));
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(
        this.#port.check({ docId: this.#host.docId(), blocks }, { signal: run }),
      );
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending.then(
      (found) => {
        if (run.cancelled || this.#disposed) return;
        this.#run = null;
        this.#store(send, found);
        this.#set('idle');
      },
      () => {
        if (run.cancelled || this.#disposed) return;
        this.#run = null;
        this.#set('unavailable');
      },
    );
  }

  #store(sent: readonly BlockSnapshot[], found: unknown): void {
    const byBlock = new Map<string, RawFinding[]>();
    if (Array.isArray(found)) {
      const lengths = new Map(sent.map((b) => [b.id, b.text.length]));
      for (const raw of found as unknown[]) {
        const f = rawFinding(raw, lengths);
        if (f === null) continue;
        const list = byBlock.get(f.blockId) ?? [];
        list.push(f.finding);
        byBlock.set(f.blockId, list);
      }
    }
    for (const b of sent)
      this.#entries.set(b.id, { text: b.text, lang: b.lang, findings: byBlock.get(b.id) ?? [] });
    this.#version++;
  }

  #set(state: ProofingState): void {
    this.#state = state;
    this.#host.changed();
  }

  /**
   * The findings that hold for the current document: those computed for the text a block has now,
   * in the scopes the reader may view, less those the author ignored. In document order.
   */
  locate(): readonly LocatedFinding[] {
    const doc = this.#host.doc();
    const cache = this.#cache;
    if (cache && cache.doc === doc && cache.version === this.#version) return cache.found;
    const found: LocatedFinding[] = [];
    for (const b of proofingBlocks(doc, this.#host.defaultLang())) {
      const e = this.#entries.get(b.id);
      if (!e || e.text !== b.text || e.lang !== b.lang) continue;
      if (!this.#host.canView(b.scope)) continue;
      for (const f of e.findings) {
        const text = b.text.slice(f.from, f.to);
        if (this.#ignoredOnce.has(onceKey(b.id, f, text))) continue;
        if (this.#ignoredEverywhere.has(everywhereKey(b.lang, text))) continue;
        found.push({
          id: `${b.id}:${String(f.from)}:${String(f.to)}:${f.kind}`,
          blockId: b.id,
          scope: b.scope,
          kind: f.kind,
          message: f.message,
          suggestions: f.suggestions,
          text,
          lang: b.lang,
          from: b.start + f.from,
          to: b.start + f.to,
        });
      }
    }
    found.sort((a, b) => a.from - b.from || a.to - b.to);
    this.#cache = { doc, version: this.#version, found };
    return found;
  }

  find(id: string): LocatedFinding | null {
    return this.locate().find((f) => f.id === id) ?? null;
  }

  /** The finding with this identifier as the interface reads it, while it is shown; null otherwise. */
  infoOf(id: string): ProofingFindingInfo | null {
    return asInfo(this.find(id));
  }

  /** The finding that holds `pos`, the first when several do. */
  at(pos: number): LocatedFinding | null {
    return this.locate().find((f) => pos >= f.from && pos <= f.to) ?? null;
  }

  /**
   * The next finding after `pos` (at `pos` too when `inclusive`) or the previous one before it,
   * wrapping at the ends; null when
   * there is none. It becomes the current finding.
   */
  step(pos: number, direction: 1 | -1, inclusive = false): LocatedFinding | null {
    const all = this.locate();
    if (all.length === 0) return null;
    let chosen: LocatedFinding | undefined;
    if (direction === 1)
      chosen = all.find((f) => (inclusive ? f.from >= pos : f.from > pos)) ?? all[0];
    else chosen = [...all].reverse().find((f) => f.from < pos) ?? all[all.length - 1];
    this.#currentId = chosen?.id ?? null;
    this.#host.changed();
    return chosen ?? null;
  }

  /** The id of the finding the last navigation chose, while it is still shown. */
  currentId(): string | null {
    const id = this.#currentId;
    return id !== null && this.locate().some((f) => f.id === id) ? id : null;
  }

  /** Hides one occurrence. It returns when the block's text changes or the document is reopened. */
  ignoreOnce(id: string): boolean {
    const f = this.find(id);
    if (!f) return false;
    const e = this.#entries.get(f.blockId);
    const raw = e?.findings.find(
      (r) => `${f.blockId}:${String(r.from)}:${String(r.to)}:${r.kind}` === id,
    );
    if (!raw) return false;
    this.#ignoredOnce.add(onceKey(f.blockId, raw, f.text));
    this.#version++;
    this.#host.changed();
    return true;
  }

  /** Hides every finding for this text in this language, for the session. */
  ignoreEverywhere(id: string): boolean {
    const f = this.find(id);
    if (!f) return false;
    this.#ignoredEverywhere.add(everywhereKey(f.lang, f.text));
    this.#version++;
    this.#host.changed();
    return true;
  }

  /** Adds the finding's text to the port's custom dictionary, then checks again. */
  addToDictionary(id: string): Promise<boolean> {
    const f = this.find(id);
    return f ? this.addWord(f.text, f.lang) : Promise.resolve(false);
  }

  /** Adds a word to a custom dictionary, the person's or the tenant's, then checks again. */
  addWord(word: string, lang: string, scope?: DictionaryScope): Promise<boolean> {
    return this.#change(scope, () => this.#port.addWord(word, lang, scope ? { scope } : undefined));
  }

  async words(lang: string): Promise<DictionaryEntry[] | null> {
    if (!this.dictionary || this.#port.listWords === undefined) return null;
    try {
      return await this.#port.listWords(lang);
    } catch {
      return null;
    }
  }

  removeWord(word: string, lang: string, scope?: DictionaryScope): Promise<boolean> {
    return this.#change(scope, () =>
      this.#port.removeWord!(word, lang, scope ? { scope } : undefined),
    );
  }

  /**
   * A change to a dictionary, then a new check. A port that fails is unavailable; a refusal of the
   * tenant's list (only an administrator changes it) says nothing about the port.
   */
  async #change(scope: DictionaryScope | undefined, call: () => Promise<void>): Promise<boolean> {
    if (!this.dictionary) return false;
    try {
      await call();
    } catch {
      if (scope !== 'tenant') this.#set('unavailable');
      return false;
    }
    this.recheck();
    return true;
  }
  info(selectionHead: number): ProofingInfo {
    const found = this.locate();
    const current = this.currentId();
    const caret = this.at(selectionHead);
    return {
      available: true,
      state: this.#state,
      count: found.length,
      omitted: this.#omitted,
      dictionary: this.dictionary,
      current: asInfo(current === null ? null : (found.find((f) => f.id === current) ?? null)),
      atCaret: asInfo(caret),
      version: this.#version,
    };
  }
}

function asInfo(f: LocatedFinding | null): ProofingFindingInfo | null {
  return f === null
    ? null
    : {
        id: f.id,
        kind: f.kind,
        message: f.message,
        text: f.text,
        suggestions: f.suggestions,
        scope: f.scope,
        lang: f.lang,
      };
}

function onceKey(blockId: string, f: { from: number; to: number }, text: string): string {
  return `${blockId}\u0000${String(f.from)}\u0000${String(f.to)}\u0000${text}`;
}

function everywhereKey(lang: string, text: string): string {
  return `${lang}\u0000${text.toLowerCase()}`;
}

/** Reads one finding of the port's answer, or null when it does not hold together. */
function rawFinding(
  raw: unknown,
  lengths: ReadonlyMap<string, number>,
): { blockId: string; finding: RawFinding } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const blockId = r['blockId'];
  const from = r['from'];
  const to = r['to'];
  if (typeof blockId !== 'string' || typeof from !== 'number' || typeof to !== 'number')
    return null;
  const length = lengths.get(blockId);
  if (length === undefined) return null;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > length)
    return null;
  const suggestions = Array.isArray(r['suggestions'])
    ? (r['suggestions'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  return {
    blockId,
    finding: {
      from,
      to,
      kind: typeof r['kind'] === 'string' ? r['kind'] : 'spelling',
      message: typeof r['message'] === 'string' ? r['message'] : '',
      suggestions,
    },
  };
}
