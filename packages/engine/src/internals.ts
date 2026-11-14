/**
 * The editing core's internals: what tests and the spike harness need and the document API never
 * offers (ProseMirror state and transactions). Reached only through `internals(core)` from
 * `@docedit/engine/testing`, so that no ProseMirror type appears on the core's public surface
 * (02 §5.1; FE-026 criterion 2).
 */
import type { Schema } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { Step } from 'prosemirror-transform';
import type { ViewHub } from './read-value.ts';
import type { SyncSession } from './sync/session.ts';
import type { SyncState } from './sync/state.ts';

export interface Internals {
  readonly state: EditorState;
  readonly schema: Schema;
  readonly sync: SyncState;
  readonly session: SyncSession | null;
  /** Remote changes that had to wait for a composition (FE-034). */
  readonly deferrals: number;
  /** Remote changes waiting now. */
  readonly deferredRemote: number;
  readonly hub: ViewHub;
  dispatch(tr: Transaction): void;
  onTransaction(listener: (tr: Transaction, state: EditorState) => void): () => void;
  /** The spike's stand-in for a remote commit (no backend). */
  applyRemote(steps: readonly Step[], mode: 'map' | 'rebase'): 'applied' | 'deferred';
  /** Treats every unconfirmed step as confirmed (the stand-in's acknowledgement). */
  confirmAll(): void;
  /** Reports the position of a block being composed, for tests without a view. */
  setCompositionProbe(probe: (() => number | null) | null): void;
  compositionEnded(): void;
}

const registry = new WeakMap<object, Internals>();

export function register(core: object, internals: Internals): void {
  registry.set(core, internals);
}

export function internals(core: object): Internals {
  const i = registry.get(core);
  if (!i) throw new Error('not an editing core');
  return i;
}
