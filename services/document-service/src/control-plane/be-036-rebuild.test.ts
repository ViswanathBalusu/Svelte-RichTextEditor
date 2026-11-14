// Reads at a pinned `seq` are rebuilt from the nearest checkpoint at or before it, replaying only
// the commits after that checkpoint, and the rebuilt version is kept for the next read (BE-036
// criterion 3; 06 §3). In-memory stores and a real worker pool. The 2,000-commit bound of the
// checkpoint cadence is the policy default (data-plane settings, checkpoint-policy.test.ts); it is
// not replayed here. Test values only.
import { type StoredCommit } from '@docedit/authority';
import { uuid7, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentWithRegions } from '../../test/control-plane/support.ts';
import { ObjectCheckpointStore } from '../objects/checkpoints.ts';
import { MemoryObjectStore } from '../objects/store.ts';
import { memoryParts, type ServiceParts } from '../server.ts';
import type { DocRef } from '../storage/types.ts';
import { ContentReader } from './content.ts';
import { FULL_VIEWS } from './visibility.ts';
import { WorkerPool } from './workers/pool.ts';

const INTRO = 'pIntro0000000001';
const TENANT = '0b36a036-0000-4000-8000-000000000036';

/** The position inside the node with `id` of the document `doc`. */
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

/** Appends one text insertion per entry of `texts`, as an editor's steps would. */
async function append(parts: ServiceParts, ref: DocRef, texts: string[]): Promise<StoredCommit[]> {
  const epoch = await parts.ownership.claim(ref, 'be-036-node');
  const head = await parts.logs.head(ref);
  const perms = await parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const commits = texts.map((t, i): StoredCommit => ({
    seq: head.seq + 1 + i,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text: t }] } },
    ] as StoredCommit['steps'],
    user: 'u-test',
    session: 'session-test',
    time: 0,
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  }));
  const r = await parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits,
  });
  expect(r.status).toBe('ok');
  return commits;
}

const envelope0 = (): JsonEnvelope => {
  const e = documentWithRegions() as unknown as JsonEnvelope;
  return { cdm: e.cdm, requires: [...e.requires], doc: e.doc };
};

const pools: WorkerPool[] = [];
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
});

async function setup(rebuiltEntries: number) {
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
    rebuiltEntries,
    responseEntries: 0,
  });
  const created = await parts.documents.create(TENANT, { cdmVersion: 1, createdBy: 'be-036-test' });
  const ref: DocRef = { tenant: TENANT, doc: created.id };
  return { parts, pool, reader, ref, checkpoints };
}

describe('a pinned read is rebuilt from the nearest checkpoint (BE-036 criterion 3)', () => {
  it('replays only the commits after the nearest checkpoint at or before the seq, and matches a full replay', async () => {
    const { parts, pool, reader, ref, checkpoints } = await setup(0);
    await checkpoints.put(ref, 0, envelope0());
    const commits = await append(parts, ref, ['a', 'b', 'c', 'd']);
    const base = envelope0();
    // The content at seq 2, made by the same worker as the reader uses, is the checkpoint at 2.
    const at2 = await pool.run<{ doc: JsonNode }>('materialise', {
      doc: base.doc,
      commits: commits.slice(0, 2).map((c) => c.steps),
    });
    await checkpoints.put(ref, 2, { cdm: base.cdm, requires: base.requires, doc: at2.doc });
    const head = await parts.logs.head(ref);

    const spy = vi.spyOn(pool, 'run');
    const at4 = await reader.rebuild(ref, head.incarnation, 4);
    expect(at4.seq).toBe(4);
    expect(spy).toHaveBeenCalledTimes(1);
    // Two commits after the checkpoint at 2, not four after 0.
    expect((spy.mock.calls[0]![1] as { commits: unknown[] }).commits).toHaveLength(2);
    spy.mockClear();

    const at3 = await reader.rebuild(ref, head.incarnation, 3);
    expect(at3.seq).toBe(3);
    expect((spy.mock.calls[0]![1] as { commits: unknown[] }).commits).toHaveLength(1);
    spy.mockRestore();

    // The rebuilt content equals a replay of every commit from seq 0.
    const full = await pool.run<{ doc: JsonNode }>('materialise', {
      doc: base.doc,
      commits: commits.map((c) => c.steps),
    });
    expect(at4.doc).toEqual(full.doc);
  });

  it('keeps the rebuilt version, so a second read of the same seq replays nothing', async () => {
    const { parts, reader, ref, checkpoints } = await setup(10);
    await checkpoints.put(ref, 0, envelope0());
    await append(parts, ref, ['x', 'y']);
    const head = await parts.logs.head(ref);
    const first = await reader.rebuild(ref, head.incarnation, 2);
    const replays = reader.replays;
    expect(replays).toBe(1);
    const second = await reader.rebuild(ref, head.incarnation, 2);
    expect(reader.replays).toBe(replays);
    expect(second).toBe(first);
  });
});
