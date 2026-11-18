/**
 * SEC-032 criteria 1 and 3: every place a client may supply a sequence number refuses a value below
 * the caller's history gate, over the real service (in-memory storage, real HTTP and a real
 * WebSocket), and the cases are tied to `SEQ_INPUTS` (services/document-service/src/data-plane/gate.ts),
 * which his-024-seq-walk.test.ts ties to the protocol definition. A new gated input therefore fails
 * the build here until it has a case.
 *
 * The history is built to leak: commit 1 types a marker word into the introduction and commit 2
 * deletes it, so the marker is in the content at seq 1 and not in the head. A caller below the gate
 * must never receive the marker. The owner holds `edit`, sees full history under the default
 * `editors` setting, and reads the marker at seq 1 (the control: the data is there to leak).
 *
 * Not covered, with the reason (see the story's Notes):
 * - Named-version creation and restore take a seq, but both need `edit`, and a caller with `edit`
 *   sees full history under `editors`, which is the only setting a document can have until HIS-025.
 *   Their cases show the refusal of a reader and the acceptance for an editor; the gate itself is
 *   shown in packages/history/test/gate-negative.test.ts and by the route-enumeration test
 *   (services/document-service/test/control-plane/prm-041-seq-routes.test.ts).
 */
import { randomUUID } from 'node:crypto';
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQ_INPUTS } from '../../../services/document-service/src/data-plane/gate.ts';
import type { DocRef } from '../../../services/document-service/src/storage/types.ts';
import { documentWithRegions, posInside, startHarness, type Harness } from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const INTRO = 'pIntro0000000001';
const MARKER = 'SECRETWORDQX';

interface Reply {
  status: number;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
}

interface Rig {
  h: Harness;
  doc: string;
  head: number;
  owner: string;
  viewer: string;
  commenter: string;
  editor: string;
}

/** A refusal below the gate: `forbidden`, and none of the old text in the body. */
function refused(r: Reply): void {
  expect(r.status, r.text).toBe(403);
  expect(r.json?.code).toBe('forbidden');
  expect(r.text).not.toContain(MARKER);
}

/** One case per gated input of `SEQ_INPUTS`: a request below the gate and a control at or above it. */
interface Case {
  /** What the control must be. */
  below(rig: Rig, as: string): Promise<void>;
  at(rig: Rig): Promise<void>;
}

const call = (rig: Rig, method: string, path: string, token: string, body?: unknown) =>
  rig.h.call(method, path, {
    token,
    ...(body !== undefined ? { body } : {}),
    headers: { 'Idempotency-Key': randomUUID() },
  }) as Promise<Reply>;

