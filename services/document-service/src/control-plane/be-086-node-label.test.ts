/**
 * BE-086 criterion 2 (lane V-BE-085-098): the control plane's per-tenant series carry the node
 * label as well as the tenant, and the tenant meter's reads keep their keys unchanged.
 */
import { describe, expect, it } from 'vitest';
import { DRIVERS, Metrics, TenantMeter } from './metrics.ts';

describe('control-plane series carry the node label (BE-086 criterion 2)', () => {
  it('labels every counter and gauge sample with the node and the tenant', async () => {
    const metrics = new Metrics({ node: 'node-a' });
    const meter = new TenantMeter(metrics);
    meter.add('tenant-x', DRIVERS.commits, 2);
    meter.add('tenant-x', DRIVERS.storedBytes, 10, { kind: 'checkpoint' });
    metrics.gauge('docedit_jobs', 'Jobs by kind.', async () => [
      { labels: { kind: 'export', tenant: 'tenant-x' }, value: 1 },
    ]);

    const text = await metrics.render();
    const lines = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(lines.length).toBe(3);
    for (const l of lines) {
      expect(l).toContain('node="node-a"');
      expect(l).toContain('tenant="tenant-x"');
    }
    expect(metrics.value(DRIVERS.commits, { tenant: 'tenant-x' })).toBe(2);
  });

  it('keeps the tenant read keys free of the node label', () => {
    const metrics = new Metrics({ node: 'node-a' });
    const meter = new TenantMeter(metrics);
    meter.add('tenant-y', DRIVERS.checkpoints, 3);
    meter.add('tenant-y', DRIVERS.storedBytes, 7, { kind: 'asset' });
    const read = meter.read('tenant-y');
    expect(read).toEqual({
      [DRIVERS.checkpoints]: 3,
      [`${DRIVERS.storedBytes}{kind=asset}`]: 7,
    });
  });

  it('refuses a bad base label name', () => {
    expect(() => new Metrics({ 'bad-name': 'x' })).toThrow(RangeError);
  });
});
