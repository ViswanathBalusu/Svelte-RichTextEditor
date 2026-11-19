/**
 * Contract cases for the optional ports (PRO-098 first version, S6). A case whose port the backend
 * lacks is skipped and the skip is reported (PRO-098 criterion 4). Presence has behavioural cases;
 * the other ports have a member check only, until their resources exist (phases 1b and 2).
 */
import type { PresencePeers } from '../generated/types.ts';
import type { Backend } from '../ports/core.ts';
import type { OptionalPortName } from '../ports/features.ts';
import { check, equal, includes, jsonEqual } from './assert.ts';
import { type ContractCase, waitUntil } from './core.ts';
import { USERS } from './fixtures.ts';
import type { CaseContext, ContractHarness, ContractOptions, HarnessFactory } from './harness.ts';
import { connect, createDoc, join, quiet, withHarness } from './support.ts';

type PortOf<K extends OptionalPortName> = NonNullable<Backend[K]>;

const MEMBERS = {
  presence: ['update', 'onPeers'],
  history: [
    'history',
    'versions',
    'createVersion',
    'diff',
    'attribution',
    'restore',
    'setReadMarker',
    'activity',
    'suggestionIntroduction',
  ],
  comments: [
    'threads',
    'createThread',
    'thread',
    'updateThread',
    'deleteThread',
    'reply',
    'updateComment',
    'deleteComment',
  ],
  assets: ['create', 'complete', 'resolve', 'upload'],
  exports: ['request', 'get', 'cancel'],
  imports: ['request', 'get'],
  fonts: ['manifest'],
  leases: ['acquire', 'heartbeat', 'release'],
  fields: ['fields', 'values', 'prefill', 'sign'],
  workflow: ['get', 'put', 'act', 'participant', 'evidence', 'final', 'onChange'],
  proofing: ['check', 'addWord'],
  assistant: ['request'],
} as const satisfies { readonly [K in OptionalPortName]: readonly (keyof PortOf<K>)[] };

/** Members of the port typings that the list above leaves out; `never` when it is complete. */
export type UnlistedOptionalMembers = {
  [K in OptionalPortName]: Exclude<keyof PortOf<K>, (typeof MEMBERS)[K][number]> extends never
    ? never
    : `${K}.${Exclude<keyof PortOf<K>, (typeof MEMBERS)[K][number]> & string}`;
}[OptionalPortName];

/**
 * Every member of each optional port (src/ports/optional.ts). The type-check fails when a name here
 * is not a member of its port, or when a port gains a member that is not listed here (PRO-092
 * criterion 5), so a new member cannot be left without a contract case.
 */
export const OPTIONAL_MEMBERS: Readonly<Record<OptionalPortName, readonly string[]>> =
  MEMBERS satisfies [UnlistedOptionalMembers] extends [never] ? unknown : never;

export function optionalCases(factory: HarnessFactory, opts: ContractOptions): ContractCase[] {
  const c = (
    id: string,
    title: string,
    port: string,
    members: readonly string[],
    body: (h: ContractHarness, ctx: CaseContext) => Promise<void>,
  ): ContractCase => ({
    id,
    title,
    port,
    members,
    run: (ctx) => withHarness(factory, (h) => body(h, ctx)),
  });

  const cases: ContractCase[] = [
    c(
      'presence.peers',
      'presence.state carries the server-derived identity; oversized states are dropped; leaving is reported',
      'presence',
      ['presence.update', 'presence.onPeers'],
      async (h, ctx) => {
        const docId = await createDoc(h);
        const a = await join(h, opts, docId, 'editor');
        if (!a.backend.presence)
          return ctx.skip('no presence port (feature `presence` not announced)');
        includes([...a.backend.features], 'presence', 'the feature is announced with the port');
        const v = await join(h, opts, docId, 'viewer');
        const peers: PresencePeers[] = [];
        v.backend.presence!.onPeers(docId, (p) => peers.push(p));
        const session = a.backend.auth.session!.session;
        a.backend.presence.update(docId, {
          seq: a.seq(),
          state: { selection: { anchor: 7, head: 9 }, scope: 'body', status: 'active' },
        });
        await waitUntil(
          opts,
          () => peers.some((p) => p.peers.some((x) => x.session === session)),
          'presence.state',
        );
        const peer = peers.flatMap((p) => p.peers).find((x) => x.session === session)!;
        equal(peer.user.id, USERS.editor.sub, 'identity comes from the session (05 §5.4)');
        jsonEqual(peer.state.selection, { anchor: 7, head: 9 }, 'the selection');
        equal(peer.seq, a.seq(), 'the seq the positions refer to');
        const limit = a.backend.auth.session!.limits.presenceBytes;
        a.backend.presence.update(docId, {
          seq: a.seq(),
          state: {
            selection: { anchor: 7, head: 7 },
            scope: 'x'.repeat(limit + 1),
            status: 'idle',
          },
        });
        await quiet(opts);
        check(
          !peers.flatMap((p) => p.peers).some((x) => x.state.scope.length > limit),
          'a state above presenceBytes is not relayed (05 §5.4)',
        );
        a.channel.close();
        await waitUntil(opts, () => peers.some((p) => p.left.includes(session)), 'left');
        await Promise.all([a.backend.close(), v.backend.close()]);
      },
    ),
  ];

  for (const [port, members] of Object.entries(OPTIONAL_MEMBERS) as Array<
    [OptionalPortName, readonly string[]]
  >) {
    if (port === 'presence') continue;
    cases.push(
      c(
        `${port}.members`,
        `the ${port} port has every member`,
        port,
        members.map((m) => `${port}.${m}`),
        async (h, ctx) => {
          const docId = await createDoc(h);
          const b = await connect(h, USERS.owner, { [docId]: 'owner' });
          const p = b[port] as unknown as Record<string, unknown> | undefined;
          if (!p) {
            await b.close();
            return ctx.skip(`no ${port} port`);
          }
          for (const m of members) equal(typeof p[m], 'function', `${port}.${m}`);
          await b.close();
        },
      ),
    );
  }
  return cases;
}
