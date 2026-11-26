/**
 * FRW-026 criteria 1 and 6: the participants list's service over the editing core and a workflow
 * port (`participantsService`, src/participants.ts), in Node.js. The port is a stand-in that
 * answers as the routes do (FRW-025): `get` the resource (not found until one exists), `put` with
 * `If-Match` ("0" creates), `workflow_active` once the state is not `draft`, and `onChange`.
 * The pane is run in the browser (packages/ui/e2e/frw-026-participants.spec.ts).
 */
import { DocumentCore } from '@docedit/engine/headless';
import type { EditorCore } from '@docedit/engine';
import { PortError, type WorkflowPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { participantsService } from '../src/participants.ts';
import { fieldsDocument, participantAccess } from '../../engine/test/frw-fields-fixture.ts';

const schedule = (run: () => void): void => queueMicrotask(run);

type Workflow = Awaited<ReturnType<WorkflowPort['get']>>['value'];

const ownerAccess = () =>
  ({
    ...participantAccess([]),
    docRole: 'owner',
    caps: ['view', 'comment', 'edit', 'structure', 'manage'],
    fill: undefined,
  }) as unknown as Parameters<DocumentCore['setAccess']>[0];

function setup(initial: Workflow | null, caps: 'owner' | 'viewer' = 'owner') {
  let stored: Workflow | null = initial;
  let rev = initial?.rev ?? 0;
  const puts: { body: Workflow; ifMatch: string }[] = [];
  const changed = new Set<() => void>();
  const port: Pick<WorkflowPort, 'get' | 'put' | 'act' | 'onChange'> = {
    act: async () => {
      throw new PortError('internal', 'not used here');
    },
    onChange: (_doc, cb) => {
      const listener = () => cb({ state: stored?.state ?? 'draft' } as never);
      changed.add(listener);
      return () => changed.delete(listener);
    },
    get: async () => {
      if (!stored) throw new PortError('not_found', 'no workflow');
      return { value: stored, etag: `"${rev}"` };
    },
    put: async (_doc, body, opts) => {
      puts.push({ body, ifMatch: opts.ifMatch });
      if (stored && stored.state !== 'draft') throw new PortError('workflow_active', 'sent');
      if (opts.ifMatch !== `"${rev}"`) throw new PortError('precondition_failed', 'stale');
      rev += 1;
      stored = { ...body, rev };
      return { value: stored, etag: `"${rev}"` };
    },
  };
  const core = new DocumentCore({ doc: fieldsDocument(), schedule });
  core.setAccess(caps === 'owner' ? ownerAccess() : participantAccess([]));
  const service = participantsService(core as unknown as EditorCore, () => ({ port, docId: 'd1' }));
  return {
    core,
    service,
    puts,
    changed,
    /** What a host does with its service credential: writes the list behind the editor's back. */
    hostWrites: (participants: Workflow['participants']) => {
      rev += 1;
      stored = {
        ...(stored ?? { id: 'w1', doc: 'd1', state: 'draft' as const }),
        rev,
        participants,
      };
      for (const l of [...changed]) l();
    },
  };
}

const tenant = {
  name: 'Jane Doe',
  sub: 'u-jane',
  roles: ['role_tenant'],
  kind: 'signer' as const,
  order: 1,
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('adding a participant saves it in the workflow resource (FRW-026 criterion 1)', () => {
  it('creates the resource with the ETag "0" and then replaces it with the current one', async () => {
    const t = setup(null);
    await t.service.prepare?.();
    expect(t.service.state.get()).toBe('draft');
    expect(t.service.participants.get()).toEqual([]);
    expect(t.service.canEdit.get()).toBe(true);

    expect(await t.service.save(tenant)).toEqual({ ok: true });
    expect(t.puts[0]?.ifMatch).toBe('"0"');
    expect(t.puts[0]?.body.participants).toEqual([
      {
        id: 'p1',
        name: 'Jane Doe',
        sub: 'u-jane',
        roles: ['role_tenant'],
        kind: 'signer',
        order: 1,
      },
    ]);

    expect(
      await t.service.save({
        ...tenant,
        name: 'Landlord',
        sub: '',
        roles: ['role_landlord'],
        order: 2,
      }),
    ).toEqual({ ok: true });
    expect(t.puts[1]?.ifMatch).toBe('"1"');
    expect(
      t.service.participants.get().map((p) => [p.id, p.name, p.sub, p.roles, p.kind, p.order]),
    ).toEqual([
      ['p1', 'Jane Doe', 'u-jane', ['role_tenant'], 'signer', 1],
      ['p2', 'Landlord', null, ['role_landlord'], 'signer', 2],
    ]);
  });

  it('changes one participant, keeps the others and removes one', async () => {
    const t = setup(null);
    await t.service.save(tenant);
    await t.service.save({ ...tenant, name: 'Second', sub: 'u-2', order: 1 });
    expect(await t.service.save({ id: 'p1', ...tenant, name: 'Jane Q. Doe', order: 3 })).toEqual({
      ok: true,
    });
    expect(t.service.participants.get().map((p) => [p.id, p.name, p.order])).toEqual([
      ['p1', 'Jane Q. Doe', 3],
      ['p2', 'Second', 1],
    ]);
    expect(await t.service.remove('p2')).toEqual({ ok: true });
    expect(t.service.participants.get().map((p) => p.id)).toEqual(['p1']);
  });

  it('refuses values that are not valid and writes nothing', async () => {
    const t = setup(null);
    expect(await t.service.save({ ...tenant, roles: [] })).toEqual({
      ok: false,
      reason: 'invalid',
      fields: ['roles'],
    });
    expect(await t.service.save({ ...tenant, order: 0 })).toEqual({
      ok: false,
      reason: 'invalid',
      fields: ['order'],
    });
    expect(await t.service.save({ ...tenant, order: 1.5 })).toEqual({
      ok: false,
      reason: 'invalid',
      fields: ['order'],
    });
    expect(await t.service.save({ ...tenant, name: ' ', sub: '' })).toEqual({
      ok: false,
      reason: 'invalid',
      fields: ['name'],
    });
    expect(await t.service.save({ ...tenant, kind: 'witness' as never })).toEqual({
      ok: false,
      reason: 'invalid',
      fields: ['kind'],
    });
    expect(t.puts).toEqual([]);
  });

  it('holds no contact detail: a participant is a sub and a name', async () => {
    const t = setup(null);
    await t.service.save(tenant);
    const written = JSON.stringify(t.puts[0]?.body);
    expect(written).not.toMatch(/mail|phone|tel|address|contact/i);
    expect(Object.keys(t.puts[0]!.body.participants[0]!).sort()).toEqual([
      'id',
      'kind',
      'name',
      'order',
      'roles',
      'sub',
    ]);
  });
});

describe('who may change the list, and when', () => {
  it('is read-only without manage and writes nothing', async () => {
    const t = setup(null, 'viewer');
    expect(t.service.canEdit.get()).toBe(false);
    expect(await t.service.save(tenant)).toEqual({ ok: false, reason: 'forbidden' });
    expect(t.puts).toEqual([]);
  });

  it('is read-only once the workflow is sent, and says so when the server refuses', async () => {
    const t = setup({
      id: 'w1',
      doc: 'd1',
      state: 'sent',
      rev: 4,
      participants: [{ id: 'p1', roles: ['role_tenant'], kind: 'signer', order: 1 }],
    });
    await t.service.prepare?.();
    expect(t.service.canEdit.get()).toBe(false);
    expect(await t.service.save(tenant)).toEqual({ ok: false, reason: 'not_draft' });
    expect(t.puts).toEqual([]);
  });

  it('reads the list again when another writer changed it first', async () => {
    const t = setup(null);
    await t.service.save(tenant);
    // A host changes the resource; the editor has not heard of it yet (no change event).
    const other = {
      id: 'p9',
      roles: ['role_landlord'],
      kind: 'approver' as const,
      order: 2,
      name: 'Host',
    };
    t.hostWrites([
      ...t.service.participants
        .get()
        .map((p) => ({ id: p.id, roles: [...p.roles], kind: p.kind, order: p.order })),
      other,
    ]);
    await settle();
    // Now stale on purpose: bump the stored revision silently.
    t.changed.clear();
    t.hostWrites([other]);
    const outcome = await t.service.save(tenant);
    expect(outcome).toEqual({ ok: false, reason: 'stale' });
    expect(t.service.participants.get().map((p) => p.id)).toEqual(['p9']);
  });
});

describe('people a host wrote appear without being entered again (FRW-026 criterion 6)', () => {
  it('lists them when the editor reads the workflow, and again on each wf.changed', async () => {
    const t = setup({
      id: 'w1',
      doc: 'd1',
      state: 'draft',
      rev: 1,
      participants: [
        {
          id: 'h1',
          roles: ['role_tenant'],
          kind: 'filler',
          order: 1,
          sub: 'host-user-7',
          name: 'Ada',
        },
      ],
    });
    await settle();
    let calls = 0;
    t.service.participants.subscribe(() => calls++);
    expect(t.service.participants.get()).toEqual([
      {
        id: 'h1',
        name: 'Ada',
        sub: 'host-user-7',
        roles: ['role_tenant'],
        kind: 'filler',
        order: 1,
        state: null,
      },
    ]);

    t.hostWrites([
      {
        id: 'h1',
        roles: ['role_tenant'],
        kind: 'filler',
        order: 1,
        sub: 'host-user-7',
        name: 'Ada',
      },
      { id: 'h2', roles: ['role_landlord'], kind: 'signer', order: 2, sub: 'host-user-8' },
    ]);
    await settle();
    expect(t.service.participants.get().map((p) => [p.id, p.name, p.sub])).toEqual([
      ['h1', 'Ada', 'host-user-7'],
      ['h2', null, 'host-user-8'],
    ]);
    expect(calls).toBeGreaterThan(0);

    // The editor can now change what the host wrote, with the host's own revision.
    expect(
      await t.service.save({
        id: 'h2',
        name: 'Bo',
        sub: 'host-user-8',
        roles: ['role_landlord'],
        kind: 'signer',
        order: 2,
      }),
    ).toEqual({ ok: true });
    expect(t.service.participants.get().find((p) => p.id === 'h2')?.name).toBe('Bo');
  });

  it('stops following the port when disposed', async () => {
    const t = setup(null);
    expect(t.changed.size).toBe(1);
    t.service.dispose();
    expect(t.changed.size).toBe(0);
  });
});
