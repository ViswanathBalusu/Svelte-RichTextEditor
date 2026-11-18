// PRO-103: `open` and `materialise` of the authority service (05 §10), through the service object
// and through the HTTP binding on an ephemeral port.
import {
  ENGINE,
  type ContentSource,
  type LogCommit,
  contentAt,
  defaultReplayers,
  stepsToJson,
} from '@docedit/authority';
import { canonicalText, documentHash } from '@docedit/model';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, listen } from '../src/http.ts';
import { AuthorityService, type CheckpointResolver } from '../src/service.ts';
import {
  type Built,
  baseEnvelope,
  buildLog,
  checkpointAt,
  envelopeOf,
  openRequest,
  schema,
  stateIdAt,
  typing,
  wireCommit,
} from './log.ts';

/** The in-process answer: the authority package on the same input, built without the service. */
function inProcess(built: Built, seq: number): string {
  const log: LogCommit[] = built.commits.map((c) => ({
    seq: c.meta.seq,
    id: c.meta.id,
    kind: 'steps',
    steps: c.payload.steps,
    user: c.meta.user,
    session: c.meta.session ?? '',
    time: 0,
    origin: c.meta.origin,
    scopes: c.meta.scopes,
    revision: c.meta.revision,
    cdm: 1,
    engine: ENGINE,
    retired: [],
    claimed: [],
  }));
  const source: ContentSource = {
    incarnation: 'x',
    head: log.length,
    checkpoints: [{ seq: 0, doc: built.docs[0]! }],
    commits: (a, b) => log.filter((c) => c.seq > a && c.seq <= b),
    resolve: () => {
      throw new Error('no snapshot');
    },
    replayers: defaultReplayers(schema),
  };
  const r = contentAt(seq, source);
  if (!r.ok) throw new Error(r.reason);
  return canonicalText(envelopeOf(r.doc));
}

