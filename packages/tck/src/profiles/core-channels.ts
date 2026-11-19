/**
 * The `core` profile, part 2 (PRO-111 criterion 3): channels (05 §5.2). Every `ch.rejected` code the
 * kit can provoke from outside, `ch.close`, `ch.closed`, and joining by `stream`, `page` and
 * `reload`, with in-flight commits accepted and unknown (04 §9).
 */
import type { Ack } from '@docedit/protocol';
import { KitFailure, check, equal, excludes, jsonEqual, oneOf } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { IDS, contractDocument, insertText, longDocument, posIn } from '../documents.ts';
import { scenario, type ScenarioDef } from '../scenario.ts';
import { TEST_HOOKS_FEATURE, hook } from './fault-injection.ts';
import {
  acked,
  ackedWithRetry,
  commitsOn,
  join,
  newId,
  openChannel,
  opened,
  readContent,
  untilSeq,
  type Member,
} from './support.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('core', def);

/**
 * The largest catchUpCommits the page scenario provokes: it makes one more commit than the limit,
 * one acknowledged commit at a time. The default of the reference service is 5,000 (05 §5.9). A
 * provisional bound, not a measurement: a server that announces more is skipped with the reason.
 */
const MAX_PAGE_LIMIT = 6000;

/** A document with three commits by its owner after the content it was created with. */
async function withHistory(ctx: ScenarioContext) {
  const doc = await ctx.document();
  const owner = await join(ctx, 'owner', doc, 'owner');
  const pos = posIn(owner.content.doc, IDS.end);
  const acks: Ack[] = [];
  let base = owner.content.seq;
  for (const t of ['a', 'b', 'c']) {
    const a = await acked(owner.wire, 1, { base, steps: [insertText(pos + acks.length, t)] });
    acks.push(a);
    base = a.seq;
  }
  return { doc, owner, acks };
}

async function rejectedWith(
  ctx: ScenarioContext,
  m: { wire: Member['wire'] },
  ch: number,
  doc: string,
  code: string,
  opts: Parameters<typeof openChannel>[4] = {},
) {
  const reply = await openChannel(ctx, m.wire, ch, doc, opts);
  if (reply.t !== 'ch.rejected')
    throw new KitFailure(`ch.open is rejected with ${code}`, `ch.rejected ${code}`, reply);
  equal(reply.d.code, code, 'the ch.rejected code (05 §5.2)');
  check(typeof reply.d.message === 'string', 'ch.rejected carries a message', 'a string', reply.d);
  equal(reply.ch, ch, 'ch.rejected carries the channel number');
}

