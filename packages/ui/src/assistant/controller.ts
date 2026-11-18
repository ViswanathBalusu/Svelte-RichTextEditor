/**
 * The assistant pane's controller (UX-045, UX-046, UX-048; 13 §6.2, §12; 10 §3.1).
 *
 * It drives `assistantStep` (request-lifecycle.ts) with the answer of an `AssistantApi`. It owns one
 * request at a time and an `AbortController` for it:
 *
 * - `ask` refuses a request the author may not make (`assistantAsk`), else starts it and reads the
 *   stream. The request is built as labelled data parts (`buildPrompt`). Text is collected, not shown,
 *   until the stream ends.
 * - The answer passes `guardOutput` before anyone sees it: a link that was not in the source becomes
 *   plain text with a notice, an image that is not an attached asset is dropped with a notice, and
 *   nothing is followed or loaded. What is left is one text to insert, held as one proposal in the
 *   action queue (UX-048 criterion 2).
 * - `approve` is the author's approval of that proposal. Only then does the executor call the API's
 *   `insert`, which records the text as suggestions (UX-046). A refusal leaves the result shown and
 *   proposes the insertion again. No other path reaches the document.
 * - `cancel` aborts the request at the port and ends it with nothing held. Chunks that arrive after
 *   that are ignored, so a late answer cannot appear (UX-045 criterion 3).
 * - An error chunk or a thrown error ends the request as a failure with retry offered. `rate_limited`
 *   and `quota_exceeded` keep their names (UX-045 criterion 4).
 */
import type { AssistantApi, AssistantTaskName, Capability } from '../core-api.ts';
import { type ActionQueue, createActionQueue } from './action-queue.ts';
import { type GuardNotice, type OutputSegment, guardOutput } from './output-guard.ts';
import { buildPrompt } from './prompt.ts';
import {
  assistantAsk,
  assistantStep,
  IDLE,
  insertionAllowed,
  type AssistantAskRefusal,
  type AssistantFailure,
  type AssistantKind,
  type AssistantState,
} from './request-lifecycle.ts';

const TASK: Record<AssistantKind, AssistantTaskName> = {
  draft: 'draft',
  rewrite: 'rewrite',
  summary: 'summarise',
  question: 'answer',
};

/** The failure the author is told about for a code the port gave. */
export function failureOf(code: string): AssistantFailure {
  return code === 'rate_limited' || code === 'quota_exceeded' ? code : 'port_failure';
}

/** What the author may insert: the guarded answer as one text, and what the guard changed. */
export interface GuardedAnswer {
  /** The text the insertion would put in; a link that passed is written as `label (address)`. */
  readonly text: string;
  readonly notices: readonly (
    GuardNotice | { readonly code: 'image-not-inserted'; readonly target: string }
  )[];
}

export interface AssistantView {
  readonly state: AssistantState;
  /** Why the last request was refused before it started, or null. */
  readonly refused: AssistantAskRefusal | null;
  /** The core's reason when the last insertion was refused (nothing was applied), or null. */
  readonly insertRefused: string | null;
  /** The last result was inserted as suggestions. */
  readonly inserted: boolean;
  /** The guarded answer while a result is shown, else null. */
  readonly answer: GuardedAnswer | null;
}

export interface AssistantController {
  view(): AssistantView;
  /** Starts a request; false when the author may not make it or one is already running. */
  ask(kind: AssistantKind, prompt: string): boolean;
  /** Repeats the last request after a failure. */
  retry(): boolean;
  /** Stops the running request; nothing is applied. */
  cancel(): void;
  /** Drops a shown or failed result and any proposal. */
  dismiss(): void;
  /**
   * The author approves the proposed insertion of the shown result: the API puts it in the document
   * as suggestions. When it refuses, nothing is applied and the result stays shown with the reason.
   * False when nothing is inserted: no result shown, no right to insert, or no insertion in the API.
   */
  approve(): Promise<boolean>;
  /** Aborts any request and stops listening. */
  dispose(): void;
}

/** The guarded segments as one text. A link that passed is kept with its address, as text. */
export function flatten(segments: readonly OutputSegment[]): {
  text: string;
  skippedImages: string[];
} {
  let text = '';
  const skippedImages: string[] = [];
  for (const s of segments) {
    if (s.kind === 'text') text += s.text;
    else if (s.kind === 'link')
      text += s.text === s.href || s.text === '' ? s.href : `${s.text} (${s.href})`;
    else skippedImages.push(s.asset);
  }
  return { text, skippedImages };
}

