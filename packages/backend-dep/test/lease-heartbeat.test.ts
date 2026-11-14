// The heartbeats of a lease held through backend-dep's leases port (PRO-097 criterion 3; 07 §10):
// acquire starts them, each one carries the entity tag of the latest response, release ends them,
// and a refused heartbeat, a missing clock or the eight-hour maximum end the keeping. The REST calls
// are recorded by a fake fetch and time is virtual, so the schedule is exact. Node.js only.
import { describe, expect, it } from 'vitest';
import { createReviewPorts, type LeaseClock } from '../src/review.ts';
import { RestClient } from '../src/rest.ts';
import type { Platform, ResponseLike } from '../src/platform.ts';
import { VirtualClock } from './support/virtual-time.ts';

const DOC = 'doc-1';
const REGION = 'region-1';
/** The default lease expiry of 07 §10 (five minutes). */
const LEASE_MS = 5 * 60 * 1000;
/** The maximum total length of a lease (07 §10: eight hours). */
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
/** The clock's epoch in Unix milliseconds (`VirtualClock` counts from here). */
const EPOCH_MS = 1_700_000_000_000;

interface Call {
  method: string;
  ifMatch: string | undefined;
  /** Virtual milliseconds since the clock started. */
  at: number;
}

interface Options {
  /** Answer a heartbeat with 412, as a server does for a stale entity tag. */
  refuseHeartbeat?: boolean;
  /** Answer the release with 412. */
  refuseRelease?: boolean;
  /** Pass a clock to the ports (the backend does). */
  withClock?: boolean;
}

function harness(opts: Options = {}) {
  const vc = new VirtualClock(7);
  const p = vc.platform();
  const calls: Call[] = [];
  let version = 0;
  let etag = '';
  const now = () => EPOCH_MS + vc.elapsed;

  const lease = () => ({
    id: 'lease-1',
    holder: 'user-1',
    expiresAt: new Date(now() + LEASE_MS).toISOString(),
  });
  const reply = (status: number, body: unknown, tag: string): ResponseLike => ({
    status,
    headers: { get: (name: string) => (name === 'etag' && tag !== '' ? tag : null) },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });

  const fetch = async (
    _url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) => {
    const method = init?.method ?? 'GET';
    const ifMatch = init?.headers?.['if-match'];
    calls.push({ method, ifMatch, at: vc.elapsed });
    if (method === 'POST') {
      version += 1;
      etag = `"v${version}"`;
      return reply(201, lease(), etag);
    }
    if (method === 'PUT') {
      if (opts.refuseHeartbeat || ifMatch !== etag) return reply(412, {}, '');
      version += 1;
      etag = `"v${version}"`;
      return reply(200, lease(), etag);
    }
    if (method === 'DELETE') {
      if (opts.refuseRelease) return reply(412, {}, '');
      return reply(204, undefined, '');
    }
    throw new Error(`unexpected ${method}`);
  };

  const client = new RestClient('https://dep.test/api', { fetch } as unknown as Platform, {
    token: async () => 'secret-token',
    renew: async () => 'renewed-token',
  });

  /* A LeaseClock over the virtual timers, as backend-dep builds one from its Timers. */
  const armed = new Map<number, unknown>();
  let keys = 0;
  const clock: LeaseClock = {
    set: (fn, ms) => {
      const key = ++keys;
      armed.set(
        key,
        p.setTimeout(() => {
          armed.delete(key);
          fn();
        }, ms),
      );
      return key;
    },
    clear: (key) => {
      if (key === null || key === undefined) return;
      const handle = armed.get(key);
      if (handle === undefined) return;
      armed.delete(key);
      p.clearTimeout(handle);
    },
    now: () => p.now(),
  };

  const ports = createReviewPorts({
    rest: async () => client,
    ...(opts.withClock === false ? {} : { clock }),
  });
  const puts = () => calls.filter((c) => c.method === 'PUT');
  return { vc, calls, ports, puts };
}

describe('lease heartbeats (PRO-097 criterion 3; 07 §10)', () => {
  it('acquire starts heartbeats at half the remaining time, each with the latest entity tag, until release', async () => {
    const h = harness();
    await h.ports.leases.acquire(DOC, REGION);
    expect(h.calls.map((c) => c.method)).toEqual(['POST']);

    await h.vc.advance(LEASE_MS / 2 - 1);
    expect(h.puts()).toHaveLength(0);
    await h.vc.advance(1);
    expect(h.puts()).toHaveLength(1);
    expect(h.puts()[0]!.ifMatch).toBe('"v1"');

    // The first heartbeat extended the lease by LEASE_MS, so the next is due half of it later,
    // and it carries the entity tag that heartbeat returned.
    await h.vc.advance(LEASE_MS / 2);
    expect(h.puts()).toHaveLength(2);
    expect(h.puts()[1]!.ifMatch).toBe('"v2"');

    await h.ports.leases.release(DOC, REGION, { ifMatch: '"v3"' });
    expect(h.calls.at(-1)!.method).toBe('DELETE');
    const sent = h.puts().length;
    await h.vc.advance(EIGHT_HOURS_MS / 100);
    expect(h.puts()).toHaveLength(sent);
    expect(h.vc.armed).toBe(0);
  });

  it('ends the keeping when the server refuses a heartbeat, and leaves no timer', async () => {
    const h = harness({ refuseHeartbeat: true });
    await h.ports.leases.acquire(DOC, REGION);
    await h.vc.advance(LEASE_MS);
    expect(h.puts()).toHaveLength(1);
    expect(h.vc.armed).toBe(0);
    await h.vc.advance(LEASE_MS * 4);
    expect(h.puts()).toHaveLength(1);
  });

  it('sends no heartbeat when the ports have no clock; explicit heartbeat calls still work', async () => {
    const h = harness({ withClock: false });
    await h.ports.leases.acquire(DOC, REGION);
    await h.vc.advance(LEASE_MS * 2);
    expect(h.puts()).toHaveLength(0);
    expect(h.vc.armed).toBe(0);
    await h.ports.leases.heartbeat(DOC, REGION, { ifMatch: '"v1"' });
    expect(h.puts()).toHaveLength(1);
  });

  it('stops heartbeating at the eight-hour maximum of the lease', async () => {
    const h = harness();
    await h.ports.leases.acquire(DOC, REGION);
    await h.vc.advance(EIGHT_HOURS_MS + LEASE_MS);
    const puts = h.puts();
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.at(-1)!.at).toBeLessThan(EIGHT_HOURS_MS);
    expect(h.vc.armed).toBe(0);
  });

  it('keeps the lease alive again when the release is refused', async () => {
    const h = harness({ refuseRelease: true });
    await h.ports.leases.acquire(DOC, REGION);
    const err = await h.ports.leases.release(DOC, REGION).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    await h.vc.advance(LEASE_MS / 2);
    expect(h.puts()).toHaveLength(1);
    expect(h.puts()[0]!.ifMatch).toBe('"v1"');
  });
});
