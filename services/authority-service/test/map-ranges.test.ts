// PRO-105: `mapRanges` of the authority service (05 §10; ADR 0015), through the service object and
// through the HTTP binding on an ephemeral port. The reference is the in-process function
// `mapRangesThrough` of `@docedit/authority`, called by this test on the same commits.
import { type Range, mapRangesThrough } from '@docedit/authority';
import { documentHash, type JsonEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { IDS, contractDocument, posIn } from '@docedit/protocol/contract';
import type { Node } from 'prosemirror-model';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServer, listen } from '../src/http.ts';
import { AuthorityService, type WireAuthor, type WireCommit } from '../src/service.ts';

const schema = cdmSchema();
const DOC = 'doc-map-ranges';
const T0 = 1_700_000_000_000;
const env = contractDocument() as unknown as JsonEnvelope;

const ALICE: WireAuthor = { sub: 'alice', session: 's-alice', role: 'editor' };
const BOB: WireAuthor = { sub: 'bob', session: 's-bob', role: 'editor' };
const PERMS = { revision: 0, grants: [] };

const uuid = (n: number): string => `0192f0c4-7b1e-7c3a-9a54-${String(n).padStart(12, '0')}`;

interface Fixture {
  service: AuthorityService;
  stateId: string;
  wire: WireCommit[];
  /** The text inserted by commit 1 (seq 1), at positions `ins` to `ins + len`. */
  ins: { from: number; to: number };
  head: Node;
}

/**
 * Four commits: alice inserts "One " in the intro (seq 1); bob inserts "Two " in the open paragraph
 * (seq 2); bob deletes "One " (seq 3); alice inserts "Three " in the intro (seq 4).
 */
async function build(): Promise<Fixture> {
  const service = new AuthorityService();
  const contentHash = await documentHash(env);
  const opened = await service.open({
    doc: DOC,
    checkpointRef: { seq: 0, chainHead: null, contentHash, content: env, createdBy: 'olivia' },
    commits: [],
    stateId: contentHash,
  });
  if (!opened.ok) throw new Error(opened.error.message);
  let stateId = opened.stateId;
  const wire: WireCommit[] = [];
  let head = schema.nodeFromJSON(env.doc);
  const ins = { from: posIn(head.toJSON(), IDS.intro, 0), to: 0 };
  ins.to = ins.from + 4;
  const steps: Array<[WireAuthor, unknown]> = [
    [
      ALICE,
      {
        stepType: 'replace',
        from: ins.from,
        to: ins.from,
        slice: { content: [{ type: 'text', text: 'One ' }] },
      },
    ],
    [
      BOB,
      {
        stepType: 'replace',
        from: posIn(head.toJSON(), IDS.openPara, 0),
        to: posIn(head.toJSON(), IDS.openPara, 0),
        slice: { content: [{ type: 'text', text: 'Two ' }] },
      },
    ],
    [BOB, { stepType: 'replace', from: ins.from, to: ins.to }],
    [
      ALICE,
      {
        stepType: 'replace',
        from: ins.from,
        to: ins.from,
        slice: { content: [{ type: 'text', text: 'Three ' }] },
      },
    ],
  ];
  for (const [i, [author, step]] of steps.entries()) {
    if (i === 1) {
      // bob's insert is positioned on the document after commit 1
      head = (await materialiseDoc(service, stateId)) ?? head;
    }
    const r = await service.applyCommit(stateId, {
      commit: {
        id: uuid(i + 1),
        base: i,
        steps: [step],
        author,
        time: T0 + i * 1000,
      },
      permissions: PERMS,
    });
    if (!r.ok || !r.accepted) throw new Error(`commit ${i + 1} was not accepted`);
    stateId = r.stateId;
    wire.push(...r.commits);
    head = (await materialiseDoc(service, stateId)) ?? head;
  }
  return { service, stateId, wire, ins, head };
}

async function materialiseDoc(
  service: AuthorityService,
  stateId: string,
): Promise<Node | undefined> {
  const m = await service.materialise(stateId);
  return m.ok ? schema.nodeFromJSON(m.content.doc) : undefined;
}

