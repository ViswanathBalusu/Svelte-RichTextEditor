// FRW-071: `completeFilling()`, `decline(reason)` and `de-workflow-complete` over the real headless
// core (its `validateFields` and `focusFieldByKey`) and a stand-in workflow port that records the
// calls, in Node.js. The port reports the participant's status as `wf.changed` does. The element's
// methods are one line over `hostApi` and `elementMethods`, checked here as well. The real service
// endpoints are `services/document-service/test/control-plane/frw-047.complete.test.ts` and
// `frw-033.decline-void.test.ts`; no backend implements the workflow port over HTTP yet.
import { DocumentCore } from '@docedit/engine/headless';
import type { WorkflowPort } from '@docedit/protocol';
import { describe, expect, it, beforeAll } from 'vitest';
import type { EditorCore } from '@docedit/engine';
import { fieldsDocument, participantAccess } from '../../engine/test/frw-fields-fixture.ts';
import { SIGN_LANDLORD, SIGN_TENANT, withSignatures } from '../../engine/test/frw-046-fixture.ts';
import { signRequestWatch } from '../src/signing.ts';
import { FillActionError, fillActionsService, type FillActions } from '../src/fill-actions.ts';
import { EVENT_NAMES, type DocEditorEventMap, type DocEditorEventName } from '../src/events.ts';
import { elementMethods, hostApi } from '../src/host-api.ts';
import { Session, type EditorHandle } from '../src/session.ts';
import { coreHost, until } from './core-host.ts';
import { backendFor, service } from './support.ts';
import { loadParts } from '@docedit/engine/headless';

// The forms part holds the entries of the fields (FND-008; parts.ts).
beforeAll(() => loadParts(['forms']));

type Status = Parameters<Parameters<WorkflowPort['onChange']>[1]>[0];
type Call = { participant: string; action: string; body: unknown };

const schedule = (run: () => void): void => queueMicrotask(run);

function setup(initial: Status | null, answer: unknown = { state: 'in_progress' }) {
  const calls: Call[] = [];
  const focused: string[] = [];
  const completed: number[] = [];
  let listener: ((s: Status) => void) | null = null;
  const port: Pick<WorkflowPort, 'participant' | 'onChange'> = {
    onChange: (_doc, cb) => {
      listener = cb;
      if (initial !== null) cb(initial);
      return () => {
        listener = null;
      };
    },
    participant: async (_doc, participant, action, body) => {
      calls.push({ participant, action, body });
      return answer as never;
    },
  };
  const core = new DocumentCore({ doc: fieldsDocument(), schedule });
  const actions = fillActionsService(
    {
      validateFields: () => core.validateFields(),
      focusFieldByKey: (key) => {
        focused.push(key);
        // The headless core has no view; the editor's core focuses the control.
        return (
          (core as { focusFieldByKey?: (k: string) => boolean }).focusFieldByKey?.(key) ?? false
        );
      },
    },
    () => ({ port, docId: 'd1' }),
    () => completed.push(1),
  );
  return { actions, core, calls, focused, completed, send: (s: Status) => listener?.(s) };
}

const ACTIVE: Status = { state: 'in_progress', participant: { id: 'p1', state: 'active' } };

const rejection = async (run: Promise<unknown>): Promise<FillActionError> => {
  try {
    await run;
  } catch (e) {
    expect(e).toBeInstanceOf(FillActionError);
    return e as FillActionError;
  }
  throw new Error('the call did not reject');
};

describe('completeFilling (criterion 1)', () => {
  it('resolves with the failures and focuses the first problem, without calling the server', async () => {
    const t = setup(ACTIVE);
    const failures = t.core.validateFields();
    expect(failures.length).toBeGreaterThan(0);
    const out = await t.actions.completeFilling();
    expect(out).toEqual({ ok: false, failures });
    expect(t.focused).toEqual([failures[0]!.key]);
    expect(t.calls).toEqual([]);
    t.actions.dispose();
  });

  it('calls the participant’s complete endpoint and resolves with the result when nothing fails', async () => {
    const calls: Call[] = [];
    const answer = { id: 'w1', state: 'in_progress' };
    const actions = fillActionsService(
      { validateFields: () => [], focusFieldByKey: () => false },
      () => ({
        docId: 'd1',
        port: {
          onChange: (_doc, cb) => {
            cb(ACTIVE);
            return () => {};
          },
          participant: async (_doc, participant, action, body) => {
            calls.push({ participant, action, body });
            return answer as never;
          },
        },
      }),
      () => {},
    );
    expect(await actions.completeFilling()).toEqual({ ok: true, result: answer });
    expect(calls).toEqual([{ participant: 'p1', action: 'complete', body: undefined }]);
  });

  it('rejects with the server’s error when the server refuses', async () => {
    const refused = new Error('refused');
    const actions = fillActionsService(
      { validateFields: () => [], focusFieldByKey: () => false },
      () => ({
        docId: 'd1',
        port: {
          onChange: (_doc, cb) => {
            cb(ACTIVE);
            return () => {};
          },
          participant: () => Promise.reject(refused),
        },
      }),
      () => {},
    );
    await expect(actions.completeFilling()).rejects.toBe(refused);
  });
});

