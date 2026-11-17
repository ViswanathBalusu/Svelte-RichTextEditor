/**
 * The pane host's registry (UX-019; 13 §3, §7.1; 02 §2; 05 §8.3). Every pane, built in or
 * contributed, is a descriptor here, and opens, loads and takes focus the same way:
 *
 * - its code is a separate chunk, requested the first time the pane opens and never before
 *   (UX-070); the host may supply the loader of a pane whose content another story builds;
 * - a pane whose backend feature is not announced, whose data the core does not offer, or that has
 *   no loader, is not offered (05 §8.3: the interface shows a feature only when its port exists);
 * - one pane is open at a time; the shell moves focus into it and back (`PaneHost`).
 */
import type { Component } from 'svelte';
import type { CoreApi } from '../core-api.ts';

/** What every pane component receives. */
export interface PaneProps {
  core: CoreApi;
  /** Closes the pane; focus goes back where it was before the pane opened. */
  close: () => void;
}

export type PaneComponent = Component<PaneProps>;
export type PaneLoader = () => Promise<PaneComponent>;

export interface PaneDescriptor {
  readonly id: string;
  /** String key of its name (`pane.<id>`), or an extension's own key. */
  readonly label: string;
  /** Loads the component; absent for a pane whose content another story or the host supplies. */
  readonly load?: PaneLoader;
  /** A backend feature that must be announced (05 §8.3). */
  readonly feature?: string;
  /**
   * A capability the user needs somewhere they can act (07 §4), checked against the capabilities at
   * the selection (`CoreApi.access`) unless the caller passes its own list.
   */
  readonly capability?: string;
  /** Whether the core offers what the pane shows. */
  readonly available?: (core: CoreApi) => boolean;
}

const load = (m: Promise<{ default: unknown }>): Promise<PaneComponent> =>
  m.then((x) => x.default as PaneComponent);

/**
 * The panes of 13 §3, plus the shortcut reference (UX-013) and the fill summary (FRW-078). The
 * content of review, history, fields, the accessibility checker, the assistant and the PDF preview
 * belongs to other stories (HIS, FRW, FE-071, UX-030 to UX-067); the host or those stories give
 * their loaders.
 */
export const BUILT_IN_PANES: readonly PaneDescriptor[] = [
  { id: 'outline', label: 'pane.outline', load: () => load(import('../panes/OutlinePane.svelte')) },
  {
    id: 'styles',
    label: 'pane.styles',
    load: () => load(import('../panes/StylesPane.svelte')),
    available: (core) => core.styles !== undefined,
  },
  {
    id: 'comments',
    label: 'pane.comments',
    feature: 'comments',
    load: () => load(import('../panes/CommentsPane.svelte')),
  },
  { id: 'catch-up', label: 'pane.catch-up', feature: 'history' },
  { id: 'review', label: 'pane.review' },
  {
    id: 'history',
    label: 'pane.history',
    feature: 'history',
    load: () => load(import('../panes/HistoryPane.svelte')),
    available: (core) => core.history !== undefined,
  },
  {
    id: 'permissions',
    label: 'pane.permissions',
    load: () => load(import('../panes/PermissionsPane.svelte')),
    available: (core) => core.regions !== undefined,
  },
  {
    id: 'fields',
    label: 'pane.fields',
    load: () => load(import('../panes/FieldsPane.svelte')),
    available: (core) => core.fieldProperties !== undefined,
  },
  {
    id: 'checker',
    label: 'pane.checker',
    load: () => load(import('../panes/CheckerPane.svelte')),
    available: (core) => core.getContent !== undefined,
  },
  {
    id: 'sources',
    label: 'pane.sources',
    load: () => load(import('../panes/SourcesPane.svelte')),
    available: (core) => core.sources !== undefined,
  },
  {
    id: 'roles',
    label: 'pane.roles',
    load: () => load(import('../panes/RolesPane.svelte')),
    available: (core) => core.roles !== undefined,
  },
  { id: 'assistant', label: 'pane.assistant' },
  { id: 'pdf', label: 'pane.pdf', feature: 'exports' },
  {
    id: 'recovered',
    label: 'pane.recovered',
    load: () => load(import('../panes/RecoveredPane.svelte')),
    available: (core) => core.recovered !== undefined,
  },
  {
    id: 'shortcuts',
    label: 'pane.shortcuts',
    load: () => load(import('../panes/ShortcutsPane.svelte')),
  },
  {
    id: 'fill',
    label: 'pane.fill',
    load: () => load(import('../panes/FillPane.svelte')),
    available: (core) => core.fill !== undefined,
  },
];

export class PaneRegistry {
  readonly #panes = new Map<string, PaneDescriptor>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(descriptors: readonly PaneDescriptor[] = BUILT_IN_PANES) {
    for (const d of descriptors) this.#panes.set(d.id, d);
  }

  /** Changes whenever a pane is registered or removed. */
  readonly view = {
    get: (): number => this.#version,
    subscribe: (listener: () => void): (() => void) => {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    },
  };

  /**
   * Adds a pane, or gives a known one its loader (the host's comments pane, an extension's panel).
   * Returns the function that removes it again.
   */
  register(descriptor: PaneDescriptor): () => void {
    if (!/^[a-z][a-z0-9-]*$/.test(descriptor.id))
      throw new Error(`pane "${descriptor.id}": the identifier must be lower case`);
    const before = this.#panes.get(descriptor.id);
    this.#panes.set(descriptor.id, { ...before, ...descriptor });
    this.#changed();
    return () => {
      if (before) this.#panes.set(descriptor.id, before);
      else this.#panes.delete(descriptor.id);
      this.#changed();
    };
  }

  get(id: string): PaneDescriptor | undefined {
    return this.#panes.get(id);
  }

  /** Every pane the editor knows, offered or not (UX-019 criterion 1). */
  known(): string[] {
    return [...this.#panes.keys()];
  }

  /**
   * Whether a pane is offered: it has a loader, its feature is announced, the user holds the
   * capability it needs (UX-019 criterion 4), and its data exists. `caps` defaults to the
   * capabilities at the selection.
   */
  offered(
    id: string,
    core: CoreApi,
    features: readonly string[],
    caps?: readonly string[],
  ): boolean {
    const d = this.#panes.get(id);
    if (!d?.load) return false;
    if (d.feature !== undefined && !features.includes(d.feature)) return false;
    if (d.capability !== undefined) {
      const held = caps ?? core.access?.get().caps ?? [];
      if (!held.includes(d.capability)) return false;
    }
    return d.available ? d.available(core) : true;
  }

  #changed(): void {
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }
}
