/**
 * The `core-relay` profile (PRO-124; 05 §9, §2; 04 §14): what a relay announces. A relay stores and
 * orders commits and relays them, and nothing more, so it never announces a feature that needs the
 * document model. The kit selects this profile for a server whose discovery says `mode: "relay"`
 * and not the profiles that need document semantics (`PROFILES` in `index.ts`).
 *
 * The scenarios that submit commits (PRO-124 criteria 2 and 3) read no content, because a relay
 * serves none (05 §9): a user opens a channel without `resume` and is streamed the log. They run
 * against the relay target of the kit's tests (`test/targets/relay-server.ts`).
 */
import { uuid7 } from '@docedit/model';
import type { Step } from '@docedit/protocol';
import { check, equal, includes, jsonEqual, oneOf } from '../assert.ts';
import { shapeViolations, type ScenarioContext } from '../context.ts';
import { insertText } from '../documents.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { acked, commitsOn, opened, rejected, untilSeq } from './support.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('core-relay', def);

/**
 * A connected user with the `editor` role on a document, whose channel is open. A relay serves no
 * content (05 §9), so the user reads none: a channel opened without `resume` streams the log from
 * its first commit.
 */
async function member(ctx: ScenarioContext, name: string, doc: string) {
  const session = await ctx.session(name, { [doc]: 'editor' });
  const channel = await opened(ctx, session.wire, 1, doc);
  return { ...session, channel, ch: 1 };
}

/** The features a relay never announces (05 §2; 04 §14). */
export const RELAY_NEVER_ANNOUNCES = ['regions', 'suggest-enforced', 'fields'] as const;

