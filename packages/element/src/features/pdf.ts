/**
 * The PDF panel (02 §2, §7; FE-071), loaded lazily: PDF.js and its worker. Spike S2 runs it in the
 * host page under the host's policy to record what PDF.js needs; production runs it in a sandboxed
 * cross-origin frame (09 §9.3 rule 7), which this module does not build.
 *
 * Under Trusted Types, PDF.js's own `new Worker(workerSrc)` is a script-URL sink: without a policy
 * PDF.js catches the error and silently runs its worker code on the main thread ("fake worker").
 * `workerMode: 'port'` creates the worker here through the component's own policy and hands it to
 * PDF.js as `workerPort`.
 */
import { workerScriptURL } from '../trusted-types.ts';

export interface PdfOptions {
  /** URL of `pdf.worker.mjs`. */
  workerUrl: string;
  /** Directory of PDF.js's optional WebAssembly decoders and their fallbacks (ends with `/`). */
  wasmUrl: string;
  standardFontDataUrl: string;
  /**
   * Directory of PDF.js's packed CMaps. With it (and the two URLs above, all same-origin) PDF.js
   * sets `useWorkerFetch`: the worker fetches its data files itself, and only then does it use
   * its WebAssembly ICC colour decoder (qcms).
   */
  cMapUrl?: string;
  useWasm?: boolean;
  /** `port`: the component creates the worker; `src`: PDF.js does (its default). */
  workerMode?: 'port' | 'src';
}

export interface PdfReport {
  ok: boolean;
  error: string | null;
  workerMode: 'port' | 'src';
  /** Whether PDF.js ended up on the main thread instead of a worker. */
  fakeWorker: boolean;
  pages: number;
  /** RGBA samples: the ICC-based CMYK fill, the CCITT image, and the white page. */
  samples: Record<'icc' | 'ccitt' | 'paper', number[]>;
  warnings: string[];
}

const capturedWarnings: string[] = [];
let consolePatched = false;

/** PDF.js reports fallbacks through console.log("Warning: …") on the main thread. */
function captureWarnings(): void {
  if (consolePatched) return;
  consolePatched = true;
  for (const level of ['log', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === 'string' && /^(Warning|Info):/.test(first)) capturedWarnings.push(first);
      original(...args);
    };
  }
}

/** `source` is the PDF's URL, or its bytes. */
export async function showPdf(
  host: HTMLElement,
  source: string | Uint8Array,
  options: PdfOptions,
): Promise<PdfReport> {
  captureWarnings();
  capturedWarnings.length = 0;
  const workerMode = options.workerMode ?? 'port';
  const report: PdfReport = {
    ok: false,
    error: null,
    workerMode,
    fakeWorker: false,
    pages: 0,
    samples: { icc: [], ccitt: [], paper: [] },
    warnings: capturedWarnings,
  };
  try {
    const pdfjs = await import('pdfjs-dist');
    if (workerMode === 'port') {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerScriptURL(options.workerUrl), {
        type: 'module',
      });
    } else {
      pdfjs.GlobalWorkerOptions.workerSrc = options.workerUrl;
    }
    const task = pdfjs.getDocument({
      ...(typeof source === 'string' ? { url: source } : { data: source }),
      wasmUrl: options.wasmUrl,
      standardFontDataUrl: options.standardFontDataUrl,
      ...(options.cMapUrl ? { cMapUrl: options.cMapUrl, cMapPacked: true } : {}),
      useWasm: options.useWasm ?? true,
      verbosity: 1,
    });
    const doc = await task.promise;
    report.pages = doc.numPages;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.setAttribute('aria-label', 'Typeset page 1');
    host.append(canvas);
    const context = canvas.getContext('2d')!;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    // The fixture (demo/pdf-fixture.ts): page 200 by 200 pt; ICC fill at (20, 20, 60, 60) from the
    // bottom left, the CCITT image at (110, 110, 60, 60).
    const sample = (x: number, yFromBottom: number) =>
      Array.from(context.getImageData(x, canvas.height - yFromBottom, 1, 1).data);
    report.samples = { icc: sample(50, 50), ccitt: sample(140, 140), paper: sample(190, 10) };
    report.fakeWorker = report.warnings.some((w) => w.includes('fake worker'));
    report.ok = true;
  } catch (e) {
    report.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return report;
}
