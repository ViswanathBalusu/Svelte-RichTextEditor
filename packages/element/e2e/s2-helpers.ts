/**
 * Helpers for the spike S2 tests (SPK-015): building policies, opening pages with them as response
 * headers, and collecting violations from the page (securitypolicyviolation events, recorded by
 * demo/spike-flags.ts), from the server (report-uri reports, which also cover workers) and the
 * requests a run made.
 */
import { type APIRequestContext, type Page } from '@playwright/test';
import { encodePolicy, harness } from './helpers.ts';

/** The strict baseline: no unsafe keyword, Trusted Types enforced, no policy name allowed. */
export const STRICT: Readonly<Record<string, string>> = {
  'default-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self'",
  'img-src': "'self'",
  'font-src': "'self'",
  'connect-src': "'self'",
  'worker-src': "'self'",
  'frame-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
  'object-src': "'none'",
  'require-trusted-types-for': "'script'",
  'trusted-types': "'none'",
  'report-uri': '{report}',
};

/** A policy from the baseline with directives replaced (null removes a directive). */
export function policy(changes: Record<string, string | null> = {}, base = STRICT): string {
  const merged: Record<string, string | null> = { ...base, ...changes };
  return Object.entries(merged)
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');
}

export interface Violation {
  directive: string;
  blocked: string;
  sample: string;
  source: string;
  target: string;
}

export interface Collected {
  dom: Violation[];
  reports: Array<{
    source: string | null;
    directive: string;
    blocked: string;
    sample: string;
    documentURI: string;
    sourceFile: string;
    line: string;
  }>;
  errors: string[];
}

export async function openS2(page: Page, run: string, csp: string, query = ''): Promise<void> {
  await page.goto(`/pages/s2.html?run=${run}&csp=${encodePolicy(csp)}${query}`);
  await page.waitForFunction(() =>
    document.querySelector('doc-editor')?.shadowRoot?.querySelector('.de-editing-surface'),
  );
  await page.evaluate(async () => {
    const el = document.querySelector('doc-editor') as unknown as { spike(): Promise<unknown> };
    (window as unknown as { h: unknown }).h = await el.spike();
  });
}

export async function collect(
  page: Page,
  request: APIRequestContext,
  run: string,
  settleMs = 700,
): Promise<Collected> {
  await page.waitForTimeout(settleMs);
  const local = await page.evaluate(() => {
    const s = (window as unknown as { __spike: { violations: Violation[]; errors: string[] } })
      .__spike;
    return { dom: s.violations, errors: s.errors };
  });
  const raw = (await (await request.get(`/csp-reports?run=${run}`)).json()) as Array<{
    source: string | null;
    body: { 'csp-report'?: Record<string, string> } | unknown;
  }>;
  const reports = raw.map((r) => {
    const body = (r.body as { 'csp-report'?: Record<string, string> })['csp-report'] ?? {};
    return {
      source: r.source,
      directive: body['effective-directive'] ?? body['violated-directive'] ?? '',
      blocked: body['blocked-uri'] ?? '',
      sample: body['script-sample'] ?? '',
      documentURI: body['document-uri'] ?? '',
      sourceFile: body['source-file'] ?? '',
      line: body['line-number'] ?? '',
    };
  });
  return { ...local, reports };
}

/** A short, stable summary of violations: directive and what was blocked. */
export function summary(c: Collected): string[] {
  const seen = new Set<string>();
  for (const v of c.dom) seen.add(`page:${v.directive}:${v.blocked || '-'}`);
  for (const r of c.reports) seen.add(`${r.source ?? '?'}:${r.directive}:${r.blocked || '-'}`);
  return [...seen].sort();
}

export async function requests(request: APIRequestContext, run: string): Promise<string[]> {
  const log = (await (await request.get(`/__log?of=${run}`)).json()) as Array<{ path: string }>;
  return log.map((e) => e.path);
}

export interface PdfRun {
  /** The worker script's own policy (served with pdf.worker.mjs). */
  workerPolicy: string;
  useWasm?: boolean;
  workerMode?: 'port' | 'src';
  /** Limit the fixture's page content (demo/pdf-fixture.ts). */
  parts?: string;
}

/**
 * Opens the fixture PDF in the PDF panel. The bytes are fetched XOR-encoded and decoded in the
 * page, then handed to PDF.js as data: on the spike machine a local filter replaced PDF responses
 * to Firefox and Edge with an empty 204 (see demo/serve.ts). Everything else PDF.js loads (worker,
 * WebAssembly, fallbacks, standard fonts, CMaps) comes from the server under the run's prefix.
 */
export function showSamplePdf(page: Page, run: string, o: PdfRun): Promise<unknown> {
  return page.evaluate(
    async ({ run, wcsp, useWasm, mode, parts }) => {
      const query = parts ? `&parts=${parts}` : '';
      const coded = new Uint8Array(
        await (await fetch(`/pdf/sample.xor?run=${run}${query}`)).arrayBuffer(),
      );
      const bytes = coded.map((b) => b ^ 0x5a);
      const el = document.querySelector('doc-editor') as unknown as {
        showPdf(source: Uint8Array, options: unknown): Promise<unknown>;
      };
      return el.showPdf(bytes, {
        workerUrl: `/vendor/pdfjs-dist/build/pdf.worker.mjs?run=${run}&wcsp=${wcsp}`,
        wasmUrl: `/r/${run}/vendor/pdfjs-dist/wasm/`,
        standardFontDataUrl: `/r/${run}/vendor/pdfjs-dist/standard_fonts/`,
        cMapUrl: `/r/${run}/vendor/pdfjs-dist/cmaps/`,
        useWasm,
        workerMode: mode,
      });
    },
    {
      run,
      wcsp: encodePolicy(o.workerPolicy),
      useWasm: o.useWasm ?? true,
      mode: o.workerMode ?? 'port',
      parts: o.parts ?? '',
    },
  );
}

export { harness };
