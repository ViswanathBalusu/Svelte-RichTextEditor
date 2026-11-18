// PRO-104: `applyCommit` of the authority service (05 §10; 04 §5, §6; 07 §5), through the service
// object and through the HTTP binding on an ephemeral port. The reference is the authority
// package's own room, long-lived in this process, as the document service holds it.
import { Room, type PermissionState, type StoredCommit } from '@docedit/authority';
import { canonicalEnvelope, documentHash, type JsonEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { IDS, contractDocument, posIn } from '@docedit/protocol/contract';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, listen } from '../src/http.ts';
import {
  AuthorityService,
  type ApplyCommitRequest,
  type WireAuthor,
  type WirePermissions,
} from '../src/service.ts';

const schema = cdmSchema();
const DOC = 'doc-apply';
const T0 = 1_700_000_000_000;

const insert = (pos: number, text: string) => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

const USERS = {
  eddie: { sub: 'eddie', session: 's-eddie', role: 'editor' },
  grace: { sub: 'grace', session: 's-grace', role: 'editor', groups: ['legal'] },
  victor: { sub: 'victor', session: 's-victor', role: 'viewer' },
  sam: { sub: 'sam', session: 's-sam', role: 'suggester' },
} as const satisfies Record<string, WireAuthor>;
type UserName = keyof typeof USERS;

const PERMS: WirePermissions = {
  revision: 0,
  grants: [{ region: IDS.locked, principal: 'group:legal', role: 'editor', expiresAt: null }],
};

const uuid = (n: number): string => `0192f0c4-7b1e-7c3a-9a54-${String(n).padStart(12, '0')}`;

async function openState(
  service: AuthorityService,
  env: JsonEnvelope = contractDocument() as unknown as JsonEnvelope,
) {
  const contentHash = await documentHash(env);
  const opened = await service.open({
    doc: DOC,
    checkpointRef: { seq: 0, chainHead: null, contentHash, content: env },
    commits: [],
    stateId: contentHash,
  });
  if (!opened.ok) throw new Error(opened.error.message);
  return { stateId: opened.stateId, env };
}

function request(
  id: number,
  base: number,
  steps: unknown,
  user: UserName,
  extra: Partial<ApplyCommitRequest> = {},
  time = T0,
): ApplyCommitRequest {
  return {
    commit: { id: uuid(id), base, steps: [steps], author: USERS[user], time },
    permissions: PERMS,
    ...extra,
  };
}

const unpack = (r: Awaited<ReturnType<AuthorityService['applyCommit']>>) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
};

