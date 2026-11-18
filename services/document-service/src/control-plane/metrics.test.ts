/**
 * The tenant meter's exposition (BE-085 criterion 2; ADR 0054): every sample of a tenant counter
 * carries the tenant label, and no document content, field value or token reaches a label or a value.
 * The commits are metered through the same proxy the service uses (`meteredLogs`), with a commit
 * whose text is a marker that must not appear in the scrape.
 */
import type { WriteRequest } from '@docedit/authority';
import { describe, expect, it } from 'vitest';
import { DRIVERS, Metrics, TenantMeter, meteredLogs } from './metrics.ts';
import type { DocRef, LogStore } from '../storage/types.ts';

const TENANT = 'tenant-meter';
const OTHER = 'tenant-other';
const DOC = '0190f0a0-0000-7000-8000-0000000000bb';
const MARKER = 'CONTENT-MARKER-7f3a';

/** A log store whose append succeeds and records nothing, so only the proxy is under test. */
function fakeLogs(): LogStore {
  const inner = {
    async append() {
      return { status: 'ok' };
    },
    async head() {
      return { seq: 0, incarnation: 'inc', epoch: 1 };
    },
  };
  return inner as unknown as LogStore;
}

/** A steps commit that carries the marker text, as a client would send it. */
function commitWith(text: string): WriteRequest {
  const commit = {
    seq: 1,
    kind: 'steps',
    steps: [
      {
        stepType: 'replace',
        from: 1,
        to: 1,
        slice: { content: [{ type: 'text', text }] },
      },
    ],
  };
  return { commits: [commit] } as unknown as WriteRequest;
}

function sampleLines(text: string): string[] {
  return text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
}

describe('tenant meter exposition (BE-085 criterion 2)', () => {
  it('labels every tenant sample with its tenant and nothing else but a kind, and holds no content', async () => {
    const metrics = new Metrics();
    const meter = new TenantMeter(metrics);
    const ref: DocRef = { tenant: TENANT, doc: DOC };
    const logs = meteredLogs(fakeLogs(), meter);
    await logs.append(ref, commitWith(MARKER), undefined);
    await logs.append(ref, commitWith(`${MARKER}-again`), undefined);
    // Other cost drivers, with and without a second label.
    meter.add(TENANT, DRIVERS.checkpoints, 1);
    meter.add(TENANT, DRIVERS.checkpointBytes, 4096);
    meter.add(TENANT, DRIVERS.storedBytes, 4096, { kind: 'checkpoint' });
    meter.add(OTHER, DRIVERS.commits, 5);

    const text = await metrics.render();
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(DOC);
    const lines = sampleLines(text);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, line).toMatch(/^docedit_tenant_[a-z_]+\{.*tenant="tenant-[a-z-]+"/);
      // The labels are the tenant and, for stored bytes, the kind only.
      const labels = /\{([^}]*)\}/.exec(line)?.[1] ?? '';
      for (const pair of labels.split(',')) expect(pair, line).toMatch(/^(tenant|kind)="[^"]*"$/);
    }
    expect(text).toContain(`${DRIVERS.commits}{tenant="${TENANT}"} 2`);
    expect(text).toContain(`${DRIVERS.payloadBytes}{tenant="${TENANT}"} `);
    expect(text).toContain(`${DRIVERS.commits}{tenant="${OTHER}"} 5`);
  });

  it('counts the whole commit as log bytes, more than its step payload, per tenant (BE-085 criterion 1)', async () => {
    const metrics = new Metrics();
    const meter = new TenantMeter(metrics);
    const logs = meteredLogs(fakeLogs(), meter);
    const req = commitWith('hello');
    await logs.append({ tenant: TENANT, doc: DOC }, req, undefined);
    const whole = Buffer.byteLength(JSON.stringify(req.commits[0]), 'utf8');
    const steps = Buffer.byteLength(
      JSON.stringify((req.commits[0] as unknown as { steps: unknown }).steps),
      'utf8',
    );
    const read = meter.read(TENANT);
    expect(read[DRIVERS.logBytes]).toBe(whole);
    expect(read[DRIVERS.payloadBytes]).toBe(steps);
    expect(whole).toBeGreaterThan(steps);
    expect(meter.read(OTHER)[DRIVERS.logBytes]).toBeUndefined();
  });

  it("reads one tenant's counters without another tenant's samples", () => {
    const metrics = new Metrics();
    const meter = new TenantMeter(metrics);
    meter.add(TENANT, DRIVERS.commits, 3);
    meter.add(OTHER, DRIVERS.commits, 9);
    expect(meter.read(TENANT)[DRIVERS.commits]).toBe(3);
    expect(meter.read(OTHER)[DRIVERS.commits]).toBe(9);
  });
});
