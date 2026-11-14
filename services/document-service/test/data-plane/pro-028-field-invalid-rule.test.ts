/**
 * PRO-028 criterion 4 on the wire (lane V-PRO-018-034, fixed in V-HIS-001-016): a `sync.reject`
 * with `field_invalid` names the rule or constraint that failed in `rule` (05 §5.3; 12 §5.3). Real
 * WebSocket clients against the data plane, so the test reads what the server sends, not the
 * room's effect. The memory stores run always; the PostgreSQL run skips with the reason when the
 * test environment is not up (pwsh -NoProfile -File infra/test-env.ps1 up). The PostgreSQL run
 * uses its own database, dropped afterwards.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posOf } from '../../../../packages/authority/test/fixtures.ts';
import { startPlane, type Plane, type Stores } from './support.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

/** The fixture's text field, assigned to `role_tenant` (Erin's participant role). */
const FIELD = 'fTenantName00001';
/** A number where a text field takes a string: the field-value constraint of I15 fails. */
const wrongValue = () => ({
  stepType: 'attr',
  pos: posOf(baseDoc(), FIELD),
  attr: 'value',
  value: 12,
});

async function rejectionsOnTheWire(p: Plane): Promise<void> {
  const doc = await p.createDocument();

  // Erin may only fill: the wrongly typed value is field_invalid, and the wire names the rule.
  const erin = await p.client('erin', { [doc]: 'filler' });
  expect((await erin.open(1, doc)).t).toBe('ch.opened');
  const r = await erin.submit(1, { base: 0, steps: [wrongValue()], origin: 'fill' });
  expect(r.t).toBe('sync.reject');
  expect(r.d).toMatchObject({ code: 'field_invalid', action: 'drop', rule: 'I15' });

  // Alice may edit: the same value is invalid_op, and the wire carries no rule.
  const alice = await p.client('alice', { [doc]: 'owner' });
  expect((await alice.open(1, doc)).t).toBe('ch.opened');
  const a = await alice.submit(1, { base: 0, steps: [wrongValue()] });
  expect(a.t).toBe('sync.reject');
  expect(a.d).toMatchObject({ code: 'invalid_op' });
  expect(a.d).not.toHaveProperty('rule');
}

describe('sync.reject names the failed rule with field_invalid on the wire (PRO-028 criterion 4, memory)', () => {
  const planes: Plane[] = [];
  afterEach(async () => {
    for (const p of planes.splice(0)) await p.close().catch(() => {});
  });

  it('sends rule I15 to a fill-only user and no rule with invalid_op to an editor', async () => {
    const p = await startPlane({ node: 'node-v-his-001-016-pro-028' });
    planes.push(p);
    await rejectionsOnTheWire(p);
  });
});

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'sync.reject names the failed rule with field_invalid on the wire (PRO-028 criterion 4, PostgreSQL)',
  () => {
    let db: TestDatabase;
    const planes: Plane[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      for (const p of planes) await p.close().catch(() => {});
      await db?.drop();
    });

    it('sends rule I15 to a fill-only user and no rule with invalid_op to an editor', async () => {
      const pg = pgStores(db.service);
      const stores: Stores = {
        logs: pg.logs,
        ownership: pg.logs,
        grants: pg.grants,
        documents: pg.docs,
      };
      const p = await startPlane({ stores, node: 'node-v-his-001-016-pro-028-pg' });
      planes.push(p);
      await rejectionsOnTheWire(p);
    });
  },
);
