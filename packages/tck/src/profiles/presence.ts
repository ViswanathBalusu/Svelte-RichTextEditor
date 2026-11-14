/**
 * The `presence` profile (PRO-112; 05 §5.4): identity comes from the server, states that are
 * invalid or too large are not relayed, and a session that leaves is reported in `left`.
 */
import type { PresencePeer, PresenceStateMessage, ServerMessage } from '@docedit/protocol';
import { check, equal, jsonEqual } from '../assert.ts';
import type { ScenarioContext } from '../context.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { join, type Member } from './support.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('presence', def);

const peersOf = (m: Member, from = 0): PresencePeer[] =>
  m.wire.messages
    .slice(from)
    .flatMap((x: ServerMessage) => (x.t === 'presence.state' && x.ch === m.ch ? x.d.peers : []));

async function two(ctx: ScenarioContext) {
  const doc = await ctx.document();
  const a = await join(ctx, 'author', doc, 'editor');
  const v = await join(ctx, 'watcher', doc, 'viewer');
  return { doc, a, v };
}

function update(m: Member, state: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  m.wire.send({ t: 'presence.update', ch: m.ch, d: { seq: m.content.seq, state, ...extra } });
}

const valid = { selection: { anchor: 7, head: 9 }, scope: 'body', status: 'active' };

export const PRESENCE: ProfileDef = {
  id: 'presence',
  title: 'Selections shared between sessions',
  spec: '05 §5.4',
  stories: ['PRO-112'],
  requires: { kind: 'features', features: ['presence'] },
  scenarios: [
    s({
      id: 'peers',
      title:
        'presence.update reaches the other session as presence.state with the server-derived identity',
      spec: '05 §5.4',
      covers: { messages: ['presence.update', 'presence.state'] },
      async run(ctx) {
        const { a, v } = await two(ctx);
        const from = v.wire.mark();
        update(a, valid);
        const m = await v.wire.next(
          (x) => x.t === 'presence.state' && x.d.peers.some((p) => p.session === a.welcome.session),
          "the author's presence",
          { from },
        );
        const peer = (m as PresenceStateMessage).d.peers.find(
          (p) => p.session === a.welcome.session,
        )!;
        equal(peer.user.id, a.welcome.user.id, 'the identity is the session user (05 §5.4)');
        jsonEqual(peer.state.selection, valid.selection, 'the selection');
        equal(peer.state.status, 'active', 'the status');
        equal(peer.seq, a.content.seq, 'the seq the positions refer to');
      },
    }),
    s({
      id: 'identity',
      title: 'a client cannot claim another identity in its presence',
      spec: '05 §5.4',
      covers: { messages: ['presence.update', 'presence.state'] },
      async run(ctx) {
        const { a, v } = await two(ctx);
        const from = v.wire.mark();
        update(
          a,
          { ...valid, user: { id: 'someone-else', name: 'Mallory' } },
          { user: { id: 'someone-else' }, session: v.welcome.session },
        );
        const m = await v.wire.next(
          (x) => x.t === 'presence.state' && x.d.peers.some((p) => p.session === a.welcome.session),
          "the author's presence",
          { from },
        );
        for (const p of (m as PresenceStateMessage).d.peers) {
          check(
            p.user.id !== 'someone-else',
            'the server adds identity; claims are ignored (05 §5.4)',
            a.welcome.user.id,
            p.user,
          );
          if (p.session === a.welcome.session)
            equal(p.user.id, a.welcome.user.id, 'the identity of the author');
        }
      },
    }),
    s({
      id: 'not-relayed',
      title: 'a state that is invalid or larger than presenceBytes is not relayed',
      spec: '05 §5.4; 04 §11',
      covers: { messages: ['presence.update'] },
      async run(ctx) {
        const { a, v } = await two(ctx);
        const limit = a.welcome.limits.presenceBytes;
        const from = v.wire.mark();
        update(a, {
          selection: { anchor: 1, head: 1 },
          scope: 'x'.repeat(limit + 1),
          status: 'idle',
        });
        update(a, { selection: { anchor: 'one', head: 2 }, scope: 'body', status: 'flying' });
        await ctx.sleep(
          Math.max(400, Math.ceil(1000 / Math.max(1, a.welcome.limits.presenceHz)) * 3),
        );
        const bad = peersOf(v, from).filter((p) => p.session === a.welcome.session);
        check(bad.length === 0, 'neither state is relayed (05 §5.4)', 'nothing', bad);
        // The session still works: a valid state afterwards is relayed.
        update(a, valid);
        await v.wire.next(
          (x) => x.t === 'presence.state' && x.d.peers.some((p) => p.session === a.welcome.session),
          'a valid presence after the refused ones',
          { from },
        );
      },
    }),
    s({
      id: 'left',
      title: 'a session that closes its channel or disconnects is reported in left',
      spec: '05 §5.4',
      covers: { messages: ['presence.state', 'ch.close'] },
      async run(ctx) {
        const { doc, a, v } = await two(ctx);
        update(a, valid);
        await v.wire.next(
          (x) => x.t === 'presence.state' && x.d.peers.some((p) => p.session === a.welcome.session),
          'the author present',
        );
        const from = v.wire.mark();
        a.wire.send({ t: 'ch.close', ch: a.ch });
        await v.wire.next(
          (x) => x.t === 'presence.state' && x.d.left.includes(a.welcome.session),
          'the author in left',
          { from },
        );
        const b = await join(ctx, 'leaver', doc, 'editor');
        update(b, valid);
        await v.wire.next(
          (x) => x.t === 'presence.state' && x.d.peers.some((p) => p.session === b.welcome.session),
          'the second author present',
        );
        const from2 = v.wire.mark();
        b.wire.terminate();
        await v.wire.next(
          (x) => x.t === 'presence.state' && x.d.left.includes(b.welcome.session),
          'a disconnected session in left',
          { from: from2 },
        );
      },
    }),
  ],
};
