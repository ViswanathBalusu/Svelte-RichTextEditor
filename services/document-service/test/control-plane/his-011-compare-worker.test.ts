// A comparison runs in a worker thread, never on the loop that serves requests (HIS-011 criterion
// 4; 06 §1 stage 1). The route sends the plain task to the pool and the answer comes back from a
// thread other than the main one; the same task run inline gives the same comparison.
import { threadId } from 'node:worker_threads';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import { compareTask, type CompareTask } from '../../src/control-plane/workers/compare-task.ts';
import { WorkerPool } from '../../src/control-plane/workers/pool.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const typing = (pos: number, text: string) => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

function firstText(doc: unknown): { pos: number; block: string } {
  const root = cdmSchema().nodeFromJSON(doc);
  let found: { pos: number; block: string } | null = null;
  root.descendants((n, pos) => {
    if (!found && n.isTextblock) found = { pos: pos + 1, block: String(n.attrs['id']) };
    return !found;
  });
  if (!found) throw new Error('no text block');
  return found;
}

async function appendBy(h: Harness, doc: string, user: string, pos: number): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [
      {
        seq: head.seq + 1,
        id: uuid7(),
        kind: 'steps' as const,
        steps: [typing(pos, 'x')] as never,
        user,
        session: 'session-test',
        time: h.now(),
        origin: 'input',
        scopes: ['body'],
        revision: perms.revision,
        cdm: 1,
        engine: 'pm-steps/1',
        retired: [],
        claimed: [],
      },
    ],
  });
  if (r.status !== 'ok') throw new Error(`append refused: ${r.status}`);
  return head.seq + 1;
}

describe('a comparison runs in a worker thread (HIS-011 criterion 4)', () => {
  let h: Harness;
  let doc: string;
  let owner: string;
  let task: CompareTask;
  const seen: { kind: string; thread: number | null }[] = [];

  beforeAll(async () => {
    h = await startHarness('memory', {});
    doc = await h.createDocument({ content: documentWithRegions(), title: 'Compare in a worker' });
    const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    const at = firstText(content.json.doc);
    await appendBy(h, doc, bob, at.pos);
    await appendBy(h, doc, bob, at.pos);
    owner = h.userToken({ [doc]: 'owner' });
    // Record every task the route sends to the pool and the thread that answered it.
    const pool = h.service.pool;
    const run = pool.run.bind(pool) as (kind: string, input: unknown) => Promise<unknown>;
    (pool as { run: unknown }).run = async (kind: string, input: unknown) => {
      if (kind === 'compare') task = input as CompareTask;
      const out = await run(kind, input);
      seen.push({ kind, thread: (out as { threadId?: number }).threadId ?? null });
      return out;
    };
  });
  afterAll(async () => {
    await h?.close();
  });

  it('sends the comparison to the pool, and a thread other than the main one answers', async () => {
    const r = await h.call('GET', `/v1/documents/${doc}/diff?fromSeq=0&toSeq=2`, { token: owner });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ fromSeq: 0, toSeq: 2, method: 'steps' });
    const compares = seen.filter((s) => s.kind === 'compare');
    expect(compares.length).toBe(1);
    expect(compares[0]?.thread).not.toBeNull();
    // The main thread has id 0; a worker has another.
    expect(compares[0]?.thread).not.toBe(threadId);
    expect(threadId).toBe(0);
  });

  it('gives the same comparison inline as in the worker (the task is plain data)', async () => {
    const pool = new WorkerPool({ size: 1, taskTimeoutMs: 30_000 });
    try {
      // The task of the request above, structured-cloned through a real worker.
      const viaWorker = (await pool.run<{ result: unknown; threadId: number }>('compare', task))
        .result;
      expect(viaWorker).toEqual(compareTask(task));
      expect(viaWorker).toMatchObject({ ok: true });
    } finally {
      await pool.close();
    }
  });

  it('refuses a seq the document does not have before any task is sent', async () => {
    const before = seen.length;
    const r = await h.call('GET', `/v1/documents/${doc}/diff?fromSeq=0&toSeq=99`, { token: owner });
    expect(r.status).toBe(404);
    expect(seen.length).toBe(before);
  });
});
