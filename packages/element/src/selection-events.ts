/**
 * `de-selection` and `de-command-state` (05 §8.1; FE-028).
 *
 * - `de-selection` fires when the selection moves to another scope or another block, with
 *   `{ scope, blockId }` and no content.
 * - `de-command-state` fires with the commands whose `enabled` or `active` result changed, and
 *   lists exactly those.
 *
 * The core notifies its `revision` view at most once per animation frame (FE-024), and that is the
 * only trigger: one check per notification gives at most one event of each kind per frame. No DOM
 * here, so the logic runs in Node.js tests; the watch is the core's, reached through the editor.
 */
import type { CommandStateChange, SelectionDetail } from './events.ts';

export type { CommandStateChange, SelectionDetail };

/** The state a command reports, as the core's `queryCommand` gives it. */
export interface CommandSnapshot {
  readonly enabled: boolean;
  readonly active: boolean;
}

/** What the reporter reads from the editor. Read-only and without content. */
export interface SelectionWatch {
  /** Notifies once per frame in which a query's answer may have changed. */
  readonly revision: { subscribe(listener: () => void): () => void };
  selectionScope(): SelectionDetail;
  commandStates(): Readonly<Record<string, CommandSnapshot | undefined>>;
}

export interface SelectionRaise {
  selection(detail: SelectionDetail): void;
  commandState(detail: { commands: CommandStateChange[] }): void;
}

function copyCommands(
  states: Readonly<Record<string, CommandSnapshot | undefined>>,
): Record<string, CommandSnapshot> {
  const out: Record<string, CommandSnapshot> = {};
  for (const name of Object.keys(states)) {
    const s = states[name];
    if (s !== undefined) out[name] = { enabled: s.enabled, active: s.active };
  }
  return out;
}

export class SelectionEvents {
  readonly #watch: SelectionWatch;
  readonly #raise: SelectionRaise;
  #scope: SelectionDetail;
  #commands: Record<string, CommandSnapshot>;

  /** The state at construction is the baseline: nothing is raised for it. */
  constructor(watch: SelectionWatch, raise: SelectionRaise) {
    this.#watch = watch;
    this.#raise = raise;
    const scope = watch.selectionScope();
    this.#scope = { scope: scope.scope, blockId: scope.blockId };
    this.#commands = copyCommands(watch.commandStates());
  }

  /** Subscribes to the revision view. Returns the function that unsubscribes. */
  start(): () => void {
    return this.#watch.revision.subscribe(() => this.check());
  }

  /** Compares the selection and the command states with the last raised ones; raises what changed. */
  check(): void {
    const scope = this.#watch.selectionScope();
    if (scope.scope !== this.#scope.scope || scope.blockId !== this.#scope.blockId) {
      this.#scope = { scope: scope.scope, blockId: scope.blockId };
      this.#raise.selection({ scope: scope.scope, blockId: scope.blockId });
    }

    const now = this.#watch.commandStates();
    const changed: CommandStateChange[] = [];
    for (const name of Object.keys(now)) {
      const s = now[name];
      if (s === undefined) continue;
      const before = this.#commands[name];
      if (before === undefined || before.enabled !== s.enabled || before.active !== s.active)
        changed.push({ name, enabled: s.enabled, active: s.active });
    }
    this.#commands = copyCommands(now);
    if (changed.length > 0) this.#raise.commandState({ commands: changed });
  }
}
