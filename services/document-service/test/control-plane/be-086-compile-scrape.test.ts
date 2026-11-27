/**
 * BE-086 criterion 1, the compile part, on a running node: the full service with the real data
 * plane and memory storage is driven over a real WebSocket (a cold open, a commit, a rejected
 * commit) and by one export job that compiles (a stand-in compile handler, as in exp-123). Then
 * `/metrics` is scraped with the metrics token. Every family of 06 §11 must be declared, the
 * compile-time family (`docedit_tenant_compile_seconds_total`, declared only after a compile) among
 * them, and that family must carry the tenant label.
 *
 * The catch-up and rebase families are declared on the node without traffic in this test; their
 * call sites and values are tested in `src/data-plane/metrics.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cdmSchema } from '@docedit/model/prosemirror';
import { DepClient, insertText } from '../data-plane/client.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const METRICS_TOKEN = 'be-086-compile-token';
const INTRO = 'pIntro0000000001';
const COMPILE_MS = 30;
const CANARY = 'canary-be086-document-text';

/** The position just inside the paragraph with this identifier. */
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

/** The families a 06 §11 scrape must declare, with the name each one has on this node. */
const REQUIRED_FAMILIES = [
  'dep_ack_latency_ms',
  'dep_persist_batch_commits',
  'dep_persist_latency_ms',
  'dep_commits_rebased_total',
  'dep_rejections_total',
  'dep_open_rooms',
  'dep_room_memory_max_bytes',
  'dep_send_queue_bytes',
  'dep_catch_up_commits',
  'dep_cold_open_ms',
  'docedit_jobs',
  'docedit_tenant_compile_seconds_total',
];

const clients: DepClient[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const h of harnesses.splice(0)) await h.close();
});

describe('a running node declares the compile time after a compile (BE-086 criterion 1)', () => {
  it('declares every listed family, the compile time with the tenant label, after one export', async () => {
    let h: Harness | undefined = undefined;
    // A stand-in compile: it writes the output and the log, as the export handler of EXP-123 does.
    const exportHandler: JobHandler = async (job) => {
      // The meter adds nothing for a compile of zero milliseconds, and the clock counts whole
      // milliseconds, so a stand-in that returns at once (as it does on a fast Linux runner) never
      // declares the family. A real compile takes longer; this one takes a few milliseconds too.
      await new Promise((resolve) => setTimeout(resolve, COMPILE_MS));
      await h!.service.assets.putExport(
        job.tenant,
        job.id,
        'output.pdf',
        Buffer.from('%PDF-1.7 test'),
        'application/pdf',
      );
      await h!.service.assets.putExport(
        job.tenant,
        job.id,
        'compile.log',
        Buffer.from('compile log'),
        'text/plain',
      );
      return {
        output: 'output.pdf',
        pages: 1,
        layout: null,
        converged: true,
        log: 'compile.log',
        diagnostics: [],
      };
    };
    h = await startHarness('memory', {
      config: { testMode: true, environment: 'test', metricsToken: METRICS_TOKEN, jobIdleMs: 20 },
      realDataPlane: true,
      jobHandlers: { export: exportHandler },
    });
    harnesses.push(h);

    const doc = await h.createDocument({ content: documentWithRegions() });
    const owner = h.userToken({ [doc]: 'owner' });

    const intro = insideAt(documentWithRegions()['doc'], INTRO);
    const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    clients.push(c);
    expect((await c.hello(owner)).t).toBe('welcome');
    expect((await c.open(1, doc)).t).toBe('ch.opened');
    expect((await c.submit(1, { base: 0, steps: [insertText(intro, CANARY)] })).t).toBe('sync.ack');
    expect((await c.submit(1, { base: 1, steps: [insertText(999_999, 'bad')] })).t).toBe(
      'sync.reject',
    );

    const exported = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: owner,
      body: { target: 'pdf' },
    });
    expect(exported.status).toBe(202);
    const jobId = exported.json.id as string;
    let state = '';
    for (let i = 0; i < 300 && state !== 'completed'; i++) {
      state = (await h.call('GET', `/v1/exports/${jobId}`, { token: owner })).json?.state;
      if (state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state).toBe('completed');

    // The compile is metered when the job ends; the scrape is read once the family is declared.
    let text = '';
    for (let i = 0; i < 100; i++) {
      const r = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
      expect(r.status).toBe(200);
      text = String((r as unknown as { text?: string }).text ?? '');
      if (text.includes('# TYPE docedit_tenant_compile_seconds_total ')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const declared = new Set([...text.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]!));
    expect(REQUIRED_FAMILIES.filter((f) => !declared.has(f))).toEqual([]);

    const compile = text
      .split('\n')
      .filter((l) => l.startsWith('docedit_tenant_compile_seconds_total{'));
    expect(compile.length).toBeGreaterThan(0);
    expect(compile.every((l) => l.includes(`tenant="${h!.tenant}"`))).toBe(true);
    // The scrape carries no document text and no token (BE-086 criterion 4).
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(doc);
  });
});
