/**
 * The assistant pane's controller (UX-045; 13 §6.2, §12).
 *
 * It drives `assistantStep` (request-lifecycle.ts) with the answer of an `AssistantApi`. It owns one
 * request at a time and an `AbortController` for it:
 *
 * - `ask` refuses a request the author may not make (`assistantAsk`), else starts it and reads the
 *   stream. Text is collected, not shown, until the stream ends; the state then holds the response.
 * - `cancel` aborts the request at the port and ends it with nothing held. Chunks that arrive after
 *   that are ignored, so a late answer cannot appear (criterion 3).
 * - An error chunk or a thrown error ends the request as a failure with retry offered. `rate_limited`
 *   and `quota_exceeded` keep their names; anything else is a port failure (criterion 4).
 * - Nothing here changes the document. An approval yields text for UX-046 to insert as suggestions;
 *   the pane has no insertion until that story exists (criterion 2).
 */
import type { AssistantApi, AssistantTaskName, Capability } from '../core-api.ts';
import {
  assistantAsk,
  assistantStep,
  IDLE,
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

export interface AssistantView {
  readonly state: AssistantState;
  /** Why the last request was refused before it started, or null. */
  readonly refused: AssistantAskRefusal | null;
}

export interface AssistantController {
  view(): AssistantView;
  /** Starts a request; false when the author may not make it or one is already running. */
  ask(kind: AssistantKind, prompt: string): boolean;
  /** Repeats the last request after a failure. */
  retry(): boolean;
  /** Stops the running request; nothing is applied. */
  cancel(): void;
  /** Drops a shown or failed result. */
  dismiss(): void;
  /** The text an approval would insert, or null; the document is not changed here. */
  approve(): string | null;
  /** Aborts any request and stops listening. */
  dispose(): void;
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

  const step = (event: Parameters<typeof assistantStep>[1]): string | null => {
    const out = assistantStep(state, event, allowInsert);
    state = out.state;
    options.onChange();
    return out.insert;
  };

  async function run(kind: AssistantKind, prompt: string, ctl: AbortController): Promise<void> {
    let text = '';
    try {
      for await (const chunk of options.api.request(TASK[kind], prompt, ctl.signal)) {
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
    refused = null;
    allowInsert = caps.includes('edit') || caps.includes('suggest');
    last = { kind, prompt };
    const ctl = new AbortController();
    current = ctl;
    step({ type: 'start', kind });
    void run(kind, prompt, ctl);
    return true;
  }

  return {
    view: () => ({ state, refused }),
    ask: start,
    retry: () => (state.phase === 'failed' && last ? start(last.kind, last.prompt) : false),
    cancel() {
      if (state.phase !== 'running') return;
      current?.abort();
      current = null;
      step({ type: 'cancel' });
    },
    dismiss() {
      refused = null;
      step({ type: 'dismiss' });
    },
    approve: () => step({ type: 'approve' }),
    dispose() {
      current?.abort();
      current = null;
    },
  };
}
