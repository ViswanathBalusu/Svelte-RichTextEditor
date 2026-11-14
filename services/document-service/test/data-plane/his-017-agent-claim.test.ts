// HIS-017 criterion 3: a commit with origin `assistant` from a connection that has no delegated
// agent identity is recorded with no agent. The agent comes from the authenticated connection, not
// from the claim the client sends (sync.test.ts already checks the broadcast author; this checks the
// stored record as well).
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

describe('assistant origin without a delegated agent identity (HIS-017 criterion 3)', () => {
  it('records no agent for an assistant-origin commit, even when the client claims one', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    a.send({
      t: 'sync.submit',
      id: 'claimed-agent',
      ch: 1,
      d: {
        id: uuid7(),
        base: 0,
        steps: [insertText(intro(), 'assisted')],
        origin: 'assistant',
        user: 'alice',
        session: 'forged',
        agent: 'robot',
        time: 0,
        author: { user: 'alice' },
      },
    });
    await a.take((m) => m.re === 'claimed-agent');
    const stored = (await p.stores.logs.read(p.ref(doc)))[0]!;
    expect(stored.origin).toBe('assistant');
    expect(stored.user).toBe('alice');
    expect(stored.agent).toBeUndefined();
  });
});
