/**
 * The PDF viewer inside its sandboxed frame (FE-071; 09 §9.3 rule 7). It waits for the element's
 * `connect` message, which carries the only port it listens to, then draws one page at a time with
 * PDF.js on a canvas: no annotation layer, no form layer, no scripting, so a PDF's JavaScript
 * actions, launch actions and form scripts never run. One page at a time also keeps a PDF with an
 * extreme page count cheap: PDF.js reads pages on demand.
 *
 * PDF.js runs in its own worker when the frame has an origin of its own (the viewer is served
 * from another origin). In an opaque frame a worker cannot be created and PDF.js runs here.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { format, type PdfViewerStrings } from '../../strings.ts';
import { workerScriptURL } from '../../trusted-types.ts';
import { isConnectMessage, type FromViewer, type ToViewer } from '../messages.ts';
import './viewer.css';

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
const status = document.querySelector<HTMLElement>('.status')!;
const zoomLabel = document.querySelector<HTMLElement>('.zoom')!;
const pages = document.querySelector<HTMLElement>('.pages')!;
const canvas = document.querySelector<HTMLCanvasElement>('canvas.page')!;
const notice = document.querySelector<HTMLElement>('.message')!;
const button = (action: string) =>
  document.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!;
const previous = button('previous');
const next = button('next');
const zoomOut = button('zoom-out');
const zoomIn = button('zoom-in');

let port: MessagePort | null = null;
let strings: PdfViewerStrings | null = null;
let doc: pdfjs.PDFDocumentProxy | null = null;
let loading: pdfjs.PDFDocumentLoadingTask | null = null;
let render: { cancel(): void } | null = null;
let worker: Worker | null = null;
let workerReady: Promise<boolean> | null = null;
let current = 1;
let zoom = ZOOM_STEPS.indexOf(1);

function post(message: FromViewer): void {
  port?.postMessage(message);
}

/**
 * Starts PDF.js's worker through the component's Trusted Types policy (spike S2 §5). An opaque
 * frame (the viewer served from the host page's own origin) cannot run a worker of that origin,
 * and Firefox and WebKit only fail when the script loads, so the frame does not try: it loads
 * PDF.js's worker code into this thread, where PDF.js finds it (`globalThis.pdfjsWorker`).
 */
async function startWorker(): Promise<boolean> {
  const src = new URL(workerUrl, location.href).href;
  pdfjs.GlobalWorkerOptions.workerSrc = src;
  if (globalThis.origin !== 'null') {
    try {
      worker = new Worker(workerScriptURL(src), { type: 'module' });
      pdfjs.GlobalWorkerOptions.workerPort = worker;
      return true;
    } catch {
      worker = null;
    }
  }
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker =
    await import('pdfjs-dist/build/pdf.worker.min.mjs');
  return false;
}

function applyStrings(s: PdfViewerStrings): void {
  document.title = s.title;
  toolbar.setAttribute('aria-label', s.toolbar);
  previous.textContent = s.previous;
  next.textContent = s.next;
  zoomOut.textContent = s.zoomOut;
  zoomIn.textContent = s.zoomIn;
  pages.setAttribute('aria-label', s.title);
}

function showNotice(text: string | null): void {
  notice.hidden = text === null;
  notice.textContent = text ?? '';
}

function updateControls(): void {
  if (!strings) return;
  const total = doc?.numPages ?? 0;
  status.textContent = total
    ? format(strings.pageOf, { page: current, pages: total })
    : strings.loading;
  zoomLabel.textContent = format(strings.zoom, { percent: Math.round(ZOOM_STEPS[zoom]! * 100) });
  previous.disabled = !doc || current <= 1;
  next.disabled = !doc || current >= total;
  zoomOut.disabled = !doc || zoom <= 0;
  zoomIn.disabled = !doc || zoom >= ZOOM_STEPS.length - 1;
}

