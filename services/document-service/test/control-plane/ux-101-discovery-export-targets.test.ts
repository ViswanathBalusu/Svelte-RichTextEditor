// UX-101 (ADR 0382, option 1): the discovery document carries `exportTargets` when the `exports`
// feature is announced, from the service's configuration, and does not carry it otherwise. The
// service refuses a target that is not in the list, so the list a client reads is the list the
// service enforces.
import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './support.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('discovery announces the export targets (UX-101)', () => {
  it('lists the configured targets when exports is announced', async () => {
    h = await startHarness('memory', {
      config: { features: ['presence', 'regions', 'exports'], exportTargets: ['pdf', 'tex'] },
    });
    const r = await h.call('GET', '/.well-known/dep');
    expect(r.status).toBe(200);
    expect(r.json.features).toContain('exports');
    expect(r.json.exportTargets).toEqual(['pdf', 'tex']);
  });

  it('two deployments with different lists announce different lists', async () => {
    h = await startHarness('memory', {
      config: { features: ['presence', 'regions', 'exports'], exportTargets: ['pdf'] },
    });
    expect((await h.call('GET', '/.well-known/dep')).json.exportTargets).toEqual(['pdf']);
  });

  it('has no exportTargets member without the exports feature', async () => {
    h = await startHarness('memory');
    const r = await h.call('GET', '/.well-known/dep');
    expect(r.json.features).not.toContain('exports');
    expect(Object.keys(r.json)).not.toContain('exportTargets');
  });
});
