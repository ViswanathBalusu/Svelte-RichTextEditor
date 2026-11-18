/**
 * The optional `fault-injection` profile (PRO-126; 05 §11; 04 §5; 06 §8). It covers what cannot be
 * seen from outside: durability before acknowledgement, fencing, the log rewind and the grants
 * revision. It applies only to a server that announces the feature `test-hooks`, which a server does
 * only while its test-mode switch is on (ADR 0219, accepted by the owner as decision 192). A server
 * without the hooks skips it, and the README says what is then unproven (the hash chain and the audit
 * trail).
 *
 * The hooks are not part of DEP: the profile uses the routes of the reference service, which ADR 0398
 * proposes as the kit's hook interface. They sit at `/_test/` on the origin of the server's REST base
 * and take the service credential:
 *
 * | Hook | Route | Effect |
 * |---|---|---|
 * | fail the next write | `POST /_test/documents/{id}/fail-next-write` `{ at }` | `at` is `before-insert` or `after-insert` |
 * | kill the room | `POST /_test/documents/{id}/kill-room` | the room stops as a crash would; its channels close `unavailable` |
 * | drop a grant announcement | `POST /_test/documents/{id}/drop-announcement` | the next announcement of a grants change is lost |
 * | rewind the log | `POST /_test/documents/{id}/rewind` `{ to }` | the log is cut at `to` and gets a new incarnation; `404` when the store cannot |
 * | read the state | `GET /_test/documents/{id}/state` | `seq`, `epoch`, `owner`, `incarnation`, `chainHead` |
 *
 * A write conflict is forced the way the server forces a fence: the room that is killed has lost its
 * claim, and a room opened afterwards claims the document at a higher epoch.
 */
import { uuid7 } from '@docedit/model';
import type { ServerMessage } from '@docedit/protocol';
import { KitFailure, check, equal, isObject, jsonEqual, oneOf } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { IDS, insertText, posIn } from '../documents.ts';
import { Http, expectStatus } from '../rest.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { acked, join, opened, readContent, submit, type Member } from './support.ts';

/** The feature a server announces when it exposes the test hooks (ADR 0219, ADR 0398). */
export const TEST_HOOKS_FEATURE = 'test-hooks';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('fault-injection', def);
const http = new Http();

interface HookState {
  seq: number;
  epoch: number;
  owner: string | null;
  incarnation: string;
  chainHead: string | null;
}

/** A call of a hook, with the service credential. */
async function hook(ctx: ScenarioContext, method: 'GET' | 'POST', path: string, body?: unknown) {
  const url = new URL(`/_test${path}`, ctx.target.discovery.rest).toString();
  const res = await http.request(method, url, {
    token: ctx.config.credential,
    ...(body !== undefined ? { body } : {}),
  });
  if (res.status === 404 && !path.endsWith('/rewind'))
    ctx.skip(`the server announces ${TEST_HOOKS_FEATURE} but has no hook at ${path} (ADR 0398)`);
  return res;
}

async function hookState(ctx: ScenarioContext, doc: string): Promise<HookState> {
  const res = expectStatus(await hook(ctx, 'GET', `/documents/${doc}/state`), 200, 'hook state');
  check(isObject(res.json), 'the state hook answers an object', 'an object', res.text);
  return res.json as unknown as HookState;
}

/** The commits of the log, by `GET /documents/{id}/commits`, every page. */
async function storedCommits(ctx: ScenarioContext, token: string, doc: string) {
  const out: Array<{ seq: number; id: string; kind: string }> = [];
  let after = 0;
  for (let page = 0; page < 50; page++) {
    const res = expectStatus(
      await ctx.service.as(token, 'GET', `/documents/${doc}/commits`, {
        query: { after, limit: 100 },
      }),
      200,
      'the commits of the log',
    );
    const items = (res.json as { items: Array<{ seq: number; id: string; kind: string }> }).items;
    if (!items.length) break;
    out.push(...items);
    after = items[items.length - 1]!.seq;
  }
  return out;
}

/** The text a document holds in one paragraph. */
const textIn = (content: { doc: unknown }) => JSON.stringify(content.doc);

/** A fresh reading member of the document: its content and a channel resumed at the head. */
const rejoin = (ctx: ScenarioContext, name: string, doc: string) => join(ctx, name, doc, 'editor');

/** The reply to a submit that must not be an acknowledgement; resolves its code. */
function notAcked(reply: Awaited<ReturnType<typeof submit>>, what: string): string {
  if (reply.t === 'sync.ack')
    throw new KitFailure(`${what}: the commit was acknowledged`, 'not an acknowledgement', reply);
  if (reply.t !== 'sync.reject')
    throw new KitFailure(`${what}: no rejection`, 'sync.reject', reply);
  return reply.d.code;
}