describe('applyCommit (PRO-104)', () => {
  const at = posIn(contractDocument().doc, IDS.intro, 0);

  it('accepts an acceptable commit: mapped steps, scopes and the new state (criterion 1)', async () => {
    const service = new AuthorityService();
    const { stateId } = await openState(service);
    const r = unpack(await service.applyCommit(stateId, request(1, 0, insert(at, 'Hi '), 'eddie')));
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    expect(r.seq).toBe(1);
    expect(r.steps).toHaveLength(1);
    expect(r.scopes).toEqual(['body']);
    expect(r.rebased).toBe(false);
    expect(r.stateId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.stateId).not.toBe(stateId);
    // The commits are in the form `open` takes, and the new state is the head of their chain.
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0]!.hash).toBe(r.stateId);
    // The new state is held: its content has the text, the old state's does not.
    const now = await service.materialise(r.stateId);
    expect(now.ok && JSON.stringify(now.content.doc)).toContain('Hi Hello world');
    const before = await service.materialise(stateId);
    expect(before.ok && JSON.stringify(before.content.doc)).not.toContain('Hi ');
  });

  it('gives the state a caller can open again from what the answer holds', async () => {
    const service = new AuthorityService();
    const { stateId, env } = await openState(service);
    const first = unpack(
      await service.applyCommit(stateId, request(1, 0, insert(at, 'A'), 'eddie')),
    );
    if (!first.accepted) throw new Error('rejected');
    const second = unpack(
      await service.applyCommit(first.stateId, request(2, 1, insert(at, 'B'), 'eddie', {}, T0 + 1)),
    );
    if (!second.accepted) throw new Error('rejected');
    // A second service, as after a restart: `open` with the commits the answers carried.
    const other = new AuthorityService();
    const opened = await other.open({
      doc: DOC,
      checkpointRef: {
        seq: 0,
        chainHead: null,
        contentHash: await documentHash(env),
        content: env,
      },
      commits: [...first.commits, ...second.commits],
      stateId: second.stateId,
    });
    expect(opened.ok).toBe(true);
    const a = await service.materialise(second.stateId);
    const b = await other.materialise(second.stateId);
    expect(a.ok && b.ok && a.text === b.text).toBe(true);
  });

  it('rejects what the room rejects, with registry codes and the scopes (criterion 2)', async () => {
    const service = new AuthorityService();
    const { stateId } = await openState(service);
    const locked = posIn(contractDocument().doc, IDS.lockedPara, 0);
    const reject = async (req: ApplyCommitRequest) => {
      const r = unpack(await service.applyCommit(stateId, req));
      expect(r.accepted).toBe(false);
      return r.accepted ? undefined : r.rejected;
    };
    // The step allow-list (04 §4).
    expect(
      (await reject(request(1, 0, { stepType: 'docAttr', attr: 'x', value: 1 }, 'eddie')))?.code,
    ).toBe('invalid_op');
    // A viewer may change nothing; an editor without the grant may not change the restricted region.
    expect((await reject(request(2, 0, insert(at, 'x'), 'victor')))?.code).toBe(
      'permission_denied',
    );
    const denied = await reject(request(3, 0, insert(locked, 'x'), 'eddie'));
    expect(denied).toMatchObject({ code: 'permission_denied', action: 'drop' });
    expect(denied?.scopes).toContain(`region:${IDS.locked}`);
    // A suggester may not change text directly (P4).
    expect((await reject(request(4, 0, insert(at, 'x'), 'sam')))?.code).toBe('permission_denied');
    // A locked document is read-only.
    expect(
      (
        await reject(
          request(5, 0, insert(at, 'x'), 'eddie', {
            permissions: { ...PERMS, documentState: 'locked' },
          }),
        )
      )?.code,
    ).toBe('read_only');
    // A base after the head cannot be rebased.
    const ahead = await reject(request(6, 9, insert(at, 'x'), 'eddie'));
    expect(['stale_base', 'invalid_op', 'rebase_failed']).toContain(ahead?.code);
    // The grantee may edit the restricted region.
    const ok = unpack(
      await service.applyCommit(stateId, request(7, 0, insert(locked, 'y'), 'grace')),
    );
    expect(ok.accepted).toBe(true);
  });

  it('rebases a commit on an older base and says so', async () => {
    const service = new AuthorityService();
    const { stateId } = await openState(service);
    const a = unpack(await service.applyCommit(stateId, request(1, 0, insert(at, 'AA'), 'eddie')));
    if (!a.accepted) throw new Error('rejected');
    // Grace types at the same place, one commit behind.
    const b = unpack(
      await service.applyCommit(a.stateId, request(2, 0, insert(at, 'BB'), 'grace', {}, T0 + 1)),
    );
    expect(b.accepted && b.rebased).toBe(true);
    expect(b.accepted && b.seq).toBe(2);
  });

  it('rejects when what the caller relied on no longer holds, as the room does (criterion 4)', async () => {
    const service = new AuthorityService();
    const { stateId } = await openState(service);
    const moved = request(1, 0, insert(at, 'x'), 'eddie', {
      permissions: { ...PERMS, revision: 4 },
      preconditions: { revision: 3 },
    });
    const r = unpack(await service.applyCommit(stateId, moved));
    expect(r).toMatchObject({
      accepted: false,
      rejected: { code: 'conflict', action: 'drop', head: 0 },
    });
    // The same holds for the head, the document state and the region states.
    for (const preconditions of [
      { head: 5 },
      { documentState: 'locked' as const },
      { workflowActive: true },
      { regionStates: { [IDS.locked]: 'approved' as const } },
    ]) {
      const x = unpack(
        await service.applyCommit(
          stateId,
          request(2, 0, insert(at, 'x'), 'eddie', { preconditions }),
        ),
      );
      expect(x, JSON.stringify(preconditions)).toMatchObject({
        accepted: false,
        rejected: { code: 'conflict' },
      });
    }
    // Preconditions that hold change nothing.
    const fine = unpack(
      await service.applyCommit(
        stateId,
        request(3, 0, insert(at, 'x'), 'eddie', { preconditions: { revision: 0, head: 0 } }),
      ),
    );
    expect(fine.accepted).toBe(true);
  });

  it('writes the control commit that records a grants revision, after the commit', async () => {
    const service = new AuthorityService();
    const { stateId } = await openState(service);
    const r = unpack(
      await service.applyCommit(
        stateId,
        request(1, 0, insert(at, 'x'), 'eddie', { permissions: { ...PERMS, revision: 1 } }),
      ),
    );
    if (!r.accepted) throw new Error('rejected');
    expect(r.commits.map((c) => c.meta.kind)).toEqual(['steps', 'control']);
    expect(r.seq).toBe(1);
    expect(r.commits[1]!.meta.revision).toBe(1);
    expect(r.commits[1]!.meta.seq).toBe(2);
    expect(r.stateId).toBe(r.commits[1]!.hash);
  });

  it('answers unknown_state and invalid_request as errors, not as rejections', async () => {
    const service = new AuthorityService();
    const { stateId } = await openState(service);
    const unknown = await service.applyCommit(
      '0'.repeat(64),
      request(1, 0, insert(at, 'x'), 'eddie'),
    );
    expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown_state' } });
    expect(await service.applyCommit('nope', {})).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await service.applyCommit(stateId, { commit: {} })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  describe('over HTTP', () => {
    let running: RunningServer | undefined;
    afterEach(async () => {
      await running?.close();
      running = undefined;
    });

    it('is POST /v1/authority/states/{stateId}/commits; a rejection is a 200 with { rejected }', async () => {
      const service = new AuthorityService();
      const { stateId } = await openState(service);
      running = await listen({ service });
      const post = (id: string, body: unknown) =>
        fetch(`${running!.url}/v1/authority/states/${id}/commits`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const ok = await post(stateId, request(1, 0, insert(at, 'Hi '), 'eddie'));
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { stateId: string; seq: number; commits: unknown[] };
      expect(body.seq).toBe(1);
      expect(body.commits).toHaveLength(1);
      const no = await post(body.stateId, request(2, 1, insert(at, 'x'), 'victor'));
      expect(no.status).toBe(200);
      expect(await no.json()).toMatchObject({ rejected: { code: 'permission_denied' } });
      const gone = await post('0'.repeat(64), request(3, 0, insert(at, 'x'), 'eddie'));
      expect(gone.status).toBe(404);
      const wrong = await fetch(`${running.url}/v1/authority/states/${stateId}/commits`);
      expect(wrong.status).toBe(405);
    });

    it('is listed among the calls the service implements', async () => {
      running = await listen({ service: new AuthorityService() });
      const body = (await (await fetch(`${running.url}/v1/authority/capabilities`)).json()) as {
        calls: string[];
        features: string[];
      };
      expect(body.calls).toContain('applyCommit');
      expect(body.features).toEqual(expect.arrayContaining(['regions', 'suggest-enforced']));
    });
  });
});

// --- The same results as the in-process package (criterion 3) -------------------------------------

interface Outcome {
  accepted: boolean;
  code?: string;
  action?: string;
  steps?: unknown;
  scopes?: string[];
  rebased?: boolean;
}

/** One long-lived room, the way the document service holds it: the reference. */
class Reference {
  readonly room: Room;
  now = T0;
  private readonly channels = new Set<string>();

  constructor(env: JsonEnvelope, perms: PermissionState) {
    this.room = new Room({
      schema,
      initial: schema.nodeFromJSON(env.doc),
      requires: env.requires,
      log: [],
      perms,
      initialRevision: 0,
      epoch: 1,
      incarnation: 'reference',
      now: () => this.now,
    });
  }

  get doc(): Node {
    return this.room.document;
  }

  apply(user: UserName, id: number, base: number, steps: unknown, time: number): Outcome {
    this.now = time;
    const u = USERS[user];
    const ch = `c-${user}`;
    if (!this.channels.has(ch)) {
      this.channels.add(ch);
      this.room.open(ch, {
        sub: u.sub,
        session: u.session,
        role: u.role,
        groups: 'groups' in u ? u.groups : [],
        participantRoles: [],
        participantActive: false,
      });
    }
    const fx = this.room.submit(ch, { id: uuid(id), base, steps });
    for (const o of fx.send)
      if (o.msg.t === 'sync.reject' && o.channel === ch)
        return { accepted: false, code: o.msg.code, action: o.msg.action };
    const stored: StoredCommit[] = [];
    let write = fx.write;
    while (write) {
      stored.push(...write.commits);
      write = this.room.writeCompleted({ status: 'ok' }).write;
    }
    const mine = stored.find((c) => c.id === uuid(id))!;
    return {
      accepted: true,
      steps: mine.steps,
      scopes: mine.scopes,
      rebased: mine.rebased ?? false,
    };
  }
}

describe('applyCommit against the in-process room (criterion 3)', () => {
  const env = contractDocument() as unknown as JsonEnvelope;
  const targets = [IDS.intro, IDS.openPara, IDS.mid, IDS.lockedPara, IDS.end] as const;
  const names = Object.keys(USERS) as UserName[];

  const op = fc.record({
    user: fc.constantFrom(...names),
    target: fc.constantFrom(...targets),
    kind: fc.constantFrom('insert', 'insert', 'insert', 'delete', 'bad'),
    lag: fc.integer({ min: 0, max: 3 }),
    text: fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom('a', 'b', 'c', ' ') }),
  });

  it('decides every commit of a random schedule as the long-lived room does', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
        const service = new AuthorityService();
        const { stateId: start } = await openState(service, env);
        let stateId = start;
        const ref = new Reference(env, {
          revision: 0,
          grants: PERMS.grants.map((g) => ({ ...g })),
          regionStates: new Map(),
          leases: [],
          documentState: 'active',
          workflowActive: false,
        });
        let head = 0;
        for (const [i, o] of ops.entries()) {
          const base = Math.max(0, head - o.lag);
          // Positions come from the reference's current document, as a client's editor would.
          const pos = posIn(ref.doc.toJSON(), o.target, 0);
          const steps =
            o.kind === 'insert'
              ? [insert(pos, o.text)]
              : o.kind === 'delete'
                ? [{ stepType: 'replace', from: pos, to: pos + 1 }]
                : [{ stepType: 'docAttr', attr: 'x', value: 1 }];
          const time = T0 + i * 10;
          const want = ref.apply(o.user, i + 1, base, steps, time);
          const r = unpack(
            await service.applyCommit(stateId, {
              commit: { id: uuid(i + 1), base, steps, author: USERS[o.user], time },
              permissions: PERMS,
            }),
          );
          if (!r.accepted) {
            expect({ accepted: false, code: r.rejected.code, action: r.rejected.action }).toEqual(
              want,
            );
            continue;
          }
          expect({
            accepted: true,
            steps: r.steps,
            scopes: r.scopes,
            rebased: r.rebased,
          }).toEqual(want);
          stateId = r.stateId;
          head = r.seq;
          expect(head).toBe(ref.room.head);
        }
        const mine = await service.materialise(stateId);
        if (!mine.ok) throw new Error(mine.error.message);
        const expected = canonicalEnvelope({
          cdm: 1,
          requires: [],
          doc: ref.doc.toJSON() as never,
        });
        expect(mine.contentHash).toBe(await documentHash(expected));
      }),
      { numRuns: 60 },
    );
  });
});
