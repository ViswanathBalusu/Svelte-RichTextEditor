/**
 * PRM-024 criteria 1 and 2 at the engine: a `permission_denied` rejection reaches the recovered
 * edits with the scope it refused, and with who changed the permissions and when when the client
 * knows it (07 §9). End to end through the mock service (authority room, protocol bridge, sync
 * session) for the region scope and a server-authored change; at the state machine for a change
 * attributed to a person, which the mock service never makes (its control commits are `system`).
 */
import type { RemoteCommit, SyncChannel, SyncReject } from '@docedit/protocol';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { editingSchema } from '../src/schema.ts';
import {
  type SyncState,
  initialState,
  local,
  receiveCommits,
  receiveReject,
  takeCommit,
} from '../src/sync/state.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, join, microtask, newService, posOf, sleep, type, until } from './support.ts';

describe('a permission rejection names the part it refused (PRM-024 criterion 1)', () => {
  it('reaches the recovered edits with the region scope the server named', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const g = await join(service, docId, 'grace', 'editor', {}, { groups: ['legal'] });
    const hold = service.holdWrites(docId);
    caret(g.core, IDS.lockedPara, 0);
    type(g.core, 'clause ');
    await sleep(5); // in flight, its write held
    service.setGrants(docId, []); // the region is no longer grace's
    await hold.release();
    await until(() => g.core.saveState.get() === 'saved', 'saved', 5000);

    const item = g.core.recovered.get().items.find((r) => r.reason === 'permission_denied');
    expect(item).toBeDefined();
    expect(item!.text).toBe('clause ');
    expect(item!.scope).toBe(`region:${IDS.locked}`);
    expect(item!.scopes).toContain(`region:${IDS.locked}`);
    // The mock service records the change as a server-authored control commit (author `system`):
    // the client does not know who changed the permissions (criterion 2, "otherwise").
    expect(item!.changedBy ?? null).toBeNull();
    expect(item!.changedAt).toEqual(expect.any(String));
    g.detach();
    await service.dispose();
  });

  it('gives no scope or changer for a rejection of another kind', () => {
    const schema = editingSchema();
    let s: SyncState = initialState(schema.nodeFromJSON(contractDocument().doc), 3, 'inc-1');
    const tr = new Transform(s.visible).insert(posOf(s.visible, IDS.intro) + 1, schema.text('x'));
    s = local(s, tr.steps, tr.doc);
    s = takeCommit(s, 'c1', { maxStepsPerCommit: 500, maxCommitBytes: 1 << 20 })!.state;
    const reject: SyncReject = {
      id: 'c1',
      code: 'conflict',
      message: 'another commit changed the same field',
      action: 'drop',
      head: 3,
    };
    const d = receiveReject(s, reject).state.discarded;
    expect(d).toHaveLength(1);
    expect(d[0]!.scopes).toBeUndefined();
    expect(d[0]!.change).toBeUndefined();
  });
});

describe('who changed the permissions, and when (PRM-024 criterion 2)', () => {
  const schema = editingSchema();
  const limits = { maxStepsPerCommit: 500, maxCommitBytes: 1 << 20 };

  function inFlight(): SyncState {
    let s: SyncState = initialState(schema.nodeFromJSON(contractDocument().doc), 3, 'inc-1');
    const tr = new Transform(s.visible).insert(
      posOf(s.visible, IDS.lockedPara) + 1,
      schema.text('clause '),
    );
    s = local(s, tr.steps, tr.doc);
    return takeCommit(s, 'c1', limits)!.state;
  }

  const control = (user: string, at: string): RemoteCommit => ({
    seq: 4,
    kind: 'control',
    id: 'ctl-4',
    steps: [],
    control: { type: 'grants', rev: 2 },
    author: { user, session: null, agent: null },
    serverTime: at,
    origin: 'control',
  });

  const denied: SyncReject = {
    id: 'c1',
    code: 'permission_denied',
    message: 'No edit permission',
    action: 'drop',
    head: 4,
    scopes: [`region:${IDS.locked}`],
  };

  it('keeps the author and time of the control commit before the rejection', () => {
    let s = inFlight();
    s = receiveCommits(s, [control('u-owner', '2026-11-13T09:30:00.000Z')], schema).state;
    const d = receiveReject(s, denied).state.discarded;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      reason: 'permission_denied',
      text: 'clause ',
      scopes: [`region:${IDS.locked}`],
      change: { user: 'u-owner', time: '2026-11-13T09:30:00.000Z', seq: 4 },
    });
  });

  it('knows no person for a server-authored change, and nothing without a control commit', () => {
    let s = inFlight();
    s = receiveCommits(s, [control('system', '2026-11-13T09:30:00.000Z')], schema).state;
    expect(receiveReject(s, denied).state.discarded[0]!.change).toEqual({
      user: null,
      time: '2026-11-13T09:30:00.000Z',
      seq: 4,
    });
    expect(receiveReject(inFlight(), denied).state.discarded[0]!.change).toBeNull();
  });

  it('reaches the core’s recovered edits as changedBy and changedAt, end to end', async () => {
    // The mock service attributes its control commits to `system`; a host that attributes them to
    // the person who changed the grants (04 §10) is played by rewriting the author on the channel.
    const service = newService();
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const backend = service.backend({ sub: 'grace', groups: ['legal'] }, { [docId]: 'editor' });
    await backend.connect();
    const content = await backend.sync.loadContent(docId);
    const core = new DocumentCore({ doc: content, schedule: microtask });
    const real = await backend.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    const seen: RemoteCommit[] = [];
    const channel: SyncChannel = {
      ...real,
      docId: real.docId,
      opened: real.opened,
      submit: (c) => real.submit(c),
      onCommits: (cb) =>
        real.onCommits((commits) =>
          cb(
            commits.map((c) => {
              if (c.kind !== 'control') return c;
              const owned = { ...c, author: { ...c.author, user: 'u-owner' } };
              seen.push(owned);
              return owned;
            }),
          ),
        ),
      onReset: (cb) => real.onReset(cb),
      onAccess: (cb) => real.onAccess(cb),
      onEvent: (cb) => real.onEvent(cb),
      onState: (cb) => real.onState(cb),
      onCheck: (cb) => real.onCheck(cb),
      close: () => real.close(),
    };
    const limits = backend.auth.session?.limits;
    const detach = core.attach(channel, {
      seq: content.seq,
      incarnation: content.incarnation,
      sync: backend.sync,
      ...(limits ? { limits } : {}),
      batchMs: 0,
      retry: { minMs: 2, maxMs: 20 },
    });
    const hold = service.holdWrites(docId);
    caret(core, IDS.lockedPara, 0);
    type(core, 'clause ');
    await sleep(5);
    service.setGrants(docId, []);
    await hold.release();
    await until(() => core.saveState.get() === 'saved', 'saved', 5000);

    const item = core.recovered.get().items.find((r) => r.reason === 'permission_denied');
    expect(seen.length).toBeGreaterThan(0);
    expect(item).toMatchObject({
      scope: `region:${IDS.locked}`,
      changedBy: 'u-owner',
      changedAt: seen.at(-1)!.serverTime,
    });
    detach();
    await service.dispose();
  });
});
