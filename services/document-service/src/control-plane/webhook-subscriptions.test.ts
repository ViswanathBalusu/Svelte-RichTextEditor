// Webhook subscriptions (05 §6.2, §7; PRO-068; the rotation part of PRO-070).
// Not covered here: the test ping and the replay (PRO-068 criteria 4 and 5), which send requests
// and wait for the dispatcher (BE-055) and the egress proxy (BE-056). The routes are not in the
// router yet; these tests call the operations the router will call.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Caller } from './pipeline.ts';
import { ApiError } from './problems.ts';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
  etagOf,
  type Answer,
} from './webhook-subscriptions.ts';
import { signDelivery, verifyDelivery } from './webhook-signing.ts';

const TENANT = 'tenant-a';

const service = (tenant = TENANT): Caller => ({
  kind: 'service',
  tenant,
  identity: null,
  actor: 'system',
  credential: 'key-1',
});

const user: Caller = {
  kind: 'user',
  tenant: TENANT,
  identity: null as never,
  actor: 'user-surrogate-1',
  credential: 'user',
};

/** Secrets are generated in sequence so that a test can name them. */
function harness() {
  let clock = 1_700_000_000_000;
  let idSeq = 0;
  let secretSeq = 0;
  const store = new MemorySubscriptionStore();
  const subs = new WebhookSubscriptions({
    store,
    now: () => {
      clock += 1000;
      return clock;
    },
    newId: () => `sub-${String(++idSeq).padStart(4, '0')}`,
    newSecret: () =>
      `whsec_${Buffer.from(`key-bytes-${++secretSeq}-0123456789abcd`).toString('base64')}`,
  });
  return { store, subs };
}

const GOOD = {
  url: 'https://receiver.example.test/hooks/docs',
  events: ['dep.document.state_changed.v1', 'dep.export.completed.v1'],
};

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected the operation to be refused');
}

async function created(
  subs: WebhookSubscriptions,
): Promise<{ id: string; secret: string; etag: string }> {
  const r: Answer = await subs.create(service(), GOOD);
  const body = r.body as { id: string; secret: string };
  return { id: body.id, secret: body.secret, etag: r.etag! };
}

describe('PRO-068 criterion 1: create, read, change and remove with If-Match', () => {
  it('creates a subscription with one secret, shown once, and an ETag', async () => {
    const { subs } = harness();
    const r = await subs.create(service(), GOOD);
    expect(r.status).toBe(201);
    expect(r.location).toBe('/webhooks/sub-0001');
    expect(r.etag).toBe('"1"');
    const body = r.body as Record<string, unknown>;
    expect(body['secret']).toMatch(/^whsec_/);
    expect(body['activeSecrets']).toBe(1);
    expect(body['events']).toEqual(GOOD.events);
  });

  it('reads the subscription without its secret', async () => {
    const { subs } = harness();
    const made = await created(subs);
    const r = await subs.get(service(), made.id);
    expect(r.status).toBe(200);
    expect(r.etag).toBe(made.etag);
    expect(r.body).not.toHaveProperty('secret');
    const list = (await subs.list(service())).body as { items: Array<Record<string, unknown>> };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty('secret');
  });

  it('changes the url and events only with a current If-Match', async () => {
    const { subs } = harness();
    const made = await created(subs);
    const url = 'https://receiver.example.test/hooks/v2';
    await expect(failure(subs.update(service(), made.id, { url }, null))).resolves.toMatchObject({
      code: 'precondition_failed',
      status: 428,
    });
    const stale = await failure(subs.update(service(), made.id, { url }, ['"0"']));
    expect(stale.code).toBe('precondition_failed');
    expect(stale.status).toBe(412);
    const ok = await subs.update(service(), made.id, { url }, [made.etag]);
    expect(ok.status).toBe(200);
    expect(ok.etag).toBe('"2"');
    expect((ok.body as { url: string }).url).toBe(url);
    const wild = await subs.update(service(), made.id, { events: ['dep.task.assigned.v1'] }, '*');
    expect((wild.body as { events: string[] }).events).toEqual(['dep.task.assigned.v1']);
  });

  it('removes the subscription with If-Match and answers 204', async () => {
    const { subs } = harness();
    const made = await created(subs);
    await expect(failure(subs.remove(service(), made.id, null))).resolves.toMatchObject({
      status: 428,
    });
    const removed = await subs.remove(service(), made.id, [made.etag]);
    expect(removed.status).toBe(204);
    const gone = await failure(subs.get(service(), made.id));
    expect(gone.code).toBe('not_found');
  });

  it('does not show a subscription of another tenant', async () => {
    const { subs } = harness();
    const made = await created(subs);
    const other = await failure(subs.get(service('tenant-b'), made.id));
    expect(other.code).toBe('not_found');
    const list = (await subs.list(service('tenant-b'))).body as { items: unknown[] };
    expect(list.items).toEqual([]);
  });

  it('refuses bodies that are not usable, with the offending member named', async () => {
    const { subs } = harness();
    const cases: Array<[unknown, string]> = [
      [{ ...GOOD, url: 'javascript:alert(1)' }, '/url'],
      [{ ...GOOD, url: 'not a url' }, '/url'],
      [{ ...GOOD, events: [] }, '/events'],
      [{ ...GOOD, events: ['document.changed'] }, '/events'],
      [{ ...GOOD, events: ['dep.export.completed.v1', 'dep.export.completed.v1'] }, '/events'],
      [{ ...GOOD, filter: 'all' }, '/filter'],
    ];
    for (const [body, path] of cases) {
      const e = await failure(subs.create(service(), body));
      expect(e.code).toBe('validation_failed');
      expect(e.violations?.[0]?.path).toBe(path);
    }
  });
});