export const CORE_RELAY: ScenarioDef[] = [
  s({
    id: 'discovery.mode-and-features',
    title: 'a relay says so in discovery and announces none of regions, suggest-enforced, fields',
    spec: '05 §2, §9; 04 §14',
    covers: { operations: ['GET /.well-known/dep'] },
    async run(ctx) {
      const res = await ctx.target.http.request('GET', ctx.target.discoveryUrl);
      equal(res.status, 200, 'GET /.well-known/dep without a credential (D66)');
      const violations = shapeViolations('Discovery', res.json);
      check(
        violations.length === 0,
        'discovery matches the published schema',
        'no violations',
        violations,
      );
      const d = ctx.target.discovery;
      oneOf(d.mode, ['relay'], 'mode');
      for (const f of RELAY_NEVER_ANNOUNCES)
        check(
          !d.features.includes(f),
          `a relay never announces ${f} (05 §2, §9)`,
          'absent',
          d.features,
        );
      includes(d.versions, '1.0', 'versions');
    },
  }),
  s({
    id: 'sync.stale-base',
    title: 'a commit whose base is not the head is rejected with stale_base and the head',
    spec: '05 §5.3, §9; 04 §14',
    covers: {
      messages: ['ch.open', 'sync.submit', 'sync.ack', 'sync.reject'],
      errors: ['stale_base'],
      operations: ['POST /documents', 'POST /tokens'],
    },
    async run(ctx) {
      const doc = await ctx.document();
      const a = await member(ctx, 'alice', doc);
      const b = await member(ctx, 'bob', doc);
      equal(a.channel.head, 0, 'the head of a new document');
      const first = await acked(a.wire, a.ch, { base: 0, steps: [insertText(1, 'A')] });
      equal(first.seq, 1, 'the first commit is seq 1');
      const behind = { id: uuid7(), base: 0, steps: [insertText(1, 'B')] };
      const r = await rejected(b.wire, b.ch, behind);
      equal(r.code, 'stale_base', 'the base 0 is behind the head 1 (04 §14)');
      equal(r.action, 'rebase', 'the action of stale_base (04 §8)');
      equal(r.id, behind.id, 'the rejection names the commit');
      equal(r.head, 1, 'the rejection carries the head');
      const ahead = await rejected(b.wire, b.ch, { base: 7, steps: [insertText(1, 'B')] });
      equal(ahead.code, 'stale_base', 'a base ahead of the head is not the head either');
      // After catching up the same commit is accepted at the head, under the same id.
      await untilSeq(b.wire, b.ch, 1);
      const again = await acked(b.wire, b.ch, { ...behind, base: 1 });
      equal(again.seq, 2, 'accepted at the head');
      equal(again.id, behind.id, 'the same commit identifier');
      equal(again.rebased, false, 'a relay rebases nothing (04 §14)');
      // Neither rejection stored anything: a late joiner streams exactly the two commits.
      const c = await member(ctx, 'carol', doc);
      await untilSeq(c.wire, c.ch, 2);
      jsonEqual(
        commitsOn(c.wire, c.ch).map((x) => x.seq),
        [1, 2],
        'only accepted commits are stored',
      );
    },
  }),
  s({
    id: 'sync.store-and-relay',
    title: 'commits at the head are acknowledged, stored in order and relayed unchanged',
    spec: '05 §5.3, §9; 04 §5 step 10, §14',
    covers: {
      messages: ['ch.open', 'ch.opened', 'sync.submit', 'sync.ack', 'sync.commit', 'sync.caughtUp'],
      fields: ['sync.submit.origin'],
    },
    async run(ctx) {
      const doc = await ctx.document();
      const a = await member(ctx, 'author', doc);
      const b = await member(ctx, 'reader', doc);
      const first: Step[] = [insertText(1, 'one')];
      const second: Step[] = [insertText(4, 'two'), insertText(7, 'three')];
      const id1 = uuid7();
      const id2 = uuid7();
      const ack1 = await acked(a.wire, a.ch, { id: id1, base: 0, steps: first, origin: 'input' });
      equal(ack1.seq, 1, 'the next seq');
      equal(ack1.rebased, false, 'not rebased');
      const ack2 = await acked(a.wire, a.ch, { id: id2, base: 1, steps: second, origin: 'paste' });
      equal(ack2.seq, 2, 'the seq after it');
      await untilSeq(b.wire, b.ch, 2);
      const got = commitsOn(b.wire, b.ch);
      jsonEqual(
        got.map((c) => c.seq),
        [1, 2],
        'the other channel receives the commits in order',
      );
      const [c1, c2] = got;
      jsonEqual(c1?.steps, first, 'the steps of the first commit, unchanged');
      jsonEqual(c2?.steps, second, 'the steps of the second commit, unchanged');
      equal(c1?.id, id1, 'the identifier of the first commit');
      equal(c2?.id, id2, 'the identifier of the second commit');
      equal(c1?.kind, 'steps', 'kind');
      equal(c1?.control, null, 'control on a step commit');
      equal(
        c1?.author.user,
        a.welcome.user.id,
        'author.user is the identity of the session (04 G6)',
      );
      equal(c1?.author.session, a.welcome.session, 'author.session');
      equal(c1?.serverTime, ack1.serverTime, 'one server time for the commit');
      equal(c1?.origin, 'input', 'origin');
      equal(c2?.origin, 'paste', 'origin');
      const own = commitsOn(a.wire, a.ch);
      check(
        own.length === 0,
        'the author gets the acknowledgement, not its own commit',
        'no sync.commit',
        own,
      );
      // Stored: a user who joins later is streamed the same commits, then told it has caught up.
      const late = await member(ctx, 'late', doc);
      await untilSeq(late.wire, late.ch, 2);
      const caught = await late.wire.nextOf('sync.caughtUp', { ch: late.ch });
      equal(caught.d.seq, 2, 'caught up at the head');
      jsonEqual(
        commitsOn(late.wire, late.ch).map((c) => [c.seq, c.id, c.steps]),
        [
          [1, id1, first],
          [2, id2, second],
        ],
        'the stored commits as they were submitted',
      );
    },
  }),
  s({
    id: 'sync.steps-unread',
    title: 'a relay does not read the steps: any step is stored and relayed as it came',
    spec: '04 §14; 05 §9',
    covers: { messages: ['sync.submit', 'sync.ack', 'sync.commit'] },
    async run(ctx) {
      const doc = await ctx.document();
      const a = await member(ctx, 'author', doc);
      const b = await member(ctx, 'reader', doc);
      // A server with a document model would refuse this step (`invalid_op`, 04 §4). A relay skips
      // the steps of 04 §5 that read it and leaves the unappliable step to the clients (04 §14).
      const odd: Step[] = [{ stepType: 'x-opaque', payload: { n: [1, 2, 3], note: 'kept as is' } }];
      const ack = await acked(a.wire, a.ch, { base: 0, steps: odd });
      equal(ack.seq, 1, 'acknowledged at the next seq');
      await untilSeq(b.wire, b.ch, 1);
      jsonEqual(commitsOn(b.wire, b.ch)[0]?.steps, odd, 'relayed without a change');
    },
  }),
];

export const CORE_RELAY_PROFILE: ProfileDef = {
  id: 'core-relay',
  title: 'The core profile for relays',
  spec: '05 §9; 04 §14',
  stories: ['PRO-124'],
  requires: { kind: 'mode', mode: 'relay' },
  scenarios: CORE_RELAY,
};
