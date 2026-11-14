// Queue depth in the scrape for autoscaling (BE-050 criterion 5; BE-065). `server.ts` registers the
// gauge `docedit_jobs` from `queue.depth()`; this test scrapes `/metrics` of a real service over
// HTTP (memory storage) and reads the samples back. The PostgreSQL `depth()` is run in
// test/control-plane/queue.test.ts, which skips without a database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/control-plane/support.ts';
import { EXPORT_KIND, EXPORT_PRIORITIES, PREVIEW_KIND } from './exports.ts';

const METRICS_TOKEN = 'metrics-scrape-test-token';
const LEASE = 60_000;

/**
 * The value of one `docedit_jobs` sample in a scrape, or null when it is absent. The scrape also
 * carries base labels on every series (the `node` label of BE-086 criterion 2), so each line's
 * labels are parsed into a map, the base labels are dropped, and the rest must equal `labels`.
 */
const BASE_LABELS = new Set(['node']);
function sample(text: string, labels: Record<string, string>): number | null {
  const want = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const line of text.split('\n')) {
    const m = /^docedit_jobs\{([^}]*)\} (\S+)$/.exec(line.trim());
    if (m === null) continue;
    const got = [...(m[1] ?? '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)]
      .map((p): [string, string] => [p[1] ?? '', p[2] ?? ''])
      .filter(([k]) => !BASE_LABELS.has(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (got.length !== want.length) continue;
    if (!got.every(([k, v], i) => want[i]?.[0] === k && want[i]?.[1] === v)) continue;
    return Number(m[2]);
  }
  return null;
}

describe('queue depth in the metrics scrape (BE-050 criterion 5)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('memory', { config: { metricsToken: METRICS_TOKEN } });
  });

  afterAll(async () => {
    await h?.close();
  });

  const scrape = async (): Promise<string> => {
    const r = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
    expect(r.status).toBe(200);
    return r.text;
  };

  it('reports queued and running jobs per kind and priority, and changes with the queue', async () => {
    const before = await scrape();
    expect(
      sample(before, {
        kind: EXPORT_KIND,
        priority: String(EXPORT_PRIORITIES[EXPORT_KIND]),
        state: 'queued',
      }),
    ).toBeNull();

    const job = (kind: string) =>
      h.parts.queue.enqueue(h.tenant, {
        kind,
        doc: randomUUID(),
        payload: {},
        createdBy: 'system',
        priority: EXPORT_PRIORITIES[kind]!,
      });
    await job(EXPORT_KIND);
    await job(EXPORT_KIND);
    await job(PREVIEW_KIND);

    const queued = await scrape();
    expect(
      sample(queued, {
        kind: EXPORT_KIND,
        priority: String(EXPORT_PRIORITIES[EXPORT_KIND]),
        state: 'queued',
      }),
    ).toBe(2);
    expect(
      sample(queued, {
        kind: PREVIEW_KIND,
        priority: String(EXPORT_PRIORITIES[PREVIEW_KIND]),
        state: 'queued',
      }),
    ).toBe(1);

    // A worker claims the preview: it moves from queued to running in the next scrape.
    const claimed = await h.parts.queue.claim([PREVIEW_KIND], 'depth-test-worker', LEASE);
    expect(claimed?.kind).toBe(PREVIEW_KIND);
    const running = await scrape();
    expect(
      sample(running, {
        kind: PREVIEW_KIND,
        priority: String(EXPORT_PRIORITIES[PREVIEW_KIND]),
        state: 'running',
      }),
    ).toBe(1);
    // The kind keeps its series with a zero, so a drained queue reads as zero, not as absent.
    expect(
      sample(running, {
        kind: PREVIEW_KIND,
        priority: String(EXPORT_PRIORITIES[PREVIEW_KIND]),
        state: 'queued',
      }),
    ).toBe(0);
    expect(
      sample(running, {
        kind: EXPORT_KIND,
        priority: String(EXPORT_PRIORITIES[EXPORT_KIND]),
        state: 'queued',
      }),
    ).toBe(2);
  });

  it('is served without a token only as a refusal, so the depth stays behind the metrics credential', async () => {
    const refused = await h.call('GET', '/metrics');
    expect(refused.status).toBe(401);
    expect(refused.text).not.toContain('docedit_jobs');
  });
});
