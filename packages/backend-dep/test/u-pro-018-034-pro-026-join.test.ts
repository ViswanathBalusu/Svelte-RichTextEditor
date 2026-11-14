// PRO-026 criterion 4 (lane U-PRO-018-034): a first join without `resume` reads the content over
// REST at some seq, opens the channel with `resume.seq` set to it, and ends with the same commits
// as a client that streamed from the start. Node.js, over the in-memory network of the mock DEP
// server (the real authority `Room` behind the wire protocol, backend-mock in memory).
import { describe, expect, it } from 'vitest';
import type { RemoteCommit } from '@docedit/protocol';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import {
  IDS,
  LEGAL_GRANT,
  USERS,
  contractDocument,
  insertText,
  posIn,
} from './support/fixtures.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer } from './support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 4000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function setup() {
  const dep = new MockDepServer();
  const net = new MemoryNetwork(dep);
  const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const make = (user: typeof USERS.editor = USERS.editor): DepBackend =>
    createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(user, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
  return { dep, net, docId, make };
}

/** The commits a joined channel delivered, in order, as the whole commit objects. */
function collect(ch: { onCommits(cb: (c: RemoteCommit[]) => void): () => void }) {
  const out: RemoteCommit[] = [];
  ch.onCommits((commits) => out.push(...commits));
  return out;
}

describe('PRO-026 criterion 4: a first join reads REST, then resumes at that seq', () => {
  it('ends with the same commits as a client that streamed from the start', async () => {
    const s = setup();
    const writer = s.make(USERS.editor);
    const streamer = s.make(USERS.editor);
    const joiner = s.make(USERS.editor);
    try {
      // The client that streams from the start: it reads the content at seq 0, then opens.
      await streamer.connect();
      const start = await streamer.sync.loadContent(s.docId);
      expect(start.seq).toBe(0);
      const streamCh = await streamer.sync.open(s.docId, {
        resume: { seq: start.seq, incarnation: start.incarnation },
      });
      const streamed = collect(streamCh);
      const streamStates: string[] = [];
      streamCh.onState((st) => streamStates.push(st.status));
      await until(() => streamStates.includes('live'), 'the streamer live');

      // Three commits before the late joiner arrives.
      await writer.connect();
      const wch = await writer.sync.open(s.docId, {
        resume: { seq: start.seq, incarnation: start.incarnation },
      });
      const wStates: string[] = [];
      wch.onState((st) => wStates.push(st.status));
      await until(() => wStates.includes('live'), 'the writer live');
      const written: Array<{ id: string; seq: number }> = [];
      const commitOnce = async (id: string) => {
        const c = await writer.sync.loadContent(s.docId);
        const ack = await wch.submit({
          id,
          base: c.seq,
          steps: [insertText(posIn(c.doc, IDS.intro), id.slice(-1))],
        });
        written.push({ id, seq: ack.seq });
      };
      for (const id of [
        '0192f0c4-0000-7000-8000-0000000000a1',
        '0192f0c4-0000-7000-8000-0000000000a2',
        '0192f0c4-0000-7000-8000-0000000000a3',
      ]) {
        await commitOnce(id);
      }
      expect(written.map((w) => w.seq)).toEqual([1, 2, 3]);
      await until(() => streamed.length >= 3, 'the streamer receives the first three');

      // The late joiner: a first join reads the content over REST at head, then opens with resume.
      await joiner.connect();
      const atJoin = await joiner.sync.loadContent(s.docId);
      expect(atJoin.seq).toBe(3);
      const joinCh = await joiner.sync.open(s.docId, {
        resume: { seq: atJoin.seq, incarnation: atJoin.incarnation },
      });
      const joined = collect(joinCh);
      const joinStates: string[] = [];
      joinCh.onState((st) => joinStates.push(st.status));
      await until(() => joinStates.includes('live'), 'the joiner live');

      // Two more commits after the join: both clients must see them.
      await commitOnce('0192f0c4-0000-7000-8000-0000000000a4');
      await commitOnce('0192f0c4-0000-7000-8000-0000000000a5');
      await until(
        () => streamed.length >= 5 && joined.length >= 2,
        'both clients receive the last two',
      );

      // The streamer saw seqs 1 to 5 once, in order.
      expect(streamed.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
      // The joiner saw exactly the commits after its REST read, in order.
      expect(joined.map((c) => c.seq)).toEqual([4, 5]);
      // The commits both clients hold for seqs 4 and 5 are the same commits, byte for byte.
      const fromStream = streamed.filter((c) => c.seq > atJoin.seq);
      expect(JSON.stringify(joined)).toBe(JSON.stringify(fromStream));
      // The commits before the join are the ones the joiner's REST read already holds: the
      // streamer's seqs 1 to 3 are the writer's acknowledged commits, in the same order.
      expect(streamed.slice(0, 3).map((c) => c.id)).toEqual(written.slice(0, 3).map((w) => w.id));
      // The head the joiner reached matches the head read over REST afterwards.
      const head = await joiner.sync.loadContent(s.docId);
      expect(head.seq).toBe(5);
    } finally {
      await writer.close();
      await streamer.close();
      await joiner.close();
    }
  });
});
