// A rebuild over a thinned range answers that the detail is no longer available (HIS-032
// criterion 4, rebuild part; 08 §11). PostgreSQL only: thinning deletes rows of
// doc_commit_payloads, which the memory store does not keep. The test creates its own document
// (its own database, see support.ts) and deletes the payload rows of that document only.
// PostgreSQL: pwsh -NoProfile -File infra/test-env.ps1 up (FND-010).
import { type StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import { documentWithRegions, skipReason, startHarness, type Harness } from './support.ts';

const INTRO = 'pIntro0000000001';

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

/** Appends `count` text commits, so that the head moves to `count` (from 0). */
async function advance(h: Harness, doc: string, count: number): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'his-032-test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const commits = Array.from({ length: count }, (_, i): StoredCommit => ({
    seq: head.seq + 1 + i,
    id: uuid7(),
    kind: 'steps',
    steps: [
      {
        stepType: 'replace',
        from: pos,
        to: pos,
        slice: { content: [{ type: 'text', text: `t${i}` }] },
      },
    ] as StoredCommit['steps'],
    user: 'system',
    session: 'session-his-032',
    time: h.now(),
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  }));
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits,
  });
  expect(r.status).toBe('ok');
}

const unavailable = await skipReason('postgres');
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('a rebuild over a thinned range (HIS-032, postgres)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('postgres', {});
  });
  afterAll(async () => {
    await h?.close();
  });

  /** A document with its head at 3 and its payload of seq 2 thinned (the row is deleted). */
  async function thinnedAt2(): Promise<{ doc: string; owner: string }> {
    const doc = await h.createDocument({ content: documentWithRegions(), title: 'HIS-032' });
    await advance(h, doc, 3);
    await h.db!.admin.query('DELETE FROM doc_commit_payloads WHERE doc_id = $1 AND seq = $2', [
      doc,
      2,
    ]);
    return { doc, owner: h.userToken({ [doc]: 'owner' }) };
  }

  it('answers the head and the seqs before the thinned commit, and refuses the rest as not_found with a reason', async () => {
    const { doc, owner } = await thinnedAt2();

    // The checkpoint at 0 needs no commit, and seq 1 needs only commit 1, which is still stored.
    const zero = await h.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: owner });
    expect(zero.status).toBe(200);
    const one = await h.call('GET', `/v1/documents/${doc}/content?seq=1`, { token: owner });
    expect(one.status).toBe(200);

    // Seq 2 needs the thinned commit 2; the head needs it too.
    const two = await h.call('GET', `/v1/documents/${doc}/content?seq=2`, { token: owner });
    expect(two.status).toBe(404);
    expect(two.json.code).toBe('not_found');
    expect(two.json.detail ?? two.text).toContain('no longer available');
    const head = await h.call('GET', `/v1/documents/${doc}/content`, { token: owner });
    expect(head.status).toBe(404);
    expect(head.json.code).toBe('not_found');
  });

  it('keeps the commit row, so the log still reaches the head and names the absent payload', async () => {
    const { doc } = await thinnedAt2();
    const ref: DocRef = { tenant: h.tenant, doc };
    const commit = await h.parts.logs.read(ref, 2, 2).catch((e: unknown) => e);
    // The stored commit has no payload: the read names the seq as absent, it does not crash.
    expect(commit).toBeInstanceOf(Error);
    expect((commit as Error).name).toBe('PayloadAbsentError');
    expect((commit as { seq: number }).seq).toBe(2);
    const head = await h.parts.logs.head(ref);
    expect(head.seq).toBe(3);
  });
});
