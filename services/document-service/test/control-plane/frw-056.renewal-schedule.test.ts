// FRW-056 criterion 2: the schedule that queues the renewal of a seal's time-stamp before it ends.
// `scheduleRenewals` over the in-memory chain store and job queue, with a clock the test moves; the
// same listing on PostgreSQL when the test environment is up; and the settings. The live path (the
// first expiry recorded by the finalisation, the renewal that appends a time-stamp) is in
// frw-053.live-seal.test.ts.
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { configFromEnv } from '../../src/config.ts';
import { MemoryJobQueue } from '../../src/control-plane/jobs/queue.ts';
import {
  RENEWAL_KIND,
  renewalHandler,
  renewalJobId,
} from '../../src/control-plane/jobs/workflow-renewal.ts';
import { MemoryRenewalStore } from '../../src/workflow/renewal-state-memory.ts';
import { PgRenewalStore } from '../../src/workflow/renewal-state-pg.ts';
import { recordFirstExpiry, scheduleRenewals } from '../../src/workflow/renewal-schedule.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const DAY = 24 * 60 * 60 * 1000;
const LEAD = 30 * DAY;
const T0 = Date.UTC(2027, 0, 1);

describe('the renewal schedule (FRW-056 criterion 2)', () => {
  it('queues one job for an expiry inside the lead time, once however often it runs', async () => {
    const clock = { now: T0 };
    const registry = new MemoryRenewalStore();
    const queue = new MemoryJobQueue(() => clock.now);
    const tenant = randomUUID();
    const soon = randomUUID();
    const later = randomUUID();
    await registry.start(tenant, soon, T0 + 10 * DAY);
    await registry.start(tenant, later, T0 + 200 * DAY);
    const deps = { registry, queue, leadMs: LEAD, now: () => clock.now };

    const run = await scheduleRenewals(deps, tenant);
    expect(run.queued).toEqual([{ doc: soon, expiresAtMs: T0 + 10 * DAY }]);
    await scheduleRenewals(deps, tenant);
    await Promise.all([scheduleRenewals(deps, tenant), scheduleRenewals(deps, tenant)]);
    const job = await queue.get(tenant, renewalJobId(soon, T0 + 10 * DAY));
    expect(job).toMatchObject({
      kind: RENEWAL_KIND,
      doc: soon,
      payload: { expiry: T0 + 10 * DAY },
    });
    expect(await queue.get(tenant, renewalJobId(later, T0 + 200 * DAY))).toBeNull();

    // Later, the second document comes into the window.
    clock.now = T0 + 180 * DAY;
    expect((await scheduleRenewals(deps, tenant)).queued.map((q) => q.doc)).toEqual([later]);
  });

  it('lists the documents of one tenant only, and not one whose time-stamp has already ended', async () => {
    const registry = new MemoryRenewalStore();
    const tenant = randomUUID();
    const other = randomUUID();
    const doc = randomUUID();
    const gone = randomUUID();
    await registry.start(tenant, doc, T0 + DAY);
    await registry.start(tenant, gone, T0 - DAY);
    await registry.start(other, randomUUID(), T0 + DAY);
    expect(await registry.listDue(tenant, T0, LEAD, 10)).toEqual([{ doc, expiresAtMs: T0 + DAY }]);
    expect(await registry.listDue(tenant, T0, LEAD, 0)).toEqual([]);
  });

  it('records a first expiry once, and not one that is missing or not a time', async () => {
    const registry = new MemoryRenewalStore();
    const tenant = randomUUID();
    const doc = randomUUID();
    expect(await recordFirstExpiry(registry, tenant, doc, undefined)).toBe(false);
    expect(await recordFirstExpiry(registry, tenant, doc, 0)).toBe(false);
    expect(await recordFirstExpiry(registry, tenant, doc, 1.5)).toBe(false);
    expect(await recordFirstExpiry(registry, tenant, doc, T0)).toBe(true);
    expect(await recordFirstExpiry(registry, tenant, doc, T0 + DAY)).toBe(false);
    expect(await registry.load(tenant, doc)).toEqual({ expiresAtMs: T0 });
  });

  it('after the renewal moves the expiry the document is no longer due, and the job fails visibly when the signer does', async () => {
    const clock = { now: T0 };
    const registry = new MemoryRenewalStore();
    const queue = new MemoryJobQueue(() => clock.now);
    const tenant = randomUUID();
    const doc = randomUUID();
    await registry.start(tenant, doc, T0 + 10 * DAY);
    const deps = { registry, queue, leadMs: LEAD, now: () => clock.now };
    await scheduleRenewals(deps, tenant);
    const job = (await queue.get(tenant, renewalJobId(doc, T0 + 10 * DAY)))!;
    let asked = 0;
    const handler = renewalHandler({
      store: registry,
      signer: {
        renew: async () => {
          asked += 1;
          return asked === 1
            ? { ok: false, reason: 'tsa_unreachable' }
            : { ok: true, newExpiresAtMs: T0 + 400 * DAY };
        },
      },
      leadMs: LEAD,
      claimMs: 60_000,
      now: () => clock.now,
    });
    const ctx = undefined as never;
    await expect(handler(job, ctx)).rejects.toMatchObject({
      code: 'renewal_failed',
      retry: true,
      result: { alert: true },
    });
    expect(await handler(job, ctx)).toEqual({ renewed: true, expiresAtMs: T0 + 400 * DAY });
    expect((await scheduleRenewals(deps, tenant)).queued).toEqual([]);
    expect(asked).toBe(2);
  });

  it('reads the lead time and the claim time from the settings, both or neither, with no default', () => {
    const base = {
      DOCEDIT_SEAL_URL: 'http://127.0.0.1:1/',
      DOCEDIT_SEAL_CREDENTIAL: 'x',
      DOCEDIT_SEAL_TIMEOUT_MS: '1000',
      DOCEDIT_SEAL_ATTEMPTS: '2',
      DOCEDIT_SEAL_DELAYS_MS: '10',
      DOCEDIT_SEAL_RETENTION_DAYS: '30',
    };
    expect(configFromEnv(base).sealing?.renewal).toBeUndefined();
    expect(
      configFromEnv({
        ...base,
        DOCEDIT_RENEWAL_LEAD_DAYS: '30',
        DOCEDIT_RENEWAL_CLAIM_MS: '60000',
      }).sealing?.renewal,
    ).toEqual({ leadMs: 30 * DAY, claimMs: 60_000 });
    expect(() => configFromEnv({ ...base, DOCEDIT_RENEWAL_LEAD_DAYS: '30' })).toThrow(
      /DOCEDIT_RENEWAL_CLAIM_MS/,
    );
    expect(() => configFromEnv({ ...base, DOCEDIT_RENEWAL_CLAIM_MS: '0' })).toThrow(
      /DOCEDIT_RENEWAL_LEAD_DAYS/,
    );
  });
});

