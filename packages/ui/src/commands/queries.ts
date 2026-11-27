/**
 * Query sources for the registry (13 §4: `enabled` and `active` name queries on the document API).
 *
 * The core's source asks `CoreApi.query`. A core that does not offer `query` yet (the spike core)
 * is answered from its read-only views where they carry the answer: the marks for `isBold` and
 * `isItalic`, the access for `canEditSelection`. Anything else stays unanswered, which leaves the
 * command enabled; running it then reports `no-effect`.
 *
 * The queries of phase 1b (`CoreQueryName1b`) are never assumed: a core answers them only when it
 * lists them in `queryNames`, and until it does the commands that name them are not registered.
 */
import type { CoreApi, CoreQueryName, CoreQueryName1b } from '../core-api.ts';
import { canChangeContent } from './access.ts';
import type { QuerySource } from './types.ts';

/** The queries of phase 1a: assumed for a core that does not list its own (the spike core). */
export const CORE_QUERY_NAMES: readonly CoreQueryName[] = [
  'canEditSelection',
  'canUndo',
  'canRedo',
  'isBold',
  'isItalic',
  'canInsertFootnote',
  'hasHeader',
];

/** The queries of phase 1b (ADR 0052), answered only by a core that lists them. */
export const CORE_QUERY_NAMES_1B: readonly CoreQueryName1b[] = [
  'canCopyFormat',
  'canPasteFormat',
  'canMarkRegion',
  'hasNextEditableRegion',
  'canInsertField',
  'canSetTableSize',
  'canMoveBlockUp',
  'canMoveBlockDown',
  'hasFooter',
];

function fromViews(core: CoreApi, name: string): boolean | undefined {
  switch (name) {
    case 'isBold':
      return core.selection.get().marks.includes('bold');
    case 'isItalic':
      return core.selection.get().marks.includes('italic');
    case 'canEditSelection':
      return core.access ? canChangeContent(core.access.get()) : undefined;
    default:
      return undefined;
  }
}

/** The document API's queries, through `core.query` when the core has it. */
export function coreQuerySource(core: CoreApi): QuerySource {
  const names = core.queryNames ?? CORE_QUERY_NAMES;
  return {
    names,
    evaluate(name) {
      return core.query?.(name) ?? fromViews(core, name);
    },
    reason(name) {
      return core.queryReason?.(name);
    },
    // The registry observes the core's views itself; this source has nothing more to report.
    subscribe: () => () => {},
  };
}

/** Reason codes of the core for `canInsertField` that the shell states in its own words. */
const FIELD_REASONS: Readonly<Record<string, string>> = {
  // 05 and the core API name the document limit `limit`; the shell's string is `fieldLimit`.
  limit: 'fieldLimit',
  fieldLimit: 'fieldLimit',
};

/**
 * Why the shell itself refuses a field at the selection (FRW-072; 12 §3.2), before it asks the
 * core: a field is never allowed in a header, footer or footnote (an open sub-editor panel, or a
 * `story:` scope), and inserting one needs `edit` there (FRW-072 criterion 1). Null when the shell
 * has no objection, so the core decides.
 */
export function fieldInsertBlock(core: CoreApi): string | null {
  if (core.panel.get() !== null) return 'subeditor';
  const access = core.access?.get();
  if (access?.scope.startsWith('story:')) return 'subeditor';
  if (core.selection.get().contexts?.includes('story')) return 'subeditor';
  if (access && !access.caps.includes('edit')) return 'noEdit';
  return null;
}

/**
 * The field palette's query (FRW-072): `canInsertField`, with the shell's rules of
 * `fieldInsertBlock` in front of the core's answer. Listed only when the core lists the query, so
 * the insert commands stay unregistered for a core that cannot insert fields. The registry asks it
 * before the core's own source and observes the views it reads (`panel`, `access`, `selection`).
 */
export function fieldInsertSource(core: CoreApi): QuerySource {
  const offered = core.queryNames?.includes('canInsertField') ?? false;
  return {
    names: offered ? ['canInsertField'] : [],
    evaluate(name) {
      if (name !== 'canInsertField') return undefined;
      if (fieldInsertBlock(core) !== null) return false;
      return core.query?.(name);
    },
    reason(name) {
      if (name !== 'canInsertField') return undefined;
      const block = fieldInsertBlock(core);
      if (block !== null) return block;
      const code = core.queryReason?.(name);
      return typeof code === 'string' ? (FIELD_REASONS[code] ?? code) : code;
    },
    subscribe: () => () => {},
  };
}

/** Reason codes of the core for `canMarkRegion` that the shell states in its own words (PRM-033). */
const REGION_REASONS: Readonly<Record<string, string>> = {
  // The core API names the document limit `limit`; the shell's string is `regionLimit`.
  limit: 'regionLimit',
  regionLimit: 'regionLimit',
};

/**
 * Why the shell itself refuses to mark a region (PRM-033 criteria 3 and 4), before it asks the core:
 * marking needs `structure` at document level and `edit` in the body, and never happens in a
 * header, footer, footnote or other sub-editor. Null when the shell has no objection.
 */
export function regionMarkBlock(core: CoreApi): string | null {
  if (core.panel.get() !== null) return 'subeditor';
  const access = core.access?.get();
  if (access?.scope.startsWith('story:')) return 'subeditor';
  if (core.selection.get().contexts?.includes('story')) return 'subeditor';
  const document = core.permissions?.get();
  if (document && !document.caps.includes('structure')) return 'structure';
  if (access && !access.caps.includes('edit')) return 'noEdit';
  return null;
}

/**
 * The query source for `canMarkRegion` (PRM-033): the shell's rules of `regionMarkBlock` in front of
 * the core's answer, and the core's reason codes mapped to the shell's strings. Listed only when the
 * core lists the query, so `insert.region` stays unregistered for a core that cannot mark regions.
 */
export function markRegionSource(core: CoreApi): QuerySource {
  const offered = core.queryNames?.includes('canMarkRegion') ?? false;
  return {
    names: offered ? ['canMarkRegion'] : [],
    evaluate(name) {
      if (name !== 'canMarkRegion') return undefined;
      if (regionMarkBlock(core) !== null) return false;
      return core.query?.(name);
    },
    reason(name) {
      if (name !== 'canMarkRegion') return undefined;
      const block = regionMarkBlock(core);
      if (block !== null) return block;
      const code = core.queryReason?.(name);
      return typeof code === 'string' ? (REGION_REASONS[code] ?? code) : code;
    },
    subscribe: () => () => {},
  };
}

/** A source for state the shell owns (which pane is open, the mode's availability). */
export class ShellQueries implements QuerySource {
  readonly #values = new Map<string, boolean>();
  readonly #reasons = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  readonly names: readonly string[];

  constructor(names: readonly string[]) {
    this.names = names;
  }

  evaluate(name: string): boolean | undefined {
    return this.#values.get(name);
  }

  reason(name: string): string | undefined {
    return this.#reasons.get(name);
  }

  /** Sets an answer and, for a false one, the reason code that explains it. */
  set(name: string, value: boolean, reason?: string | null): void {
    const before = this.#reasons.get(name);
    const next = !value && reason ? reason : undefined;
    if (this.#values.get(name) === value && before === next) return;
    this.#values.set(name, value);
    if (next) this.#reasons.set(name, next);
    else this.#reasons.delete(name);
    for (const listener of [...this.#listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
