/**
 * PRO-034 criterion 3, the permission half (lane V-PRO-018-034, round 2; 05 §5.5; 12 §10): a
 * workflow transition that changes what is allowed sends `perm.changed` to every open connection,
 * with a higher `rev` than the one the connection had when its channel opened. This test shows
 * the permission part alone through the real data plane over the in-memory stores
 * (test/data-plane/support.ts), which is what the transition path `workflowActive` drives. The
 * whole criterion, with `wf.changed`, is in test/control-plane/pro-034-workflow-perm-changed.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startPlane, type Plane } from '../../test/data-plane/support.ts';

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}

describe('a workflow transition sends perm.changed with a higher rev (PRO-034 criterion 3)', () => {
  it('starting a workflow sends every connection a perm.changed whose rev is above its opening rev', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' });
    const frank = await p.client('frank', { [doc]: 'viewer' });
    const opened = new Map<string, number>();
    for (const [name, c] of [
      ['alice', alice],
      ['bob', bob],
      ['frank', frank],
    ] as const) {
      const ch = await c.open(1, doc);
      opened.set(name, ch.d!['access'] && (ch.d!['access'] as { rev: number }).rev);
    }

    const perms = await p.changeGrants(doc, { workflowActive: true });
    expect(perms.workflowActive).toBe(true);

    for (const [name, c] of [
      ['alice', alice],
      ['bob', bob],
      ['frank', frank],
    ] as const) {
      const pc = await c.take((m) => m.t === 'perm.changed');
      const rev = pc.d!['rev'] as number;
      expect(rev, name).toBeGreaterThan(opened.get(name)!);
      expect(c.all('perm.changed'), name).toHaveLength(1);
    }
  });
});
