/**
 * The `webhooks` profile (05 §7, §11; PRO-121). The kit runs a receiver (receiver.ts), registers a
 * subscription that points at it through `POST /webhooks`, makes events happen, and checks what
 * arrives: the CloudEvents body against the definition, the Standard Webhooks signature with the
 * kit's own verifier (webhook-verify.ts), the retry of a delivery under one `webhook-id`, the two
 * secrets of a rotation, and the debounce of `dep.document.changed.v1`.
 *
 * DEP gives webhooks no feature name, as it gives none to `fonts` and `imports` (ADR 0416,
 * proposed), so the profile always runs and each scenario is skipped when the server keeps no
 * subscriptions (`GET /webhooks` answers `not_found`). The receiver has to be reachable from the
 * target, which refuses private and loopback addresses (10 §3.2); see `receiver` in config.ts.
 */
import { definition } from '@docedit/protocol';
import { KitFailure, check, equal, jsonEqual } from '../assert.ts';
import { validator, type ScenarioContext } from '../context.ts';
import { IDS, insertText, posIn } from '../documents.ts';
import { Receiver, type Received } from '../receiver.ts';
import { expectStatus } from '../rest.ts';
import { scenario, type ProfileDef, type ScenarioDef } from '../scenario.ts';
import { verifyRequest } from '../webhook-verify.ts';
import { acked, join } from './support.ts';

const s = (def: Omit<ScenarioDef, 'id'> & { id: string }) => scenario('webhooks', def);

const CREATED = 'dep.document.created.v1';
const CHANGED = 'dep.document.changed.v1';

/** The window of 05 §7 for `dep.document.changed.v1`, and the slack allowed for network jitter. */
const CHANGE_WINDOW_MS = 10_000;
const JITTER_MS = 1_000;
/** Commits of the debounce scenario (criterion 5 of PRO-121). */
const BURST = 100;

interface Subscription {
  id: string;
  secret: string;
  etag: string;
  path: string;
}

/** Skips the scenario when the server offers no webhook subscriptions. */
async function requireWebhooks(ctx: ScenarioContext) {
  const res = await ctx.service.call('GET', '/webhooks');
  if (res.status === 404 || res.status === 501)
    ctx.skip('the server keeps no webhook subscriptions (GET /webhooks is 404)');
  expectStatus(res, 200, 'GET /webhooks');
}

async function startReceiver(ctx: ScenarioContext): Promise<Receiver> {
  return Receiver.start(ctx.config.receiver ?? {});
}

async function subscribe(
  ctx: ScenarioContext,
  rx: Receiver,
  name: string,
  events: string[],
): Promise<Subscription> {
  const path = `${ctx.config.run}/${name}`;
  const res = expectStatus(
    await ctx.service.call('POST', '/webhooks', { body: { url: rx.urlFor(path), events } }),
    201,
    'POST /webhooks',
  );
  const body = res.json as { id?: unknown; secret?: unknown };
  check(
    typeof body.id === 'string' && typeof body.secret === 'string',
    'the subscription comes with its identifier and its one secret',
    'id and secret',
    res.json,
  );
  return {
    id: body.id as string,
    secret: body.secret as string,
    etag: res.headers.get('etag') ?? '*',
    path: `/${path}`,
  };
}

async function unsubscribe(ctx: ScenarioContext, sub: Subscription | undefined) {
  if (!sub) return;
  const current = await ctx.service.call('GET', `/webhooks/${sub.id}`);
  await ctx.service.call('DELETE', `/webhooks/${sub.id}`, {
    headers: { 'if-match': current.headers.get('etag') ?? '*' },
  });
}

/** The first request of a subscription for an event, or a failure that says what did not arrive. */
async function delivery(
  ctx: ScenarioContext,
  rx: Receiver,
  sub: Subscription,
  type: string,
  doc: string,
  from = 0,
): Promise<Received> {
  const hit = await rx.waitFor(
    (r) => r.path === sub.path && bodyOf(r)?.['type'] === type && bodyOf(r)?.['subject'] === doc,
    Math.max(ctx.timeoutMs, 15_000),
    from,
  );
  if (!hit)
    throw new KitFailure(
      `${type} for the document reached the receiver`,
      `a request at ${sub.path}`,
      `${rx.received.length} requests, none for the event`,
    );
  return hit;
}

function bodyOf(r: Received): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(r.body);
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Runs `fn` with a receiver and one subscription, and removes both whatever `fn` does. */
async function withSubscription(
  ctx: ScenarioContext,
  name: string,
  events: string[],
  fn: (rx: Receiver, sub: Subscription) => Promise<void>,
  prepare?: (rx: Receiver) => void,
) {
  await requireWebhooks(ctx);
  const rx = await startReceiver(ctx);
  let sub: Subscription | undefined;
  try {
    prepare?.(rx);
    sub = await subscribe(ctx, rx, name, events);
    await fn(rx, sub);
  } finally {
    await unsubscribe(ctx, sub).catch(() => undefined);
    await rx.stop();
  }
}

