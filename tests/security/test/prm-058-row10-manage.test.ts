// PRM-058 criterion 5 (07 §12 row 10, lane w9): a user without `manage` is refused each operation of
// the row. Over the wire, on memory and PostgreSQL (when the integration environment is up): restore
// a document, change a region's state, break a lease, change grants and delete the document. Each
// refusal leaves the document as it was. `workflow.action` has no route in the service (the engine
// is FRW's), so the matrix itself is asked for it: `authorise` refuses an editor and admits an owner,
// and the row lists the operation, so a route added later falls under the same rule.
import { MATRIX, authorise, computeAccess } from '@docedit/authority';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const OPEN = 'rOpen00000000001';

describe('PRM-058 row 10: the matrix row lists the operations and refuses a user without manage', () => {
  const row = MATRIX.find((r) => r.row === 10)!;
  const conn = (role: 'editor' | 'owner') => ({
    sub: 'u',
    session: 's',
    role,
    groups: [],
    participantRoles: [],
    participantActive: false,
  });
  const access = (role: 'editor' | 'owner') =>
    computeAccess(
      conn(role),
      [{ id: OPEN, policy: 'inherit' }],
      {
        revision: 1,
        grants: [],
        regionStates: new Map(),
        leases: [],
        documentState: 'active',
        workflowActive: true,
      },
      0,
    );

  it('names every operation of 07 §12 row 10, including the workflow action', () => {
    expect(row.requirement).toMatchObject({ kind: 'manage' });
    const ops = (row.requirement as unknown as { operations: string[] }).operations;
    for (const op of [
      'document.restore',
      'grants.change',
      'region_state.change',
      'region.policy',
      'lease.break',
      'workflow.action',
      'document.delete',
    ])
      expect(ops, op).toContain(op);
  });

  it('refuses an editor and admits an owner, also while a workflow is active', () => {
    const refused = authorise(row.id, { credential: 'user', access: access('editor') });
    expect(refused.ok).toBe(false);
    expect(authorise(row.id, { credential: 'user', access: access('owner') }).ok).toBe(true);
  });
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`PRM-058 row 10 over the wire (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip !== null)(
      'refuses restore, state change, lease break, grant change and delete to an editor, and changes nothing',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const owner = await h.mintToken(h.a, 'owner-row10', { [doc]: 'owner' });
        const editor = await h.mintToken(h.a, 'editor-row10', { [doc]: 'editor' });
        const other = await h.mintToken(h.a, 'editor2-row10', { [doc]: 'editor' });
        const path = `/v1/documents/${doc}`;
        const grants = async (token: string) =>
          h.call('GET', `${path}/grants`, { token }).then((r) => {
            expect(r.status, r.text).toBe(200);
            return r.headers.get('etag')!;
          });

        // Another editor holds a lease on the open region: the first editor is not its holder.
        const taken = await h.call('POST', `${path}/regions/${OPEN}/lease`, { token: other });
        expect(taken.status, taken.text).toBe(201);
        const etagBefore = await grants(owner);

        const refusals = {
          restore: await h.call('POST', `${path}/restore`, {
            token: editor,
            headers: { 'Idempotency-Key': randomUUID() },
            body: { toSeq: 0 },
          }),
          state: await h.call('PUT', `${path}/regions/${OPEN}/state`, {
            token: editor,
            body: { state: 'approved' },
            headers: { 'If-Match': etagBefore },
          }),
          break: await h.call('DELETE', `${path}/regions/${OPEN}/lease`, { token: editor }),
          grants: await h.call('PATCH', `${path}/grants`, {
            token: editor,
            headers: { 'If-Match': etagBefore },
            body: { grants: [{ region: OPEN, principal: 'user:someone', role: 'editor' }] },
          }),
          delete: await h.call('DELETE', path, { token: editor }),
        };
        for (const [name, r] of Object.entries(refusals)) {
          expect(r.status, `${name}: ${r.text}`).toBe(403);
          expect(r.json.code, name).toBe('forbidden');
        }

        // Nothing changed: the grants revision, the lease holder and the document are as they were.
        expect(await grants(owner)).toBe(etagBefore);
        const read = await h.call('GET', path, { token: owner });
        expect(read.status).toBe(200);
        const held = await h.call('POST', `${path}/regions/${OPEN}/lease`, { token: other });
        expect(held.status, held.text).toBe(201);
        expect(held.json.id).toBe(taken.json.id);

        // With `manage` the same lease break is served.
        const broken = await h.call('DELETE', `${path}/regions/${OPEN}/lease`, { token: owner });
        expect(broken.status, broken.text).toBeLessThan(300);
      },
    );
  });
}
