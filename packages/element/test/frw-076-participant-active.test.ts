// FRW-076 criterion 7: a participant who is not active sees the bar say so and has read-only
// fields; when the access that follows `wf.changed` (`perm.changed`, FRW-035 criterion 2) makes the
// participant active, the same editor lets the fields be filled, without a reload. The real
// headless core, the element's fill view and its fill actions over a stand-in workflow port. The
// server half (a transition recomputes the flag and pushes `perm.changed` and `wf.changed`) is
// `packages/authority/test/frw-035.workflow-push.test.ts`. Node.js, no DOM.
import { DocumentCore } from '@docedit/engine/headless';
import type { WorkflowPort } from '@docedit/protocol';
import { describe, expect, it, beforeAll } from 'vitest';
import { fillActionsService } from '../src/fill-actions.ts';
import { fillView, type FillSource } from '../src/fill.ts';
import {
  FIELD_IDS,
  fieldsDocument,
  participantAccess,
} from '../../engine/test/frw-fields-fixture.ts';
import { loadParts } from '@docedit/engine/headless';

// The forms part holds the entries of the fields (FND-008; parts.ts).
beforeAll(() => loadParts(['forms']));

type Status = Parameters<Parameters<WorkflowPort['onChange']>[1]>[0];

const schedule = (run: () => void): void => queueMicrotask(run);

describe('a participant who becomes active can fill without a reload (FRW-076 criterion 7)', () => {
  function setup() {
    const listeners = new Set<(s: Status) => void>();
    const port: Pick<WorkflowPort, 'get' | 'act' | 'onChange'> = {
      onChange: (_doc, cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      get: async () => {
        throw new Error('a participant does not read the resource');
      },
      act: async () => {
        throw new Error('no');
      },
    };
    const core = new DocumentCore({
      doc: fieldsDocument(),
      mode: 'fill',
      access: { ...participantAccess(['role_tenant'], false), rev: 2 },
      schedule,
    });
    const actions = fillActionsService(
      { validateFields: () => [], focusFieldByKey: () => false },
      () => ({ port, docId: 'd1' }),
      () => {},
    );
    const fill = fillView(core as unknown as FillSource, actions.status);
    const push = (s: Status) => {
      for (const l of [...listeners]) l(s);
    };
    return { core, fill, push };
  }

  it('shows the bar a reason and keeps every field read-only while the participant waits', () => {
    const { core, fill, push } = setup();
    expect(core.fieldFillable(FIELD_IDS.name)).toBe(false);
    expect(fill.get()).toMatchObject({ active: false, inactive: 'waiting' });
    push({ state: 'in_progress', participant: { id: 'p1', state: 'waiting' } });
    expect(fill.get()).toMatchObject({ active: false, inactive: 'waiting' });
    push({ state: 'correcting', participant: { id: 'p1', state: 'paused' } });
    expect(fill.get()).toMatchObject({ active: false, inactive: 'paused' });
    expect(core.fieldFillable(FIELD_IDS.name)).toBe(false);
  });

  it('opens the fields of the participant when the access says active, and tells the bar', () => {
    const { core, fill, push } = setup();
    let heard = 0;
    fill.subscribe(() => heard++);
    expect(core.fieldFillable(FIELD_IDS.name)).toBe(false);
    // The server's transition pushes `perm.changed` (the access, active) and `wf.changed`.
    core.setAccess({ ...participantAccess(['role_tenant'], true), rev: 3 });
    push({ state: 'in_progress', participant: { id: 'p1', state: 'active' } });
    expect(core.fieldFillable(FIELD_IDS.name)).toBe(true);
    const now = fill.get();
    expect(now?.active).toBe(true);
    expect(now).not.toHaveProperty('inactive');
    expect(heard).toBeGreaterThan(0);
    // A field of another role stays closed.
    expect(core.fieldFillable(FIELD_IDS.landlord)).toBe(false);
  });

  it('closes them again when the participant is paused', () => {
    const { core, fill, push } = setup();
    core.setAccess({ ...participantAccess(['role_tenant'], true), rev: 3 });
    expect(core.fieldFillable(FIELD_IDS.name)).toBe(true);
    core.setAccess({ ...participantAccess(['role_tenant'], false), rev: 4 });
    push({ state: 'correcting', participant: { id: 'p1', state: 'paused' } });
    expect(core.fieldFillable(FIELD_IDS.name)).toBe(false);
    expect(fill.get()).toMatchObject({ active: false, inactive: 'paused' });
  });
});
