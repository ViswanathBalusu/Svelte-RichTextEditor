/**
 * The layout engine's entry point (02 §9.1, §9.3; FE-076). One call takes the flow blocks of a
 * document and the injected providers, and returns the layout tree. The engine has no other input:
 * no DOM, no clock, no host object and no caller callback reach it (FND-004), so the same flow and
 * providers give the same tree on every run.
 *
 * The providers are the three of `ItemProviders`: the text measurer (`measure.ts`), the break
 * opportunities and the line breaker (`lines.ts`). The page pass is this package's own. A kernel in
 * another language plugs in behind the same interfaces (ADR 0016; the WASM epic), and the engine
 * does not change. Header and footer stories come from the flow itself (`FlowDocument.stories`),
 * laid out with the same providers by `flowStoryResolver`.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import type { FlowDocument } from './flow.ts';
import { documentItems, flowStoryResolver, type ItemProviders } from './items.ts';
import type { LinePin } from './reconcile.ts';
import { paginate, type PinOptions, type Reconciliation } from './paginate.ts';
import { freezeTree, type LayoutTree } from './tree.ts';

/** The engine's name and version, recorded in every tree it returns. */
export const LAYOUT_ENGINE = '@docedit/layout@0.0.0';

export interface LayoutResult {
  readonly tree: LayoutTree;
  /** Blocks the adapter does not place yet (tables, FE-083). */
  readonly unplaced: readonly string[];
  /** Blocks taller than a page body (see `paginate.ts`). */
  readonly overflowed: readonly string[];
  /** False when the page passes did not settle within `MAX_COUNT_PASSES` (see `paginate.ts`). */
  readonly pageCountSettled: boolean;
  /** What happened to the typeset page starts, when some were given (FE-100; `paginate.ts`). */
  readonly reconciliation?: Reconciliation;
}

/**
 * Options of `layoutFlow`: the typeset page starts to adopt, and the typeset line starts (FE-100),
 * for a tenant that has switched reconciliation on. `lines` are the line starts of `adoptablePins`
 * (line granularity only); the editor's own breaks stay where no line start is given.
 */
export interface LayoutFlowOptions {
  readonly pins?: PinOptions;
  readonly lines?: readonly LinePin[];
}

/** The providers with the typeset line starts of `lines`, grouped by block (FE-100 criterion 1). */
function withLineStarts(base: ItemProviders, lines: readonly LinePin[]): ItemProviders {
  if (lines.length === 0) return base;
  const byBlock = new Map<string, number[]>();
  for (const { blockId, offset } of lines) {
    const list = byBlock.get(blockId);
    if (list) list.push(offset);
    else byBlock.set(blockId, [offset]);
  }
  return { ...base, forcedLines: byBlock };
}

/**
 * Lays out a flow document with the injected providers: the flow and the providers are its only
 * inputs, with the typeset page starts and line starts when reconciliation is switched on (02 §9.7;
 * FE-100).
 */
export function layoutFlow(
  doc: FlowDocument,
  base: ItemProviders,
  options: LayoutFlowOptions = {},
): LayoutResult {
  const providers = withLineStarts(base, options.lines ?? []);
  const { first, items, unplaced, notes } = documentItems(
    doc,
    providers,
    flowStoryResolver(doc, providers),
  );
  const { pages, overflowed, pageCountSettled, reconciliation } = paginate(items, first, {
    notes,
    ...(options.pins ? { pins: options.pins } : {}),
  });
  const tree: LayoutTree = freezeTree({
    engine: LAYOUT_ENGINE,
    measurer: providers.measurer.id,
    pages,
  });
  return freezeTree({
    tree,
    unplaced,
    overflowed,
    pageCountSettled,
    ...(reconciliation ? { reconciliation } : {}),
  });
}