const CASES: Record<string, Case> = {
  'GET /documents/{id}/content|query.seq': {
    async below(rig, as) {
      refused(await call(rig, 'GET', `/v1/documents/${rig.doc}/content?seq=1`, as));
    },
    async at(rig) {
      const r = await call(
        rig,
        'GET',
        `/v1/documents/${rig.doc}/content?seq=${rig.head}`,
        rig.viewer,
      );
      expect(r.status, r.text).toBe(200);
      expect(r.text).not.toContain(MARKER);
    },
  },
  'GET /documents/{id}/commits|query.after': {
    async below(rig, as) {
      refused(await call(rig, 'GET', `/v1/documents/${rig.doc}/commits?after=0`, as));
    },
    async at(rig) {
      const r = await call(
        rig,
        'GET',
        `/v1/documents/${rig.doc}/commits?after=${rig.head}`,
        rig.viewer,
      );
      expect(r.status, r.text).toBe(200);
    },
  },
  'POST /documents/{id}/exports|body.seq': {
    async below(rig, as) {
      refused(
        await call(rig, 'POST', `/v1/documents/${rig.doc}/exports`, as, { target: 'pdf', seq: 1 }),
      );
    },
    async at(rig) {
      // The gate lets the head through. With no export worker in this rig the route may answer
      // something else, but never the gate's refusal.
      const r = await call(rig, 'POST', `/v1/documents/${rig.doc}/exports`, rig.viewer, {
        target: 'pdf',
        seq: rig.head,
      });
      expect(r.text).not.toContain('history visibility');
    },
  },
  'GET /documents/{id}/diff|query.fromSeq': {
    async below(rig, as) {
      refused(
        await call(rig, 'GET', `/v1/documents/${rig.doc}/diff?fromSeq=1&toSeq=${rig.head}`, as),
      );
    },
    async at(rig) {
      const r = await call(
        rig,
        'GET',
        `/v1/documents/${rig.doc}/diff?fromSeq=${rig.head}&toSeq=${rig.head}`,
        rig.viewer,
      );
      expect(r.status, r.text).toBe(200);
      expect(r.text).not.toContain(MARKER);
    },
  },
  'GET /documents/{id}/history|query.fromSeq': {
    async below(rig, as) {
      refused(await call(rig, 'GET', `/v1/documents/${rig.doc}/history?fromSeq=1`, as));
    },
    async at(rig) {
      const r = await call(
        rig,
        'GET',
        `/v1/documents/${rig.doc}/history?fromSeq=${rig.head + 1}`,
        rig.viewer,
      );
      expect(r.status, r.text).toBe(200);
      expect(r.text).not.toContain(MARKER);
    },
  },
  'GET /documents/{id}/history|query.toSeq': {
    async below(rig, as) {
      refused(await call(rig, 'GET', `/v1/documents/${rig.doc}/history?toSeq=1`, as));
    },
    async at(rig) {
      const r = await call(
        rig,
        'GET',
        `/v1/documents/${rig.doc}/history?toSeq=${rig.head}`,
        rig.viewer,
      );
      expect(r.status, r.text).toBe(200);
      expect(r.text).not.toContain(MARKER);
    },
  },
  'GET /documents/{id}/diff|query.toSeq': {
    async below(rig, as) {
      refused(await call(rig, 'GET', `/v1/documents/${rig.doc}/diff?fromSeq=0&toSeq=1`, as));
    },
    async at(rig) {
      const r = await call(
        rig,
        'GET',
        `/v1/documents/${rig.doc}/diff?fromSeq=0&toSeq=${rig.head}`,
        rig.owner,
      );
      expect(r.status, r.text).toBe(200);
    },
  },
  'GET /documents/{id}/attribution|query.atSeq': {
    async below(rig, as) {
      refused(await call(rig, 'GET', `/v1/documents/${rig.doc}/attribution?atSeq=1`, as));
    },
    async at(rig) {
      const r = await call(
        rig,
        'GET',
        `/v1/documents/${rig.doc}/attribution?atSeq=${rig.head}`,
        rig.viewer,
      );
      expect(r.status, r.text).toBe(200);
      expect(r.text).not.toContain(MARKER);
    },
  },
  'GET /documents/{id}/threads|query.seq': {
    async below(rig, as) {
      refused(await call(rig, 'GET', `/v1/documents/${rig.doc}/threads?seq=1`, as));
    },
    async at(rig) {
      const r = await call(
        rig,
        'GET',
        `/v1/documents/${rig.doc}/threads?seq=${rig.head}`,
        rig.viewer,
      );
      expect(r.status, r.text).toBe(200);
    },
  },
  'GET /documents/{id}/field-values|query.seq': {
    async below(rig, as) {
      refused(await call(rig, 'GET', `/v1/documents/${rig.doc}/field-values?seq=1`, as));
    },
    async at(rig) {
      const r = await call(
        rig,
        'GET',
        `/v1/documents/${rig.doc}/field-values?seq=${rig.head}`,
        rig.viewer,
      );
      expect(r.status, r.text).toBe(200);
    },
  },
  'POST /documents/{id}/fork|body.atSeq': {
    // A fork is a service-credential operation. The service credential reads full history unless it
    // names the user it acts for in `DEP-Actor` (PRM-042 criterion 4; ADR 0379, proposed).
    async below(rig) {
      const r = await rig.h.call('POST', `/v1/documents/${rig.doc}/fork`, {
        token: rig.h.a.apiKey,
        headers: { 'Idempotency-Key': randomUUID(), 'DEP-Actor': 'carol' },
        body: { atSeq: 1 },
      });
      refused(r as Reply);
    },
    async at(rig) {
      const r = await rig.h.call('POST', `/v1/documents/${rig.doc}/fork`, {
        token: rig.h.a.apiKey,
        headers: { 'Idempotency-Key': randomUUID(), 'DEP-Actor': 'carol' },
        body: { atSeq: rig.head },
      });
      expect(r.status, r.text).toBe(201);
    },
  },
  'POST /documents/{id}/versions|body.seq': {
    // `edit` is needed, and `edit` sees full history under `editors`: the reader is refused for the
    // role and the editor is accepted at seq 1, so no gate refusal is reachable (see the header).
    async below(rig, as) {
      const r = await call(rig, 'POST', `/v1/documents/${rig.doc}/versions`, as, {
        seq: 1,
        name: 'x',
      });
      expect(r.status, r.text).toBe(403);
      expect(r.text).not.toContain(MARKER);
    },
    async at(rig) {
      const r = await call(rig, 'POST', `/v1/documents/${rig.doc}/versions`, rig.editor, {
        seq: 1,
        name: 'First draft',
      });
      expect(r.status, r.text).toBe(201);
    },
  },
  'POST /documents/{id}/restore|body.toSeq': {
    async below(rig, as) {
      const r = await call(rig, 'POST', `/v1/documents/${rig.doc}/restore`, as, { toSeq: 1 });
      expect(r.status, r.text).toBe(403);
      expect(r.text).not.toContain(MARKER);
    },
    async at(rig) {
      // A dry run at seq 1 by the owner is not refused by the gate.
      const r = await call(rig, 'POST', `/v1/documents/${rig.doc}/restore`, rig.owner, {
        toSeq: 1,
        dryRun: true,
      });
      expect(r.text).not.toContain('history visibility');
      expect(r.status, r.text).toBeLessThan(500);
    },
  },
};

