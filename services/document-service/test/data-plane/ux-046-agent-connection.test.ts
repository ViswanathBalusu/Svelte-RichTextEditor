// UX-046 criterion 6 over a real socket and the real room: a connection whose verified token names an
// agent has its commits stored with origin `assistant` and the agent, whatever the client claims; it
// holds at most `suggest`, so a direct insertion is refused, and a suggestion is accepted (ADR 0234 A).
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

const submit = (id: string, steps: unknown[], origin: string) => ({
  t: 'sync.submit',
  id,
  ch: 1,
  d: { id: uuid7(), base: 0, steps, origin, user: 'alice', session: 'forged', time: 0 },
});

describe('an agent connection is the assistant (UX-046 criterion 6)', () => {
  it('stores a suggestion with origin assistant and the agent, and refuses a direct insertion', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'editor' }, { agent: 'agt_model-x' });
    await a.open(1, doc);
    // An editor's agent holds at most `suggest`: a plain insertion is refused and nothing is stored.
    a.send(submit('direct', [insertText(intro(), 'direct')], 'input'));
    const refused = await a.take((m) => m.re === 'direct');
    expect(refused['t']).toBe('sync.reject');
    expect((refused['d'] as { code: string }).code).toBe('permission_denied');
    expect(await p.stores.logs.read(p.ref(doc))).toHaveLength(0);

    // The same text as an `ins` suggestion naming the person is accepted; the client claims `input`.
    const suggestion = {
      stepType: 'replace',
      from: intro(),
      to: intro(),
      slice: {
        content: [
          {
            type: 'text',
            text: 'suggested',
            marks: [{ type: 'ins', attrs: { id: 'sgAgent000000001', user: 'alice' } }],
          },
        ],
      },
    };
    a.send(submit('suggested', [suggestion], 'input'));
    const ack = await a.take((m) => m.re === 'suggested');
    expect(ack['t']).toBe('sync.ack');
    const stored = (await p.stores.logs.read(p.ref(doc)))[0]!;
    expect(stored.origin).toBe('assistant');
    expect(stored.agent).toBe('agt_model-x');
    expect(stored.user).toBe('alice');
  });
});
