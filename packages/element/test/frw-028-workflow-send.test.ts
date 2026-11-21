/**
 * FRW-028: the send dialog's service over the editing core and a workflow port
 * (`workflowSendService`, src/workflow-send.ts), in Node.js. The port is a stand-in that answers as
 * the service does (FRW-027 route): `get` the workflow resource, `act('send')` sends it or refuses
 * with a problem whose violations name the failures. The dialog is run in the browser
 * (packages/ui/e2e/frw-028-send-dialog.spec.ts).
 */
import { DocumentCore, loadParts } from '@docedit/engine/headless';
import type { EditorCore } from '@docedit/engine';
import { PortError, type WorkflowPort } from '@docedit/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { refusal, workflowSendService } from '../src/workflow-send.ts';
import { fieldsDocument } from '../../engine/test/frw-fields-fixture.ts';

// The rules language loads on first use (FND-008; engine parts.ts).
beforeAll(() => loadParts(['rules']));

const schedule = (run: () => void): void => queueMicrotask(run);

type Workflow = Awaited<ReturnType<WorkflowPort['get']>>['value'];

const workflow = (state: Workflow['state'], roles: string[][]): Workflow => ({
  id: 'w1',
  doc: 'd1',
  state,
  rev: 1,
  participants: roles.map((r, i) => ({ id: `p${i + 1}`, roles: r, kind: 'filler', order: 1 })),
});

function setup(initial: Workflow | PortError, onAct?: () => unknown) {
  let current: Workflow | PortError = initial;
  const acts: string[] = [];
  const changed = new Set<() => void>();
  const port: Pick<WorkflowPort, 'get' | 'act' | 'onChange'> = {
    onChange: (_doc, cb) => {
      const listener = () => cb({ state: 'in_progress' });
      changed.add(listener);
      return () => changed.delete(listener);
    },
    get: async () => {
      if (current instanceof PortError) throw current;
      return { value: current, etag: '"1"' };
    },
    act: async (_doc, action) => {
      acts.push(action);
      const result = onAct?.();
      if (result instanceof PortError) throw result;
      if (current instanceof PortError) throw current;
      current = { ...current, state: 'sent' };
      return { value: current, etag: '"2"' };
    },
  };
  const core = new DocumentCore({ doc: fieldsDocument(), schedule });
  const service = workflowSendService(core as unknown as EditorCore, () => ({
    port,
    docId: 'd1',
  }));
  return {
    core,
    service,
    acts,
    changed,
    set: (next: Workflow) => void (current = next),
  };
}

const BOTH = [['role_tenant'], ['role_landlord']];

describe('the checks and the state come from the workflow resource (FRW-028 criteria 1 and 4)', () => {
  it('has no state until the resource is read, then the state and the failed role check', async () => {
    const { service } = setup(workflow('draft', [['role_tenant']]));
    expect(service.state.get()).toBeNull();
    await service.refresh();
    expect(service.state.get()).toBe('draft');
    expect(service.failures.get()).toEqual([
      { code: 'role_without_participant', roles: ['role_landlord'] },
    ]);
  });

  it('tells its listeners when the state and the failures change', async () => {
    const { service } = setup(workflow('draft', BOTH));
    let states = 0;
    let checks = 0;
    service.state.subscribe(() => states++);
    service.failures.subscribe(() => checks++);
    await service.refresh();
    expect(states).toBe(1);
    expect(checks).toBeGreaterThan(0);
    expect(service.failures.get()).toEqual([]);
  });

  it('treats a document without a workflow resource as a draft with nobody bound', async () => {
    const { service } = setup(new PortError('not_found', 'no workflow'));
    await service.refresh();
    expect(service.state.get()).toBe('draft');
    expect(service.failures.get().map((f) => f.code)).toEqual(['role_without_participant']);
  });

  it('keeps the same list object while the failures are the same', async () => {
    const { service } = setup(workflow('draft', [['role_tenant']]));
    await service.refresh();
    expect(service.failures.get()).toBe(service.failures.get());
  });
});

describe('sending (FRW-028 criterion 3)', () => {
  it('asks the port to send, and the state follows the answer', async () => {
    const { service, acts } = setup(workflow('draft', BOTH));
    await service.refresh();
    expect(await service.send()).toEqual({ ok: true, state: 'sent' });
    expect(acts).toEqual(['send']);
    expect(service.state.get()).toBe('sent');
  });
});