const databases: TestDatabase[] = [];
const why = await postgresUnavailable();

describe.skipIf(why)('the renewal schedule on PostgreSQL (FRW-056 criterion 2)', () => {
  afterAll(async () => {
    for (const db of databases) await db.drop();
  });

  it('records a first expiry once and lists the documents due, soonest first, for one tenant', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const store = new PgRenewalStore(db.service);
    const tenant = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    const late = randomUUID();
    const gone = randomUUID();
    expect(await store.start(tenant, a, T0 + 20 * DAY)).toBe(true);
    expect(await store.start(tenant, a, T0 + 25 * DAY)).toBe(false);
    await store.start(tenant, b, T0 + 5 * DAY);
    await store.start(tenant, late, T0 + 300 * DAY);
    await store.start(tenant, gone, T0 - DAY);
    await store.start(randomUUID(), randomUUID(), T0 + DAY);
    expect(await store.load(tenant, a)).toEqual({ expiresAtMs: T0 + 20 * DAY });
    expect(await store.listDue(tenant, T0, LEAD, 10)).toEqual([
      { doc: b, expiresAtMs: T0 + 5 * DAY },
      { doc: a, expiresAtMs: T0 + 20 * DAY },
    ]);
    expect(await store.listDue(tenant, T0, LEAD, 1)).toEqual([
      { doc: b, expiresAtMs: T0 + 5 * DAY },
    ]);
  });
});