describe('decline (criterion 2)', () => {
  it('calls the decline endpoint with the reason', async () => {
    const t = setup(ACTIVE);
    await t.actions.decline('  I do not agree  ');
    expect(t.calls).toEqual([
      { participant: 'p1', action: 'decline', body: { reason: 'I do not agree' } },
    ]);
  });

  it('rejects without calling the server when there is no reason', async () => {
    const t = setup(ACTIVE);
    for (const reason of ['', '   ', undefined as unknown as string]) {
      expect((await rejection(t.actions.decline(reason))).reason).toBe('reason_required');
    }
    expect(t.calls).toEqual([]);
  });
});

describe('a participant who is not active (criterion 5)', () => {
  it.each(['waiting', 'unverified', 'completed', 'paused', 'closed', 'copy'])(
    'rejects both methods with the participant’s status %s, and calls nothing',
    async (state) => {
      const t = setup({ state: 'in_progress', participant: { id: 'p1', state } });
      expect((await rejection(t.actions.completeFilling())).reason).toBe(state);
      expect((await rejection(t.actions.decline('no'))).reason).toBe(state);
      expect(t.calls).toEqual([]);
      expect(t.focused).toEqual([]);
    },
  );

  it('rejects when the workflow is not in progress, when no status is known, and with no workflow', async () => {
    const stopped = setup({ state: 'voided', participant: { id: 'p1', state: 'closed' } });
    expect((await rejection(stopped.actions.completeFilling())).reason).toBe('not_in_progress');
    const unknown = setup(null);
    expect((await rejection(unknown.actions.decline('no'))).reason).toBe('no_status');
    const none = fillActionsService(
      { validateFields: () => [], focusFieldByKey: () => false },
      () => null,
      () => {},
    );
    expect((await rejection(none.completeFilling())).reason).toBe('no_workflow');
  });

  it('follows the status: a participant who becomes active may act', async () => {
    const t = setup({ state: 'in_progress', participant: { id: 'p1', state: 'waiting' } });
    expect((await rejection(t.actions.decline('no'))).reason).toBe('waiting');
    t.send(ACTIVE);
    await t.actions.decline('no');
    expect(t.calls).toHaveLength(1);
  });
});

describe('de-workflow-complete (criterion 4)', () => {
  it('is raised once when the workflow is reported completed, and not before', () => {
    const t = setup(ACTIVE);
    expect(t.completed).toEqual([]);
    t.send({ state: 'in_progress', participant: { id: 'p1', state: 'completed' } });
    expect(t.completed).toEqual([]);
    t.send({ state: 'completed', participant: { id: 'p1', state: 'completed' } });
    expect(t.completed).toEqual([1]);
    t.send({ state: 'completed' });
    t.send({ state: 'finalised' });
    expect(t.completed).toEqual([1]);
  });

  it('is raised for a session that opens on a completed workflow', () => {
    expect(setup({ state: 'completed' }).completed).toEqual([1]);
  });

  it('stops after dispose', () => {
    const t = setup(ACTIVE);
    t.actions.dispose();
    t.send({ state: 'completed' });
    expect(t.completed).toEqual([]);
  });
});

describe('the element’s methods', () => {
  const noWorkflow = 'no_workflow';
  it('reject with a reason when the core has no workflow, and with none when no document is loaded', async () => {
    const api = hostApi(new DocumentCore({ doc: fieldsDocument(), schedule }));
    expect((await rejection(api.completeFilling())).reason).toBe(noWorkflow);
    expect((await rejection(api.decline('no'))).reason).toBe(noWorkflow);
    const methods = elementMethods(() => null);
    expect((await rejection(methods.completeFilling())).reason).toBe('no_document');
    expect((await rejection(methods.decline('no'))).reason).toBe('no_document');
  });

  it('forward to the service over the host api', async () => {
    const t = setup(ACTIVE);
    const actions: FillActions = t.actions;
    const api = hostApi(t.core, undefined, actions);
    await api.decline('nope');
    expect(t.calls[0]).toMatchObject({ action: 'decline' });
    expect(await api.completeFilling()).toMatchObject({ ok: false });
  });
});