/** The in-process reference: the commits after `seq`, mapped with the authority's function. */
function reference(f: Fixture, seq: number, ranges: Range[]) {
  const commits = f.wire
    .filter((c) => c.meta.seq > seq)
    .map((c) => ({ kind: c.meta.kind, steps: c.payload.steps }));
  return mapRangesThrough(ranges, commits, schema);
}

describe('mapRanges of the authority service (PRO-105, criterion 1: equal to the in-process mapping)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await build();
  });

  it('maps ranges from each seq to the head exactly as mapRangesThrough does', async () => {
    const sets: Range[] = [
      { from: f.ins.from, to: f.ins.to }, // the text alice inserted
      { from: 1, to: 3 },
      { from: f.ins.to, to: f.ins.to }, // a caret (presence position)
      { from: 0, to: 2 },
    ];
    for (const seq of [0, 1, 2, 3]) {
      const got = await f.service.mapRanges(f.stateId, { seq, ranges: sets });
      expect(got).toEqual({
        ok: true,
        seq,
        headSeq: 4,
        ranges: reference(f, seq, sets),
      });
    }
  });

  it('answers the head itself with the ranges unchanged', async () => {
    const r = { from: 2, to: 5 };
    const got = await f.service.mapRanges(f.stateId, { seq: 4, ranges: [r] });
    expect(got).toEqual({
      ok: true,
      seq: 4,
      headSeq: 4,
      ranges: [{ from: 2, to: 5, collapsed: false }],
    });
  });
});

describe('mapRanges of the authority service (PRO-105, criterion 2: deleted content collapses)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await build();
  });

  it('collapses a range whose content was deleted, as ADR 0015 defines', async () => {
    // The range covers "One " as inserted at seq 1; bob deletes it at seq 3.
    const got = await f.service.mapRanges(f.stateId, {
      seq: 1,
      ranges: [{ from: f.ins.from, to: f.ins.to }],
    });
    expect(got).toMatchObject({ ok: true, ranges: [{ collapsed: true }] });
    const [m] = (got as { ranges: Array<{ from: number; to: number; collapsed: boolean }> }).ranges;
    expect(m!.from).toBe(m!.to);
  });
});

describe('mapRanges of the authority service (PRO-105, criterion 3: an unknown state says so)', () => {
  it('answers unknown_state with a message to open again, and refuses a seq the state lacks', async () => {
    const f = await build();
    expect(
      await f.service.mapRanges('0'.repeat(64), { seq: 0, ranges: [{ from: 0, to: 0 }] }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unknown_state', message: expect.stringContaining('open again') },
    });
    expect(await f.service.mapRanges(f.stateId, { seq: 9, ranges: [] })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(
      await f.service.mapRanges(f.stateId, {
        seq: 0,
        ranges: [
          { from: 3, to: 1 },
          { from: -1, to: 2 },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await f.service.mapRanges(f.stateId, { ranges: [] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});

describe('mapRanges over HTTP and in the capabilities', () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('answers POST /map-ranges with the same result as the service, and lists the call', async () => {
    const f = await build();
    running = await listen({ service: f.service });
    const body = { seq: 1, ranges: [{ from: f.ins.from, to: f.ins.to }] };
    const res = await fetch(`${running!.url}/v1/authority/states/${f.stateId}/map-ranges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { seq: number; headSeq: number; ranges: unknown[] };
    const direct = await f.service.mapRanges(f.stateId, body);
    expect(json).toEqual({ seq: 1, headSeq: 4, ranges: (direct as { ranges: unknown[] }).ranges });

    const unknown = await fetch(
      `${running!.url}/v1/authority/states/${'0'.repeat(64)}/map-ranges`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    expect(unknown.status).not.toBe(200);

    const wrong = await fetch(`${running!.url}/v1/authority/states/${f.stateId}/map-ranges`);
    expect(wrong.status).toBe(405);

    const caps = (await (await fetch(`${running!.url}/v1/authority/capabilities`)).json()) as {
      calls: string[];
    };
    expect(caps.calls).toContain('mapRanges');
  });
});
