/**
 * The `core` profile, part 3 (PRO-111 criterion 4): sync with engine `pm-steps/1` (05 §5.3; 04).
 * Acknowledgements plain, rebased and rebuilt for a duplicate, `busy`, each reject action the kit
 * can provoke from outside, `sync.reset`, and the order of acknowledgements and commits.
 */
import { canonicalNodeText, isTimestamp, uuid7, type JsonNode } from '@docedit/model';
import { chunkMessage, type ServerMessage } from '@docedit/protocol';
import { KitFailure, check, equal, excludes, includes, jsonEqual, oneOf } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { IDS, deleteRange, importedDocument, insertText, posIn, textOf } from '../documents.ts';
import { scenario, type ScenarioDef } from '../scenario.ts';
import {
  acked,
  join,
  knownSeq,
  readContent,
  rejected,
  submit,
  untilSeq,
  type Member,
} from './support.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('core', def);

async function pair(ctx: ScenarioContext) {
  const doc = await ctx.document();
  const a = await join(ctx, 'alice', doc, 'editor');
  const b = await join(ctx, 'bob', doc, 'editor');
  return { doc, a, b };
}

export const CORE_SYNC: ScenarioDef[] = [
  s({
    id: 'sync.ack',
    title: 'a commit is acknowledged, and other sessions receive it with server attribution',
    spec: '05 §5.3; 04 §3, §5 step 10; D10',
    covers: {
      messages: ['sync.submit', 'sync.ack', 'sync.commit'],
      fields: ['sync.submit.origin'],
    },
    async run(ctx) {
      const doc = await ctx.document();
      const a = await join(ctx, 'author', doc, 'editor');
      const v = await join(ctx, 'watcher', doc, 'viewer');
      const id = uuid7();
      const steps = [insertText(posIn(a.content.doc, IDS.intro), 'x')];
      const ack = await acked(a.wire, 1, { id, base: a.content.seq, steps, origin: 'input' });
      equal(ack.id, id, 'the commit identifier');
      equal(ack.seq, a.content.seq + 1, 'the next seq');
      equal(ack.rebased, false, 'not rebased');
      equal(ack.steps, undefined, 'no steps when not rebased');
      check(
        isTimestamp(ack.serverTime),
        'serverTime is an RFC 3339 timestamp',
        'a timestamp',
        ack.serverTime,
      );
      await untilSeq(v.wire, 1, ack.seq);
      const c = v.wire.messages
        .flatMap((m) => (m.t === 'sync.commit' ? m.d.commits : []))
        .find((x) => x.seq === ack.seq)!;
      equal(c.kind, 'steps', 'kind');
      equal(c.id, id, 'id');
      jsonEqual(c.steps, steps, 'steps as applied');
      equal(c.control, null, 'control on a step commit (D10)');
      equal(c.author.user, a.welcome.user.id, 'author.user is the identity of the session (04 G6)');
      equal(c.author.session, a.welcome.session, 'author.session');
      equal(c.author.agent, null, 'author.agent');
      equal(c.origin, 'input', 'origin');
      equal(c.serverTime, ack.serverTime, 'one server time for the commit');
      const own = a.wire.messages
        .flatMap((m) => (m.t === 'sync.commit' ? m.d.commits : []))
        .filter((x) => x.seq === ack.seq);
      check(
        own.length === 0,
        'the author gets the acknowledgement, not its own commit',
        'no sync.commit',
        own,
      );
    },
  }),
  s({
    id: 'sync.rebased',
    title: 'a commit on an older base is rebased and acknowledged with the mapped steps',
    spec: '05 §5.3; 04 §7',
    covers: { messages: ['sync.ack'], fields: ['sync.ack.steps'] },
    async run(ctx) {
      const { a, b } = await pair(ctx);
      const base = a.content.seq;
      const first = await acked(a.wire, 1, {
        base,
        steps: [insertText(posIn(a.content.doc, IDS.intro), 'A')],
      });
      const end = posIn(b.content.doc, IDS.end);
      const ack = await acked(b.wire, 1, { base, steps: [insertText(end, 'B')] });
      equal(ack.seq, first.seq + 1, 'ordered after the first commit');
      equal(ack.rebased, true, 'rebased');
      check(ack.steps?.length === 1, 'the mapped steps (04 §7)', 'one step', ack.steps);
      equal(ack.steps[0]!['from'], end + 1, 'mapped over the earlier insertion');
    },
  }),
  s({
    id: 'sync.duplicate',
    title: 'a resubmitted commit is acknowledged again with its seq and its steps',
    spec: '05 §5.3; 04 §5 step 2',
    covers: { messages: ['sync.ack'], fields: ['sync.ack.steps'] },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'retry', doc, 'editor');
      const marker = '§dup§';
      const commit = {
        id: uuid7(),
        base: m.content.seq,
        steps: [insertText(posIn(m.content.doc, IDS.intro), marker)],
      };
      const first = await acked(m.wire, 1, commit);
      const again = await acked(m.wire, 1, commit);
      equal(again.seq, first.seq, 'the stored seq (04 G4)');
      equal(again.id, commit.id, 'the same commit');
      check(
        Array.isArray(again.steps) && again.steps.length === 1,
        'a rebuilt acknowledgement carries steps (05 §5.3)',
        'steps',
        again,
      );
      const content = await readContent(ctx, m.token, m.doc);
      equal(textOf(content.doc, IDS.intro).split(marker).length - 1, 1, 'stored once (04 G4)');
    },
  }),
  s({
    id: 'sync.busy',
    title: 'a second submit while the first is pending is rejected with busy, action retry',
    spec: '05 §5.3; 04 §8',
    covers: { errors: ['busy'] },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'eager', doc, 'editor');
      const pos = posIn(m.content.doc, IDS.intro);
      let saw = false;
      for (let attempt = 0; attempt < 5 && !saw; attempt++) {
        const base = knownSeq(m);
        const ids = [`b1-${attempt}`, `b2-${attempt}`] as const;
        // Both frames leave in one go, so the second can arrive while the first is pending.
        m.wire.sendText(
          JSON.stringify({
            t: 'sync.submit',
            id: ids[0],
            ch: 1,
            d: { id: uuid7(), base, steps: [insertText(pos, 'q')] },
          }),
        );
        m.wire.sendText(
          JSON.stringify({
            t: 'sync.submit',
            id: ids[1],
            ch: 1,
            d: { id: uuid7(), base, steps: [insertText(pos, 'r')] },
          }),
        );
        const r1 = await m.wire.reply(ids[0]);
        const r2 = await m.wire.reply(ids[1]);
        check(r1.t === 'sync.ack', 'the first submit is acknowledged', 'sync.ack', r1);
        if (r2.t === 'sync.reject' && r2.d.code === 'busy') {
          equal(r2.d.action, 'retry', 'the action for busy (04 §8)');
          saw = true;
        } else
          check(
            r2.t === 'sync.ack' || r2.t === 'sync.reject',
            'the second submit is answered',
            'sync.ack or sync.reject',
            r2,
          );
      }
      if (!saw)
        ctx.skip(
          'the server answered the first submit before it read the second; provoking busy needs held writes (fault injection, 05 §11)',
        );
    },
  }),
  s({
    id: 'sync.reject.drop',
    title: 'a commit outside the writable set is rejected with permission_denied, action drop',
    spec: '05 §5.3, §5.8; 04 §8; 07 §5',
    covers: {
      messages: ['sync.reject'],
      errors: ['permission_denied'],
      fields: ['sync.reject.scopes'],
    },
    async run(ctx) {
      const doc = await ctx.document();
      const v = await join(ctx, 'viewer', doc, 'viewer');
      const id = uuid7();
      const r = await rejected(v.wire, 1, {
        id,
        base: v.content.seq,
        steps: [insertText(posIn(v.content.doc, IDS.intro), 'x')],
      });
      equal(r.code, 'permission_denied', 'code (07 §5.2 P6)');
      equal(r.action, 'drop', 'action (04 §8)');
      equal(r.id, id, 'id');
      equal(r.head, v.content.seq, 'head is the current durable head');
      check(typeof r.message === 'string' && r.message.length > 0, 'a message', 'text', r.message);
      if (r.scopes) includes(r.scopes, 'body', 'the scopes name the body');
      else ctx.note('the rejection names no scopes');
    },
  }),
  s({
    id: 'sync.reject.rebase',
    title: 'a step that cannot be mapped is rejected with rebase_failed, action rebase',
    spec: '05 §5.3; 04 §5 step 4, §8',
    covers: { messages: ['sync.reject'], errors: ['rebase_failed'] },
    async run(ctx) {
      const { a, b } = await pair(ctx);
      const base = a.content.seq;
      const p = posIn(a.content.doc, IDS.intro);
      const del = await acked(a.wire, 1, { base, steps: [deleteRange(p + 6, p + 11)] });
      const r = await rejected(b.wire, 1, { base, steps: [deleteRange(p + 7, p + 10)] });
      equal(r.code, 'rebase_failed', 'code');
      equal(r.action, 'rebase', 'action');
      equal(r.head, del.seq, 'head');
    },
  }),
  s({
    id: 'sync.reject.reload',
    title: 'a base ahead of the head is rejected with invalid_op, action reload',
    spec: '05 §5.3; 04 §5 step 3, §8',
    covers: { messages: ['sync.reject'], errors: ['invalid_op'] },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'ahead', doc, 'editor');
      const r = await rejected(m.wire, 1, {
        base: m.content.seq + 5,
        steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
      });
      equal(r.code, 'invalid_op', 'code');
      equal(r.action, 'reload', 'action');
    },
  }),
  s({
    id: 'sync.reject.invalid',
    title: 'an unknown step type and a commit without steps are rejected with invalid_op',
    spec: '04 §3.1, §4; G38',
    covers: { messages: ['sync.reject'], errors: ['invalid_op'] },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'odd', doc, 'editor');
      const r = await rejected(m.wire, 1, {
        base: m.content.seq,
        steps: [{ stepType: 'x-tck-step', from: 1 }],
      });
      equal(r.code, 'invalid_op', 'an unknown step type (04 §4)');
      oneOf(r.action, ['drop', 'reload'], 'the action of invalid_op (04 §8)');
      const empty = await submit(m.wire, 1, { base: m.content.seq, steps: [] });
      check(
        (empty.t === 'sync.reject' && empty.d.code === 'invalid_op') ||
          (empty.t === 'error' && empty.d.code === 'bad_message'),
        'a commit without steps is refused (04 §3.1: one or more steps; G38)',
        'sync.reject invalid_op, or error bad_message for the schema',
        empty,
      );
    },
  }),
  s({
    id: 'sync.read-only',
    title:
      'a locked document raises document.updated, limits access and rejects commits with read_only',
    spec: '04 §5 step 1; 05 §5.5, §5.6; G40',
    covers: {
      messages: ['event', 'perm.changed'],
      events: ['document.updated'],
      errors: ['read_only'],
      operations: ['PATCH /documents/{id}'],
    },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'locked', doc, 'editor');
      const from = m.wire.mark();
      await ctx.service.setState(doc, 'locked');
      ctx.defer(() => ctx.service.setState(doc, 'active'));
      const ev = await m.wire.next(
        (x) => x.t === 'event' && x.d.type === 'document.updated',
        'event document.updated',
        { from },
      );
      if (ev.t === 'event')
        equal(ev.d.resource, `/documents/${doc}`, 'the resource of document.updated');
      const perm = await m.wire.nextOf('perm.changed', { from });
      excludes(perm.d.scopes['body'], 'edit', 'no edit in a locked document (07 §4)');
      check(
        perm.d.rev > m.opened.access.rev,
        'rev increases',
        `> ${m.opened.access.rev}`,
        perm.d.rev,
      );
      // 07 §4 limit 1 (PRM-005): the commit is refused in both states and nothing is stored.
      const refusedIn = async (state: 'locked' | 'archived'): Promise<void> => {
        const before = await readContent(ctx, m.token, doc);
        const r = await rejected(m.wire, 1, {
          base: knownSeq(m),
          steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
        });
        equal(r.code, 'read_only', `code in a ${state} document (04 §5 step 1; G40)`);
        equal(r.action, 'drop', `action in a ${state} document`);
        const after = await readContent(ctx, m.token, doc);
        equal(after.seq, before.seq, `nothing is stored in a ${state} document: the seq`);
        equal(
          canonicalNodeText(after.doc as unknown as JsonNode),
          canonicalNodeText(before.doc as unknown as JsonNode),
          `nothing is stored in a ${state} document: the content`,
        );
      };
      await refusedIn('locked');
      const archivedFrom = m.wire.mark();
      await ctx.service.setState(doc, 'archived');
      const archived = await m.wire.nextOf('perm.changed', { from: archivedFrom });
      excludes(archived.d.scopes['body'], 'edit', 'no edit in an archived document (07 §4)');
      excludes(archived.d.scopes['body'], 'comment', 'no comment in an archived document (07 §4)');
      await refusedIn('archived');
    },
  }),
  s({
    id: 'sync.reset',
    title:
      'a snapshot commit sends sync.reset; commits continue after it and older bases get stale_base',
    spec: '05 §5.3, §6.2; 04 §3.2',
    covers: {
      messages: ['sync.reset'],
      errors: ['stale_base'],
      operations: ['PUT /documents/{id}/content'],
    },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'importer', doc, 'editor');
      const before = await acked(m.wire, 1, {
        base: m.content.seq,
        steps: [insertText(posIn(m.content.doc, IDS.intro), 'x')],
      });
      const from = m.wire.mark();
      await ctx.service.replaceContent(doc, importedDocument());
      const reset = await m.wire.nextOf('sync.reset', { from, ch: 1 });
      equal(reset.d.reason, 'import', 'reason');
      check(
        reset.d.seq > before.seq,
        'the snapshot has the next seq',
        `> ${before.seq}`,
        reset.d.seq,
      );
      const content = await readContent(ctx, m.token, doc, reset.d.seq);
      equal(textOf(content.doc, IDS.intro), 'Imported text', 'the content at the reset seq');
      const ack = await acked(m.wire, 1, {
        base: reset.d.seq,
        steps: [insertText(posIn(content.doc, IDS.intro), 'y')],
      });
      equal(ack.seq, reset.d.seq + 1, 'commits continue after the snapshot');
      const r = await rejected(m.wire, 1, {
        base: before.seq,
        steps: [insertText(posIn(content.doc, IDS.intro), 'z')],
      });
      equal(r.code, 'stale_base', 'a base older than the snapshot (04 §3.2)');
      equal(r.action, 'rebase', 'action (04 §3.2 as revised)');
    },
  }),
  s({
    id: 'sync.order',
    title: 'concurrent writers: gap-free order, acknowledgements after lower commits, one content',
    spec: '05 §5.3; 04 G1, G3, G5',
    covers: { messages: ['sync.ack', 'sync.commit'] },
    async run(ctx) {
      const doc = await ctx.document();
      const members: Member[] = [];
      for (const n of ['one', 'two', 'three']) members.push(await join(ctx, n, doc, 'editor'));
      const start = members[0]!.content.seq;
      const at = posIn(members[0]!.content.doc, IDS.end);
      const rounds = 5;
      await Promise.all(
        members.map(async (m, k) => {
          for (let i = 0; i < rounds; i++) {
            const base = knownSeq(m);
            const r = await submit(m.wire, 1, { base, steps: [insertText(at, `${k}${i}`)] });
            if (r.t !== 'sync.ack')
              throw new KitFailure(
                'a concurrent commit is acknowledged (it only inserts)',
                'sync.ack',
                r,
              );
          }
        }),
      );
      const head = start + rounds * members.length;
      for (const m of members)
        await m.wire
          .next(() => knownSeq(m) >= head, `seq ${head} on ${m.wire.label}`)
          .catch(() => undefined);
      const ids = new Map<number, string>();
      for (const m of members) {
        check(knownSeq(m) >= head, `${m.wire.label} saw every commit`, head, knownSeq(m));
        const seen: number[] = [];
        for (const msg of m.wire.messages as ServerMessage[]) {
          if (msg.t === 'sync.commit')
            for (const c of msg.d.commits) {
              seen.push(c.seq);
              const known = ids.get(c.seq);
              if (known === undefined) ids.set(c.seq, c.id);
              else equal(c.id, known, `one commit at seq ${c.seq} (04 G1)`);
            }
          if (msg.t === 'sync.ack') {
            const lower = Array.from({ length: msg.d.seq - start - 1 }, (_, i) => start + 1 + i);
            const missing = lower.filter((x) => !seen.includes(x));
            check(
              missing.length === 0,
              `the acknowledgement of ${msg.d.seq} comes after every lower commit on the channel (05 §5.3)`,
              'all lower seqs delivered first',
              `missing ${missing.join(', ')} on ${m.wire.label}`,
            );
            seen.push(msg.d.seq);
          }
        }
        const sorted = [...seen].sort((x, y) => x - y);
        jsonEqual(
          sorted,
          Array.from({ length: head - start }, (_, i) => start + 1 + i),
          'every seq once, without gaps (04 G5)',
        );
      }
      const texts = await Promise.all(
        members.map(async (m) =>
          canonicalNodeText((await readContent(ctx, m.token, doc)).doc as unknown as JsonNode),
        ),
      );
      for (const t of texts) equal(t, texts[0], 'the same content for everyone (04 G3)');
    },
  }),
  s({
    id: 'sync.too-large',
    title: 'a commit above maxCommitBytes is refused with too_large',
    spec: '04 §3.1; 05 §5.8',
    timeoutMs: 90_000,
    covers: { errors: ['too_large'], messages: ['chunk'] },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'huge', doc, 'editor');
      const limit = m.welcome.limits.maxCommitBytes;
      if (limit > 8 * 1024 * 1024) ctx.skip(`maxCommitBytes is ${limit}`);
      const text = JSON.stringify({
        t: 'sync.submit',
        id: 'big',
        ch: 1,
        d: {
          id: uuid7(),
          base: m.content.seq,
          steps: [insertText(posIn(m.content.doc, IDS.intro), 'h'.repeat(limit + 1024))],
        },
      });
      for (const f of chunkMessage(text, m.welcome.limits.maxMessageBytes, uuid7()))
        m.wire.sendText(f);
      const reply = await m.wire.reply('big', { timeoutMs: 30_000 }).catch((e: unknown) => {
        if (m.wire.closed) return null;
        throw e;
      });
      if (reply === null) {
        ctx.closeCode(m.wire.closed!.code);
        equal(
          m.wire.closed!.code,
          4413,
          'a message the server will not reassemble closes with 4413',
        );
        ctx.note('the server closed the connection instead of rejecting the commit');
        return;
      }
      check(
        (reply.t === 'sync.reject' && reply.d.code === 'too_large') ||
          (reply.t === 'error' && reply.d.code === 'too_large'),
        'a commit above maxCommitBytes (04 §3.1)',
        'sync.reject too_large',
        reply,
      );
      if (reply.t === 'sync.reject') equal(reply.d.action, 'drop', 'the action of too_large');
    },
  }),
  s({
    id: 'sync.too-many-steps',
    title: 'a commit with more than maxStepsPerCommit steps is refused',
    spec: '04 §3.1',
    covers: { messages: ['sync.reject'] },
    async run(ctx) {
      const doc = await ctx.document();
      const m = await join(ctx, 'steps', doc, 'editor');
      const n = m.welcome.limits.maxStepsPerCommit + 1;
      if (n > 5000) ctx.skip(`maxStepsPerCommit is ${n - 1}`);
      const pos = posIn(m.content.doc, IDS.intro);
      const r = await submit(m.wire, 1, {
        base: m.content.seq,
        steps: Array.from({ length: n }, () => insertText(pos, 's')),
      });
      check(
        r.t === 'sync.reject' && ['invalid_op', 'too_large'].includes(r.d.code),
        `${n} steps (04 §3.1)`,
        'sync.reject invalid_op or too_large',
        r,
      );
    },
  }),
];
