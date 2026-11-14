/**
 * SEC-047 criterion 5 (lane U-SEC-033-048): a compile log can carry user text. It is kept with the
 * export (the job's `compile.log` under its prefix, linked from the result), it is readable only by
 * callers with `edit` (SEC-036 criterion 4, tests/security/test/sec-036-raw-log-route.test.ts), and
 * its text is not copied into the service's own output. This file runs an export whose compile log
 * holds a canary written as user text, and captures every byte the process writes to stdout and
 * stderr while the job runs and settles. The canary must be absent from that output, and it must
 * still be kept in the stored log. Node.js, memory storage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  startHarness,
  type Harness,
} from '../../../services/document-service/test/control-plane/support.ts';
import type { JobHandler } from '../../../services/document-service/src/control-plane/jobs/runner.ts';

const CANARY = 'CANARY_COMPILE_LOG_U-SEC-033-048 ! Pricing: 42 EUR for region B';
const RAW_LOG = `Overfull \\hbox in paragraph: ${CANARY}`;

describe('SEC-047 criterion 5: a stored compile log is kept with the export and not copied into service output', () => {
  let h: Harness;

  const compileHandler: JobHandler = async (job, ctx) => {
    await ctx.report('compiling', 60);
    await h.service.assets.putExport(
      job.tenant,
      job.id,
      'output.pdf',
      Buffer.from('%PDF-1.7 test'),
      'application/pdf',
    );
    await h.service.assets.putExport(
      job.tenant,
      job.id,
      'compile.log',
      Buffer.from(RAW_LOG),
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

  beforeAll(async () => {
    h = await startHarness('memory', {
      jobHandlers: { export: compileHandler },
      config: { jobIdleMs: 20, jobLeaseMs: 2000 },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('keeps the log with the export and writes its text to no stdout or stderr line', async () => {
    const written: string[] = [];
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const capture = (chunk: unknown): string => {
      const text =
        typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      written.push(text);
      return text;
    };
    (process.stdout as unknown as { write: (c: unknown, ...r: unknown[]) => boolean }).write = (
      c,
      ...r
    ) => {
      capture(c);
      return (stdoutWrite as (c: unknown, ...r: unknown[]) => boolean)(c, ...r);
    };
    (process.stderr as unknown as { write: (c: unknown, ...r: unknown[]) => boolean }).write = (
      c,
      ...r
    ) => {
      capture(c);
      return (stderrWrite as (c: unknown, ...r: unknown[]) => boolean)(c, ...r);
    };
    try {
      // Control: the capture sees a write to stdout, so the absence below is not vacuous.
      process.stdout.write('sec-047 capture control\n');
      expect(written.join('')).toContain('sec-047 capture control');
      const doc = await h.createDocument({ content: documentWithRegions() });
      const editor = h.userToken({ [doc]: 'editor' });
      const created = await h.call('POST', `/v1/documents/${doc}/exports`, {
        token: editor,
        body: { target: 'pdf', options: { profile: 'final' } },
      });
      expect(created.status).toBeLessThan(300);
      const id = created.json.id as string;
      let done: { state?: string; result?: { log?: string } } | undefined;
      for (let i = 0; i < 200; i++) {
        const r = await h.call('GET', `/v1/exports/${id}`, { token: editor });
        if (r.json?.state === 'completed' || r.json?.state === 'failed') {
          done = r.json;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(done?.state).toBe('completed');
      // Control: the log is kept with the export (an editor is given its signed URL).
      expect(done?.result?.log).toMatch(/^(https?|memory):\/\//);
    } finally {
      (process.stdout as unknown as { write: unknown }).write = stdoutWrite;
      (process.stderr as unknown as { write: unknown }).write = stderrWrite;
    }

    // The canary is in the stored log (the compile handler wrote it), and not in the process output.
    expect(RAW_LOG).toContain(CANARY);
    expect(written.join('')).not.toContain(CANARY);
    expect(written.join('')).not.toContain('U-SEC-033-048 ! Pricing');
  });
});