/**
 * Gated inputs of `SEQ_INPUTS` that have no case, each with its reason. A listed input that gains a
 * case, or a route that is served, must leave this list (the test below fails otherwise).
 */
const OPEN: Record<string, string> = {};

/** `ch.open|resume.seq` is a wire case, not an HTTP one. */
const WIRE = 'ch.open|resume.seq';

describe('SEC-032: every place a sequence number is supplied honours the gate', () => {
  let rig: Rig;

  beforeAll(async () => {
    const h = await startHarness('memory');
    const doc = await h.createDocument(h.a, documentWithRegions());
    const ref: DocRef = { tenant: h.a.id, doc };
    const epoch = await h.parts.ownership.claim(ref, 'sec-032-node');
    const perms = await h.parts.grants.current(ref);
    const head0 = await h.parts.logs.head(ref);
    const at = posInside(documentWithRegions()['doc'], INTRO);
    const base = {
      kind: 'steps' as const,
      user: 'u-alice',
      session: 'session-test',
      origin: 'input' as const,
      scopes: ['body'],
      revision: perms.revision,
      cdm: 1,
      engine: 'pm-steps/1',
      retired: [],
      claimed: [],
    };
    // Seq 1 types the marker; seq 2 deletes it again.
    const commits: StoredCommit[] = [
      {
        ...base,
        seq: head0.seq + 1,
        id: uuid7(),
        time: h.now(),
        steps: [
          {
            stepType: 'replace',
            from: at,
            to: at,
            slice: { content: [{ type: 'text', text: MARKER }] },
          },
        ] as StoredCommit['steps'],
      },
      {
        ...base,
        seq: head0.seq + 2,
        id: uuid7(),
        time: h.now() + 1,
        steps: [{ stepType: 'replace', from: at, to: at + MARKER.length }] as StoredCommit['steps'],
      },
    ];
    const r = await h.parts.logs.append(ref, {
      epoch,
      revision: perms.revision,
      fromSeq: head0.seq + 1,
      commits,
    });
    expect(r.status).toBe('ok');
    rig = {
      h,
      doc,
      head: head0.seq + 2,
      owner: h.userToken(h.a, 'olive', { [doc]: 'owner' }),
      viewer: h.userToken(h.a, 'carol', { [doc]: 'viewer' }),
      commenter: h.userToken(h.a, 'cora', { [doc]: 'commenter' }),
      editor: h.userToken(h.a, 'eddie', { [doc]: 'editor' }),
    };
  });
  afterAll(async () => {
    await rig?.h.close();
  });

  it('the history holds the marker at seq 1 and not at the head (the data is there to leak)', async () => {
    const old = await call(rig, 'GET', `/v1/documents/${rig.doc}/content?seq=1`, rig.owner);
    expect(old.status, old.text).toBe(200);
    expect(old.text).toContain(MARKER);
    const head = await call(rig, 'GET', `/v1/documents/${rig.doc}/content`, rig.owner);
    expect(head.text).not.toContain(MARKER);
  });

  /** The gated inputs with no case, and the cases that no gated input names. */
  function coverage(inputs: ReadonlyArray<{ where: string; field: string; rule: string }>) {
    const gated = inputs.filter((i) => i.rule !== 'exempt').map((i) => `${i.where}|${i.field}`);
    const covered = new Set([...Object.keys(CASES), WIRE, ...Object.keys(OPEN)]);
    return {
      uncovered: gated.filter((k) => !covered.has(k)),
      stale: [...covered].filter((k) => !gated.includes(k)),
    };
  }

  it('each gated input of SEQ_INPUTS has a case or is named open (a new input fails here)', () => {
    expect(coverage(SEQ_INPUTS)).toEqual({ uncovered: [], stale: [] });
  });

  it('the check fails on a new route with a sequence field, until it has a case (shown on a mutated list; SEC-032 criterion 3)', () => {
    // The walk of the protocol definition (HIS-024, his-024-seq-walk.test.ts) forces a new route's
    // field into SEQ_INPUTS; this check then forces a case for it.
    const added = { where: 'GET /documents/{id}/new-route', field: 'query.atSeq', rule: 'state' };
    expect(coverage([...SEQ_INPUTS, added]).uncovered).toEqual([
      'GET /documents/{id}/new-route|query.atSeq',
    ]);
    // An exempt field needs no case, and a case for a field that is gone is stale.
    expect(coverage([...SEQ_INPUTS, { ...added, rule: 'exempt' }]).uncovered).toEqual([]);
    const without = SEQ_INPUTS.filter((i) => !i.where.startsWith('GET /documents/{id}/history'));
    expect(coverage(without).stale.length).toBeGreaterThan(0);
  });

  it('no route is named open: every gated input has a case', () => {
    expect(Object.keys(OPEN)).toEqual([]);
  });

  for (const [key, c] of Object.entries(CASES)) {
    it(`${key}: a viewer and a commenter below the gate are refused; a request at the gate is served`, async () => {
      await c.below(rig, rig.viewer);
      await c.below(rig, rig.commenter);
      await c.at(rig);
    });
  }

  it('the activity list holds nothing below the gate', async () => {
    const own = await call(rig, 'GET', `/v1/documents/${rig.doc}/activity`, rig.owner);
    expect(own.status, own.text).toBe(200);
    expect(own.json.items.map((i: { seq: number }) => i.seq)).toEqual([1, 2]);
    for (const token of [rig.viewer, rig.commenter]) {
      const r = await call(rig, 'GET', `/v1/documents/${rig.doc}/activity`, token);
      expect(r.status, r.text).toBe(200);
      expect(r.json.items.every((i: { seq: number }) => i.seq >= rig.head)).toBe(true);
      expect(r.text).not.toContain(MARKER);
    }
  });

  it('ch.open|resume.seq: below the gate a resume is answered with reload and no commit is streamed', async () => {
    const connect = async (token: string) => {
      const c = await WireClient.connect(rig.h.wsUrl, { origin: rig.h.a.origin });
      await c.hello(token);
      return c;
    };
    // A first connection learns the incarnation and the view; a second one resumes with them.
    const open = async (token: string, resumeSeq: number | 'head') => {
      const first = await connect(token);
      let opened;
      try {
        opened = await first.open(1, rig.doc);
        expect(opened.t).toBe('ch.opened');
      } finally {
        first.terminate();
      }
      const { incarnation, view } = opened.d as { incarnation: string; view: string };
      const c = await connect(token);
      try {
        const again = await c.open(1, rig.doc, {
          resume: { seq: resumeSeq === 'head' ? rig.head : resumeSeq, incarnation, view },
        });
        return { again, streamed: c.all('sync.commit', 1) };
      } finally {
        c.terminate();
      }
    };
    for (const role of ['viewer', 'commenter'] as const) {
      const token = await rig.h.mintToken(rig.h.a, `u-${role}`, { [rig.doc]: role });
      const below = await open(token, 0);
      expect(below.again.d, role).toMatchObject({ catchUp: 'reload' });
      expect(below.streamed, role).toEqual([]);
      // At the head the same reader is up to date: the reload above is the gate, not the token.
      const atHead = await open(token, 'head');
      expect(atHead.again.d, role).toMatchObject({ catchUp: 'stream' });
    }
    // The editor holds `edit`, sees full history under `editors`, and streams from the same seq.
    const editorToken = await rig.h.mintToken(rig.h.a, 'u-editor', { [rig.doc]: 'editor' });
    const streamed = await open(editorToken, 0);
    expect(streamed.again.d).toMatchObject({ catchUp: 'stream' });
  });
});
