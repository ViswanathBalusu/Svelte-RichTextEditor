// FRW-039 criterion 6, the element's half: the participant's status `unverified` reaches the guided
// bar as the reason it is inactive, and the code the input submits goes to the participant's verify
// endpoint through the workflow port, with the refusals mapped to what the input tells. The input
// itself (label, paste, live region, keyboard) is `packages/ui/e2e/frw-039-access-code.spec.ts`; the
// service is `services/document-service/test/control-plane/frw-039.access-code.test.ts`. Node.js.
import { PortError, type WorkflowPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { fillActionsService } from '../src/fill-actions.ts';
import { fillView, type FillSource } from '../src/fill.ts';

type Status = Parameters<Parameters<WorkflowPort['onChange']>[1]>[0];
type Call = { doc: string; participant: string; action: string; body: unknown };

function view<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(next: T) {
      value = next;
      for (const l of [...listeners]) l();
    },
  };
}

function setup(answer: () => unknown = () => ({ state: 'in_progress' })) {
  const calls: Call[] = [];
  let listener: ((s: Status) => void) | null = null;
  const port: Pick<WorkflowPort, 'participant' | 'onChange'> = {
    onChange: (_doc, cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    participant: async (doc, participant, action, body) => {
      calls.push({ doc, participant, action, body });
      const r = answer();
      if (r instanceof Error) throw r;
      return r as never;
    },
  };
  const actions = fillActionsService(
    { validateFields: () => [], focusFieldByKey: () => false },
    () => ({ port, docId: 'd1' }),
    () => {},
  );
  const permissions = view<{ fill: { roles: string[]; active: boolean } | null } | null>({
    fill: { roles: ['role_tenant'], active: false },
  });
  const source: FillSource = {
    revision: view(0),
    mode: view({ effective: 'fill' }),
    permissions,
    fillFields: () => [],
  };
  return {
    actions,
    calls,
    permissions,
    fill: fillView(source, actions.status),
    push: (s: Status) => listener?.(s),
  };
}

const UNVERIFIED: Status = { state: 'in_progress', participant: { id: 'p1', state: 'unverified' } };

describe('the status unverified reaches the guided bar (FRW-039 criterion 6)', () => {
  it('says unverified while the code is outstanding, then nothing once the participant is active', () => {
    const { fill, push, permissions } = setup();
    push(UNVERIFIED);
    expect(fill.get()).toMatchObject({ active: false, inactive: 'unverified' });
    // The right code: the access follows with `active`, and the status with it.
    permissions.set({ fill: { roles: ['role_tenant'], active: true } });
    push({ state: 'in_progress', participant: { id: 'p1', state: 'active' } });
    expect(fill.get()?.active).toBe(true);
    expect(fill.get()).not.toHaveProperty('inactive');
  });
});

describe('the code goes to the participant’s verify endpoint (FRW-039 criterion 6)', () => {
  it('posts the code for the participant the server named, and nothing else', async () => {
    const { actions, calls, push } = setup();
    push(UNVERIFIED);
    expect(await actions.verify('abc 123')).toEqual({ ok: true });
    expect(calls).toEqual([
      { doc: 'd1', participant: 'p1', action: 'verify', body: { code: 'abc 123' } },
    ]);
  });

  it('maps a refused code, too many attempts and any other failure', async () => {
    let next: unknown = new PortError('forbidden', 'no');
    const { actions, push } = setup(() => next);
    push(UNVERIFIED);
    expect(await actions.verify('x')).toEqual({ ok: false, reason: 'wrong' });
    next = new PortError('rate_limited', 'slow down', { retryAfterMs: 7000 });
    expect(await actions.verify('x')).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterMs: 7000,
    });
    // The problem body's own member counts when the header is missing.
    next = new PortError('rate_limited', 'slow down', { details: { retryAfterMs: 2000 } });
    expect(await actions.verify('x')).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterMs: 2000,
    });
    next = new PortError('rate_limited', 'slow down');
    expect(await actions.verify('x')).toEqual({ ok: false, reason: 'rate_limited' });
    next = new PortError('unavailable', 'down');
    expect(await actions.verify('x')).toEqual({ ok: false, reason: 'failed' });
    next = new Error('network');
    expect(await actions.verify('x')).toEqual({ ok: false, reason: 'failed' });
  });

  it('calls nothing before the server has said who the participant is', async () => {
    const { actions, calls } = setup();
    expect(await actions.verify('x')).toEqual({ ok: false, reason: 'failed' });
    expect(calls).toEqual([]);
  });
});