describe('a session raises de-workflow-complete (criterion 4)', () => {
  it('names the event, raises it with the state when the editor reports it, and stops at close', async () => {
    expect(EVENT_NAMES).toContain('de-workflow-complete');
    const { service: s, docId } = service();
    const backend = backendFor(s, docId, 'editor', 'editor');
    const host = coreHost();
    const raised: { name: DocEditorEventName; detail: unknown }[] = [];
    const listeners = new Set<() => void>();
    const mount = host.mount.bind(host);
    const session = new Session({
      docId,
      backend,
      ownsBackend: false,
      host: {
        emit<K extends DocEditorEventName>(name: K, detail: DocEditorEventMap[K]) {
          raised.push({ name, detail });
        },
        async mount(content) {
          const handle = await mount(content);
          const withComplete: EditorHandle = {
            ...handle,
            workflowComplete: {
              subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
              },
            },
          };
          return withComplete;
        },
      },
    });
    await session.start();
    await until(() => raised.some((e) => e.name === 'de-ready'), 'de-ready');
    const complete = () => raised.filter((e) => e.name === 'de-workflow-complete');
    expect(complete()).toEqual([]);
    for (const listener of [...listeners]) listener();
    expect(complete()).toEqual([{ name: 'de-workflow-complete', detail: { state: 'completed' } }]);
    await session.close();
    expect(listeners.size).toBe(0);
  });
});

describe('de-sign-request (criterion 3)', () => {
  const newCore = () =>
    new DocumentCore({
      doc: withSignatures(),
      mode: 'fill',
      access: participantAccess(['role_tenant']),
      schedule,
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('names the field and its key each time the participant starts to sign, and not for a field of another role', async () => {
    const core = newCore();
    const fields: Array<{ fieldId: string; key: string }> = [];
    const stop = signRequestWatch(core as unknown as EditorCore).subscribe((f) => fields.push(f));
    expect(core.requestSign(SIGN_TENANT)).toBe(true);
    await settle();
    expect(fields).toEqual([{ fieldId: SIGN_TENANT, key: 'tenant.signature' }]);
    // Closing the step raises nothing; starting again raises the event again.
    core.clearSignRequest();
    await settle();
    expect(fields).toHaveLength(1);
    expect(core.requestSign(SIGN_TENANT)).toBe(true);
    await settle();
    expect(fields).toHaveLength(2);
    // A field the participant may not sign makes no request and no event.
    expect(core.requestSign(SIGN_LANDLORD)).toBe(false);
    await settle();
    expect(fields).toHaveLength(2);
    stop();
    core.clearSignRequest();
    core.requestSign(SIGN_TENANT);
    await settle();
    expect(fields).toHaveLength(2);
  });

  it('does not raise a request that was open before the listener was added', async () => {
    const core = newCore();
    core.requestSign(SIGN_TENANT);
    const fields: unknown[] = [];
    signRequestWatch(core as unknown as EditorCore).subscribe((f) => fields.push(f));
    await settle();
    expect(fields).toEqual([]);
  });

  it('is named by the element, raised by a session with the field and key, and stops at close', async () => {
    expect(EVENT_NAMES).toContain('de-sign-request');
    const { service: s, docId } = service();
    const backend = backendFor(s, docId, 'editor', 'editor');
    const host = coreHost();
    const raised: { name: DocEditorEventName; detail: unknown }[] = [];
    const listeners = new Set<(f: { fieldId: string; key: string }) => void>();
    const mount = host.mount.bind(host);
    const session = new Session({
      docId,
      backend,
      ownsBackend: false,
      host: {
        emit<K extends DocEditorEventName>(name: K, detail: DocEditorEventMap[K]) {
          raised.push({ name, detail });
        },
        async mount(content) {
          const handle = await mount(content);
          const withSign: EditorHandle = {
            ...handle,
            signRequested: {
              subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
              },
            },
          };
          return withSign;
        },
      },
    });
    await session.start();
    await until(() => raised.some((e) => e.name === 'de-ready'), 'de-ready');
    for (const listener of [...listeners]) listener({ fieldId: 'f1', key: 'tenant.signature' });
    expect(raised.filter((e) => e.name === 'de-sign-request')).toEqual([
      { name: 'de-sign-request', detail: { fieldId: 'f1', key: 'tenant.signature' } },
    ]);
    await session.close();
    expect(listeners.size).toBe(0);
  });
});
