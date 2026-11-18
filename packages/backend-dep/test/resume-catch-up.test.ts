// PRO-095 criteria 1 and 2 (lane U-PRO-086-102): after a lost connection the channel reopens with
// `resume` (seq, incarnation, inflight) and follows the catch-up mode the server chose (stream,
// page or reload); `sync.caughtUp` comes before any resubmission of a commit the server reports as
// unknown. The server is MockDepServer behind CatchUpServer, which can name the mode of each
// resumed `ch.opened`. Node.js, over the in-memory network.
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
import { CatchUpServer, type CatchUpMode } from './support/catch-up-server.ts';
import { MemoryNetwork } from './support/memory-network.ts';
import { MockDepServer, type MockDepServerOptions } from './support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A control commit at `seq` (no steps), the shape a server streams or pages. */
function control(seq: number, rev: number): RemoteCommit {
  return {
    seq,
    kind: 'control',
    id: `0192f0c4-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    steps: [],
    control: { type: 'grants', rev },
    author: { user: 'system', session: null, agent: null },
    serverTime: '2026-11-13T10:00:00.000Z',
    origin: 'control',
  };
}

function setup(modes: CatchUpMode[], options: MockDepServerOptions = {}) {
  const dep = new MockDepServer(options);
  const server = new CatchUpServer(dep, modes);
  const net = new MemoryNetwork(server);
  const docId = dep.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const make = (): DepBackend =>
    createDepBackend({
      endpoint: dep.endpoint,
      getToken: async () => dep.mintToken(USERS.editor, { [docId]: 'editor' }),
      platform: { random: () => 0, ...net.platform() },
    });
  return { dep, server, net, docId, make };
}

/** The `resume` objects of every `ch.open` the client sent, read from the wire. */
function resumesOf(net: MemoryNetwork): Array<Record<string, unknown>> {
  return net
    .decoded('c2s')
    .filter((f) => f['t'] === 'ch.open' && (f['d'] as { resume?: unknown }).resume !== undefined)
    .map((f) => (f['d'] as { resume: Record<string, unknown> }).resume);
}

interface Seen {
  status: string;
  code?: string | null | undefined;
}

async function joined(s: ReturnType<typeof setup>, b: DepBackend) {
  await b.connect();
  const content = await b.sync.loadContent(s.docId);
  const ch = await b.sync.open(s.docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const states: Seen[] = [];
  const received: number[] = [];
  ch.onState((st) => states.push({ status: st.status, code: 'code' in st ? st.code : undefined }));
  ch.onCommits((commits) => received.push(...commits.map((c) => c.seq)));
  await until(() => states.some((x) => x.status === 'live'), 'live');
  return { ch, content, states, received };
}

describe('PRO-095: a resumed channel follows the catch-up mode the server chooses', () => {
  it('stream: reopens with resume (seq, incarnation), receives the commits, then sync.caughtUp', async () => {
    const s = setup(['stream']);
    const b = s.make();
    const { content, states, received } = await joined(s, b);
    s.server.pageCommits = [control(content.seq + 1, 11), control(content.seq + 2, 12)];
    const before = resumesOf(s.net).length;
    s.net.cut();
    await until(() => resumesOf(s.net).length > before, 'a resume after the cut');
    const resume = resumesOf(s.net).at(-1)!;
    expect(resume['seq']).toBe(content.seq);
    expect(resume['incarnation']).toBe(content.incarnation);
    await until(() => states.filter((x) => x.status === 'live').length >= 2, 'live again');
    expect(s.server.openedModes).toEqual(['stream']);
    expect(received).toEqual([content.seq + 1, content.seq + 2]);
    await b.close();
  });

  it('page: reopens with resume, reads the missing commits over REST and then goes live', async () => {
    const s = setup(['page']);
    const b = s.make();
    const { content, states, received } = await joined(s, b);
    s.server.pageCommits = [control(content.seq + 1, 11), control(content.seq + 2, 12)];
    const before = resumesOf(s.net).length;
    s.net.cut();
    await until(() => resumesOf(s.net).length > before, 'a resume after the cut');
    await until(() => states.filter((x) => x.status === 'live').length >= 2, 'live again');
    expect(s.server.openedModes).toEqual(['page']);
    expect(s.server.pageRequests).toEqual([content.seq]);
    expect(received).toEqual([content.seq + 1, content.seq + 2]);
    await b.close();
  });

  it('reload: the channel closes with unavailable and the caller reads the pinned content', async () => {
    const s = setup(['reload']);
    const b = s.make();
    const { content, states } = await joined(s, b);
    const before = resumesOf(s.net).length;
    s.net.cut();
    await until(
      () => states.some((x) => x.status === 'closed' && x.code === 'unavailable'),
      'the reload close',
    );
    expect(s.server.openedModes).toEqual(['reload']);
    // Only the one resume was sent: the reload is not retried by the channel itself.
    expect(resumesOf(s.net).length).toBe(before + 1);
    const pinned = await b.sync.loadContent(s.docId, content.seq);
    expect(pinned.seq).toBe(content.seq);
    await b.close();
  });
});

describe('PRO-095 criterion 2: sync.caughtUp comes before a resubmission of an unknown commit', () => {
  it('resubmits the lost commit only after the server has caught the channel up', async () => {
    const s = setup([], { limits: { ackTimeoutMs: 80 } });
    const b = s.make();
    const { ch, content, states } = await joined(s, b);
    // The first submit never reaches the server, so on resume the server reports it as unknown.
    s.server.swallowBudget = 1;
    const commit = {
      id: '0192f0c4-0000-7000-8000-0000000000e1',
      base: content.seq,
      steps: [insertText(posIn(content.doc, IDS.intro), 'q')],
    };
    const failed = ch.submit(commit).then(
      () => null,
      (e: unknown) => e,
    );
    await until(() => resumesOf(s.net).some((r) => r['inflight'] === commit.id), 'the resume');
    // An unanswered submit fails with unavailable (D23); the caller decides whether to resubmit.
    expect(await failed).toMatchObject({ code: 'unavailable' });
    await until(() => states.filter((x) => x.status === 'live').length >= 2, 'live again');
    // The caller resubmits only once the channel is live again (after sync.caughtUp).
    const result = await ch.submit(commit);
    expect(result).toMatchObject({ seq: content.seq + 1 });

    // The wire order: the resumed ch.opened, then sync.caughtUp, then the second sync.submit.
    const frames = s.net.frames;
    const submitIdx = frames
      .map((f, i) => ({ f, i }))
      .filter(
        ({ f }) =>
          f.dir === 'c2s' && f.text.includes('"t":"sync.submit"') && f.text.includes(commit.id),
      )
      .map(({ i }) => i);
    // The first frame was swallowed; the second one is the resubmission.
    expect(submitIdx.length).toBe(2);
    const resubmitAt = submitIdx[1]!;
    const resumedOpenAt = frames
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => f.dir === 's2c' && f.text.includes('"t":"ch.opened"') && i < resubmitAt)
      .map(({ i }) => i)
      .at(-1)!;
    expect(resumedOpenAt).toBeGreaterThan(submitIdx[0]!);
    // The server answers the resume with the fate of the lost commit: it never stored it.
    expect(frames[resumedOpenAt]!.text).toContain('"state":"unknown"');
    const caughtUpAt = frames.findIndex(
      (f, i) => i > resumedOpenAt && f.dir === 's2c' && f.text.includes('"t":"sync.caughtUp"'),
    );
    expect(caughtUpAt).toBeGreaterThan(resumedOpenAt);
    expect(resubmitAt).toBeGreaterThan(caughtUpAt);
    await b.close();
  });

  it('holds a resubmission made while catching up until sync.caughtUp has arrived and the port reports live', async () => {
    const s = setup(['stream'], { limits: { ackTimeoutMs: 80 } });
    const b = s.make();
    const { ch, content, states } = await joined(s, b);
    const commit = {
      id: '0192f0c4-0000-7000-8000-0000000000e2',
      base: content.seq,
      steps: [insertText(posIn(content.doc, IDS.intro), 'r')],
    };
    // The first submit is lost; the server holds sync.caughtUp of the resumed channel back.
    s.server.swallowBudget = 1;
    s.server.holdCaughtUp = true;
    const failed = ch.submit(commit).then(
      () => null,
      (e: unknown) => e,
    );
    await until(() => resumesOf(s.net).some((r) => r['inflight'] === commit.id), 'the resume');
    expect(await failed).toMatchObject({ code: 'unavailable' });
    await until(() => s.server.held.length > 0, 'the held sync.caughtUp');
    // The caller resubmits at once, while the channel is still catching up.
    const liveBefore = states.filter((x) => x.status === 'live').length;
    expect(states.at(-1)?.status).not.toBe('live');
    const result = ch.submit(commit);
    await sleep(60);
    const submits = () =>
      s.net
        .decoded('c2s')
        .filter((f) => f['t'] === 'sync.submit' && JSON.stringify(f).includes(commit.id)).length;
    // Only the lost frame has been sent: the port holds the resubmission back.
    expect(submits()).toBe(1);
    expect(states.filter((x) => x.status === 'live').length).toBe(liveBefore);
    s.server.releaseCaughtUp();
    expect(await result).toMatchObject({ seq: content.seq + 1 });
    expect(states.filter((x) => x.status === 'live').length).toBe(liveBefore + 1);
    expect(submits()).toBe(2);
    await b.close();
  });
});