export function createAssistantController(options: {
  readonly api: AssistantApi;
  /** The author's capabilities at the selection, read each time a request starts. */
  readonly caps: () => readonly Capability[];
  readonly onChange: () => void;
}): AssistantController {
  let state: AssistantState = IDLE;
  let refused: AssistantAskRefusal | null = null;
  let last: { kind: AssistantKind; prompt: string } | null = null;
  let current: AbortController | null = null;
  let allowInsert = false;
  let insertRefused: string | null = null;
  let inserted = false;
  let answer: GuardedAnswer | null = null;
  let proposal: number | null = null;

  // The only executor: it calls the API's insertion, which records suggestions. A refusal throws so
  // the queue reports it, and nothing is applied.
  const queue: ActionQueue = createActionQueue((action) => {
    if (action.kind !== 'insert-text' || !options.api.insert) throw new Error('unsupported');
    const result = options.api.insert(action.text);
    if (!result.ok) throw new Error(result.reason);
  });

  const clearProposal = (): void => {
    if (proposal !== null) queue.reject(proposal);
    proposal = null;
    answer = null;
  };

  const step = (event: Parameters<typeof assistantStep>[1]): string | null => {
    const out = assistantStep(state, event, allowInsert);
    state = out.state;
    options.onChange();
    return out.insert;
  };

  /** Guards the collected text and holds its insertion as one proposal; nothing runs. */
  function hold(text: string): void {
    const source = options.api.source?.() ?? { text: '', assets: [] };
    const guarded = guardOutput(text, { sourceText: source.text, attachedAssets: source.assets });
    const flat = flatten(guarded.segments);
    answer = {
      text: flat.text,
      notices: [
        ...guarded.notices,
        ...flat.skippedImages.map((target) => ({ code: 'image-not-inserted' as const, target })),
      ],
    };
    proposal = queue.propose({ kind: 'insert-text', text: flat.text });
  }

  async function run(kind: AssistantKind, prompt: string, ctl: AbortController): Promise<void> {
    let text = '';
    try {
      for await (const chunk of options.api.request(TASK[kind], prompt, ctl.signal, buildPrompt)) {
        if (ctl.signal.aborted) return;
        if (chunk.kind === 'text') text += chunk.text;
        else if (chunk.kind === 'error') {
          if (current === ctl) step({ type: 'failure', failure: failureOf(chunk.code) });
          return;
        } else break;
      }
    } catch {
      if (ctl.signal.aborted) return;
      if (current === ctl) step({ type: 'failure', failure: 'port_failure' });
      return;
    }
    if (ctl.signal.aborted || current !== ctl) return;
    hold(text);
    step({ type: 'response', text });
  }

  function start(kind: AssistantKind, prompt: string): boolean {
    if (state.phase === 'running') return false;
    const caps = options.caps();
    const offer = assistantAsk(kind, caps);
    if (!offer.enabled) {
      refused = offer.reason;
      options.onChange();
      return false;
    }
    clearProposal();
    refused = null;
    insertRefused = null;
    inserted = false;
    allowInsert = insertionAllowed(caps);
    last = { kind, prompt };
    const ctl = new AbortController();
    current = ctl;
    step({ type: 'start', kind });
    void run(kind, prompt, ctl);
    return true;
  }

  return {
    view: () => ({ state, refused, insertRefused, inserted, answer }),
    ask: start,
    retry: () => (state.phase === 'failed' && last ? start(last.kind, last.prompt) : false),
    cancel() {
      if (state.phase !== 'running') return;
      current?.abort();
      current = null;
      step({ type: 'cancel' });
    },
    dismiss() {
      clearProposal();
      refused = null;
      insertRefused = null;
      inserted = false;
      step({ type: 'dismiss' });
    },
    async approve() {
      if (state.phase !== 'shown' || !options.api.insert || proposal === null || answer === null)
        return false;
      allowInsert = insertionAllowed(options.caps());
      if (!allowInsert) return false;
      const id = proposal;
      const text = answer.text;
      proposal = null;
      const outcome = await queue.approve(id);
      if (!outcome.ok) {
        // Nothing was applied: the result stays shown and the insertion is proposed again.
        insertRefused = outcome.reason === 'failed' ? outcome.message : outcome.reason;
        proposal = queue.propose({ kind: 'insert-text', text });
        options.onChange();
        return false;
      }
      answer = null;
      step({ type: 'approve' });
      inserted = true;
      options.onChange();
      return true;
    },
    dispose() {
      current?.abort();
      current = null;
      clearProposal();
    },
  };
}
