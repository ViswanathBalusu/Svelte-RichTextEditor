/**
 * The assistant request lifecycle (UX-045, state level). Covered: a response is held and only an
 * approval inserts it (the property behind criterion 2), a failure ends with nothing held and retry
 * offered (criterion 4), a cancel discards the response (criterion 3, the state only), no pane
 * without a port (criterion 5), the view-only insertion gate and request gate (criterion 6), and the
 * message names a live region would announce (input to criterion 7). The port's stop of a request,
 * the live region and the pane are not built: nothing is ticked on this alone.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Capability } from '../src/core-api.ts';
import {
  IDLE,
  announcement,
  assistantAsk,
  assistantPaneOffered,
  assistantStep,
  insertionAllowed,
  retryOffered,
  type AssistantEvent,
  type AssistantState,
} from '../src/assistant/request-lifecycle.ts';

const CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
];

const kindArb = fc.constantFrom('draft', 'rewrite', 'summary', 'question') as fc.Arbitrary<
  'draft' | 'rewrite' | 'summary' | 'question'
>;

const eventArb: fc.Arbitrary<AssistantEvent> = fc.oneof(
  kindArb.map((kind) => ({ type: 'start' as const, kind })),
  fc.string({ maxLength: 20 }).map((text) => ({ type: 'response' as const, text })),
  fc
    .constantFrom<'rate_limited' | 'quota_exceeded' | 'port_failure'>(
      'rate_limited',
      'quota_exceeded',
      'port_failure',
    )
    .map((failure) => ({ type: 'failure' as const, failure })),
  fc.constant({ type: 'cancel' as const }),
  fc.constant({ type: 'dismiss' as const }),
  fc.constant({ type: 'approve' as const }),
);

function run(events: readonly AssistantEvent[], allowInsert: boolean) {
  let state: AssistantState = IDLE;
  const inserted: string[] = [];
  for (const event of events) {
    const step = assistantStep(state, event, allowInsert);
    state = step.state;
    if (step.insert !== null) inserted.push(step.insert);
  }
  return { state, inserted };
}

describe('assistant request lifecycle (UX-045, state level)', () => {
  it('holds a response and inserts nothing until the author approves it (criterion 2)', () => {
    const shown = assistantStep(
      assistantStep(IDLE, { type: 'start', kind: 'draft' }, true).state,
      { type: 'response', text: 'A draft.' },
      true,
    );
    expect(shown.state).toEqual({ phase: 'shown', kind: 'draft', text: 'A draft.' });
    expect(shown.insert).toBeNull();
    const approved = assistantStep(shown.state, { type: 'approve' }, true);
    expect(approved).toEqual({ state: IDLE, insert: 'A draft.' });
  });

  it('inserts nothing for any event sequence without an approval (property, criterion 2)', () => {
    fc.assert(
      fc.property(
        fc.array(
          eventArb.filter((e) => e.type !== 'approve'),
          { maxLength: 30 },
        ),
        fc.boolean(),
        (events, allow) => {
          expect(run(events, allow).inserted).toEqual([]);
        },
      ),
    );
  });

  it('ends a failed request with nothing held and retry offered (criterion 4)', () => {
    for (const failure of ['rate_limited', 'quota_exceeded', 'port_failure'] as const) {
      const step = assistantStep(
        assistantStep(IDLE, { type: 'start', kind: 'rewrite' }, true).state,
        { type: 'failure', failure },
        true,
      );
      expect(step.state).toEqual({ phase: 'failed', kind: 'rewrite', failure, retry: true });
      expect(step.insert).toBeNull();
    }
  });

  it('discards a response when the request is cancelled while it runs (criterion 3, state only)', () => {
    const running = assistantStep(IDLE, { type: 'start', kind: 'summary' }, true).state;
    const cancelled = assistantStep(running, { type: 'cancel' }, true);
    expect(cancelled.state).toEqual({ phase: 'cancelled', kind: 'summary' });
    // A late response after the cancel is not held.
    expect(assistantStep(cancelled.state, { type: 'response', text: 'late' }, true).state).toEqual(
      cancelled.state,
    );
  });

  it('is not offered without an assistant port (criterion 5)', () => {
    expect(assistantPaneOffered(undefined)).toBe(false);
    expect(assistantPaneOffered(null)).toBe(false);
    expect(assistantPaneOffered({})).toBe(true);
  });

  it('gates insertion on edit or suggest, so a view-only author cannot insert (criterion 6, property)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom(...CAPS), { maxLength: 7 }), (caps) => {
        expect(insertionAllowed(caps)).toBe(caps.includes('edit') || caps.includes('suggest'));
      }),
    );
    expect(insertionAllowed(['view', 'comment'])).toBe(false);
  });

  it('offers retry only after a failure (criterion 4)', () => {
    const running = assistantStep(IDLE, { type: 'start', kind: 'draft' }, true).state;
    expect(retryOffered(running)).toBe(false);
    expect(
      retryOffered(
        assistantStep(running, { type: 'failure', failure: 'quota_exceeded' }, true).state,
      ),
    ).toBe(true);
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), fc.boolean(), (events, allow) => {
        const { state } = run(events, allow);
        expect(retryOffered(state)).toBe(state.phase === 'failed');
      }),
    );
  });

  it('lets a view-only author ask questions and summaries and refuses drafts and rewrites with a reason (criterion 6)', () => {
    const viewOnly: Capability[] = ['view'];
    expect(assistantAsk('question', viewOnly)).toEqual({ enabled: true });
    expect(assistantAsk('summary', viewOnly)).toEqual({ enabled: true });
    expect(assistantAsk('draft', viewOnly)).toEqual({ enabled: false, reason: 'no-change' });
    expect(assistantAsk('rewrite', viewOnly)).toEqual({ enabled: false, reason: 'no-change' });
    expect(assistantAsk('draft', ['view', 'suggest'])).toEqual({ enabled: true });
    expect(assistantAsk('rewrite', ['view', 'edit'])).toEqual({ enabled: true });
  });

  it('refuses every request without view, and gates drafts and rewrites on the insertion rule (criterion 6, property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...CAPS), { maxLength: 7 }),
        kindArb,
        (caps, kind) => {
          const offer = assistantAsk(kind, caps);
          if (!caps.includes('view')) {
            expect(offer).toEqual({ enabled: false, reason: 'no-view' });
          } else if (kind === 'question' || kind === 'summary') {
            expect(offer).toEqual({ enabled: true });
          } else {
            expect(offer.enabled).toBe(insertionAllowed(caps));
          }
        },
      ),
    );
  });

  it('names the progress and completion messages for a live region (criterion 7 input only)', () => {
    const running = assistantStep(IDLE, { type: 'start', kind: 'question' }, true).state;
    expect(announcement(IDLE)).toBeNull();
    expect(announcement(running)).toBe('assistant.progress');
    expect(announcement(assistantStep(running, { type: 'response', text: 'x' }, true).state)).toBe(
      'assistant.done',
    );
    expect(
      announcement(
        assistantStep(running, { type: 'failure', failure: 'rate_limited' }, true).state,
      ),
    ).toBe('assistant.error.rate_limited');
    expect(announcement(assistantStep(running, { type: 'cancel' }, true).state)).toBeNull();
  });
});
