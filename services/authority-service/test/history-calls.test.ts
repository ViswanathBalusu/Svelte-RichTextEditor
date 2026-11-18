// PRO-106: `restoreSteps`, `diff` and `attribution` of the authority service (05 §10; 08 §6 to §8),
// through the service object and through the HTTP binding on an ephemeral port. The reference is
// the in-process package: the functions of `@docedit/history` called on the same log by this test.
import {
  type LogCommit,
  type StoredCommit,
  computeAccess,
  contentAt,
  defaultReplayers,
  hiddenSet,
  regionInfos,
  type PermissionState,
} from '@docedit/authority';
import {
  AttributionMap,
  attributionAt,
  commitAuthor,
  compare,
  planRestore,
} from '@docedit/history';
import { canonicalEnvelope, documentHash, type JsonEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { IDS, contractDocument, posIn } from '@docedit/protocol/contract';
import type { Node } from 'prosemirror-model';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServer, listen } from '../src/http.ts';
import {
  AuthorityService,
  type WireAuthor,
  type WireCommit,
  type WirePermissions,
} from '../src/service.ts';

const schema = cdmSchema();
const DOC = 'doc-history';
const T0 = 1_700_000_000_000;
const env = contractDocument() as unknown as JsonEnvelope;

const insert = (pos: number, text: string) => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

const USERS: Record<string, WireAuthor> = {
  alice: { sub: 'alice', session: 's-alice', role: 'editor' },
  bob: { sub: 'bob', session: 's-bob', role: 'editor' },
  olivia: { sub: 'olivia', session: 's-olivia', role: 'owner' },
  victor: { sub: 'victor', session: 's-victor', role: 'viewer' },
};
const PERMS: WirePermissions = { revision: 0, grants: [] };
const NOW = T0 + 100_000;

const uuid = (n: number): string => `0192f0c4-7b1e-7c3a-9a54-${String(n).padStart(12, '0')}`;

interface Fixture {
  service: AuthorityService;
  stateId: string;
  wire: WireCommit[];
  stored: StoredCommit[];
  head: Node;
}

/** The fixture: four commits by two users in the intro paragraph and the open region. */
async function build(): Promise<Fixture> {
  const service = new AuthorityService();
  const contentHash = await documentHash(env);
  const opened = await service.open({
    doc: DOC,
    checkpointRef: {
      seq: 0,
      chainHead: null,
      contentHash,
      content: env,
      createdBy: 'olivia',
    },
    commits: [],
    stateId: contentHash,
  });
  if (!opened.ok) throw new Error(opened.error.message);
  let stateId = opened.stateId;
  const wire: WireCommit[] = [];
  const plan: Array<[string, string, string]> = [
    ['alice', IDS.intro, 'One '],
    ['bob', IDS.openPara, 'Two '],
    ['alice', IDS.intro, 'Three '],
    ['bob', IDS.mid, 'Four '],
  ];
  let head = schema.nodeFromJSON(env.doc);
  for (const [i, [user, target, text]] of plan.entries()) {
    const pos = posIn(head.toJSON(), target, 0);
    const r = await service.applyCommit(stateId, {
      commit: {
        id: uuid(i + 1),
        base: i,
        steps: [insert(pos, text)],
        author: USERS[user]!,
        time: T0 + i * 1000,
      },
      permissions: PERMS,
    });
    if (!r.ok || !r.accepted) throw new Error(`commit ${i + 1} was not accepted`);
    stateId = r.stateId;
    wire.push(...r.commits);
    const m = await service.materialise(stateId);
    if (!m.ok) throw new Error(m.error.message);
    head = schema.nodeFromJSON(m.content.doc);
  }
  const stored: StoredCommit[] = wire.map((c) => ({
    seq: c.meta.seq,
    id: c.meta.id,
    kind: c.meta.kind as 'steps',
    steps: c.payload.steps,
    user: c.meta.user,
    session: c.meta.session ?? '',
    time: Date.parse(c.meta.time),
    origin: c.meta.origin,
    scopes: c.meta.scopes,
    revision: c.meta.revision,
    cdm: c.meta.cdm,
    engine: c.meta.engine,
    retired: [],
    claimed: [],
  }));
  return { service, stateId, wire, stored, head };
}