async function draw(): Promise<void> {
  if (!doc || !strings) return;
  const number = current;
  render?.cancel();
  render = null;
  updateControls();
  try {
    const page = await doc.getPage(number);
    if (number !== current) return;
    const scale = ZOOM_STEPS[zoom]!;
    const viewport = page.getViewport({ scale });
    const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    // CSSOM writes, which a content security policy does not restrict (spike S2 §4).
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.setAttribute(
      'aria-label',
      format(strings.pageOf, { page: number, pages: doc.numPages }),
    );
    const task = page.render({
      canvas,
      canvasContext: canvas.getContext('2d')!,
      viewport,
      ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
    });
    render = task;
    await task.promise;
    if (number !== current) return;
    showNotice(null);
    post({ type: 'rendered', page: number, pages: doc.numPages, scale });
  } catch (e) {
    if (e instanceof Error && e.name === 'RenderingCancelledException') return;
    showNotice(strings.pageFailed);
    post({ type: 'failed', code: 'page_failed', page: number, message: describe(e) });
  }
}

function describe(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.slice(0, 300);
}

async function open(message: Extract<ToViewer, { type: 'open' }>): Promise<void> {
  strings = message.strings;
  applyStrings(strings);
  await close();
  toolbar.hidden = false;
  showNotice(null);
  updateControls();
  const usesWorker = await (workerReady ??= startWorker());
  const base = new URL('./pdfjs/', location.href).href;
  try {
    loading = pdfjs.getDocument({
      ...('url' in message.source ? { url: message.source.url } : { data: message.source.data }),
      // With these three on the frame's own origin PDF.js fetches its data in the worker and uses
      // its WebAssembly decoders; without WebAssembly it falls back to JavaScript (spike S2 §7).
      wasmUrl: `${base}wasm/`,
      standardFontDataUrl: `${base}standard_fonts/`,
      cMapUrl: `${base}cmaps/`,
      cMapPacked: true,
      enableXfa: false,
      verbosity: 0,
    });
    doc = await loading.promise;
  } catch (e) {
    doc = null;
    updateControls();
    showNotice(strings.failed);
    post({ type: 'failed', code: 'load_failed', message: describe(e) });
    return;
  }
  current = 1;
  post({ type: 'opened', pages: doc.numPages, worker: usesWorker });
  await draw();
}

async function close(): Promise<void> {
  render?.cancel();
  render = null;
  const task = loading;
  loading = null;
  doc = null;
  if (task) await task.destroy().catch(() => {});
}

function go(page: number): void {
  if (!doc) return;
  const target = Math.min(Math.max(1, Math.trunc(page)), doc.numPages);
  if (target === current) return;
  current = target;
  void draw();
}

function setZoom(step: number): void {
  if (!doc) return;
  const target = Math.min(Math.max(0, step), ZOOM_STEPS.length - 1);
  if (target === zoom) return;
  zoom = target;
  void draw();
}

previous.addEventListener('click', () => go(current - 1));
next.addEventListener('click', () => go(current + 1));
zoomOut.addEventListener('click', () => setZoom(zoom - 1));
zoomIn.addEventListener('click', () => setZoom(zoom + 1));

document.addEventListener('keydown', (event) => {
  if (!doc || event.altKey || event.ctrlKey || event.metaKey) return;
  const actions: Record<string, () => void> = {
    PageDown: () => go(current + 1),
    PageUp: () => go(current - 1),
    Home: () => go(1),
    End: () => go(doc?.numPages ?? 1),
    '+': () => setZoom(zoom + 1),
    '=': () => setZoom(zoom + 1),
    '-': () => setZoom(zoom - 1),
  };
  const action = actions[event.key];
  if (action) {
    event.preventDefault();
    action();
  }
});

function onPortMessage(event: MessageEvent<ToViewer>): void {
  const message = event.data;
  if (message?.type === 'open') void open(message);
  else if (message?.type === 'page') go(message.page);
  else if (message?.type === 'close') {
    void close();
    worker?.terminate();
    worker = null;
    workerReady = null;
  }
}

// The element connects once, from the frame's parent; later connect messages are ignored.
window.addEventListener('message', (event) => {
  if (port || event.source !== window.parent || !isConnectMessage(event.data)) return;
  const received = event.ports[0];
  if (!received) return;
  port = received;
  port.onmessage = onPortMessage;
  post({ type: 'ready' });
});
