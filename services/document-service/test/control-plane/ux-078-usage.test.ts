// UX-078 criterion 2: `GET /usage` answers one figure per quota dimension for a UTC calendar month
// (owner decision 69), with no content and no personal data. The unit part uses a fake clock; the
// composed part starts the service with its real data plane, opens sockets and reads the peaks over
// HTTP with the service key and with a user token. Test values only.
import { afterEach, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { LiveQuotas } from '../../src/control-plane/live-quotas.ts';
import { UsagePeaks, UsageService } from '../../src/control-plane/usage.ts';
import { MemoryQuotaStore } from '../../src/control-plane/quotas.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const JUNE_10 = Date.UTC(2026, 5, 10, 12);
const JULY_2 = Date.UTC(2026, 6, 2, 9);
const FIGURES = [
  'commitRate',
  'connections',
  'exportConcurrency',
  'exportMinutes',
  'month',
  'openDocuments',
  'roomCpuBudget',
  'storage',
];

describe('the usage figures (unit)', () => {
  it('keeps the largest value of the month for each tenant, and starts again in the next month', async () => {
    let now = JUNE_10;
    const peaks = new UsagePeaks(() => now);
    const quotas = new MemoryQuotaStore(() => true);
    const gate = new LiveQuotas({
      quotas: { get: (t) => quotas.get(t) },
      usage: peaks,
      now: () => now,
      windowMs: 60_000,
      countRetryMs: 1_000,
    });
    for (const doc of ['a', 'b', 'c']) expect(gate.admitDocument('t1', doc).ok).toBe(true);
    gate.closeDocument('t1', 'c');
    for (let i = 0; i < 4; i++) expect(gate.admitConnection('t1').ok).toBe(true);
    for (let i = 0; i < 4; i++) gate.releaseConnection('t1');
    expect(gate.admitConnection('t1').ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(gate.admitCommit('t1').ok).toBe(true);
    gate.chargeCpu('t1', 30);
    gate.chargeCpu('t1', 12);
    expect(gate.admitConnection('t2').ok).toBe(true);

    const usage = new UsageService({
      peaks,
      now: () => now,
      storedBytes: async (t) => (t === 't1' ? 4096 : 0),
      minutesUsed: async (t, at) => (t === 't1' && at === Date.UTC(2026, 5, 1) ? 90.2 : 0),
    });
    const june = await usage.read('t1');
    expect(june).toEqual({
      month: '2026-06',
      connections: 4,
      openDocuments: 3,
      commitRate: 5,
      roomCpuBudget: 42,
      storage: 4096,
      exportConcurrency: 0,
      exportMinutes: 91,
    });
    expect((await usage.read('t2')).connections).toBe(1);
    expect((await usage.read('t3')).connections).toBe(0);

    // A later month shows its own figures, and the earlier month is still readable.
    now = JULY_2;
    expect(gate.admitConnection('t1').ok).toBe(true);
    const july = await usage.read('t1');
    expect(july.month).toBe('2026-07');
    expect(july.connections).toBe(2);
    expect(july.exportMinutes).toBe(0);
    expect((await usage.read('t1', '2026-06')).connections).toBe(4);
    expect((await usage.read('t1', '2026-06')).exportMinutes).toBe(91);
  });

  it('keeps the last storage level of an earlier month, and refuses a month that is not YYYY-MM', async () => {
    let now = JUNE_10;
    const peaks = new UsagePeaks(() => now);
    peaks.level('t1', 'storage', 500);
    peaks.level('t1', 'storage', 300);
    peaks.peak('t1', 'exportConcurrency', 2);
    peaks.peak('t1', 'exportConcurrency', 1);
    peaks.peak('t1', 'exportConcurrency', -4);
    peaks.peak('t1', 'exportConcurrency', Number.NaN);
    now = JULY_2;
    const usage = new UsageService({ peaks, now: () => now, storedBytes: async () => 9000 });
    const june = await usage.read('t1', '2026-06');
    expect(june.storage).toBe(300);
    expect(june.exportConcurrency).toBe(2);
    expect((await usage.read('t1')).storage).toBe(9000);
    await expect(usage.read('t1', '2026-13')).rejects.toThrow(RangeError);
    await expect(usage.read('t1', 'June')).rejects.toThrow(RangeError);
  });
});

describe('GET /usage in the composed service', () => {
  const clients: DepClient[] = [];
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.terminate();
    for (const h of harnesses.splice(0)) await h.close();
  });

  it('reads the peaks of this month with the service key, refuses a user token, and carries only the figures', async () => {
    const h = await startHarness('memory', {
      config: { testMode: true, environment: 'test' },
      realDataPlane: true,
    });
    harnesses.push(h);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const token = h.userToken({ [doc]: 'owner' });
    for (let i = 0; i < 2; i++) {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(token)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).not.toBe('error');
    }

    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const read = await h.call('GET', '/v1/usage', { token: h.apiKey });
    expect(read.status, read.text).toBe(200);
    expect(Object.keys(read.json).sort()).toEqual(FIGURES);
    expect(read.json.month).toBe(month);
    expect(read.json.connections).toBeGreaterThanOrEqual(2);
    expect(read.json.openDocuments).toBe(1);
    for (const key of FIGURES.filter((k) => k !== 'month'))
      expect(Number.isInteger(read.json[key]) && read.json[key] >= 0, key).toBe(true);
    // No identifier of a document or a user is in the answer.
    expect(read.text).not.toContain(doc);
    expect(read.headers.get('cache-control')).toBe('no-store');

    const named = await h.call('GET', `/v1/usage?month=${month}`, { token: h.apiKey });
    expect(named.json).toEqual(read.json);
    const earlier = await h.call('GET', '/v1/usage?month=2020-01', { token: h.apiKey });
    expect(earlier.status).toBe(200);
    expect(earlier.json).toEqual({
      month: '2020-01',
      connections: 0,
      openDocuments: 0,
      commitRate: 0,
      roomCpuBudget: 0,
      storage: earlier.json.storage,
      exportConcurrency: 0,
      exportMinutes: 0,
    });

    for (const bad of ['?month=2026-13', '?month=June', '?month=2026-01&month=2026-02', '?x=1']) {
      const r = await h.call('GET', `/v1/usage${bad}`, { token: h.apiKey });
      expect(r.status, bad).toBe(400);
    }
    const refused = await h.call('GET', '/v1/usage', { token });
    expect(refused.status).toBe(403);
  });
});
