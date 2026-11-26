// BE-051 criterion 4 in the composed service (lane w5): a compile that reports line-level layout for
// page-break reconciliation (`options.layout: "lines"`) is refused unless the tenant has enabled it;
// the setting is off by default, is per tenant, and is audited when it changes. Runs in memory and on
// PostgreSQL (a database of its own, dropped afterwards). The compile worker is a stub that counts
// the jobs it is given.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobFailure, type JobHandler } from '../../src/control-plane/jobs/runner.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`page-break reconciliation compiles are opt-in (${storage}; BE-051 criterion 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const compiled: Array<Record<string, unknown>> = [];
    const handler: JobHandler = async (job) => {
      compiled.push(job.payload['options'] as Record<string, unknown>);
      throw new JobFailure('compile_failed', 'The stub does not compile.');
    };

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        jobHandlers: { export: handler },
        config: { jobIdleMs: 20, jobLeaseMs: 2000 },
      });
    });
    afterAll(async () => {
      await h?.close();
    });

    const request = async (options: Record<string, unknown> | undefined) => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const token = h.userToken({ [doc]: 'editor' });
      return h.call('POST', `/v1/documents/${doc}/exports`, {
        token,
        body: options === undefined ? { target: 'pdf' } : { target: 'pdf', options },
      });
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    it.skipIf(skip)(
      'is off by default: a lines compile is refused and no job is queued',
      async () => {
        expect(await h.parts.tenantSettings!.get(h.tenant)).toEqual({
          pageBreakReconciliation: false,
        });
        const before = compiled.length;
        const r = await request({ profile: 'preview', layout: 'lines' });
        expect(r.status, r.text).toBe(403);
        expect(r.json.code).toBe('forbidden');
        await settle();
        expect(compiled.length).toBe(before);
        // The documents that were refused have no export job: none of them was created.
        expect(r.text).not.toContain('"state"');
      },
    );

    it.skipIf(skip)('accepts the other layout values and requests without the option', async () => {
      for (const options of [undefined, { profile: 'preview' }, { layout: 'blocks' }]) {
        const r = await request(options);
        expect(r.status, `${JSON.stringify(options)}: ${r.text}`).toBe(202);
      }
      const bad = await request({ layout: 'pages' });
      expect(bad.status).toBe(400);
    });

    it.skipIf(skip)(
      'accepts a lines compile once the tenant enables it, and refuses it again when switched off',
      async () => {
        await h.parts.tenantSettings!.set(h.tenant, 'operator', { pageBreakReconciliation: true });
        const on = await request({ profile: 'preview', layout: 'lines' });
        expect(on.status, on.text).toBe(202);
        await settle();
        expect(compiled.some((o) => o['layout'] === 'lines')).toBe(true);

        await h.parts.tenantSettings!.set(h.tenant, 'operator', { pageBreakReconciliation: false });
        const off = await request({ layout: 'lines' });
        expect(off.status, off.text).toBe(403);
        // Each change is audited with the previous and the new value, and a repeat is not.
        await h.parts.tenantSettings!.set(h.tenant, 'operator', { pageBreakReconciliation: false });
        const events = await h.parts.audit!.query(h.tenant, {
          kind: 'tenant_setting.changed',
          limit: 10,
        });
        expect(
          events.map(
            (e) =>
              (e.data['settings'] as { pageBreakReconciliation: boolean }).pageBreakReconciliation,
          ),
        ).toEqual([true, false]);
      },
    );

    it.skipIf(skip)("is per tenant: another tenant's setting is its own", async () => {
      const other = randomUUID();
      expect(await h.parts.tenantSettings!.get(other)).toEqual({ pageBreakReconciliation: false });
      await h.parts.registry.putTenant(other, 'BE-051 other tenant');
      await h.parts.tenantSettings!.set(other, 'operator', { pageBreakReconciliation: true });
      expect(await h.parts.tenantSettings!.pageBreakReconciliation(other)).toBe(true);
      expect(await h.parts.tenantSettings!.pageBreakReconciliation(h.tenant)).toBe(false);
    });
  });
}
