// SYN-027 criterion 4: a channel that resumes with `catchUp: "stream"` over a gap of 5,000 commits
// (the catch-up target, `catchUpCommits`) receives every commit once and in order, while commits
// are stored during the stream, and what the client received equals the log. The room is
// synchronous, so the stream is the set of effects the room returns for the channel; the host
// delivers them in chunks, and between chunks other writers' commits are stored and their effects
// queue behind the stream, as a host's send queue would hold them. The wire queue is BE's.
import { type Node, Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/codes.ts';
import { Room } from '../src/room/room.ts';
import type { CommitInput, Effects, LogCommit, Resume, ToClient } from '../src/room/types.ts';
import { parseSteps, stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

const T0 = 1_790_400_000_000;
const id = (n: number): string => `0192f0c4-9300-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PARAGRAPHS = ['pIntro0000000001', 'pMiddle000000001', 'pTerms000000001A'] as const;

function room(): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-stress',
    now: () => T0,
  });
}

function insertCommit(doc: Node, n: number, base: number): CommitInput {
  const pos = posInside(doc, PARAGRAPHS[n % PARAGRAPHS.length]!);
  return {
    id: id(n),
    base,
    steps: stepsToJson([
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(`e${n} `)), 0, 0)),
    ]),
  };
}

const forChannel = (fx: Effects, channel: string): ToClient[] =>
  fx.send.filter((s) => s.channel === channel).map((s) => s.msg);

/**
 * Submits commit `n` from the writer `w`, stores it, and returns the messages the channel `late`
 * is sent for it (the broadcast of the store) and the stored commit that the log now holds.
 */
function storeOne(r: Room, n: number, log: LogCommit[]): ToClient[] {
  const sub = r.submit('w', insertCommit(r.document, n, r.head));
  const write = sub.write;
  if (!write) throw new Error(`commit ${n} was not written`);
  log.push(...write.commits);
  const done = r.writeCompleted({ status: 'ok' });
  return [...forChannel(sub, 'late'), ...forChannel(done, 'late')];
}

describe('a 5,000-commit stream joins the missing and live commits (SYN-027 criterion 4)', () => {
  it('the client receives exactly the log, each commit once and in order, with commits stored mid-stream', () => {
    const N = DEFAULT_LIMITS.catchUpCommits ?? 5_000;
    const INJECTED = 3;
    const CHUNK = 500;
    const log: LogCommit[] = [];

    const r = room();
    r.open('w', USERS.carol);
    for (let n = 1; n <= N; n++) {
      const sub = r.submit('w', insertCommit(r.document, n, r.head));
      if (!sub.write) throw new Error(`commit ${n} was not written`);
      log.push(...sub.write.commits);
      r.writeCompleted({ status: 'ok' });
    }
    expect(r.head).toBe(N);
    expect(log.map((c) => c.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // Resume at seq 0: the gap is exactly the catch-up commit limit, so the room streams it.
    const resume: Resume = { seq: 0, incarnation: r.incarnation, inflight: null };
    const opened = r.open('late', USERS.alice, resume);
    const queue: ToClient[] = forChannel(opened, 'late');
    expect(queue[0]?.t).toBe('ch.opened');
    expect(queue.at(-1)).toEqual({ t: 'sync.caughtUp', head: N });

    const received: ToClient[] = [];
    let injected = 0;
    while (queue.length > 0) {
      received.push(queue.shift()!);
      // Between chunks of the stream, another writer stores a commit; its effects queue behind.
      if (received.length % CHUNK === 0 && injected < INJECTED) {
        injected++;
        queue.push(...storeOne(r, N + injected, log));
      }
    }
    expect(injected).toBe(INJECTED);
    expect(r.head).toBe(N + INJECTED);

    // Order: the stream's commits, then sync.caughtUp, then the live commits, each seq once.
    const commits = received.flatMap((m) => (m.t === 'sync.commit' ? [m.commit] : []));
    expect(commits.map((c) => c.seq)).toEqual(
      Array.from({ length: N + INJECTED }, (_, i) => i + 1),
    );
    const caught = received.findIndex((m) => m.t === 'sync.caughtUp');
    const index = (seq: number) =>
      received.findIndex((m) => m.t === 'sync.commit' && m.commit.seq === seq);
    expect(caught).toBeGreaterThan(index(N));
    expect(caught).toBeLessThan(index(N + 1));
    expect(received.some((m) => m.t === 'sync.ack' || m.t === 'sync.reject')).toBe(false);

    // The client equals the log: same identifiers and steps, and the steps applied in order to
    // the initial document give the room's document.
    expect(commits.map((c) => c.id)).toEqual(log.map((c) => c.id));
    expect(commits.map((c) => c.steps)).toEqual(log.map((c) => (c as { steps: unknown }).steps));
    let doc: Node = baseDoc();
    for (const c of commits) {
      const parsed = parseSteps(schema, c.steps, DEFAULT_LIMITS);
      if (!parsed.ok) throw new Error(`commit ${c.seq} does not parse`);
      for (const step of parsed.value) {
        const res = step.apply(doc);
        if (res.failed || !res.doc) throw new Error(`commit ${c.seq} does not apply`);
        doc = res.doc;
      }
    }
    expect(doc.eq(r.document)).toBe(true);
  }, 120_000);
});