export const FAULT_INJECTION: ProfileDef = {
  id: 'fault-injection',
  title: 'Durability, fencing, log rewind and the grants revision, through the test hooks',
  spec: '05 §11; 04 §5; 06 §8',
  stories: ['PRO-126'],
  requires: { kind: 'features', features: [TEST_HOOKS_FEATURE] },
  scenarios: [
    s({
      id: 'durability',
      title:
        'no commit is acknowledged before it is stored: a failed write is refused, and an acknowledged commit survives a killed room',
      spec: '04 §5; 06 §8',
      covers: { messages: ['sync.submit', 'sync.ack', 'sync.reject', 'ch.closed'] },
      async run(ctx) {
        const doc = await ctx.document();
        const m = await join(ctx, 'writer', doc, 'editor');
        const at = posIn(m.content.doc, IDS.end);
        const start = await hookState(ctx, doc);
        equal(start.seq, m.content.seq, 'the hook and the content agree on the head');

        // A write that fails before its insert: refused, nothing stored.
        expectStatus(
          await hook(ctx, 'POST', `/documents/${doc}/fail-next-write`, { at: 'before-insert' }),
          204,
          'fail-next-write before-insert',
        );
        const id1 = uuid7();
        const r1 = await submit(m.wire, 1, {
          id: id1,
          base: start.seq,
          steps: [insertText(at, 'one')],
        });
        equal(notAcked(r1, 'a write that failed before its insert'), 'unavailable', 'the code');
        jsonEqual(await hookState(ctx, doc), start, 'nothing was stored by the failed write');

        // A write that fails after its insert and before COMMIT: refused, the insert is undone.
        expectStatus(
          await hook(ctx, 'POST', `/documents/${doc}/fail-next-write`, { at: 'after-insert' }),
          204,
          'fail-next-write after-insert',
        );
        const id2 = uuid7();
        const r2 = await submit(m.wire, 1, {
          id: id2,
          base: start.seq,
          steps: [insertText(at, 'two')],
        });
        equal(notAcked(r2, 'a write that failed after its insert'), 'unavailable', 'the code');
        jsonEqual(
          await hookState(ctx, doc),
          start,
          'the head and the chain head are as before: the insert was undone',
        );
        const viewer = await readContent(ctx, m.token, doc);
        check(
          !textIn(viewer).includes('one') && !textIn(viewer).includes('two'),
          'neither refused commit is in the content',
          'no text',
          textIn(viewer).length,
        );

        // The refused commit, sent again under its id, is stored once and acknowledged.
        const again = await acked(m.wire, 1, {
          id: id1,
          base: start.seq,
          steps: [insertText(at, 'one')],
        });
        equal(again.seq, start.seq + 1, 'the same commit is stored at the next seq');
        const stored = await hookState(ctx, doc);
        equal(stored.seq, start.seq + 1, 'the head moved by one commit');
        check(
          stored.chainHead !== start.chainHead,
          'the chain head moved',
          'a new chain head',
          stored.chainHead,
        );

        // An acknowledged commit survives a killed room: it is in the log when the room is back.
        const ack2 = await acked(m.wire, 1, {
          id: uuid7(),
          base: again.seq,
          steps: [insertText(at, 'three')],
        });
        const killed = expectStatus(
          await hook(ctx, 'POST', `/documents/${doc}/kill-room`),
          200,
          'kill-room',
        );
        check(isObject(killed.json), 'kill-room answers an object', 'an object', killed.text);
        const back = await rejoin(ctx, 'survivor', doc);
        check(
          back.content.seq >= ack2.seq,
          'every acknowledged commit is still in the log',
          `a head of at least ${ack2.seq}`,
          back.content.seq,
        );
        check(textIn(back.content).includes('three'), 'the acknowledged text is in the content');
        const ids = (await storedCommits(ctx, back.token, doc))
          .filter((c) => c.kind === 'steps')
          .map((c) => c.id);
        check(ids.includes(id1) && ids.includes(ack2.id), 'both commits are in the log by id');
        equal(ids.filter((i) => i === id1).length, 1, 'the retried commit is stored once');
      },
    }),
    s({
      id: 'fencing',
      title:
        'a killed room closes its channels with unavailable, and a commit sent again is stored once',
      spec: '04 §9; 05 §5.2; 06 §8',
      covers: {
        messages: ['sync.submit', 'sync.ack', 'ch.closed', 'ch.open', 'ch.opened'],
        fields: ['ch.open.resume', 'ch.opened.inflight'],
      },
      async run(ctx) {
        const doc = await ctx.document();
        const m = await join(ctx, 'inflight', doc, 'editor');
        const at = posIn(m.content.doc, IDS.end);
        const base = (await acked(m.wire, 1, { base: m.content.seq, steps: [insertText(at, 'a')] }))
          .seq;

        // Three commits in flight, and the room is fenced at the same time.
        const ids = [uuid7(), uuid7(), uuid7()];
        const from = m.wire.mark();
        for (const [i, id] of ids.entries())
          m.wire.send({
            t: 'sync.submit',
            id: m.wire.nextId('f'),
            ch: 1,
            d: { id, base, steps: [insertText(at + 1 + i, `${i}`)] },
          });
        const killed = await hook(ctx, 'POST', `/documents/${doc}/kill-room`);
        expectStatus(killed, 200, 'kill-room');
        const closed = await m.wire.next<Extract<ServerMessage, { t: 'ch.closed' }>>(
          (x) => x.t === 'ch.closed' && x.ch === 1,
          'ch.closed on the fenced room',
          { from },
        );
        equal(closed.d.code, 'unavailable', 'the channel of a fenced room closes `unavailable`');
        const answered = new Set(
          m.wire.messages
            .slice(from)
            .flatMap((x) => (x.t === 'sync.ack' && x.ch === 1 ? [x.d.id] : [])),
        );

        // The same user comes back, as a client does after the channel closes (04 §9). A document
        // is open once per connection, so each question for a commit has a connection of its own.
        const reconnect = async (label: string) => {
          const token = await ctx.service.token(m.sub, { [doc]: 'editor' });
          const wire = await ctx.connect({ label });
          await ctx.hello(wire, token);
          return { token, wire };
        };
        const back = await reconnect('back');
        const content = await readContent(ctx, back.token, doc);
        const view = content.view !== undefined ? { view: content.view } : {};
        await opened(ctx, back.wire, 1, doc, {
          resume: { seq: content.seq, incarnation: content.incarnation, ...view },
        });
        let head = content.seq;
        const resends: string[] = [];
        for (const [i, id] of ids.entries()) {
          const probe = await reconnect(`probe${i}`);
          // The client resumes at the last seq it confirmed, before the commits in flight.
          const o = await opened(ctx, probe.wire, 1, doc, {
            resume: { seq: base, incarnation: content.incarnation, inflight: id, ...view },
          });
          const state = (o.inflight as { state?: string } | undefined)?.state;
          oneOf(state, ['accepted', 'unknown'], `the state of an in-flight commit (04 §9)`);
          if (answered.has(id))
            equal(state, 'accepted', 'a commit that was acknowledged is stored (04 §9)');
          if (state === 'unknown') resends.push(id);
        } // Those that were not stored are sent again under their identifiers.
        for (const [i, id] of ids.entries()) {
          if (!resends.includes(id)) continue;
          const ack = await acked(back.wire, 1, {
            id,
            base: head,
            steps: [insertText(posIn(content.doc, IDS.end), `r${i}`)],
          });
          head = ack.seq;
        }
        // Whatever the room did with them, every commit is in the log once.
        const stored = (await storedCommits(ctx, back.token, doc)).filter(
          (c) => c.kind === 'steps',
        );
        for (const id of ids)
          equal(stored.filter((c) => c.id === id).length, 1, `commit ${id} is stored exactly once`);
        equal(
          new Set(stored.map((c) => c.id)).size,
          stored.length,
          'no commit identifier is in the log twice',
        );
        equal(
          new Set(stored.map((c) => c.seq)).size,
          stored.length,
          'no sequence number is used twice',
        );
        ctx.note(
          `${answered.size} of 3 commits in flight were acknowledged before the fence, ${resends.length} were sent again`,
        );
      },
    }),
    s({
      id: 'rewind',
      title:
        'after a log rewind, clients that reconnect receive catchUp reload for the new incarnation',
      spec: '04 §9; 06 §8',
      covers: {
        messages: ['ch.closed', 'ch.open', 'ch.opened'],
        fields: ['ch.open.resume'],
      },
      async run(ctx) {
        const doc = await ctx.document();
        const m: Member = await join(ctx, 'rewound', doc, 'editor');
        const at = posIn(m.content.doc, IDS.end);
        let base = m.content.seq;
        const seqs: number[] = [];
        for (const t of ['1', '2', '3']) {
          base = (await acked(m.wire, 1, { base, steps: [insertText(at, t)] })).seq;
          seqs.push(base);
        }
        const before = await readContent(ctx, m.token, doc);
        const to = seqs[0]!;
        const from = m.wire.mark();
        const res = await hook(ctx, 'POST', `/documents/${doc}/rewind`, { to });
        if (res.status === 404)
          ctx.skip('the server cannot rewind the log of its store (the hook answers not_found)');
        expectStatus(res, 200, 'rewind');
        const done = res.json as { head: number; incarnation: string };
        equal(done.head, to, 'the log is cut at the requested seq');
        check(
          done.incarnation !== before.incarnation,
          'the rewound log has a new incarnation',
          'another incarnation',
          done.incarnation,
        );
        const closed = await m.wire.next<Extract<ServerMessage, { t: 'ch.closed' }>>(
          (x) => x.t === 'ch.closed' && x.ch === 1,
          'ch.closed after the rewind',
          { from },
        );
        equal(closed.d.code, 'unavailable', 'the channels of the room close `unavailable`');

        // A client that reconnects with the state it had (the old incarnation and its seq).
        const s1 = await ctx.session('reconnect', { [doc]: 'editor' });
        const o = await opened(ctx, s1.wire, 1, doc, {
          resume: { seq: before.seq, incarnation: before.incarnation },
        });
        equal(o.catchUp, 'reload', 'catchUp for a client of the old incarnation');
        equal(o.incarnation, done.incarnation, 'the channel is on the new incarnation');
        equal(o.head, to, 'the head is the rewound head');
        // A resume at a seq that exists in both logs is still a reload: the incarnation differs.
        const s2 = await ctx.session('reconnect2', { [doc]: 'editor' });
        const o2 = await opened(ctx, s2.wire, 1, doc, {
          resume: { seq: to, incarnation: before.incarnation },
        });
        equal(o2.catchUp, 'reload', 'catchUp for a seq both logs have, at the old incarnation');
        // The content a client then reads is the new log's.
        const after = await readContent(ctx, s1.token, doc);
        equal(after.incarnation, done.incarnation, 'the content is of the new incarnation');
        equal(after.seq, to, 'the content is at the rewound head');
        const state = await hookState(ctx, doc);
        equal(state.incarnation, done.incarnation, 'the hook state names the new incarnation');
      },
    }),
    s({
      id: 'grants-revision',
      title:
        'a grants change whose announcement is lost never lets a commit be stored under the old grants',
      spec: '06 §8; 07 §9',
      covers: { messages: ['sync.submit', 'sync.ack', 'sync.reject'] },
      async run(ctx) {
        const sub = ctx.sub('grantee');
        const doc = await ctx.document(undefined, [
          { region: IDS.locked, principal: `user:${sub}`, role: 'editor' },
        ]);
        // The grant is a change after creation, so a control commit precedes this; let it land.
        await ctx.sleep(300);
        const token = await ctx.service.token(sub, { [doc]: 'editor' });
        const wire = await ctx.connect({ label: 'grantee' });
        await ctx.hello(wire, token);
        const content = await readContent(ctx, token, doc);
        const o = await opened(ctx, wire, 1, doc, {
          resume: {
            seq: content.seq,
            incarnation: content.incarnation,
            ...(content.view !== undefined ? { view: content.view } : {}),
          },
        });
        const pos = posIn(content.doc, IDS.lockedPara);
        const first = await acked(wire, 1, { base: o.head, steps: [insertText(pos, 'ok')] });

        // The announcement of the revocation is lost: the room does not hear that the grant is gone.
        expectStatus(
          await hook(ctx, 'POST', `/documents/${doc}/drop-announcement`),
          204,
          'drop-announcement',
        );
        await ctx.service.setGrants(doc, []);
        const id = uuid7();
        let outcome = '';
        let base = first.seq;
        for (let attempt = 0; attempt < 20; attempt++) {
          const reply = await submit(wire, 1, { id, base, steps: [insertText(pos, 'REVOKED')] });
          if (reply.t === 'sync.ack')
            throw new KitFailure(
              'a commit was acknowledged under the revoked grants',
              'a rejection',
              reply,
            );
          if (reply.t !== 'sync.reject')
            throw new KitFailure(
              'no rejection of a commit under revoked grants',
              'sync.reject',
              reply,
            );
          outcome = reply.d.code;
          // A refusal the client may retry is sent again; it ends in the refusal of the new rights.
          if (reply.d.action !== 'retry') break;
          const wait = Math.min(Math.max(reply.d.retryAfterMs ?? 100, 50), 1000);
          await ctx.sleep(wait);
          if (reply.d.head !== undefined) base = reply.d.head;
        }
        oneOf(outcome, ['permission_denied', 'forbidden'], 'the refusal that ends the retries');
        const after = await readContent(ctx, token, doc);
        check(
          !textIn(after).includes('REVOKED'),
          'nothing was stored under the old grants revision',
          'no REVOKED text',
          'found',
        );
        const stored = await storedCommits(ctx, token, doc);
        check(
          !stored.some((c) => c.id === id),
          'the commit is not in the log',
          'no such id',
          stored.length,
        );
      },
    }),
  ],
};