describe('a send the server refuses (FRW-028 criterion 4)', () => {
  it('returns the failures the problem names, as the server counted them', async () => {
    const refused = new PortError('validation_failed', 'checks failed', {
      details: {
        violations: [
          { path: '/fields/tenant.email', rule: 'a required field has an assignee' },
          { path: '/roles/role_landlord', rule: 'a role has a participant who holds it' },
        ],
      },
    });
    // The editor thinks every check passes; the server disagrees.
    const { service } = setup(workflow('draft', BOTH), () => refused);
    await service.refresh();
    expect(service.failures.get()).toEqual([]);
    expect(await service.send()).toEqual({
      ok: false,
      reason: 'checklist_failed',
      failures: [
        { code: 'required_field_unassigned', keys: ['tenant.email'] },
        { code: 'role_without_participant', roles: ['role_landlord'] },
      ],
    });
    expect(service.state.get()).toBe('draft');
  });

  it('reads a pending_suggestions refusal, with or without the identifier', () => {
    expect(
      refusal(
        new PortError('pending_suggestions', 'x', {
          details: { violations: [{ path: '/suggestions/s1' }] },
        }),
      ),
    ).toEqual({
      ok: false,
      reason: 'checklist_failed',
      failures: [{ code: 'pending_suggestions', suggestionIds: ['s1'] }],
    });
    expect(refusal(new PortError('pending_suggestions', 'x'))).toEqual({
      ok: false,
      reason: 'checklist_failed',
      failures: [{ code: 'pending_suggestions', suggestionIds: [null] }],
    });
  });

  it('maps the other refusals: forbidden, a workflow no longer a draft, anything else', () => {
    expect(refusal(new PortError('forbidden', 'x'))).toEqual({ ok: false, reason: 'forbidden' });
    expect(refusal(new PortError('conflict', 'x'))).toEqual({ ok: false, reason: 'not_draft' });
    expect(refusal(new PortError('workflow_active', 'x'))).toEqual({
      ok: false,
      reason: 'not_draft',
    });
    expect(refusal(new PortError('validation_failed', 'x'))).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(refusal(new PortError('unavailable', 'x'))).toEqual({ ok: false, reason: 'failed' });
    expect(refusal(new Error('network'))).toEqual({ ok: false, reason: 'failed' });
  });

  it('reads the workflow again after a conflict, so the state is the server’s', async () => {
    const { service } = setup(workflow('sent', BOTH), () => new PortError('conflict', 'sent'));
    expect(await service.send()).toEqual({ ok: false, reason: 'not_draft' });
    expect(service.state.get()).toBe('sent');
  });
});

describe('the lock banner follows the workflow (FRW-029 criterion 6)', () => {
  const running = (): Workflow => ({
    ...workflow('in_progress', BOTH),
    participants: [
      { id: 'p1', roles: ['role_tenant'], kind: 'filler', order: 1, name: 'Ada', state: 'active' },
      { id: 'p2', roles: ['role_landlord'], kind: 'signer', order: 2, state: 'pending' },
    ],
  });

  it('reads the workflow when it is made, without the dialog being opened', async () => {
    const { service } = setup(running());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.state.get()).toBe('in_progress');
    expect(service.participants.get()).toEqual([
      { id: 'p1', name: 'Ada', roles: ['role_tenant'], state: 'active' },
      { id: 'p2', name: null, roles: ['role_landlord'], state: 'pending' },
    ]);
  });

  it('reads it again when the port reports wf.changed, and tells its listeners once per real change', async () => {
    const { service, changed, set } = setup(running());
    await new Promise((resolve) => setTimeout(resolve, 0));
    let heard = 0;
    service.participants.subscribe(() => heard++);
    // The same workflow again: the view is not replaced.
    for (const listener of [...changed]) listener();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toBe(0);
    const moved = running();
    moved.participants[0]!.state = 'completed';
    moved.participants[1]!.state = 'active';
    set(moved);
    for (const listener of [...changed]) listener();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toBe(1);
    expect(service.participants.get().map((p) => p.state)).toEqual(['completed', 'active']);
  });

  it('stops following the port when it is disposed', async () => {
    const { service, changed } = setup(running());
    expect(changed.size).toBe(1);
    service.dispose?.();
    expect(changed.size).toBe(0);
  });
});
