/**
 * The assistant's action queue (UX-048 criterion 2; 13 §6.2; 10 §3.1).
 *
 * The model's output may ask for side effects. This queue holds each one as a proposal and runs
 * nothing until the user approves that specific proposal. `propose` and `reject` never call the
 * executor. `approve` removes the proposal first and then calls the executor once, so an approval
 * runs at most one time, and a failing executor is reported and not retried.
 *
 * - The kinds are the side effects of 13 §6.2 that the editor can cause: inserting text, inserting a
 *   link (as a mark, which is not followed), inserting a picture that is an attached asset, creating
 *   a comment, and calling a host action. Following a link or loading a picture from an address is
 *   not a kind: the guard never produces one, and the executor is the only place either could run.
 * - `proposeFromGuard` turns the segments of `guardOutput` into proposals. It makes no proposal for
 *   a notice: a blocked link is already text, and a blocked picture is dropped.
 * - The queue creates no node and calls no port. Its executor is the caller's (the core or the
 *   host); this module imports nothing from the editor.
 * - The queue has no size bound. The spec gives no number, so none is set here (ADR 0328, decision 3).
 */
import type { GuardResult } from './output-guard.ts';

export type AssistantAction =
  | { readonly kind: 'insert-text'; readonly text: string }
  | { readonly kind: 'insert-link'; readonly text: string; readonly href: string }
  | { readonly kind: 'insert-image'; readonly asset: string }
  | { readonly kind: 'create-comment'; readonly text: string }
  | { readonly kind: 'host-action'; readonly name: string; readonly args: unknown };

export interface PendingAction {
  readonly id: number;
  readonly action: AssistantAction;
}

export type ApproveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unknown' }
  | { readonly ok: false; readonly reason: 'failed'; readonly message: string };

export type ActionExecutor = (action: AssistantAction) => void | Promise<void>;

export interface ActionQueue {
  /** Holds a proposal and returns its identifier. Nothing runs. */
  propose(action: AssistantAction): number;
  /** Holds one proposal per insertable segment of the guarded output. Nothing runs. */
  proposeFromGuard(result: GuardResult): number[];
  /** The proposals not yet approved or rejected, in the order they were made. */
  pending(): readonly PendingAction[];
  /** Runs the executor once for this proposal, after removing it. */
  approve(id: number): Promise<ApproveOutcome>;
  /** Removes the proposal without running anything. False when it is not pending. */
  reject(id: number): boolean;
}

export function createActionQueue(execute: ActionExecutor): ActionQueue {
  const held = new Map<number, AssistantAction>();
  let next = 1;

  const propose = (action: AssistantAction): number => {
    const id = next;
    next += 1;
    held.set(id, action);
    return id;
  };

  return {
    propose,

    proposeFromGuard(result: GuardResult): number[] {
      const ids: number[] = [];
      for (const s of result.segments) {
        if (s.kind === 'text') ids.push(propose({ kind: 'insert-text', text: s.text }));
        else if (s.kind === 'link')
          ids.push(propose({ kind: 'insert-link', text: s.text, href: s.href }));
        else ids.push(propose({ kind: 'insert-image', asset: s.asset }));
      }
      return ids;
    },

    pending(): readonly PendingAction[] {
      return [...held].map(([id, action]) => ({ id, action }));
    },

    async approve(id: number): Promise<ApproveOutcome> {
      const action = held.get(id);
      if (action === undefined) return { ok: false, reason: 'unknown' };
      held.delete(id);
      try {
        await execute(action);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: 'failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    reject(id: number): boolean {
      return held.delete(id);
    },
  };
}
