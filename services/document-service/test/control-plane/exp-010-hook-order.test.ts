// EXP-010 criterion 3: the host's pre-export policy hook runs before the job is created, and a
// refusal by it stops the request with a reason the caller can read (13 section 10; 05 section 7).
// The gate is a stub that looks at the queue while the request waits for it, so the test shows the
// order: at the moment the hook is asked, the document has no export job; after a refusal it still
// has none; after an allow it has one. The sender and the signed request are tested in
// ux-086-policy-hook.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  HookAsk,
  HookOutcome,
  PolicyHookGate,
} from '../../src/control-plane/policy-hook-client.ts';
import { EXPORT_KIND } from '../../src/control-plane/exports.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const REASON = 'Exports of this classification need the data owner to agree first.';

describe('EXP-010 the policy hook runs before the export job exists (criterion 3)', () => {
  let h: Harness;
  const state = {
    answer: 'allow' as 'allow' | 'deny',
    asked: [] as HookAsk[],
    jobsWhenAsked: [] as boolean[],
    doc: '',
  };

  const gate: PolicyHookGate = {
    async ask(input: HookAsk): Promise<HookOutcome> {
      state.asked.push(input);
      // The request is waiting for this answer: a job here would mean the hook came too late.
      state.jobsWhenAsked.push(
        (await h.parts.queue.latestFor(h.tenant, input.document, EXPORT_KIND)) !== null,
      );
      return state.answer === 'allow'
        ? { kind: 'decided', decision: { allow: true } }
        : { kind: 'decided', decision: { allow: false, reason: REASON } };
    },
  };

  beforeAll(async () => {
    h = await startHarness('memory', { parts: { policyHook: gate } });
  });
  afterAll(async () => {
    await h.close();
  });

  const request = (doc: string) =>
    h.call('POST', `/v1/documents/${doc}/exports`, {
      token: h.userToken({ [doc]: 'editor' }),
      body: { target: 'pdf' },
    });

  it('asks the hook before any job exists, and starts the job when the hook allows it', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    state.answer = 'allow';
    state.asked = [];
    state.jobsWhenAsked = [];
    const r = await request(doc);
    expect(r.status, r.text).toBe(202);
    expect(state.asked).toHaveLength(1);
    expect(state.asked[0]).toMatchObject({ document: doc, action: 'export', target: 'pdf' });
    expect(state.jobsWhenAsked).toEqual([false]);
    expect(await h.parts.queue.latestFor(h.tenant, doc, EXPORT_KIND)).not.toBeNull();
  });

  it('stops the request on a refusal, with the hook reason in the answer and no job', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    state.answer = 'deny';
    state.asked = [];
    state.jobsWhenAsked = [];
    const r = await request(doc);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('forbidden');
    expect(r.text).toContain(REASON);
    expect(state.jobsWhenAsked).toEqual([false]);
    expect(await h.parts.queue.latestFor(h.tenant, doc, EXPORT_KIND)).toBeNull();
  });

  it('does not ask the hook for a caller the permission check refuses first', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    state.answer = 'allow';
    state.asked = [];
    const restricted = h.userToken({ [doc]: 'owner' }, { restrict: ['no-export'] });
    const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: restricted,
      body: { target: 'pdf' },
    });
    expect(r.status).toBe(403);
    expect(state.asked).toEqual([]);
  });
});