export const WEBHOOKS_PROFILE: ProfileDef = {
  id: 'webhooks',
  title: 'Signed webhooks: bodies, signatures, rotation, retries and the debounce',
  spec: '05 §7, §11',
  stories: ['PRO-121'],
  requires: { kind: 'always' },
  scenarios: [
    s({
      id: 'body',
      title: 'a delivery is a CloudEvents body whose type, subject and data match the schemas',
      spec: '05 §7',
      covers: { operations: ['POST /webhooks'] },
      async run(ctx) {
        await withSubscription(ctx, 'body', [CREATED], async (rx, sub) => {
          const doc = await ctx.document();
          const hit = await delivery(ctx, rx, sub, CREATED, doc);
          const body = bodyOf(hit)!;
          const def = definition.WEBHOOKS.find((w) => definition.webhookType(w) === CREATED);
          check(def !== undefined, 'the definition names the event', CREATED, 'not found');
          const violations = validator
            .check(definition.webhookEnvelope(def!), body)
            .map((v) => `${v.path || '/'} ${v.message}`);
          jsonEqual(violations, [], 'the body matches the schema of the event');
          equal(body['specversion'], '1.0', 'specversion');
          equal(body['type'], CREATED, 'type');
          equal(body['subject'], doc, 'subject is the document identifier');
          check(
            /json/i.test(hit.headers['content-type'] ?? ''),
            'the body is JSON',
            'a JSON content type',
            hit.headers['content-type'],
          );
          equal(hit.status, 204, 'the receiver answered 204');
        });
      },
    }),
    s({
      id: 'signature',
      title: 'every delivery carries a signature that verifies, and that nothing else verifies',
      spec: '05 §7',
      covers: { operations: ['POST /webhooks'] },
      async run(ctx) {
        await withSubscription(ctx, 'signature', [CREATED], async (rx, sub) => {
          const doc = await ctx.document();
          const hit = await delivery(ctx, rx, sub, CREATED, doc);
          const ok = verifyRequest({
            headers: hit.headers,
            body: hit.body,
            secrets: [sub.secret],
            now: nowSeconds(),
          });
          check(ok.ok, 'the signature verifies with the subscription secret', 'ok', ok);
          const ts = Number(hit.headers['webhook-timestamp']);
          check(
            Math.abs(nowSeconds() - ts) <= 300,
            'the timestamp is within five minutes of the receiver clock',
            'at most 300 s',
            nowSeconds() - ts,
          );
          // The verifier is only worth something if it refuses what it should.
          const changed = verifyRequest({
            headers: hit.headers,
            body: `${hit.body} `,
            secrets: [sub.secret],
            now: nowSeconds(),
          });
          check(!changed.ok, 'a body changed by one byte does not verify', 'refused', changed);
          const late = verifyRequest({
            headers: hit.headers,
            body: hit.body,
            secrets: [sub.secret],
            now: ts + 301,
          });
          check(!late.ok, 'a delivery older than five minutes does not verify', 'refused', late);
          const other = verifyRequest({
            headers: hit.headers,
            body: hit.body,
            secrets: ['whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
            now: nowSeconds(),
          });
          check(!other.ok, 'another secret does not verify it', 'refused', other);
        });
      },
    }),
    s({
      id: 'rotation',
      title:
        'during a rotation a delivery verifies with either secret, and after it with the new one',
      spec: '05 §7',
      covers: { operations: ['PATCH /webhooks/{id}'] },
      async run(ctx) {
        await withSubscription(ctx, 'rotation', [CREATED], async (rx, sub) => {
          const rotate = expectStatus(
            await ctx.service.call('PATCH', `/webhooks/${sub.id}`, {
              body: { rotate: true },
              headers: { 'if-match': sub.etag },
            }),
            200,
            'PATCH /webhooks/{id} with rotate',
          );
          const issued = (rotate.json as { secret?: unknown }).secret;
          check(
            typeof issued === 'string',
            'the rotation returns the new secret',
            'a secret',
            rotate.json,
          );
          const during = await delivery(ctx, rx, sub, CREATED, await ctx.document());
          const withOne = (secret: string) =>
            verifyRequest({
              headers: during.headers,
              body: during.body,
              secrets: [secret],
              now: nowSeconds(),
            });
          check(
            withOne(sub.secret).ok,
            'the old secret verifies during the rotation',
            'ok',
            during.headers,
          );
          check(
            withOne(issued as string).ok,
            'the new secret verifies during the rotation',
            'ok',
            during.headers,
          );
          const entries = (during.headers['webhook-signature'] ?? '').split(' ').filter(Boolean);
          equal(entries.length, 2, 'one signature per active secret');
          check(entries[0]!.startsWith('v1,'), 'the signature version is v1', 'v1,...', entries[0]);

          const retire = expectStatus(
            await ctx.service.call('PATCH', `/webhooks/${sub.id}`, {
              body: { retire: true },
              headers: { 'if-match': rotate.headers.get('etag') ?? '*' },
            }),
            200,
            'PATCH /webhooks/{id} with retire',
          );
          check(
            retire.headers.get('etag') !== null,
            'the retirement answers an ETag',
            'an ETag',
            null,
          );
          const mark = rx.received.length;
          const after = await delivery(ctx, rx, sub, CREATED, await ctx.document(), mark);
          const verifies = (secret: string) =>
            verifyRequest({
              headers: after.headers,
              body: after.body,
              secrets: [secret],
              now: nowSeconds(),
            }).ok;
          check(
            verifies(issued as string),
            'the new secret verifies after the retirement',
            'ok',
            after.headers,
          );
          check(
            !verifies(sub.secret),
            'the retired secret no longer verifies',
            'refused',
            after.headers,
          );
        });
      },
    }),
    s({
      id: 'retry',
      title: 'a delivery answered 500 arrives again under the same webhook-id',
      spec: '05 §7',
      timeoutMs: 120_000,
      covers: { operations: ['POST /webhooks'] },
      async run(ctx) {
        await withSubscription(
          ctx,
          'retry',
          [CREATED],
          async (rx, sub) => {
            const doc = await ctx.document();
            const attempts = (): Received[] =>
              rx.received.filter((r) => r.path === sub.path && bodyOf(r)?.['subject'] === doc);
            await rx.waitFor(
              () => attempts().length >= 3,
              Math.min(ctx.config.scenarioTimeoutMs - 10_000, 100_000),
            );
            const got = attempts();
            check(
              got.length >= 3,
              'the server retried a delivery that was answered 500 (05 §7: at least once)',
              'at least 3 attempts',
              `${got.length} attempts`,
            );
            const ids = new Set(got.map((r) => r.headers['webhook-id']));
            equal(ids.size, 1, 'every attempt carries the same webhook-id');
            jsonEqual(
              got.slice(0, 2).map((r) => r.status),
              [500, 500],
              'the first two attempts failed',
            );
            equal(got[2]!.status, 204, 'the third attempt was accepted');
            const body = got[0]!.body;
            check(
              got.every((r) => r.body === body),
              'every attempt carries the same body',
              'one body',
              'bodies differ',
            );
            // A receiver deduplicates on the identifier: one event, however many attempts.
            const events = new Set(got.map((r) => r.headers['webhook-id']));
            equal(events.size, 1, 'one event after deduplication on webhook-id');
            // A delivery that was accepted is not sent again.
            await new Promise((r) => setTimeout(r, 2_000));
            equal(attempts().length, got.length, 'no attempt after the receiver accepted it');
          },
          (rx) => rx.answerWith((_r, n) => (n < 2 ? 500 : 204)),
        );
      },
    }),
    s({
      id: 'debounce',
      title: 'a hundred commits make at most one dep.document.changed per document per ten seconds',
      spec: '05 §7',
      timeoutMs: 90_000,
      covers: { messages: ['sync.submit', 'sync.ack'] },
      async run(ctx) {
        await withSubscription(ctx, 'debounce', [CHANGED], async (rx, sub) => {
          const doc = await ctx.document();
          const m = await join(ctx, 'burst', doc, 'editor');
          const started = Date.now();
          let base = m.content.seq;
          const at = posIn(m.content.doc, IDS.intro);
          for (let i = 0; i < BURST; i++) {
            const a = await acked(m.wire, m.ch, { base, steps: [insertText(at + i, 'x')] });
            base = a.seq;
          }
          const burstMs = Date.now() - started;
          ctx.note(`${BURST} commits acknowledged in ${burstMs} ms`);
          if (burstMs > CHANGE_WINDOW_MS)
            ctx.skip(
              `the ${BURST} commits took ${burstMs} ms, more than the ${CHANGE_WINDOW_MS} ms window`,
            );
          // The change that was held back is raised when its window ends.
          await rx.waitFor(() => changes().length >= 2, CHANGE_WINDOW_MS + 2 * JITTER_MS + 2_000);
          function changes(): Received[] {
            return rx.received.filter(
              (r) =>
                r.path === sub.path &&
                bodyOf(r)?.['type'] === CHANGED &&
                bodyOf(r)?.['subject'] === doc,
            );
          }
          const got = changes();
          check(got.length >= 1, 'the first change is delivered', 'at least one', 0);
          check(got.length < BURST, 'the changes are coalesced', `fewer than ${BURST}`, got.length);
          for (let i = 1; i < got.length; i++) {
            const gap = got[i]!.at - got[i - 1]!.at;
            check(
              gap >= CHANGE_WINDOW_MS - JITTER_MS,
              'two deliveries for one document are at least ten seconds apart',
              `at least ${CHANGE_WINDOW_MS - JITTER_MS} ms`,
              `${gap} ms`,
            );
          }
          const last = bodyOf(got[got.length - 1]!)!['data'] as { seq?: number } | undefined;
          check(
            typeof last?.seq === 'number',
            'the delivery names the head it refers to',
            'data.seq',
            last,
          );
          await m.wire.close();
        });
      },
    }),
  ],
};
