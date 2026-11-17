/** Helpers for the proofing tests (UX-041, UX-042): a stepped clock, a mock port, a core with a styled document. */
import type { CancelSignal, ProofingBlock, ProofingFinding } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { DocumentCore } from '../src/headless.ts';
import type { ProofingClock, ProofingPort } from '../src/proofing.ts';
import { internals } from '../src/testing.ts';
import { styledDocument, styledEditorAccess } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

/** A clock the test steps: `fire` runs every timer set so far. */
export function manualClock(): ProofingClock & { fire(): void; pending(): number } {
  let next = 0;
  const timers = new Map<number, () => void>();
  return {
    setTimeout(fn) {
      const handle = ++next;
      timers.set(handle, fn);
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    fire() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    pending: () => timers.size,
  };
}

/** Lets the promise callbacks of the port and the controller run. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

export interface Recorded {
  readonly blocks: readonly ProofingBlock[];
  readonly signal: CancelSignal | undefined;
}

/** Marks every word in `bad` as a spelling finding with the suggestions given for it. */
export function wordPort(
  bad: Record<string, string[]>,
  extra: Partial<ProofingPort> = {},
): ProofingPort & { requests: Recorded[] } {
  const requests: Recorded[] = [];
  return {
    requests,
    check(request, opts) {
      requests.push({ blocks: request.blocks, signal: opts?.signal });
      const found: ProofingFinding[] = [];
      for (const block of request.blocks) {
        for (const m of block.text.matchAll(/[\p{L}']+/gu)) {
          const suggestions = bad[m[0]];
          if (suggestions === undefined) continue;
          found.push({
            blockId: block.blockId,
            from: m.index,
            to: m.index + m[0].length,
            kind: 'spelling',
            message: `Unknown word: ${m[0]}`,
            suggestions,
          });
        }
      }
      return Promise.resolve(found);
    },
    addWord: () => Promise.resolve(),
    ...extra,
  };
}

export function newCore(over: { access?: ReturnType<typeof styledEditorAccess> | null } = {}) {
  return new DocumentCore({
    doc: styledDocument(),
    access: over.access === undefined ? styledEditorAccess() : over.access,
    schedule: microtask,
  });
}

export const blockText = (core: DocumentCore, id: string): string =>
  internals(core).state.doc.nodeAt(posOf(internals(core).state.doc, id))!.textContent;

/** Puts the caret at the end of a block. */
export function endOf(core: DocumentCore, id: string): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id);
  const node = i.state.doc.nodeAt(at)!;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + node.nodeSize - 1)));
}
