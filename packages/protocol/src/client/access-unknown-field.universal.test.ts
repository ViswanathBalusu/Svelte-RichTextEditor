// An `access` object with a field the client does not know is read as if the field were absent
// (PRO-032; 05 §1 rule 3, PRO-005). The channel still opens, goes live and hands the known shape to
// the host. Universal: pure logic, no Node.js or browser APIs.
import { describe, expect, it } from 'vitest';
import type { Access, ChannelOpened, ServerMessage } from '../generated/types.ts';
import { ClientChannel, type ChannelEffect } from './channel.ts';

const DOC = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
const INC = '0192aa00-0000-7000-8000-000000000001';

const access = (rev: number): Access =>
  ({
    rev,
    asOfSeq: 0,
    docRole: 'editor',
    caps: ['view', 'edit'],
    scopes: { body: ['view', 'edit'] },
    leases: {},
    fill: null,
    restrictions: [],
  }) as unknown as Access;

function machine() {
  let n = 0;
  return new ClientChannel({ doc: DOC, ids: () => `e${++n}`, answerTimeoutMs: 1000 });
}

const states = (fx: ChannelEffect[]) => fx.flatMap((e) => (e.kind === 'state' ? [e.state] : []));
const accesses = (fx: ChannelEffect[]) =>
  fx.flatMap((e) => (e.kind === 'access' ? [e.access] : []));

function opened(re: string, d: Partial<ChannelOpened>, extraAccess: Record<string, unknown>) {
  const message: ServerMessage = {
    t: 'ch.opened',
    re,
    ch: 1,
    d: {
      head: 5,
      incarnation: INC,
      catchUp: 'reload',
      access: { ...access(1), ...extraAccess } as unknown as Access,
      ...d,
    } as ChannelOpened,
  } as ServerMessage;
  return message;
}

describe('an access object with an unknown field (PRO-032; PRO-005)', () => {
  it('opens and goes live without rejecting the unknown field', () => {
    const m = machine();
    const open = m.open(1, ['presence'], undefined, 0);
    const id = (open.find((e) => e.kind === 'send') as { message: { id?: string } }).message.id!;
    const fx = m.receive(
      opened(id, {}, { futureRule: { kind: 'region-hold', until: 9 }, scopes: { body: ['view'] } }),
      0,
    );
    expect(states(fx)).toEqual([{ status: 'live', seq: 5 }]);
    expect(accesses(fx)).toHaveLength(1);
    // The known members are read as before, and the unknown member is ignored: the host never sees
    // it (PRO-032 criterion 5; lane U-PRO-018-034, knownAccess in channel.ts).
    const a = accesses(fx)[0]! as unknown as Record<string, unknown>;
    expect(a['rev']).toBe(1);
    expect(a['caps']).toEqual(['view', 'edit']);
    expect('futureRule' in a).toBe(false);
  });

  it('applies a later access change that carries an unknown field', () => {
    const m = machine();
    const open = m.open(1, [], undefined, 0);
    const id = (open.find((e) => e.kind === 'send') as { message: { id?: string } }).message.id!;
    m.receive(opened(id, {}, {}), 0);
    const fx = m.receive(
      {
        t: 'perm.changed',
        ch: 1,
        d: { ...access(2), futureRule: { x: 1 } },
      } as unknown as ServerMessage,
      0,
    );
    const got = accesses(fx);
    expect(got).toHaveLength(1);
    expect(got[0]!.rev).toBe(2);
  });
});