/** The in-process content source over the same log. */
function sourceOf(f: Fixture) {
  const log: LogCommit[] = f.stored;
  return {
    incarnation: 'reference',
    head: log.length,
    checkpoints: [{ seq: 0, doc: schema.nodeFromJSON(env.doc) }],
    commits: (a: number, b: number) => log.filter((c) => c.seq > a && c.seq <= b),
    resolve: () => {
      throw new Error('no snapshot');
    },
    replayers: defaultReplayers(schema),
  };
}

const nodeAt = (f: Fixture, seq: number): Node => {
  const r = contentAt(seq, sourceOf(f));
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};

const attributionMap = (f: Fixture, seq: number): AttributionMap => {
  const r = attributionAt(seq, {
    schema,
    checkpoints: [
      {
        seq: 0,
        map: AttributionMap.create(schema.nodeFromJSON(env.doc).content.size, {
          user: 'olivia',
          seq: 0,
        }),
      },
    ],
    commits: (a, b) => f.stored.filter((c) => c.seq > a && c.seq <= b),
  });
  if (!r.ok) throw new Error(r.reason);
  return r.map;
};

const perms = (): PermissionState => ({
  revision: 0,
  grants: [],
  regionStates: new Map(),
  leases: [],
  documentState: 'active',
  workflowActive: false,
});

function conn(user: string) {
  const a = USERS[user]!;
  return {
    sub: a.sub,
    session: a.session,
    role: a.role,
    groups: [],
    participantRoles: [],
    participantActive: false,
  };
}

