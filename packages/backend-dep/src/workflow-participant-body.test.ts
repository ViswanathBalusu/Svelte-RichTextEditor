/**
 * A participant action without a body (UX-106): the published operations of `complete` and the
 * other participant actions take a JSON body, and the service answers `validation_failed` ("the
 * route needs a body") to a request without one. The port sends `{}` then, and what it was given
 * otherwise (the reason of a decline).
 */
import { describe, expect, it } from 'vitest';
import { createWorkflowRest } from './workflow.ts';
import type { RestClient } from './rest.ts';

function portWithCalls() {
  const calls: Array<{ method: string; url: string; init: unknown }> = [];
  const rest = {
    call: (method: string, url: string, init: unknown) => {
      calls.push({ method, url, init });
      return Promise.resolve({ value: {}, etag: undefined });
    },
  } as unknown as RestClient;
  return { port: createWorkflowRest({ rest: () => Promise.resolve(rest) }), calls };
}

describe('participant actions of the workflow port', () => {
  it('send an empty JSON object when the action has no body', async () => {
    const { port, calls } = portWithCalls();
    await port.participant('d1', 'p1', 'complete');
    expect(calls).toEqual([
      {
        method: 'POST',
        url: '/documents/d1/workflow/participants/p1/complete',
        init: { body: {} },
      },
    ]);
  });

  it('send the body they were given', async () => {
    const { port, calls } = portWithCalls();
    await port.participant('d1', 'p1', 'decline', { reason: 'No' });
    expect(calls[0]?.init).toEqual({ body: { reason: 'No' } });
  });
});