describe('open (PRO-103 criterion 1)', () => {
  it('loads a document and names the state by the hash-chain head', async () => {
    const built = await buildLog(['a', 'b', 'c']);
    const service = new AuthorityService();
    const r = await service.open(await openRequest(built, 3));
    expect(r).toEqual({ ok: true, stateId: built.heads[3], seq: 3, doc: built.doc });
    expect(service.holds(built.heads[3]!)).toBe(true);
  });

  it('names a document with no commit by the checkpoint content hash', async () => {
    const built = await buildLog([]);
    const service = new AuthorityService();
    const r = await service.open(await openRequest(built, 0));
    expect(r).toMatchObject({ ok: true, stateId: built.start.contentHash, seq: 0 });
  });

  it('loads from a later checkpoint and the commits after it', async () => {
    const built = await buildLog(['a', 'b', 'c', 'd']);
    const service = new AuthorityService();
    const r = await service.open(await openRequest(built, 4, 2));
    expect(r).toMatchObject({ ok: true, stateId: built.heads[4], seq: 4 });
    const m = await service.materialise(built.heads[4]);
    expect(m.ok && m.text).toBe(canonicalText(envelopeOf(built.docs[4]!)));
  });

  it('refuses a log that does not end at the stateId named', async () => {
    const built = await buildLog(['a', 'b', 'c']);
    const service = new AuthorityService();
    const req = await openRequest(built, 3);
    const r = await service.open({ ...req, stateId: built.heads[2] });
    expect(r).toMatchObject({ ok: false, error: { code: 'state_mismatch' } });
    expect(service.size).toBe(0);
  });

  it('refuses a payload that was changed, a missing commit and a broken link', async () => {
    const built = await buildLog(['a', 'b', 'c']);
    const service = new AuthorityService();
    const req = await openRequest(built, 3);
    const changed = structuredClone(req.commits);
    changed[1]!.payload.retired = ['rGone'];
    expect(await service.open({ ...req, commits: changed })).toMatchObject({
      ok: false,
      error: { code: 'chain_broken', detail: { seq: 2 } },
    });
    expect(
      await service.open({ ...req, commits: [req.commits[0]!, req.commits[2]!] }),
    ).toMatchObject({ ok: false, error: { code: 'chain_broken', detail: { seq: 2 } } });
    const relinked = structuredClone(req.commits);
    relinked[2]!.prevHash = built.heads[1]!;
    expect(await service.open({ ...req, commits: relinked })).toMatchObject({
      ok: false,
      error: { code: 'chain_broken' },
    });
    expect(service.size).toBe(0);
  });

  it('refuses a commit whose payload was thinned', async () => {
    const built = await buildLog(['a', 'b']);
    const req = await openRequest(built, 2);
    const thinned = structuredClone(req.commits) as unknown as Array<Record<string, unknown>>;
    thinned[0]!['payload'] = null;
    expect(await new AuthorityService().open({ ...req, commits: thinned })).toMatchObject({
      ok: false,
      error: { code: 'payload_missing', detail: { index: 0 } },
    });
  });

  it('refuses a checkpoint that does not hash to its reference and one it cannot read', async () => {
    const built = await buildLog(['a']);
    const service = new AuthorityService();
    const req = await openRequest(built, 1);
    const other = envelopeOf(built.docs[1]!);
    expect(
      await service.open({ ...req, checkpointRef: { ...req.checkpointRef, content: other } }),
    ).toMatchObject({ ok: false, error: { code: 'checkpoint_mismatch' } });
    const { content: _omitted, ...bare } = req.checkpointRef;
    expect(await service.open({ ...req, checkpointRef: bare })).toMatchObject({
      ok: false,
      error: { code: 'checkpoint_unavailable' },
    });
    const future = { ...baseEnvelope(), cdm: 2 };
    expect(
      await service.open({
        ...req,
        checkpointRef: { ...req.checkpointRef, content: future },
      }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported_cdm' } });
  });

  it('asks the resolver for a checkpoint it is not carried', async () => {
    const built = await buildLog(['a', 'b']);
    const asked: number[] = [];
    const resolver: CheckpointResolver = {
      ref: (_doc, ref) => {
        asked.push(ref.seq);
        return Promise.resolve(envelopeOf(built.docs[ref.seq]!));
      },
      snapshot: () => Promise.resolve(undefined),
    };
    const service = new AuthorityService({ resolver });
    const req = await openRequest(built, 2, 1);
    const { content: _omitted, ...bare } = req.checkpointRef;
    const r = await service.open({ ...req, checkpointRef: bare });
    expect(r).toMatchObject({ ok: true, seq: 2 });
    expect(asked).toEqual([1]);
  });

  it('rejects malformed requests with invalid_request', async () => {
    const service = new AuthorityService();
    for (const bad of [null, [], {}, { doc: 'd' }, { doc: 'd', stateId: 'zz' }]) {
      expect(await service.open(bad)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }
  });
});

describe('materialise (PRO-103 criterion 2)', () => {
  it('returns the canonical content, byte for byte what the authority package gives', async () => {
    const built = await buildLog(['a', 'b', 'c']);
    const service = new AuthorityService();
    await service.open(await openRequest(built, 3));
    for (let seq = 0; seq <= 3; seq++) {
      const m = await service.materialise(built.heads[3], seq);
      expect(m.ok && m.text).toBe(inProcess(built, seq));
      expect(m.ok && m.contentHash).toBe(await documentHash(envelopeOf(built.docs[seq]!)));
    }
  });

  it('reads the head when no seq is given, and refuses a seq outside the state', async () => {
    const built = await buildLog(['a', 'b', 'c']);
    const service = new AuthorityService();
    await service.open(await openRequest(built, 3, 1));
    const head = await service.materialise(built.heads[3]);
    expect(head).toMatchObject({ ok: true, seq: 3 });
    expect(await service.materialise(built.heads[3], 4)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await service.materialise(built.heads[3], 0)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await service.materialise(built.heads[3], 1)).toMatchObject({ ok: true, seq: 1 });
    expect(await service.materialise(built.heads[3], 1.5)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('property: every seq of a random log equals the in-process content', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[A-Za-z0-9 ]{1,6}$/), { minLength: 0, maxLength: 6 }),
        fc.nat(6),
        async (texts, pick) => {
          const clean = texts;
          const built = await buildLog(clean);
          const service = new AuthorityService();
          const n = clean.length;
          const from = pick % (n + 1);
          const opened = await service.open(await openRequest(built, n, from));
          expect(opened).toMatchObject({ ok: true, seq: n });
          const seq = from + (pick % (n - from + 1));
          const m = await service.materialise(stateIdAt(built, n), seq);
          expect(m.ok && m.text).toBe(inProcess(built, seq));
        },
      ),
      { numRuns: 30 },
    );
  });

  it('replays a snapshot commit from the checkpoint the resolver gives', async () => {
    const built = await buildLog(['a']);
    const restored = baseEnvelope(); // the document as created: a restore to seq 0
    const snapshot = await wireCommit(built.doc, 2, built.heads[1]!, 'snapshot', {
      steps: [],
      snapshot: { checkpoint: 'ckpt-2', reason: 'restore' },
    });
    const doc2 = schema.nodeFromJSON(restored.doc);
    const step = typing(doc2, 'pOne000000000001', 'z');
    const after = await wireCommit(built.doc, 3, snapshot.hash, 'steps', {
      steps: stepsToJson([step]),
      retired: [],
      claimed: [],
    });
    const resolver: CheckpointResolver = {
      ref: () => Promise.resolve(undefined),
      snapshot: (_d, id) => Promise.resolve(id === 'ckpt-2' ? restored : undefined),
    };
    const service = new AuthorityService({ resolver });
    const req = {
      doc: built.doc,
      checkpointRef: built.start,
      commits: [built.commits[0]!, snapshot, after],
      stateId: after.hash,
    };
    expect(await service.open(req)).toMatchObject({ ok: true, seq: 3 });
    const m = await service.materialise(after.hash, 3);
    expect(m.ok && m.text).toBe(canonicalText(envelopeOf(step.apply(doc2).doc!)));
    const atSnapshot = await service.materialise(after.hash, 2);
    expect(atSnapshot.ok && atSnapshot.text).toBe(canonicalText(restored));
    // Without the resolver the snapshot cannot be loaded.
    expect(await new AuthorityService().open(req)).toMatchObject({
      ok: false,
      error: { code: 'checkpoint_unavailable' },
    });
  });
});

describe('a rewound log (PRO-103 criterion 3)', () => {
  it('never answers an old stateId with the new state', async () => {
    const before = await buildLog(['a', 'b', 'c']);
    const after = await buildLog(['a', 'b', 'X']); // rewound to 2, then another commit 3
    expect(after.heads[3]).not.toBe(before.heads[3]);
    expect(after.heads[2]).toBe(before.heads[2]);

    const service = new AuthorityService();
    await service.open(await openRequest(before, 3));
    await service.open(await openRequest(after, 3));

    const old = await service.materialise(before.heads[3], 3);
    const now = await service.materialise(after.heads[3], 3);
    expect(old.ok && old.text).toBe(inProcess(before, 3));
    expect(now.ok && now.text).toBe(inProcess(after, 3));
    expect(old.ok && now.ok && old.text !== now.text).toBe(true);
  });

  it('says unknown_state for an old stateId the service no longer holds', async () => {
    const before = await buildLog(['a', 'b', 'c']);
    const after = await buildLog(['a', 'b', 'X']);
    const service = new AuthorityService({ capacity: 1 });
    await service.open(await openRequest(before, 3));
    await service.open(await openRequest(after, 3));
    expect(service.holds(before.heads[3]!)).toBe(false);
    expect(await service.materialise(before.heads[3], 3)).toMatchObject({
      ok: false,
      error: { code: 'unknown_state' },
    });
    const now = await service.materialise(after.heads[3], 3);
    expect(now.ok && now.text).toBe(inProcess(after, 3));
  });
});

describe('no state that matters (PRO-103 criterion 4)', () => {
  it('gives the same content after a restart or an eviction', async () => {
    const built = await buildLog(['a', 'b', 'c']);
    const req = await openRequest(built, 3);
    const service = new AuthorityService({ capacity: 1 });
    await service.open(req);
    const first = await service.materialise(built.heads[3]);

    service.clear(); // a restart
    expect(await service.materialise(built.heads[3])).toMatchObject({
      ok: false,
      error: { code: 'unknown_state' },
    });
    expect(await service.open(req)).toMatchObject({ ok: true, stateId: built.heads[3] });
    expect(await service.materialise(built.heads[3])).toEqual(first);

    // An eviction by another document.
    const other = await buildLog(['q'], { doc: 'doc-0002' });
    await service.open(await openRequest(other, 1));
    expect(service.holds(built.heads[3]!)).toBe(false);
    await service.open(req);
    expect(await service.materialise(built.heads[3])).toEqual(first);

    // A second service object, as a second replica.
    const replica = new AuthorityService();
    await replica.open(req);
    expect(await replica.materialise(built.heads[3])).toEqual(first);
  });

  it('opening twice with the same inputs is the same answer', async () => {
    const built = await buildLog(['a', 'b']);
    const service = new AuthorityService();
    const req = await openRequest(built, 2);
    const a = await service.open(req);
    const b = await service.open(req);
    expect(b).toEqual(a);
    expect(service.size).toBe(1);
    expect(await checkpointAt(built, 1)).toMatchObject({ seq: 1 });
  });
});

describe('the HTTP binding', () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('opens with JSON and with NDJSON, and serves the same bytes as the service', async () => {
    const built = await buildLog(['a', 'b', 'c']);
    const service = new AuthorityService();
    running = await listen({ service });
    const req = await openRequest(built, 3);

    const json = await fetch(`${running.url}/v1/authority/documents/${built.doc}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        checkpointRef: req.checkpointRef,
        commits: req.commits,
        stateId: req.stateId,
      }),
    });
    expect(json.status).toBe(201);
    expect(await json.json()).toEqual({ stateId: built.heads[3], seq: 3, doc: built.doc });

    service.clear();
    const lines = [
      JSON.stringify({ checkpointRef: req.checkpointRef, stateId: req.stateId }),
      ...req.commits.map((c) => JSON.stringify(c)),
    ].join('\n');
    const nd = await fetch(`${running.url}/v1/authority/documents/${built.doc}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: lines,
    });
    expect(nd.status).toBe(201);

    for (const seq of [0, 2, 3]) {
      const res = await fetch(
        `${running.url}/v1/authority/states/${built.heads[3]}/content?seq=${seq}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-seq')).toBe(String(seq));
      expect(await res.text()).toBe(inProcess(built, seq));
    }
    const head = await fetch(`${running.url}/v1/authority/states/${built.heads[3]}/content`);
    expect(head.headers.get('x-seq')).toBe('3');
  });

  it('answers failures as problem details with the code', async () => {
    const built = await buildLog(['a']);
    running = await listen({ service: new AuthorityService() });
    const unknown = await fetch(`${running.url}/v1/authority/states/${built.heads[1]}/content`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toBe('application/problem+json');
    expect(await unknown.json()).toMatchObject({ code: 'unknown_state', status: 404 });

    const req = await openRequest(built, 1);
    const wrong = await fetch(`${running.url}/v1/authority/documents/${built.doc}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...req, stateId: built.start.contentHash }),
    });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ code: 'state_mismatch' });

    const notJson = await fetch(`${running.url}/v1/authority/documents/${built.doc}/open`, {
      method: 'POST',
      body: '{',
    });
    expect(notJson.status).toBe(400);
    expect((await fetch(`${running.url}/v1/authority/nothing`)).status).toBe(404);
    expect((await fetch(`${running.url}/v1/authority/documents/${built.doc}/open`)).status).toBe(
      405,
    );
    expect((await fetch(`${running.url}/v1/authority/ready`)).status).toBe(200);
  });
});