describe('PRO-068 criterion 2: user tokens cannot reach /webhooks', () => {
  it('refuses every operation for a user caller', async () => {
    const { subs, store } = harness();
    const made = await created(subs);
    const row = await store.get(TENANT, made.id);
    expect(row?.version).toBe(1);
    const calls: Array<Promise<unknown>> = [
      subs.create(user, GOOD),
      subs.list(user),
      subs.get(user, made.id),
      subs.update(user, made.id, { url: GOOD.url }, [made.etag]),
      subs.remove(user, made.id, [made.etag]),
    ];
    for (const p of calls) {
      const e = await failure(p);
      expect(e.code).toBe('forbidden');
      expect(e.status).toBe(403);
    }
    expect((await store.get(TENANT, made.id))?.version).toBe(1);
  });
});

describe('PRO-068 criterion 3 and PRO-070 criterion 3 (store level): two secrets during a rotation', () => {
  it('keeps two secrets active until the old one is retired, and both verify a delivery', async () => {
    const { subs } = harness();
    const made = await created(subs);

    const rotated = await subs.update(service(), made.id, { rotate: true }, [made.etag]);
    expect(rotated.status).toBe(200);
    const issued = (rotated.body as { secret: string; activeSecrets: number }).secret;
    expect((rotated.body as { activeSecrets: number }).activeSecrets).toBe(2);
    expect(issued).toMatch(/^whsec_/);
    expect(issued).not.toBe(made.secret);

    const active = await subs.activeSecrets(TENANT, made.id);
    expect(active).toEqual([made.secret, issued]);

    // The signature header holds one entry per active secret, so a receiver knowing either secret
    // verifies the delivery (05 §7; webhook-signing.ts). The dispatcher that sends it is BE-055.
    const body = '{"specversion":"1.0","type":"dep.export.completed.v1"}';
    const now = 1_700_000_000;
    const headers = signDelivery({ id: 'msg_1', timestamp: now, body, secrets: [...active] });
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    for (const known of active) {
      expect(verifyDelivery({ headers, body, secrets: [known], now })).toEqual({ ok: true });
    }

    const again = await failure(subs.update(service(), made.id, { rotate: true }, [rotated.etag!]));
    expect(again.code).toBe('conflict');

    const retired = await subs.update(service(), made.id, { retire: true }, '*');
    expect((retired.body as { activeSecrets: number }).activeSecrets).toBe(1);
    expect(await subs.activeSecrets(TENANT, made.id)).toEqual([issued]);
    const oldOnly = signDelivery({ id: 'msg_2', timestamp: now, body, secrets: [made.secret] });
    expect(verifyDelivery({ headers: oldOnly, body, secrets: [issued], now })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });

    const none = await failure(subs.update(service(), made.id, { retire: true }, '*'));
    expect(none.code).toBe('conflict');
  });

  it('refuses rotate and retire in one request', async () => {
    const { subs } = harness();
    const made = await created(subs);
    const e = await failure(subs.update(service(), made.id, { rotate: true, retire: true }, '*'));
    expect(e.code).toBe('validation_failed');
  });
});

describe('PRO-068 criterion 1 under If-Match (property)', () => {
  it('refuses any tag other than the current ETag and leaves the stored version alone', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 12 }).filter((t) => t !== '*'),
        async (tag) => {
          const { subs, store } = harness();
          const made = await created(subs);
          const quoted = `"${tag}"`;
          if (quoted === etagOf(1)) return;
          const e = await failure(
            subs.update(service(), made.id, { url: 'https://other.example.test/' }, [quoted]),
          );
          expect(e.code).toBe('precondition_failed');
          expect((await store.get(TENANT, made.id))?.version).toBe(1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('accepts any well-formed list of distinct event names with a version suffix', async () => {
    const segment = fc.stringMatching(/^[a-z]{1,8}$/);
    const eventName = fc
      .tuple(fc.array(segment, { minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 9 }))
      .map(([parts, v]) => `dep.${parts.join('.')}.v${v}`);
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(eventName, { minLength: 1, maxLength: 6 }),
        async (events) => {
          const { subs } = harness();
          const r = await subs.create(service(), { url: GOOD.url, events });
          expect((r.body as { events: string[] }).events).toEqual(events);
        },
      ),
      { numRuns: 60 },
    );
  });
});
