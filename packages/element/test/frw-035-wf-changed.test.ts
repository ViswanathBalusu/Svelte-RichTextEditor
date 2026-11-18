// FRW-035 criterion 6: the editor receives `wf.changed` and the guided bar and the lock indicator
// follow without a reload. The port is a stand-in that reports the object as the channel does
// (`ch.opened.workflow`, then `wf.changed`), to every listener; the real port over the wire is
// `packages/backend-dep/src/frw-035.workflow-port.universal.test.ts`. The services are those the
// editor makes: the send service (the lock banner's state), the fill actions (the participant's
// status) and the fill view (the bar's summary). Node.js, no DOM.
import { DocumentCore } from '@docedit/engine/headless';
import type { EditorCore } from '@docedit/engine';
import { PortError, type WorkflowPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { fillActionsService } from '../src/fill-actions.ts';
import { fillView, type FillSource } from '../src/fill.ts';
import { workflowSendService } from '../src/workflow-send.ts';
import { fieldsDocument } from '../../engine/test/frw-fields-fixture.ts';

type Status = Parameters<Parameters<WorkflowPort['onChange']>[1]>[0];

const schedule = (run: () => void): void => queueMicrotask(run);

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

function setup() {
  const listeners = new Set<(s: Status) => void>();
  // A participant may not read the workflow resource: `get` is refused, only the push tells.
  const port: Pick<WorkflowPort, 'get' | 'act' | 'onChange'> = {
    onChange: (_doc, cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    get: async () => {
      throw new PortError('forbidden', 'the participant may not read the workflow');
    },
    act: async () => {
      throw new PortError('forbidden', 'no');
    },
  };
  const core = new DocumentCore({ doc: fieldsDocument(), schedule });
  const source = () => ({ port, docId: 'd1' });
  const send = workflowSendService(core as unknown as EditorCore, source);
  const actions = fillActionsService(
    { validateFields: () => [], focusFieldByKey: () => false },
    source,
    () => {},
  );
  const permissions = view<{
    fill: { roles: string[]; active: boolean } | null;
  } | null>({ fill: { roles: ['role_tenant'], active: false } });
  const source2: FillSource = {
    revision: view(0),
    mode: view({ effective: 'fill' }),
    permissions,
    fillFields: () => [],
  };
  const fill = fillView(source2, actions.status);
  return {
    send,
    actions,
    permissions,
    fill,
    push: (s: Status) => {
      for (const l of [...listeners]) l(s);
    },
    listeners,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the editor follows wf.changed without a reload (FRW-035 criterion 6)', () => {
  it('moves the lock indicator state at once, though the participant cannot read the resource', async () => {
    const { send, push } = setup();
    expect(send.state.get()).toBeNull();
    let heard = 0;
    send.state.subscribe(() => heard++);
    push({ state: 'in_progress', participant: { id: 'p1', state: 'waiting' } });
    expect(send.state.get()).toBe('in_progress');
    push({ state: 'correcting', participant: { id: 'p1', state: 'paused' } });
    expect(send.state.get()).toBe('correcting');
    push({ state: 'voided' });
    await tick();
    expect(send.state.get()).toBe('voided');
    expect(heard).toBe(3);
    // The same state again is not a change.
    push({ state: 'voided' });
    expect(heard).toBe(3);
  });

  it('tells the guided bar whether the participant is waiting or paused', () => {
    const { fill, push, permissions } = setup();
    let heard = 0;
    fill.subscribe(() => heard++);
    // Before anything is reported the bar reads waiting.
    expect(fill.get()).toMatchObject({ active: false, inactive: 'waiting' });

    push({ state: 'in_progress', participant: { id: 'p1', state: 'waiting' } });
    expect(fill.get()).toMatchObject({ active: false, inactive: 'waiting' });

    push({ state: 'correcting', participant: { id: 'p1', state: 'paused' } });
    expect(fill.get()).toMatchObject({ active: false, inactive: 'paused' });
    expect(heard).toBeGreaterThan(0);

    // The access that follows (`perm.changed`) makes the participant active: no reason is shown.
    permissions.set({ fill: { roles: ['role_tenant'], active: true } });
    push({ state: 'in_progress', participant: { id: 'p1', state: 'active' } });
    const now = fill.get();
    expect(now?.active).toBe(true);
    expect(now).not.toHaveProperty('inactive');
  });

  it('stops following when the services are disposed', () => {
    const { send, actions, listeners } = setup();
    expect(listeners.size).toBe(2);
    send.dispose?.();
    actions.dispose();
    expect(listeners.size).toBe(0);
  });
});
