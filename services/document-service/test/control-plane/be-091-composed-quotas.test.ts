/**
 * BE-091 criteria 1 to 3 on a composed node (lane w5): the quota values are written through the
 * administration route `PUT /v1/quotas` (UX-078), not into a store the test holds, and the real
 * data plane and REST routes read them at the next request. The node is the full service with
 * memory or PostgreSQL storage (PostgreSQL in Podman where it is available).
 *
 * Covered: the connection, open-documents, room CPU budget and commit-rate answers on the socket
 * (`retryAfterMs`) and on REST (`Retry-After`), a change applying to the next request, and another
 * tenant's commits being unaffected by a tenant at its quota, with a latency measurement.
 * Test values only.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { cdmSchema } from '@docedit/model/prosemirror';
import { uuid7 } from '@docedit/model';
import { checkProblem } from '@docedit/protocol';
import { signJws } from '../../src/control-plane/jwt.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { DepClient, insertText } from '../data-plane/client.ts';
import {
  documentWithRegions,
  hostKey,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const INTRO = 'pIntro0000000001';

function insideAt(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

const clients: DepClient[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const h of harnesses.splice(0)) await h.close();
});

async function node(storage: Storage): Promise<Harness> {
  const h = await startHarness(storage, {
    config: { testMode: true, environment: 'test' },
    realDataPlane: true,
  });
  harnesses.push(h);
  return h;
}

async function putQuotas(h: Harness, body: Record<string, number>): Promise<void> {
  const read = await h.call('GET', '/v1/quotas', { token: h.apiKey });
  const r = await h.call('PUT', '/v1/quotas', {
    token: h.apiKey,
    body,
    headers: { 'If-Match': read.headers.get('etag')! },
  });
  expect(r.status, r.text).toBe(200);
}

async function connect(h: Harness): Promise<DepClient> {
  const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
  clients.push(c);
  return c;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`BE-091 quotas written through PUT /quotas, read by the node (${storage})`, async () => {
    const skip = await skipReason(storage);

    it.skipIf(skip)(
      'applies a connection quota written through the administration API to the next hello, and a raised one to the hello after',
      async () => {
        const h = await node(storage);
        const doc = await h.createDocument({ content: documentWithRegions() });
        const token = h.userToken({ [doc]: 'owner' });
        await putQuotas(h, { connections: 1 });

        const first = await connect(h);
        expect((await first.hello(token)).t).toBe('welcome');
        const refused = await (await connect(h)).hello(token);
        expect(refused.t).toBe('error');
        expect(refused.d?.code).toBe('quota_exceeded');
        expect(refused.d?.retryAfterMs).toBeGreaterThan(0);
        // UX-078 criterion 3 (owner decision 110): the refusal names the kind of quota.
        expect(refused.d?.quota).toBe('connections');

        await putQuotas(h, { connections: 2 });
        expect((await (await connect(h)).hello(token)).t).toBe('welcome');
      },
    );

    it.skipIf(skip)(
      'answers a ch.open over the open-documents quota with quota_exceeded and retryAfterMs, counts a document once across its channels, and admits again once the sessions end',
      async () => {
        const h = await node(storage);
        const content = documentWithRegions();
        const docA = await h.createDocument({ content });
        const docB = await h.createDocument({ content });
        const token = h.userToken({ [docA]: 'owner', [docB]: 'owner' });
        await putQuotas(h, { openDocuments: 1 });

        const one = await connect(h);
        await one.hello(token);
        expect((await one.open(1, docA)).t).toBe('ch.opened');

        // A second session on the same document does not count it twice.
        const two = await connect(h);
        await two.hello(token);
        expect((await two.open(1, docA)).t).toBe('ch.opened');

        // Another document is over the quota.
        const three = await connect(h);
        await three.hello(token);
        const refused = await three.open(1, docB);
        expect(refused.t).toBe('error');
        expect(refused.d?.code).toBe('quota_exceeded');
        expect(refused.d?.quota).toBe('openDocuments');
        expect(refused.d?.retryAfterMs).toBeGreaterThan(0);
        expect(
          checkProblem({
            surface: 'socket',
            code: refused.d?.code,
            retryAfterMs: refused.d?.retryAfterMs,
          }),
        ).toEqual([]);

        // The document stops counting when its last channel is gone.
        one.terminate();
        two.terminate();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect((await three.open(1, docB)).t).toBe('ch.opened');
      },
    );

    it.skipIf(skip)(
      'refuses a commit as rate_limited with action retry once the tenant has spent its room CPU budget',
      async () => {
        const h = await node(storage);
        const content = documentWithRegions();
        const doc = await h.createDocument({ content });
        const token = h.userToken({ [doc]: 'owner' });
        const intro = insideAt(content['doc'], INTRO);
        const c = await connect(h);
        await c.hello(token);
        expect((await c.open(1, doc)).t).toBe('ch.opened');
        expect((await c.submit(1, { base: 0, steps: [insertText(intro, 'a')] })).t).toBe(
          'sync.ack',
        );

        // A budget of 0 milliseconds is spent from the start (06 §12; 04 §12).
        await putQuotas(h, { roomCpuBudget: 0 });
        const refused = await c.submit(1, { base: 1, steps: [insertText(intro, 'b')] });
        expect(refused.t).toBe('sync.reject');
        expect(refused.d?.code).toBe('rate_limited');
        expect(refused.d?.action).toBe('retry');
        expect(refused.d?.quota).toBe('roomCpuBudget');
        expect(refused.d?.retryAfterMs).toBeGreaterThan(0);
        expect(
          checkProblem({
            surface: 'sync',
            code: refused.d?.code,
            retryAfterMs: refused.d?.retryAfterMs,
          }),
        ).toEqual([]);

        await putQuotas(h, { roomCpuBudget: 1_000_000 });
        expect((await c.submit(1, { base: 1, steps: [insertText(intro, 'b')] })).t).toBe(
          'sync.ack',
        );
      },
    );

    it.skipIf(skip)(
      'answers a REST commit over the commit-rate quota with 429, quota_exceeded and Retry-After, and applies a raised quota to the next request',
      async () => {
        const h = await node(storage);
        const doc = await h.createDocument({ content: documentWithRegions() });
        await putQuotas(h, { commitRate: 0 });

        const refused = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: documentWithRegions(),
          headers: { 'If-Match': '"unused"' },
        });
        expect(refused.status, refused.text).toBe(429);
        expect(refused.json.code).toBe('quota_exceeded');
        expect(refused.json.quota).toBe('commitRate');
        const retry = Number(refused.headers.get('retry-after'));
        expect(Number.isInteger(retry) && retry >= 1).toBe(true);
        expect(
          checkProblem({
            surface: 'rest',
            code: refused.json.code,
            retryAfterHeader: String(retry),
          }),
        ).toEqual([]);

        // Raised: the request is no longer refused for the quota (it meets the next check).
        await putQuotas(h, { commitRate: 100 });
        const next = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: documentWithRegions(),
          headers: { 'If-Match': '"unused"' },
        });
        expect(next.json?.code).not.toBe('quota_exceeded');
      },
    );
  });
}

describe('BE-091 criterion 2: measuring another tenant while one is at its quota', () => {
  async function secondTenant(h: Harness) {
    const tenant = randomUUID();
    await h.parts.registry.putTenant(tenant, 'Second tenant');
    const key = hostKey('EdDSA');
    await h.parts.registry.addKey(tenant, {
      kid: key.kid,
      use: 'user',
      alg: key.alg,
      jwk: key.jwk,
    });
    const api = newApiKey(tenant);
    await h.parts.registry.addApiKey(tenant, { id: api.id, secretHash: hashSecret(api.secret) });
    await h.parts.registry.addOrigin(tenant, 'https://app.example.test');
    const created = await h.call('POST', '/v1/documents', {
      token: api.credential,
      body: { content: documentWithRegions() },
    });
    expect(created.status, created.text).toBe(201);
    const doc = created.json.id as string;
    const iat = Math.floor(h.now() / 1000);
    const token = signJws(
      { alg: key.alg, typ: 'JWT', kid: key.kid },
      {
        iss: 'https://host.example.test',
        aud: h.serviceId,
        iat,
        exp: iat + 600,
        jti: uuid7(),
        tid: tenant,
        sub: 'bob',
        docs: { [doc]: 'owner' },
      },
      key.privateKey,
    );
    return { tenant, doc, token };
  }

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

  it('acknowledges the other tenant while the first is refused at its commit-rate quota, and records the median', async () => {
    const h = await node('memory');
    const content = documentWithRegions();
    const intro = insideAt(content['doc'], INTRO);
    const docA = await h.createDocument({ content });
    const tokenA = h.userToken({ [docA]: 'owner' });
    const b = await secondTenant(h);
    await putQuotas(h, { commitRate: 1 });

    const a = await connect(h);
    await a.hello(tokenA);
    await a.open(1, docA);
    const cb = await connect(h);
    await cb.hello(b.token);
    expect((await cb.open(1, b.doc)).t).toBe('ch.opened');

    const N = 40;
    let base = 0;
    const timeB = async (): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < N; i += 1) {
        const t0 = performance.now();
        const r = await cb.submit(1, { base, steps: [insertText(intro, 'x')] });
        out.push(performance.now() - t0);
        expect(r.t).toBe('sync.ack');
        base += 1;
      }
      return out;
    };

    const idle = await timeB();
    // Tenant A is at its quota: its first commit is acknowledged and the rest are refused, as fast
    // as the loop can send them, while tenant B commits.
    expect((await a.submit(1, { base: 0, steps: [insertText(intro, 'a')] })).t).toBe('sync.ack');
    let refusals = 0;
    let stop = false;
    const flood = (async () => {
      while (!stop) {
        const r = await a.submit(1, { base: 1, steps: [insertText(intro, 'a')] });
        if (r.t === 'sync.reject' && r.d?.code === 'quota_exceeded') refusals += 1;
      }
    })();
    const busy = await timeB();
    stop = true;
    await flood;

    expect(refusals).toBeGreaterThan(0);
    // The measurement, taken in this process on memory storage, loopback sockets and this
    // machine: the median acknowledgement of tenant B, idle and while tenant A is refused.
    const idleMs = median(idle);
    const busyMs = median(busy);
    console.info(
      `BE-091 criterion 2: tenant B median ack ${idleMs.toFixed(2)} ms idle, ${busyMs.toFixed(2)} ms while tenant A is refused (${N} commits each, ${refusals} refusals of A)`,
    );
    // A loose bound that a coupling between the tenants (a shared queue or lock) would break; it
    // is not a performance figure of the spec.
    expect(busyMs).toBeLessThan(idleMs * 3 + 25);
  });

  it('leaves the other tenant at its idle latency while the first retries at its quota, within 1.5 times the slower idle run plus 5 ms', async () => {
    // The first test floods as fast as one loop can, so both tenants fight for the same event
    // loop. Here tenant A behaves as a client that honours `retryAfterMs` but is impatient: it
    // retries after at most 20 ms (50 attempts a second, all refused). Tenant B is timed in three
    // runs of the same size taken one after the other, idle, with A retrying, and idle again; the
    // middle run must stay within 1.5 times the slower idle run plus 5 ms. On a machine shared
    // with other work the two idle runs differ by 20 to 50 percent, so this shows that no
    // coupling (a shared queue or lock) exists, not that the latency is equal to the microsecond.
    // The tolerance is a test setting, not a figure of the specification.
    const h = await node('memory');
    const content = documentWithRegions();
    const intro = insideAt(content['doc'], INTRO);
    const docA = await h.createDocument({ content });
    const tokenA = h.userToken({ [docA]: 'owner' });
    const b = await secondTenant(h);
    await putQuotas(h, { commitRate: 1 });

    const cb = await connect(h);
    await cb.hello(b.token);
    expect((await cb.open(1, b.doc)).t).toBe('ch.opened');

    const N = 200;
    let base = 0;
    const timeB = async (): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < N; i += 1) {
        const t0 = performance.now();
        const r = await cb.submit(1, { base, steps: [insertText(intro, 'x')] });
        out.push(performance.now() - t0);
        expect(r.t).toBe('sync.ack');
        base += 1;
      }
      return out;
    };

    await timeB(); // warm-up, not recorded
    const idle1 = median(await timeB());
    // Connected only now: a session that sends nothing for two heartbeat intervals is closed.
    const a = await connect(h);
    await a.hello(tokenA);
    await a.open(1, docA);
    expect((await a.submit(1, { base: 0, steps: [insertText(intro, 'a')] })).t).toBe('sync.ack');
    let refusals = 0;
    let stop = false;
    const retrying = (async () => {
      while (!stop) {
        const r = await a.submit(1, { base: 1, steps: [insertText(intro, 'a')] });
        if (r.t === 'sync.reject' && r.d?.code === 'quota_exceeded') {
          refusals += 1;
          const wait = Math.min(Number(r.d?.retryAfterMs ?? 20), 20);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    })();
    const busy = median(await timeB());
    stop = true;
    await retrying;
    a.close();
    const idle2 = median(await timeB());

    expect(refusals).toBeGreaterThan(0);
    console.info(
      `BE-091 criterion 2: tenant B median ack ${idle1.toFixed(3)} ms, then ${busy.toFixed(3)} ms while tenant A was refused ${refusals} times, then ${idle2.toFixed(3)} ms (${N} commits per run; one Node.js process, memory storage, loopback)`,
    );
    expect(busy).toBeLessThanOrEqual(Math.max(idle1, idle2) * 1.5 + 5);
  });

  it.skipIf(!process.env['DOCEDIT_LATENCY_RUN'])(
    'shows no difference in the acknowledgement of the other tenant between blocks with and without the first tenant retrying at its quota (interleaved blocks, bootstrap interval; set DOCEDIT_LATENCY_RUN=1 on a quiet machine)',
    async () => {
      // The runs above are taken one after the other, so a drift of the machine (other work, a
      // growing document) lands in the difference. Here tenant B commits in blocks of 25, strictly
      // alternating (idle, busy, busy, idle, ...: the order is reversed each pair, so a linear drift
      // cancels), while tenant A retries at its quota every 20 ms at most in the busy blocks and
      // sends nothing in the idle ones. The figure is the median of the busy block medians minus the
      // median of the idle block medians, with a 95 percent bootstrap interval over the blocks.
      const h = await node('memory');
      const content = documentWithRegions();
      const intro = insideAt(content['doc'], INTRO);
      const docA = await h.createDocument({ content });
      const tokenA = h.userToken({ [docA]: 'owner' });
      const b = await secondTenant(h);
      await putQuotas(h, { commitRate: 1 });

      const cb = await connect(h);
      await cb.hello(b.token);
      expect((await cb.open(1, b.doc)).t).toBe('ch.opened');
      const a = await connect(h);
      await a.hello(tokenA);
      await a.open(1, docA);
      expect((await a.submit(1, { base: 0, steps: [insertText(intro, 'a')] })).t).toBe('sync.ack');

      let refusals = 0;
      let retrying = false;
      let stop = false;
      let lastPing = 0;
      const loop = (async () => {
        while (!stop) {
          if (!retrying) {
            // A silent session is closed after two heartbeat intervals: a ping now and then.
            if (Date.now() - lastPing >= 500) {
              lastPing = Date.now();
              a.send({ t: 'ping' });
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
            continue;
          }
          const r = await a.submit(1, { base: 1, steps: [insertText(intro, 'a')] });
          if (r.t === 'sync.reject' && r.d?.code === 'quota_exceeded') {
            refusals += 1;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(Number(r.d?.retryAfterMs ?? 20), 20)),
            );
          }
        }
      })();

      let base = 0;
      const block = async (): Promise<number> => {
        const out: number[] = [];
        for (let i = 0; i < 25; i += 1) {
          const t0 = performance.now();
          const r = await cb.submit(1, { base, steps: [insertText(intro, 'x')] });
          out.push(performance.now() - t0);
          expect(r.t).toBe('sync.ack');
          base += 1;
        }
        return median(out);
      };
      for (let i = 0; i < 4; i += 1) await block(); // warm-up, not recorded

      const idle: number[] = [];
      const busy: number[] = [];
      const PAIRS = 20;
      for (let p = 0; p < PAIRS; p += 1) {
        for (const phase of p % 2 === 0
          ? (['idle', 'busy'] as const)
          : (['busy', 'idle'] as const)) {
          retrying = phase === 'busy';
          if (retrying) await new Promise((resolve) => setTimeout(resolve, 30));
          (phase === 'busy' ? busy : idle).push(await block());
        }
      }
      stop = true;
      await loop;

      const diff = median(busy) - median(idle);
      // Bootstrap: resample the blocks of each condition with replacement.
      let seed = 0x2f6e2b1;
      const rand = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const draw = (xs: number[]): number[] => xs.map(() => xs[Math.floor(rand() * xs.length)]!);
      const diffs: number[] = [];
      for (let i = 0; i < 2000; i += 1) diffs.push(median(draw(busy)) - median(draw(idle)));
      diffs.sort((x, y) => x - y);
      const lo = diffs[Math.floor(0.025 * diffs.length)]!;
      const hi = diffs[Math.floor(0.975 * diffs.length)]!;

      expect(refusals).toBeGreaterThan(0);
      console.info(
        `BE-091 criterion 2 (interleaved): tenant B block median ack ${median(idle).toFixed(3)} ms idle, ${median(busy).toFixed(3)} ms while tenant A retried (${PAIRS} pairs of 25 commits, ${refusals} refusals of A); difference ${diff.toFixed(3)} ms, 95% bootstrap interval ${lo.toFixed(3)} to ${hi.toFixed(3)} ms`,
      );
      // On a quiet machine the whole interval must lie below 5 ms; the bound is a test setting, not a
      // figure of the specification. On a machine shared with other work the interval is wider than
      // that (2026-11-26: -15.6 to 27.1 ms with block medians near 48 ms), which is why the test is
      // off unless asked for.
      expect(hi).toBeLessThan(5);
    },
    240_000,
  );
});