export const CORE_CHANNELS: ScenarioDef[] = [
  s({
    id: 'channel.reload',
    title:
      'ch.open without resume answers reload at the durable head; the next live commit is head + 1',
    spec: '05 §5.2; D08',
    covers: { messages: ['ch.open', 'ch.opened'], operations: ['GET /documents/{id}/content'] },
    async run(ctx) {
      const { doc, owner, acks } = await withHistory(ctx);
      const v = await ctx.session('viewer', { [doc]: 'viewer' });
      const o = await opened(ctx, v.wire, 1, doc, {});
      equal(o.catchUp, 'reload', 'catchUp without resume (05 §5.2)');
      equal(o.head, acks.at(-1)!.seq, 'head is the durable head');
      equal(o.incarnation, owner.content.incarnation, 'incarnation');
      equal(o.inflight, undefined, 'no inflight without resume.inflight (D08)');
      equal(o.access.docRole, 'viewer', 'access.docRole');
      const pinned = await readContent(ctx, v.token, doc, o.head);
      equal(pinned.seq, o.head, 'the pinned read at head (05 §5.2)');
      const from = v.wire.mark();
      const next = await acked(owner.wire, 1, {
        base: o.head,
        steps: [insertText(posIn(owner.content.doc, IDS.intro), 'z')],
      });
      const m = await v.wire.next(
        (x) => x.t === 'sync.commit' && x.ch === 1,
        'the first live commit',
        { from },
      );
      if (m.t !== 'sync.commit') throw new KitFailure('a sync.commit', 'sync.commit', m);
      equal(m.d.commits[0]!.seq, o.head + 1, 'the first live commit is head + 1 (05 §5.2)');
      equal(next.seq, o.head + 1, 'the acknowledged seq');
    },
  }),
  s({
    id: 'channel.stream',
    title:
      'an editor resuming below the head gets the missed commits as a stream, then sync.caughtUp',
    spec: '05 §5.2, §5.3; 04 §9',
    covers: {
      messages: ['sync.caughtUp', 'sync.commit'],
      fields: ['ch.open.resume', 'ch.opened.view'],
    },
    async run(ctx) {
      const { doc, owner, acks } = await withHistory(ctx);
      const [s1, s2, s3] = acks.map((a) => a.seq) as [number, number, number];
      const e = await ctx.session('editor', { [doc]: 'editor' });
      const pinned = await readContent(ctx, e.token, doc, s1);
      const resume: { seq: number; incarnation: string; view?: string } = {
        seq: s1,
        incarnation: pinned.incarnation,
      };
      if (pinned.view !== undefined) resume.view = pinned.view;
      const o = await opened(ctx, e.wire, 1, doc, { resume });
      equal(o.catchUp, 'stream', 'catchUp for an editor within the limits (05 §5.2; ADR 0034)');
      equal(o.head, s3, 'head');
      // The view token is optional and opaque (ADR 0019, proposed; D28): a string when present.
      if (o.view !== undefined)
        check(
          typeof o.view === 'string' && o.view.length > 0,
          'ch.opened.view is an opaque string (D28)',
          'a string',
          o.view,
        );
      const caught = await e.wire.nextOf('sync.caughtUp', { ch: 1 });
      equal(caught.d.seq, s3, 'sync.caughtUp carries the head');
      const at = e.wire.messages.indexOf(caught);
      const streamed = e.wire.messages
        .slice(0, at)
        .flatMap((m) => (m.t === 'sync.commit' && m.ch === 1 ? m.d.commits.map((c) => c.seq) : []));
      jsonEqual(
        streamed,
        [s2, s3],
        'every commit from resume.seq + 1 to head, in order, before sync.caughtUp',
      );
      const live = await acked(owner.wire, 1, {
        base: s3,
        steps: [insertText(posIn(owner.content.doc, IDS.intro), 'L')],
      });
      await untilSeq(e.wire, 1, live.seq, 'the first live commit after the stream');
    },
  }),
  s({
    id: 'channel.reload-viewer',
    title: 'a viewer resuming below the head reloads under the default history visibility',
    spec: '05 §5.2; 07 §8; ADR 0034 (proposed)',
    covers: { messages: ['ch.opened'], fields: ['ch.open.resume'] },
    async run(ctx) {
      if (ctx.config.historyVisibility !== 'editors')
        ctx.skip(
          `depends on the history visibility \`editors\` (ADR 0034); the target applies ${ctx.config.historyVisibility}`,
        );
      const { doc, owner, acks } = await withHistory(ctx);
      const v = await ctx.session('viewer', { [doc]: 'viewer' });
      const o = await opened(ctx, v.wire, 1, doc, {
        resume: { seq: acks[0]!.seq, incarnation: owner.content.incarnation },
      });
      equal(
        o.catchUp,
        'reload',
        'a viewer may not see the history below the head (07 §8; ADR 0034 default)',
      );
      equal(o.head, acks.at(-1)!.seq, 'head');
    },
  }),
  s({
    id: 'channel.resume-mismatch',
    title: 'a resume with another incarnation or a seq beyond the head reloads',
    spec: '05 §5.2; 04 §9 step 3',
    covers: { fields: ['ch.open.resume'] },
    async run(ctx) {
      const doc = await ctx.document();
      const a = await ctx.session('a', { [doc]: 'editor' });
      const c = await readContent(ctx, a.token, doc);
      const o1 = await opened(ctx, a.wire, 1, doc, {
        resume: { seq: c.seq, incarnation: `${c.incarnation}-other` },
      });
      equal(o1.catchUp, 'reload', 'another incarnation');
      const b = await ctx.session('b', { [doc]: 'editor' });
      const o2 = await opened(ctx, b.wire, 1, doc, {
        resume: { seq: c.seq + 10, incarnation: c.incarnation },
      });
      equal(o2.catchUp, 'reload', 'a seq beyond the head');
    },
  }),
  s({
    id: 'channel.inflight',
    title: 'resume.inflight is reported accepted with its seq, or unknown',
    spec: '05 §5.2; 04 §9; D08',
    covers: { fields: ['ch.open.resume', 'ch.opened.inflight'] },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'writer', doc, 'editor');
      const ack = await acked(m.wire, 1, {
        base: m.content.seq,
        steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
      });
      // The same user reconnects, as a client does after losing the connection (04 §9).
      const token = await ctx.service.token(m.sub, { [doc]: 'editor' });
      const w2 = await ctx.connect({ label: 'reconnected' });
      await ctx.hello(w2, token);
      const o = await opened(ctx, w2, 1, doc, {
        resume: { seq: m.content.seq, incarnation: m.content.incarnation, inflight: ack.id },
      });
      jsonEqual(o.inflight, { state: 'accepted', seq: ack.seq }, 'a stored commit (04 §9 step 2)');
      const w3 = await ctx.connect({ label: 'unknown' });
      await ctx.hello(w3, await ctx.service.token(m.sub, { [doc]: 'editor' }));
      const o3 = await opened(ctx, w3, 1, doc, {
        resume: { seq: ack.seq, incarnation: m.content.incarnation, inflight: newId() },
      });
      jsonEqual(o3.inflight, { state: 'unknown' }, 'a commit that was not stored');
    },
  }),
  s({
    id: 'channel.page',
    title: 'a resume beyond the catch-up limits is paged or reloaded, never streamed past them',
    spec: '05 §5.2; 04 §9 step 4',
    timeoutMs: 300_000,
    covers: { fields: ['ch.open.resume'] },
    async run(ctx) {
      const limit = ctx.limits.catchUpCommits;
      if (limit > MAX_PAGE_LIMIT)
        ctx.skip(
          `catchUpCommits is ${limit}: provoking a page needs more than the ${MAX_PAGE_LIMIT} commits this scenario is bounded to`,
        );
      const doc = await ctx.document(longDocument(4));
      const owner = await join(ctx, 'owner', doc, 'owner');
      let base = owner.content.seq;
      const pos = posIn(owner.content.doc, 'pLong00000000000');
      for (let i = 0; i <= limit + 1; i++)
        base = (await ackedWithRetry(owner.wire, 1, { base, steps: [insertText(pos, 'p')] })).seq;
      const e = await ctx.session('late', { [doc]: 'editor' });
      const o = await opened(ctx, e.wire, 1, doc, {
        resume: { seq: owner.content.seq, incarnation: owner.content.incarnation },
      });
      oneOf(o.catchUp, ['page', 'reload'], `catchUp beyond ${limit} commits (04 §9)`);
      if (o.catchUp === 'page') {
        const res = await ctx.service.as(e.token, 'GET', `/documents/${doc}/commits`, {
          query: { after: owner.content.seq, limit: 50 },
        });
        equal(res.status, 200, 'GET /documents/{id}/commits for the page');
      } else ctx.note('the target reloads beyond its limits rather than paging');
    },
  }),
  s({
    id: 'channel.rejected.not-found',
    title: 'ch.open of a document that does not exist is rejected with not_found',
    spec: '05 §5.2',
    covers: { messages: ['ch.rejected'], errors: ['not_found'] },
    async run(ctx) {
      const missing = ctx.missingDocument();
      const res = await ctx.service.call('POST', '/tokens', {
        body: { sub: ctx.sub('missing'), docs: { [missing]: 'editor' } },
      });
      if (res.status !== 200 && res.status !== 201)
        ctx.skip(
          `the server mints no token for a document that does not exist (HTTP ${res.status})`,
        );
      const token = (res.json as { token: string }).token;
      const w = await ctx.connect({ label: 'missing' });
      await ctx.hello(w, token);
      await rejectedWith(ctx, { wire: w }, 1, missing, 'not_found');
    },
  }),
  s({
    id: 'channel.rejected.forbidden',
    title: 'ch.open of a document the token does not cover is rejected with forbidden',
    spec: '05 §5.2, §3.1',
    covers: { messages: ['ch.rejected'], errors: ['forbidden'] },
    async run(ctx) {
      const doc = await ctx.document();
      const other = await ctx.document();
      const w = await ctx.session('outsider', { [doc]: 'editor' });
      await rejectedWith(ctx, w, 1, other, 'forbidden');
    },
  }),
  s({
    id: 'channel.rejected.engine',
    title: 'an engine the server does not run is rejected with unsupported_engine',
    spec: '05 §5.2',
    covers: { messages: ['ch.rejected'], errors: ['unsupported_engine'] },
    async run(ctx) {
      const doc = await ctx.document();
      const w = await ctx.session('engine', { [doc]: 'editor' });
      await rejectedWith(ctx, w, 1, doc, 'unsupported_engine', { engine: 'x-tck-engine/9' });
    },
  }),
  s({
    id: 'channel.rejected.cdm',
    title: 'a CDM version the server does not serve is rejected with unsupported_cdm',
    spec: '05 §5.2',
    covers: { messages: ['ch.rejected'], errors: ['unsupported_cdm'] },
    async run(ctx) {
      const doc = await ctx.document();
      const w = await ctx.session('cdm', { [doc]: 'editor' });
      await rejectedWith(ctx, w, 1, doc, 'unsupported_cdm', { cdm: 99 });
    },
  }),
  s({
    id: 'channel.rejected.feature',
    title: 'a feature the server did not announce is rejected with unsupported_feature',
    spec: '05 §1 rule 4, §5.2',
    covers: { messages: ['ch.rejected'], errors: ['unsupported_feature'] },
    async run(ctx) {
      const doc = await ctx.document();
      const w = await ctx.session('feature', { [doc]: 'editor' });
      await rejectedWith(ctx, w, 1, doc, 'unsupported_feature', {
        features: ['x-tck-unannounced'],
      });
    },
  }),
  s({
    id: 'channel.rejected.requires',
    title:
      'a document whose requires lists a feature the client did not ask for is rejected with unsupported_feature',
    spec: '03 §11; 05 §5.2',
    covers: { messages: ['ch.rejected'], errors: ['unsupported_feature'] },
    async run(ctx) {
      const content = contractDocument();
      (content as unknown as { requires: string[] }).requires = ['extensions'];
      const res = await ctx.service.call('POST', '/documents', { body: { content } });
      if (res.status !== 201 && res.status !== 200)
        ctx.skip(
          `the server refused a document that requires \`extensions\` without extension nodes (HTTP ${res.status})`,
        );
      const doc = (res.json as { id: string }).id;
      const w = await ctx.session('requires', { [doc]: 'editor' });
      await rejectedWith(ctx, w, 1, doc, 'unsupported_feature', { features: [] });
    },
  }),
  s({
    id: 'channel.rejected.already-open',
    title: 'a second channel for one document is rejected with already_open',
    spec: '05 §4, §5.2',
    covers: { messages: ['ch.rejected'], errors: ['already_open'] },
    async run(ctx) {
      const doc = await ctx.document();
      const w = await ctx.session('twice', { [doc]: 'editor' });
      await opened(ctx, w.wire, 1, doc, {});
      await rejectedWith(ctx, w, 2, doc, 'already_open');
    },
  }),
  s({
    id: 'channel.rejected.limit',
    title: 'one channel more than maxChannels is rejected with channel_limit',
    spec: '05 §5.1, §5.2',
    timeoutMs: 90_000,
    covers: { messages: ['ch.rejected'], errors: ['channel_limit'] },
    async run(ctx) {
      const max = ctx.limits.maxChannels;
      if (max > 60) ctx.skip(`maxChannels is ${max}: too many documents for one scenario`);
      const docs: string[] = [];
      for (let i = 0; i <= max; i++) docs.push(await ctx.document());
      const sub = ctx.sub('many');
      // A token names at most 20 documents (05 §3.1): channels beyond them carry their own token.
      const first = docs.slice(0, 20);
      const token = await ctx.service.token(
        sub,
        Object.fromEntries(first.map((d) => [d, 'viewer'])),
      );
      const w = await ctx.connect({ label: 'many' });
      await ctx.hello(w, token);
      for (let i = 0; i < max; i++) {
        const own = i < 20 ? undefined : await ctx.service.token(sub, { [docs[i]!]: 'viewer' });
        await opened(ctx, w, i + 1, docs[i]!, own ? { token: own } : {});
      }
      const last = docs[max]!;
      const own = max < 20 ? undefined : await ctx.service.token(sub, { [last]: 'viewer' });
      await rejectedWith(
        ctx,
        { wire: w },
        max + 1,
        last,
        'channel_limit',
        own ? { token: own } : {},
      );
    },
  }),
  s({
    id: 'channel.rejected.unavailable',
    title: 'ch.open while the server cannot serve the document is rejected with unavailable',
    spec: '05 §5.2, §11',
    needs: { testMode: true },
    covers: { messages: ['ch.rejected'], errors: ['unavailable'] },
    async run(ctx) {
      // Only a server that fails on demand lets the kit see this code. The hook is the one of the
      // fault-injection profile (ADR 0219, owner decision 192; ADR 0398): POST /_test/database
      // makes the store unreachable, so the room cannot be opened or kept.
      if (!ctx.has(TEST_HOOKS_FEATURE))
        ctx.skip(`the server does not announce ${TEST_HOOKS_FEATURE}`);
      const doc = await ctx.document();
      const w = await ctx.session('unavailable', { [doc]: 'editor' });
      let down = false;
      try {
        const res = await hook(ctx, 'POST', '/database', { down: true });
        check(res.status === 204, 'the database hook answers 204', '204', res.status);
        down = true;
        await rejectedWith(ctx, w, 1, doc, 'unavailable');
      } finally {
        if (down) await hook(ctx, 'POST', '/database', { down: false });
      }
      // The refusal is not final: once the store is back, the document opens.
      await opened(ctx, w.wire, 2, doc, {});
    },
  }),
  s({
    id: 'channel.token',
    title:
      'a channel may carry its own token for the same user; a token of another user is refused',
    spec: '05 §3.1, §5.2',
    covers: { messages: ['ch.open', 'ch.opened'], fields: ['ch.open.token'] },
    async run(ctx) {
      const d1 = await ctx.document();
      const d2 = await ctx.document();
      const s1 = await ctx.session('channels', { [d1]: 'editor' });
      const own = await ctx.service.token(s1.sub, { [d2]: 'viewer' });
      const o = await opened(ctx, s1.wire, 2, d2, { token: own });
      equal(o.access.docRole, 'viewer', 'the channel has the role of its own token (05 §3.1)');
      const d3 = await ctx.document();
      const intruder = await ctx.service.token(ctx.sub('intruder'), { [d3]: 'owner' });
      const r = await openChannel(ctx, s1.wire, 3, d3, { token: intruder });
      check(
        r.t !== 'ch.opened',
        'a channel token of another user is refused (05 §3.1: same tid and sub)',
        'ch.rejected or error',
        r,
      );
    },
  }),
  s({
    id: 'channel.close',
    title:
      'after ch.close nothing more arrives on the channel, and the document can be opened again',
    spec: '05 §5.2; G30',
    covers: { messages: ['ch.close'] },
    async run(ctx) {
      const doc = await ctx.document();
      const owner = await join(ctx, 'owner', doc, 'owner');
      const v = await join(ctx, 'viewer', doc, 'viewer');
      v.wire.send({ t: 'ch.close', ch: 1 });
      await v.wire.settle(300);
      const from = v.wire.mark();
      const a = await acked(owner.wire, 1, {
        base: owner.content.seq,
        steps: [insertText(posIn(owner.content.doc, IDS.intro), 'c')],
      });
      await v.wire.settle(500);
      const after = v.wire.messages
        .slice(from)
        .filter((m) => 'ch' in m && m.ch === 1 && m.t !== 'ch.closed');
      check(
        after.length === 0,
        'nothing is delivered on a closed channel',
        'no messages on channel 1',
        after.map((m) => m.t),
      );
      const o = await opened(ctx, v.wire, 2, doc, {});
      check(
        o.head >= a.seq,
        'the document opens again on another channel',
        `head ≥ ${a.seq}`,
        o.head,
      );
    },
  }),
  s({
    id: 'channel.closed',
    title: 'a revocation for one document closes that channel with ch.closed; the others stay open',
    spec: '05 §3.3, §5.2; D73',
    covers: {
      messages: ['ch.closed'],
      operations: ['POST /sessions/revoke'],
      errors: ['forbidden'],
    },
    async run(ctx) {
      const d1 = await ctx.document();
      const d2 = await ctx.document();
      const w = await ctx.session('two', { [d1]: 'editor', [d2]: 'editor' });
      await opened(ctx, w.wire, 1, d1, {});
      const o2 = await opened(ctx, w.wire, 2, d2, {});
      await ctx.sleep(1100);
      await ctx.service.revoke(w.sub, d1);
      const closed = await w.wire.nextOf('ch.closed', { ch: 1 });
      equal(closed.d.code, 'forbidden', 'the code after a revocation (05 §5.2)');
      check(
        typeof closed.d.reason === 'string',
        'ch.closed carries a reason',
        'a string',
        closed.d,
      );
      check(
        w.wire.open,
        'the session stays open: the token still covers another document (D73)',
        'open',
        w.wire.closed,
      );
      const c2 = await readContent(ctx, w.token, d2);
      const a = await acked(w.wire, 2, {
        base: o2.head,
        steps: [insertText(posIn(c2.doc, IDS.intro), 'k')],
      });
      check(a.seq > o2.head, 'the other channel still accepts commits', `> ${o2.head}`, a.seq);
      excludes(
        commitsOn(w.wire, 1).map((c) => c.seq),
        a.seq,
        'nothing more on the closed channel',
      );
    },
  }),
];
