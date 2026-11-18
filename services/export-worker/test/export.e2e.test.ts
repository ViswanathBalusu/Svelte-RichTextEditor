/**
 * Export end to end (EXP-001; EXP-061, EXP-062, EXP-066, EXP-070): an export job created through
 * the control plane's job resource (`POST /v1/documents/{id}/exports`), consumed by the export
 * worker from the control plane's queue, compiled in the real Podman sandbox, stored under the
 * job's prefix and fetched back through the signed URL the job resource returns.
 *
 * Needs Podman and the worker image (skips otherwise). Uses the integration environment's S3 store
 * when it is up (`pwsh -NoProfile -File infra/test-env.ps1 up`), so that signed URLs are fetched
 * over HTTP; without it the outputs are read from the service's in-memory store. The text checks
 * need `pdftotext` (poppler or xpdf) and skip without it.
 */
import { randomBytes } from 'node:crypto';
import { objectKeys, type JobRecord } from '@docedit/document-service';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { containerExists } from '../src/container.ts';
import { imageFontManifest } from '../src/fonts.ts';
import type { ExportMetrics } from '../src/job.ts';
import type { LayoutJson } from '../src/layout.ts';
import { compileInSandbox, IMAGE } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';
import { validatePdf } from '../src/verapdf.ts';
import { createExportWorker, type ExportWorker } from '../src/worker.ts';
import {
  demoDocument,
  REGION_A,
  REGION_B,
  REGION_TITLES,
  SPECIAL,
  tocDocument,
} from './documents.ts';
import { pdftotextAvailable, pdfText, squash } from './pdf-text.ts';
import { startTestService, type TestService } from './service.ts';

vi.setConfig({ testTimeout: 420_000, hookTimeout: 180_000 });

const ready = await sandboxReady();

