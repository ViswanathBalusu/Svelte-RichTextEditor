// Lane V-HIS-001-016, HIS-005 criterion 5: a commit made under another engine or CDM major version
// has no replayer in the replay worker, so the rebuild refuses it instead of replaying it with the
// `pm-steps/1` CDM 1 replayer. In-memory stores and a real worker pool. Test values only.
import { type StoredCommit } from '@docedit/authority';
import { uuid7, type JsonEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterEach, describe, expect, it } from 'vitest';
import { documentWithRegions } from '../../test/control-plane/support.ts';
import { ObjectCheckpointStore } from '../objects/checkpoints.ts';
import { MemoryObjectStore } from '../objects/store.ts';
import { memoryParts } from '../server.ts';
import type { DocRef } from '../storage/types.ts';
import { ContentReader } from './content.ts';
import { ApiError } from './problems.ts';
import { FULL_VIEWS } from './visibility.ts';
import { WorkerPool } from './workers/pool.ts';

const INTRO = 'pIntro0000000001';
const TENANT = '0b5a0005-0000-4000-8000-000000000005';

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

const envelope0 = (): JsonEnvelope => {
  const e = documentWithRegions() as unknown as JsonEnvelope;
  return { cdm: e.cdm, requires: [...e.requires], doc: e.doc };
};

const pools: WorkerPool[] = [];
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
});

describe('a commit under another engine or CDM major version is refused (HIS-005 criterion 5)', () => {
  it('refuses a rebuild that would replay a commit of an unknown engine, and serves a matching one', async () => {
    const parts = memoryParts();
    const pool = new WorkerPool({ size: 1, taskTimeoutMs: 30_000 });
    pools.push(pool);
    const checkpoints = new ObjectCheckpointStore(new MemoryObjectStore());
    const reader = new ContentReader({
      logs: parts.logs,
      documents: parts.documents,
      grants: parts.grants,
      checkpoints,
      pool,
      views: FULL_VIEWS,
      rebuiltEntries: 0,
      responseEntries: 0,
    });
    const created = await parts.documents.create(TENANT, {
      cdmVersion: 1,
      createdBy: 'his-005-test',
    });
    const ref: DocRef = { tenant: TENANT, doc: created.id };
    await checkpoints.put(ref, 0, envelope0());

    const epoch = await parts.ownership.claim(ref, 'his-005-node');
    const perms = await parts.grants.current(ref);
    const pos = inside(documentWithRegions()['doc'], INTRO);
    const commit = (seq: number, engine: string): StoredCommit => ({
      seq,
      id: uuid7(),
      kind: 'steps',
      steps: [
        {
          stepType: 'replace',
          from: pos,
          to: pos,
          slice: { content: [{ type: 'text', text: `t${seq}` }] },
        },
      ] as StoredCommit['steps'],
      user: 'u-test',
      session: 'session-test',
      time: 0,
      origin: 'input',
      scopes: ['body'],
      revision: perms.revision,
      cdm: 1,
      engine,
      retired: [],
      claimed: [],
    });
    const older = await parts.logs.append(ref, {
      epoch,
      revision: perms.revision,
      fromSeq: 1,
      commits: [commit(1, 'pm-steps/1')],
    });
    expect(older.status).toBe('ok');
    const foreign = await parts.logs.append(ref, {
      epoch,
      revision: perms.revision,
      fromSeq: 2,
      commits: [commit(2, 'pm-steps/0')],
    });
    expect(foreign.status).toBe('ok');
    const head = await parts.logs.head(ref);

    // The commit at seq 1 is replayable: the rebuild at 1 succeeds.
    const at1 = await reader.rebuild(ref, head.incarnation, 1);
    expect(at1.seq).toBe(1);

    // The commit at seq 2 has no replayer: the rebuild at 2 is refused with the reason, and no
    // content is served from it.
    const err = await reader.rebuild(ref, head.incarnation, 2).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toMatch(/no replayer for engine pm-steps\/0 and CDM 1/);
  });
});
