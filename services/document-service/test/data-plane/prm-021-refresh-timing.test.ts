// PRM-021 criterion 5: a group change and a document-role change in the next token take effect at
// the same refresh, with one perm.changed, and not before (07 §9; PRO-014 auth.refresh).
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const LEGAL = 'region:rLegal000000000B';

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function refresh(c: DepClient, token: string): Promise<void> {
  const id = c.nextId();
  c.send({ t: 'auth.refresh', id, d: { token } });
  await c.take((m) => m.re === id, 3000, 'answer to auth.refresh');
}

describe('the old role lasts until the token ends (PRM-021 criterion 3)', () => {
  it('serves the role the token carries until the token expires, then ends the session with token_expired', async () => {
    const p = await startPlane();
    planes.push(p);
    const doc = await p.createDocument();
    // A short token stands in for the 15-minute one: the session ends when it expires, so an
    // open channel cannot keep a role the host has since changed past the token's lifetime.
    const bob = await p.client('bob', { [doc]: 'editor' }, { expiresIn: 1500 });
    await bob.open(1, doc);
    expect((await bob.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).t).toBe(
      'sync.ack',
    );
    const ended = await bob.take((m) => m.t === 'error' && m.d!['code'] === 'token_expired', 5000);
    expect(ended.d).toMatchObject({ code: 'token_expired' });
    expect(bob.all('ch.closed')).toHaveLength(0);
  });
});

describe('document roles and groups change at the same refresh (PRM-021 criterion 5)', () => {
  it('applies a lower document role and a removed group together, with one perm.changed', async () => {
    const p = await startPlane();
    planes.push(p);
    const doc = await p.createDocument();
    // Bob is an editor, and the legal group gives him edit on the legal region.
    const bob = await p.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
    const opened = await bob.open(1, doc);
    // Before the refresh the group gives edit on the legal region, and the editor role edits the body.
    expect(opened.d!['access'].scopes[LEGAL]).toContain('edit');
    expect((await bob.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).t).toBe(
      'sync.ack',
    );
    // The host's next token drops both the editor role and the group in one go.
    await refresh(bob, p.tokens.issue({ user: 'bob', docs: { [doc]: 'viewer' }, groups: [] }));
    const changed = await bob.take((m) => m.t === 'perm.changed' && m.ch === 1);
    expect(changed.d).toMatchObject({ docRole: 'viewer' });
    expect(changed.d!['scopes'][LEGAL]).not.toContain('edit');
    expect(bob.all('perm.changed', 1)).toHaveLength(1);
    // Both are gone at once: a commit in the body is refused under the new role.
    expect((await bob.submit(1, { base: 1, steps: [insertText(intro(), 'c')] })).d).toMatchObject({
      code: 'permission_denied',
    });
  });
});