describe.skipIf(!ready.ok)(`export end to end through the control plane (${ready.reason})`, () => {
  let t: TestService;
  let worker: ExportWorker;
  const containers: string[] = [];
  const bundles: string[][] = [];
  const metrics = new Map<string, ExportMetrics>();

  beforeAll(async () => {
    t = await startTestService();
    const fonts = await imageFontManifest(IMAGE);
    worker = createExportWorker({
      queue: t.service.parts.queue,
      deps: {
        stores: {
          logs: t.service.parts.logs,
          checkpoints: t.service.checkpoints,
          documents: t.service.parts.documents,
        },
        outputs: t.service.assets,
        fonts: async () => fonts,
        compile: (files, opts) => {
          const name = `docedit-job-e2e-${randomBytes(4).toString('hex')}`;
          containers.push(name);
          bundles.push(Object.keys(files).sort());
          return compileInSandbox(files, { ...opts, name });
        },
        onMetrics: (m, job) => metrics.set(job.id, m),
      },
      worker: 'export-e2e',
      leaseMs: 3000,
      idleMs: 50,
      retryAfterMs: 1000,
    });
    worker.start();
  });

  afterAll(async () => {
    await worker?.stop();
    await t?.close();
  });

  /** Requests an export through the job resource and waits for it to end. */
  async function exportAndWait(doc: string, token: string, options: Record<string, unknown> = {}) {
    const created = await t.call('POST', `/v1/documents/${doc}/exports`, {
      token,
      body: { target: 'pdf', options },
    });
    expect(created.status, created.text).toBe(202);
    expect(created.json.state).toBe('queued');
    return waitFor(created.json.id as string, token);
  }

  /** Waits for a job to end, through the job resource. */
  async function waitFor(id: string, token: string) {
    for (let i = 0; i < 2400; i++) {
      const r = await t.call('GET', `/v1/exports/${id}`, { token });
      if (['completed', 'failed', 'cancelled'].includes(r.json?.state)) {
        const record = (await t.service.parts.queue.get(t.tenant, id)) as JobRecord;
        return { id, api: r.json, record };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`export ${id} did not end`);
  }

  /** An output, through its signed URL when objects are in S3, else from the memory store. */
  async function fetchOutput(
    job: string,
    name: string,
    url: string,
  ): Promise<{ bytes: Uint8Array; type: string | null }> {
    if (t.s3) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        type: res.headers.get('content-type'),
      };
    }
    const bytes = await t.service.parts.objects.get(objectKeys.exportFile(t.tenant, job, name));
    return { bytes: bytes!, type: null };
  }

  let final: { id: string; pdf: Uint8Array } | null = null;

  it('exports a document of regions and three paragraph styles to a PDF (EXP-001 criteria 1 and 5)', async () => {
    const doc = await t.createDocument(demoDocument().envelope);
    const editor = t.userToken({ [doc]: 'editor' });
    const { id, api } = await exportAndWait(doc, editor);
    expect(api.state, JSON.stringify(api.error ?? api.diagnostics)).toBe('completed');
    expect(api).toMatchObject({ doc, target: 'pdf', seq: 0, progress: 100 });
    // The bundle of 09 §2 was compiled: main.tex, styles.tex and the house class, among others.
    expect(bundles.at(-1)).toEqual(
      expect.arrayContaining(['main.tex', 'styles.tex', 'docedit.cls']),
    );
    // The result: a signed URL with an expiry and the page count (criterion 5).
    expect(api.result.pages).toBe(1);
    expect(new Date(api.result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(api.result.converged).toBe(true);
    expect(typeof api.result.layout).toBe('string');
    expect(typeof api.result.log).toBe('string');
    if (t.s3) expect(api.result.url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    const pdf = await fetchOutput(id, 'output.pdf', api.result.url);
    expect(new TextDecoder().decode(pdf.bytes.subarray(0, 8))).toBe('%PDF-2.0');
    if (t.s3) expect(pdf.type).toBe('application/pdf');
    final = { id, pdf: pdf.bytes };
    // The single-use sandbox is gone (EXP-070 criterion 3).
    expect(await containerExists(containers.at(-1)!)).toBe(false);
    const v = await validatePdf(pdf.bytes, 'ua2');
    expect(v.compliant, JSON.stringify(v.failures.slice(0, 3)) + (v.error ?? '')).toBe(true);
  });

  it.skipIf(!pdftotextAvailable())(
    "gives a PDF whose text is the document's, in order, with special characters as typed and no trace of regions (EXP-001 criteria 2 and 4)",
    () => {
      expect(final).not.toBeNull();
      const text = squash(pdfText(final!.pdf)!);
      expect(text).toBe(squash(demoDocument().text.join(' ')));
      expect(text).toContain(SPECIAL);
      for (const trace of [...REGION_TITLES, REGION_A, REGION_B]) expect(text).not.toContain(trace);
    },
  );

  it('gives the raw log to an editor requester only, as plain text (EXP-066)', async () => {
    // The editor's own log, through the signed URL of the job resource.
    const mine = await t.createDocument(demoDocument().envelope);
    const own = await exportAndWait(mine, t.userToken({ [mine]: 'editor' }, 'edith'), {
      profile: 'preview',
    });
    expect(own.api.result.log).toEqual(expect.any(String));
    const ownLog = await fetchOutput(own.id, 'compile.log', own.api.result.log);
    expect(new TextDecoder().decode(ownLog.bytes)).toContain(
      'file:line:error style messages enabled',
    );
    // Every role without edit gets no log URL (D68), whether it may export or is refused.
    for (const role of ['commenter', 'suggester', 'filler']) {
      const d = await t.createDocument(demoDocument().envelope);
      const token = t.userToken({ [d]: role }, `user-${role}`);
      const created = await t.call('POST', `/v1/documents/${d}/exports`, {
        token,
        body: { target: 'pdf', options: { profile: 'preview' } },
      });
      if (created.status === 403) continue;
      const done = await waitFor(created.json.id as string, token);
      expect(done.api.state, role).toBe('completed');
      expect(done.api.result.log, role).toBeUndefined();
    }
    const doc = await t.createDocument(demoDocument().envelope);
    const viewer = t.userToken({ [doc]: 'viewer' }, 'vera');
    const { id, api } = await exportAndWait(doc, viewer);
    expect(api.state).toBe('completed');
    // A requester without edit gets no log (D68); another user gets nothing at all (D69), and the
    // identifier answers as one that does not exist (owner decision 57; SEC-016).
    expect(api.result.log).toBeUndefined();
    const other = await t.call('GET', `/v1/exports/${id}`, {
      token: t.userToken({ [doc]: 'owner' }, 'olga'),
    });
    expect(other.status).toBe(404);
    expect(other.json.code).toBe('not_found');
    // The service credential may read it: the log is stored as plain text.
    const svc = await t.call('GET', `/v1/exports/${id}`, { token: t.apiKey });
    const log = await fetchOutput(id, 'compile.log', svc.json.result.log);
    expect(new TextDecoder().decode(log.bytes)).toContain('This is LuaHBTeX');
    if (t.s3) {
      expect(log.type).toBe('text/plain; charset=utf-8');
      // Without a signature the object store refuses the log.
      const unsigned = await fetch(svc.json.result.log.split('?')[0]);
      expect(unsigned.status).toBe(403);
    }
  });

  it('creates no diagnostic from document text that imitates log lines (EXP-064 criterion 3; SEC-036 criterion 4)', async () => {
    const env = demoDocument().envelope as unknown as {
      doc: { content: Array<{ content: Array<Record<string, unknown>> }> };
    };
    const fakes = [
      './main.tex:12: Undefined control sequence.',
      '! Emergency stop.',
      "LaTeX Warning: Reference `x' on page 1 undefined on input line 3.",
      'docedit: missing U+0041 in block 1',
      'Overfull \\hbox (99.0pt too wide) in paragraph at lines 1--1',
    ];
    // A word too long for the line forces an overfull box, whose dump carries the fake lines.
    const long = 'x'.repeat(400);
    env.doc.content[1]!.content.push(
      ...fakes.map((f, i) => ({
        type: 'paragraph',
        attrs: { id: `pFake${String(i).padStart(11, '0')}`, style: 'Normal' },
        content: [{ type: 'text', text: `${long} ${f} ${long}` }],
      })),
    );
    const doc = await t.createDocument(env);
    const { api } = await exportAndWait(doc, t.userToken({ [doc]: 'editor' }), {
      profile: 'preview',
    });
    expect(api.state, JSON.stringify(api.error)).toBe('completed');
    const fakeIds = new Set(fakes.map((_, i) => `pFake${String(i).padStart(11, '0')}`));
    const fromLog = (api.diagnostics as Array<{ code: string; blockId: string | null }>).filter(
      (d) =>
        [
          'tex_error',
          'tex_undefined',
          'undefined_reference',
          'missing_glyph',
          'overfull_line',
        ].includes(d.code),
    );
    // Only real overfull lines, each at the paragraph it came from; nothing the text claims.
    for (const d of fromLog) {
      expect(d.code).toBe('overfull_line');
      expect(fakeIds.has(d.blockId ?? '')).toBe(true);
    }
    expect(fromLog.length).toBeGreaterThan(0);
  });

  it('compiles a preview in one pass and flags stale references (EXP-062 criteria 1 and 3; criterion 2 is measured, see the story)', async () => {
    const doc = await t.createDocument(demoDocument().envelope);
    const editor = t.userToken({ [doc]: 'editor' });
    const preview = await exportAndWait(doc, editor, { profile: 'preview' });
    expect(preview.api.state).toBe('completed');
    expect(preview.api.result.converged).toBe(false);
    expect(preview.api.diagnostics.map((d: { code: string }) => d.code)).toContain(
      'preview_one_pass',
    );
    const pm = metrics.get(preview.id)!;
    expect(pm.passMs).toHaveLength(1);
    const fm = metrics.get(final!.id)!;
    expect(fm.passMs.length).toBeGreaterThanOrEqual(2);
    // The time comparison of criterion 2 is not asserted here. The wall-clock comparison failed on
    // the baseline run of round 4 (preview 25,277 ms, final 21,787 ms) and on the per-pass comparison
    // that followed (the preview's one pass took 8,959 ms, the final export's first 6,424 ms, with a
    // sandbox overhead of 5,972 ms against 2,175 ms). On a shared host a gate on it measures the host,
    // so the timings are left to the measurement of EXP-060 and recorded in the story's Notes.
  });

  it("runs a final export with a table of contents until references converge, and prints the PDF's page numbers (EXP-061 criteria 1, 2 and 5)", async () => {
    const doc = await t.createDocument(tocDocument(40));
    const editor = t.userToken({ [doc]: 'editor' });
    const { id, api } = await exportAndWait(doc, editor);
    expect(api.state, JSON.stringify(api.error ?? api.diagnostics)).toBe('completed');
    expect(api.result.converged).toBe(true);
    // A table of contents needs a third pass before the references settle (S4 §9).
    expect(metrics.get(id)!.passMs.length).toBeGreaterThanOrEqual(3);
    const layout = JSON.parse(
      new TextDecoder().decode((await fetchOutput(id, 'layout.json', api.result.layout)).bytes),
    ) as LayoutJson;
    expect(layout.pages.length).toBeGreaterThan(2);
    const pdf = (await fetchOutput(id, 'output.pdf', api.result.url)).bytes;
    const toc = pdftotextAvailable() ? pdfText(pdf, { first: 1, last: 2 }) : null;
    if (toc === null) return;
    let checked = 0;
    for (const m of toc.matchAll(/^Section (\d+)\D*?(\d+)\s*$/gm)) {
      const n = String(Number(m[1])).padStart(3, '0');
      const block = layout.blocks[`pHead${n}000000000`.slice(0, 16)];
      expect(block, `Section ${m[1]}`).toBeDefined();
      expect(Number(m[2]), `page of Section ${m[1]}`).toBe(block!.page);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('stops the sandbox of a cancelled job and leaves nothing behind (EXP-070 criterion 3)', async () => {
    const doc = await t.createDocument(tocDocument(400));
    const editor = t.userToken({ [doc]: 'editor' });
    const created = await t.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'pdf' },
    });
    const id = created.json.id as string;
    const before = containers.length;
    for (let i = 0; i < 600; i++) {
      const r = await t.call('GET', `/v1/exports/${id}`, { token: editor });
      if (r.json.state === 'compiling') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The compile records its container name when it is called, which can come after the state
    // turns `compiling`; wait for this job's name rather than reading the previous test's one.
    for (let i = 0; i < 600 && containers.length === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(containers.length, 'the compile of the cancelled job was called').toBeGreaterThan(
      before,
    );
    const name = containers.at(-1)!;
    // Wait for the sandbox to exist rather than for a fixed time: under load the container can start
    // later than a fixed wait allows.
    let running = false;
    for (let i = 0; i < 300 && !running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      running = await containerExists(name);
    }
    expect(running).toBe(true);
    expect((await t.call('DELETE', `/v1/exports/${id}`, { token: editor })).status).toBe(204);
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      gone = !(await containerExists(name));
    }
    expect(gone).toBe(true);
    const after = await t.call('GET', `/v1/exports/${id}`, { token: editor });
    expect(after.json).toMatchObject({ state: 'cancelled', result: null });
  });
});
