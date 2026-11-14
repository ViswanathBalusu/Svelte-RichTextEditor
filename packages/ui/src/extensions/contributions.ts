/**
 * Panels and status-bar items that extensions contribute (UX-052; 13 §3, §7.1, §7.2).
 *
 * - A panel is a pane: it goes into the pane host's registry (`PaneRegistry`, UX-019), so it opens
 *   and takes focus the way a built-in pane does. Its loader runs the first time the panel is
 *   opened and never before (`contributePanel` only records it). A failed load is not kept, so the
 *   next open tries again. An identifier that a built-in pane already has is refused, so an
 *   extension cannot replace the editor's own panes (ADR 0136, decision 7, proposed).
 * - A status-bar item has a visible `text` and a `label` that is its text alternative (WCAG 2.2,
 *   1.1.1 and 4.1.2). Both are required and must not be blank. The position is `start` or `end`:
 *   the items of each position keep their registration order, and `start` items come before `end`
 *   items (ADR 0136, decision 8, proposed). The status bar reads `list()`.
 * - Labels are the extension's own text (ADR 0136, decision 3): nothing here looks a key up in the
 *   host's string tables.
 */
import type { PaneComponent, PaneRegistry } from '../shell/panes.ts';

const ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const PANE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export class ContributionError extends Error {
  readonly contributionId: string;

  constructor(contributionId: string, message: string) {
    super(`contribution "${contributionId}": ${message}`);
    this.name = 'ContributionError';
    this.contributionId = contributionId;
  }
}

/** A panel an extension contributes. The identifier is the pane identifier. */
export interface PanelContribution {
  /** Lower case, letters, digits and hyphens. Unique among the panes the editor knows. */
  readonly id: string;
  /** The name of the panel, shown in its heading and in the pane list. Not blank. */
  readonly label: string;
  /** Loads the panel's component. Called on the first open only. */
  readonly load: () => Promise<PaneComponent>;
}

/**
 * Adds a panel to the pane registry. Returns the function that removes it. Nothing is loaded here:
 * the loader runs when the pane is opened, and the result is kept for later opens of the same
 * panel (a rejected load is forgotten, so a later open tries again).
 */
export function contributePanel(registry: PaneRegistry, panel: PanelContribution): () => void {
  const id = String(panel.id);
  if (!PANE_ID_PATTERN.test(id))
    throw new ContributionError(id, 'the panel identifier must be lower case');
  if (typeof panel.label !== 'string' || panel.label.trim() === '')
    throw new ContributionError(id, 'the panel needs a label');
  if (typeof panel.load !== 'function') throw new ContributionError(id, 'the panel has no loader');
  if (registry.get(id) !== undefined)
    throw new ContributionError(id, 'a pane with this identifier is already registered');

  let pending: Promise<PaneComponent> | undefined;
  const once = (): Promise<PaneComponent> => {
    if (pending === undefined) {
      let started: Promise<PaneComponent>;
      try {
        started = Promise.resolve(panel.load());
      } catch (error) {
        return Promise.reject(error);
      }
      pending = started.catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };

  return registry.register({ id, label: panel.label.trim(), load: once });
}

export type StatusPosition = 'start' | 'end';

/** A status-bar item an extension contributes. */
export interface StatusItem {
  /** Identifier of the form `area.name`, unique among the status items. */
  readonly id: string;
  /** Where the item goes: after the editor's own `start` items, or after its `end` items. */
  readonly position: StatusPosition;
  /** What is shown. Not blank. */
  readonly text: string;
  /** The text alternative a screen reader announces. Not blank. */
  readonly label: string;
}

/** The status-bar items, read by the status bar in the order it shows them. */
export class StatusItemRegistry {
  readonly #items = new Map<string, StatusItem>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  /** Changes whenever an item is added or removed. */
  readonly view = {
    get: (): number => this.#version,
    subscribe: (listener: () => void): (() => void) => {
      this.#listeners.add(listener);
      return () => {
        this.#listeners.delete(listener);
      };
    },
  };

  /** Adds an item and returns the function that removes it. Throws naming the item when invalid. */
  add(item: StatusItem): () => void {
    const id = String(item.id);
    if (!ID_PATTERN.test(id))
      throw new ContributionError(id, 'the identifier must have the form "area.name"');
    if (this.#items.has(id))
      throw new ContributionError(id, 'a status item with this identifier is already registered');
    if (item.position !== 'start' && item.position !== 'end')
      throw new ContributionError(id, 'the position must be "start" or "end"');
    if (typeof item.label !== 'string' || item.label.trim() === '')
      throw new ContributionError(id, 'it needs a text alternative (label)');
    if (typeof item.text !== 'string' || item.text.trim() === '')
      throw new ContributionError(id, 'it needs text');
    this.#items.set(id, { ...item, id, text: item.text.trim(), label: item.label.trim() });
    this.#changed();
    return () => this.remove(id);
  }

  remove(id: string): boolean {
    const removed = this.#items.delete(id);
    if (removed) this.#changed();
    return removed;
  }

  /** The items in display order: `start` items, then `end` items, each in registration order. */
  list(): StatusItem[] {
    const all = [...this.#items.values()];
    return [
      ...all.filter((item) => item.position === 'start'),
      ...all.filter((item) => item.position === 'end'),
    ];
  }

  #changed(): void {
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }
}
