/**
 * Spike S2 (SPK-015; ADR 0016): the PDF panel (pdfjs-dist 6.5.438) when WebAssembly is allowed,
 * blocked by the worker's policy, or switched off, and when PDF.js creates its worker itself under
 * Trusted Types. The fixture (demo/pdf-fixture.ts) needs qcms_bg.wasm for its ICC-based CMYK fill
 * and jbig2.wasm for its CCITT image; both decoders have a JavaScript fallback in pdfjs-dist.
 * Records the files fetched, the pixels sampled, the warnings and the violations per browser.
 */
import { expect, test } from '@playwright/test';
import { record, runId } from './helpers.ts';
import { collect, openS2, policy, requests, showSamplePdf, summary } from './s2-helpers.ts';

/** CMYK (0, 1, 1, 0) through PDF.js's built-in DeviceCMYK conversion, sampled in Chromium and WebKit. */
const DEVICE_CMYK_RED = [255, 46, 23];

const WITH_WASM =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; report-uri {report}";
const WITHOUT_WASM =
  "default-src 'none'; script-src 'self'; connect-src 'self'; report-uri {report}";

interface PdfReport {
  ok: boolean;
  error: string | null;
  fakeWorker: boolean;
  samples: Record<'icc' | 'ccitt' | 'paper', number[]>;
  warnings: string[];
}

const cases = [
  { name: 'WebAssembly allowed in the worker', worker: WITH_WASM, useWasm: true, mode: 'port' },
  {
    name: 'WebAssembly blocked by the worker policy',
    worker: WITHOUT_WASM,
    useWasm: true,
    mode: 'port',
  },
  {
    name: 'WebAssembly switched off (useWasm: false)',
    worker: WITHOUT_WASM,
    useWasm: false,
    mode: 'port',
  },
  {
    name: 'PDF.js creates the worker itself under Trusted Types',
    worker: WITH_WASM,
    useWasm: true,
    mode: 'src',
  },
] as const;

for (const c of cases) {
  test(`PDF panel: ${c.name}`, async ({ page, request }) => {
    const run = runId();
    await openS2(page, run, policy({ 'trusted-types': 'docedit-worker' }));
    const report = (await showSamplePdf(page, run, {
      workerPolicy: c.worker,
      useWasm: c.useWasm,
      workerMode: c.mode,
    })) as PdfReport;
    const collected = await collect(page, request, run, 1000);
    const fetched = (await requests(request, run)).filter((p) => p.includes('pdfjs-dist'));
    const attempt = `${test.info().repeatEachIndex}.${test.info().retry}`;
    record(`s2-pdf-${c.name.replace(/[^A-Za-z]+/g, '-')}-attempt${attempt}`, {
      report,
      fetched,
      violations: summary(collected),
      dom: collected.dom,
      reports: collected.reports,
    });

    expect(report.ok, report.error ?? '').toBe(true);
    // The CCITT image decodes in every case (WebAssembly or its JavaScript fallback): black.
    expect(report.samples.ccitt.slice(0, 3)).toEqual([0, 0, 0]);
    const fetchedWasm = fetched.some((p) => p.endsWith('/jbig2.wasm'));
    const fetchedQcms = fetched.some((p) => p.endsWith('/qcms_bg.wasm'));
    const fetchedFallback = fetched.some((p) => p.endsWith('/jbig2_nowasm_fallback.js'));
    // The CMYK fill through qcms differs from PDF.js's own DeviceCMYK conversion, its fallback.
    const icc = report.samples.icc.slice(0, 3);
    const viaFallback = JSON.stringify(icc) === JSON.stringify(DEVICE_CMYK_RED);
    switch (c.name) {
      case 'WebAssembly allowed in the worker':
        expect({
          fetchedWasm,
          fetchedQcms,
          fetchedFallback,
          fake: report.fakeWorker,
          viaFallback,
        }).toEqual({
          fetchedWasm: true,
          fetchedQcms: true,
          fetchedFallback: false,
          fake: false,
          viaFallback: false,
        });
        expect(summary(collected)).toEqual([]);
        break;
      case 'WebAssembly blocked by the worker policy':
        // Both modules are fetched and refused by the worker's policy; PDF.js falls back to its
        // JavaScript decoder for the image and to DeviceCMYK for the colour.
        expect({ fetchedWasm, fetchedQcms, fetchedFallback, viaFallback }).toEqual({
          fetchedWasm: true,
          fetchedQcms: true,
          fetchedFallback: true,
          viaFallback: true,
        });
        break;
      case 'WebAssembly switched off (useWasm: false)':
        expect({ fetchedWasm, fetchedQcms, fetchedFallback, viaFallback }).toEqual({
          fetchedWasm: false,
          fetchedQcms: false,
          fetchedFallback: true,
          viaFallback: true,
        });
        expect(summary(collected)).toEqual([]);
        break;
      case 'PDF.js creates the worker itself under Trusted Types':
        // new Worker(string) is a script-URL sink: PDF.js catches the TypeError and runs its
        // worker code on the main thread ("fake worker").
        expect(report.fakeWorker).toBe(true);
        expect(summary(collected).some((v) => v.includes('require-trusted-types-for'))).toBe(true);
        break;
    }
  });
}