describe('the history calls (PRO-106)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await build();
  });

  describe('restoreSteps', () => {
    it('gives the steps that restore a region, equal to the in-process plan (criterion 1)', async () => {
      const r = await f.service.restoreSteps(f.stateId, {
        requester: USERS['alice'],
        permissions: PERMS,
        now: NOW,
        toSeq: 0,
        region: IDS.open,
      });
      if (!r.ok || 'refused' in r) throw new Error(JSON.stringify(r));
      expect(r.kind).toBe('steps');
      // The same plan from the package, on the same documents.
      const c = conn('alice');
      const head = nodeAt(f, 4);
      const target = nodeAt(f, 0);
      const plan = planRestore(
        { toSeq: 0, region: IDS.open },
        {
          schema,
          head: { seq: 4, doc: head, attribution: attributionMap(f, 4) },
          target: () => ({ doc: target, attribution: attributionMap(f, 0) }),
          gate: { min: 0, head: 4, named: () => false },
          hidden: hiddenSet(c, head, perms(), NOW),
          access: computeAccess(c, regionInfos(head), perms(), NOW),
          user: 'alice',
          regionStates: new Map(),
          workflowActive: false,
        },
      );
      if (!plan.ok || plan.plan.kind !== 'steps') throw new Error('no in-process plan');
      expect(r.kind === 'steps' && r.steps).toEqual(plan.plan.stepsJson);
      expect(r.preconditions).toEqual(plan.plan.preconditions);
      expect(r.unchanged).toBe(plan.plan.unchanged);
      expect(r.unchanged).toBe(false);
      expect(r.toSeq).toBe(0);
      expect(r.headSeq).toBe(4);
    });

    it('gives a snapshot of the content for a whole-document restore', async () => {
      const r = await f.service.restoreSteps(f.stateId, {
        requester: USERS['olivia'],
        permissions: PERMS,
        now: NOW,
        toSeq: 1,
        dryRun: true,
      });
      if (!r.ok || 'refused' in r) throw new Error(JSON.stringify(r));
      expect(r.unchanged).toBe(false);
      expect(r.dryRun?.fromSeq).toBe(4);
      const c = conn('olivia');
      const head = nodeAt(f, 4);
      const plan = planRestore(
        { toSeq: 1, dryRun: true },
        {
          schema,
          head: { seq: 4, doc: head, attribution: attributionMap(f, 4) },
          target: () => ({ doc: nodeAt(f, 1), attribution: attributionMap(f, 1) }),
          gate: { min: 0, head: 4, named: () => false },
          hidden: hiddenSet(c, head, perms(), NOW),
          access: computeAccess(c, regionInfos(head), perms(), NOW),
          user: 'olivia',
          regionStates: new Map(),
          workflowActive: false,
        },
      );
      if (!plan.ok) throw new Error('no in-process plan');
      expect(r.kind).toBe(plan.plan.kind);
      expect(r.dryRun).toEqual(plan.plan.dryRun);
      if (r.kind === 'snapshot')
        expect(r.content).toEqual(
          canonicalEnvelope({ cdm: 1, requires: [], doc: plan.plan.result.toJSON() as never }),
        );
    });

    it('refuses what the history rules refuse, as an answer', async () => {
      const ask = (requester: WireAuthor, extra: object) =>
        f.service.restoreSteps(f.stateId, {
          requester,
          permissions: PERMS,
          now: NOW,
          toSeq: 1,
          ...extra,
        });
      // Only a manager restores the whole document.
      expect(await ask(USERS['alice']!, {})).toMatchObject({
        ok: true,
        refused: { code: 'forbidden' },
      });
      // A seq below the gate.
      expect(await ask(USERS['olivia']!, { gate: { min: 3 } })).toMatchObject({
        refused: { code: 'forbidden' },
      });
      // A seq past the head, and a region that is not there.
      expect(await ask(USERS['olivia']!, { toSeq: 9 })).toMatchObject({
        refused: { code: 'not_found' },
      });
      expect(await ask(USERS['alice']!, { region: 'no-such-region' })).toMatchObject({
        refused: { code: expect.stringMatching(/forbidden|not_found/) },
      });
      // A workflow forbids it.
      const wf = await f.service.restoreSteps(f.stateId, {
        requester: USERS['olivia'],
        permissions: { ...PERMS, workflowActive: true },
        now: NOW,
        toSeq: 1,
      });
      expect(wf).toMatchObject({ refused: { code: 'workflow_active' } });
    });
  });

  describe('diff', () => {
    it('gives the comparison of two states, equal to the in-process one (criterion 2)', async () => {
      for (const granularity of ['word', 'char'] as const) {
        const r = await f.service.diff(f.stateId, {
          requester: USERS['alice'],
          permissions: PERMS,
          now: NOW,
          fromSeq: 0,
          toSeq: 4,
          granularity,
        });
        if (!r.ok || 'refused' in r) throw new Error(JSON.stringify(r));
        const c = conn('alice');
        const head = nodeAt(f, 4);
        const want = compare(
          { fromSeq: 0, toSeq: 4, granularity },
          {
            schema,
            incarnation: 'reference',
            content: (s) => nodeAt(f, s),
            commits: (a, b) => f.stored.filter((x) => x.seq > a && x.seq <= b),
            attribution: (s) => attributionMap(f, s),
            scopeIndex: (scope, a, b) => {
              const hit = [...f.stored]
                .reverse()
                .find((x) => x.seq > a && x.seq <= b && x.scopes.includes(scope));
              return hit ? commitAuthor(hit) : undefined;
            },
          },
          {
            gate: { min: 0, head: 4, named: () => false },
            hidden: hiddenSet(c, head, perms(), NOW),
          },
        );
        if (!want.ok) throw new Error(want.reason);
        expect(r.comparison).toEqual(want.comparison);
        expect(r.comparison.granularity).toBe(granularity);
        // Four commits by two users: spans carry who and which commit.
        const users = new Set(
          r.comparison.changes.flatMap((ch) => (ch.spans ?? []).map((s) => s.user)),
        );
        expect(users).toEqual(new Set(['alice', 'bob']));
      }
    });

    it('limits the result to a region and refuses what the gate refuses', async () => {
      const inRegion = await f.service.diff(f.stateId, {
        requester: USERS['alice'],
        permissions: PERMS,
        now: NOW,
        fromSeq: 0,
        toSeq: 4,
        region: IDS.open,
      });
      if (!inRegion.ok || 'refused' in inRegion) throw new Error(JSON.stringify(inRegion));
      expect(inRegion.comparison.region).toBe(IDS.open);
      expect(inRegion.comparison.changes.length).toBeGreaterThan(0);
      const below = await f.service.diff(f.stateId, {
        requester: USERS['alice'],
        permissions: PERMS,
        now: NOW,
        fromSeq: 0,
        toSeq: 4,
        gate: { min: 2 },
      });
      expect(below).toMatchObject({ ok: true, refused: { code: 'forbidden' } });
      const past = await f.service.diff(f.stateId, {
        requester: USERS['alice'],
        permissions: PERMS,
        now: NOW,
        fromSeq: 0,
        toSeq: 40,
      });
      expect(past).toMatchObject({ refused: { code: 'not_found' } });
    });
  });

  describe('attribution', () => {
    it('says who wrote which spans, equal to the in-process map (criterion 3)', async () => {
      const r = await f.service.attribution(f.stateId, {
        requester: USERS['alice'],
        permissions: PERMS,
        now: NOW,
      });
      if (!r.ok || 'refused' in r) throw new Error(JSON.stringify(r));
      expect(r.seq).toBe(4);
      const map = attributionMap(f, 4);
      for (const b of r.blocks)
        expect(b.runs, b.id).toEqual(
          map.slice(b.from, b.to).map(({ from, len, ...a }) => ({ from, len, ...a })),
        );
      const intro = r.blocks.find((b) => b.id === IDS.intro)!;
      // The opening token and the original text are olivia's (0); "Three " and "One " are alice's.
      expect(intro.runs.map((x) => [x.user, x.seq])).toEqual([
        ['olivia', 0],
        ['alice', 3],
        ['alice', 1],
        ['olivia', 0],
      ]);
      const open = r.blocks.find((b) => b.id === IDS.openPara)!;
      expect(open.runs.map((x) => [x.user, x.seq])).toEqual([
        ['olivia', 0],
        ['bob', 2],
        ['olivia', 0],
      ]);
    });

    it('limits the answer to a region or to blocks, at a seq of the past', async () => {
      const region = await f.service.attribution(f.stateId, {
        requester: USERS['alice'],
        permissions: PERMS,
        now: NOW,
        region: IDS.open,
      });
      if (!region.ok || 'refused' in region) throw new Error(JSON.stringify(region));
      expect(region.blocks.map((b) => b.id)).toEqual([IDS.openPara]);
      const past = await f.service.attribution(f.stateId, {
        requester: USERS['alice'],
        permissions: PERMS,
        now: NOW,
        seq: 1,
        blocks: [IDS.intro],
      });
      if (!past.ok || 'refused' in past) throw new Error(JSON.stringify(past));
      expect(past.seq).toBe(1);
      expect(past.blocks[0]!.runs.map((x) => [x.user, x.seq])).toEqual([
        ['olivia', 0],
        ['alice', 1],
        ['olivia', 0],
      ]);
      expect(
        await f.service.attribution(f.stateId, {
          requester: USERS['alice'],
          permissions: PERMS,
          blocks: ['nope'],
        }),
      ).toMatchObject({ refused: { code: 'not_found' } });
      expect(
        await f.service.attribution(f.stateId, {
          requester: USERS['alice'],
          permissions: PERMS,
          gate: { min: 3 },
          seq: 1,
        }),
      ).toMatchObject({ refused: { code: 'forbidden' } });
    });

    it('takes the baseline from the checkpoint reference', async () => {
      // The same state opened from a checkpoint at seq 2 with the map saved at 2.
      const mid = nodeAt(f, 2);
      const midEnv = { cdm: 1, requires: [], doc: mid.toJSON() } as unknown as JsonEnvelope;
      const service = new AuthorityService();
      const opened = await service.open({
        doc: DOC,
        checkpointRef: {
          seq: 2,
          chainHead: f.wire[1]!.hash,
          contentHash: await documentHash(midEnv),
          content: midEnv,
          attribution: attributionMap(f, 2).toJSON(),
        },
        commits: f.wire.slice(2),
        stateId: f.stateId,
      });
      expect(opened.ok).toBe(true);
      const r = await service.attribution(f.stateId, {
        requester: USERS['alice'],
        permissions: PERMS,
      });
      const full = await f.service.attribution(f.stateId, {
        requester: USERS['alice'],
        permissions: PERMS,
      });
      expect(r).toEqual(full);
      // A baseline that does not cover the checkpoint is refused at open.
      const bad = await service.open({
        doc: DOC,
        checkpointRef: {
          seq: 2,
          chainHead: f.wire[1]!.hash,
          contentHash: await documentHash(midEnv),
          content: midEnv,
          attribution: AttributionMap.create(3, { user: 'x', seq: 0 }).toJSON(),
        },
        commits: f.wire.slice(2),
        stateId: f.stateId,
      });
      expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    });
  });

  it('answer unknown_state and invalid_request as errors (criterion 4: each call is defined)', async () => {
    const ask = { requester: USERS['alice'], permissions: PERMS };
    for (const call of ['restoreSteps', 'diff', 'attribution'] as const) {
      expect(await f.service[call]('0'.repeat(64), { ...ask, toSeq: 0, fromSeq: 0 })).toMatchObject(
        {
          ok: false,
          error: { code: 'unknown_state' },
        },
      );
      expect(await f.service[call](f.stateId, {})).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
      expect(await f.service[call]('nope', ask)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }
  });

  describe('over HTTP', () => {
    let running: RunningServer | undefined;
    afterEach(async () => {
      await running?.close();
      running = undefined;
    });

    it('has a route for each call, and a refusal is a 200 with { refused }', async () => {
      running = await listen({ service: f.service });
      const post = (call: string, body: unknown) =>
        fetch(`${running!.url}/v1/authority/states/${f.stateId}/${call}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const base = { requester: USERS['alice'], permissions: PERMS, now: NOW };
      const diffRes = await post('diff', { ...base, fromSeq: 0, toSeq: 4 });
      expect(diffRes.status).toBe(200);
      expect(await diffRes.json()).toMatchObject({ comparison: { fromSeq: 0, toSeq: 4 } });
      const att = await post('attribution', base);
      expect(att.status).toBe(200);
      expect(((await att.json()) as { blocks: unknown[] }).blocks.length).toBeGreaterThan(0);
      const restore = await post('restore-steps', { ...base, toSeq: 1 });
      expect(restore.status).toBe(200);
      expect(await restore.json()).toMatchObject({ refused: { code: 'forbidden' } });
      const missing = await fetch(`${running.url}/v1/authority/states/${'0'.repeat(64)}/diff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(base),
      });
      expect(missing.status).toBe(404);
      const wrong = await fetch(`${running.url}/v1/authority/states/${f.stateId}/diff`);
      expect(wrong.status).toBe(405);
      const caps = (await (await fetch(`${running.url}/v1/authority/capabilities`)).json()) as {
        calls: string[];
        features: string[];
      };
      expect(caps.calls).toEqual(expect.arrayContaining(['restoreSteps', 'diff', 'attribution']));
      expect(caps.features).toContain('history');
    });
  });
});
