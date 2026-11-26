/**
 * Hooks for the demo pages and the end-to-end suites. Not part of the published module: only the
 * demo build imports this file, and nothing in `src/index.ts` refers to it.
 *
 * - `internalsOf` reads the lifecycle state of an element (mounted, suspended, the session).
 * - `setEndpointBackendFactory` turns `endpoint` into a backend of the test's choice.
 * - `installSpikeHooks` gives an element the methods spikes S1 and S2 drive (`spike()`,
 *   `showPdf()`, `showMath()`, `openMathEditor()`) and the read-only state they check, so that
 *   their suites keep running against the production element.
 */
import type { SpikeHarness } from '@docedit/engine/testing';
import type { MathEditorOptions, MathEditorReport, MathItem, MathReport } from './features/math.ts';
import type { PdfOptions, PdfReport } from './features/pdf.ts';
import { INTERNALS, type InternalsView } from './internals.ts';
import type { PdfSource } from './pdf/messages.ts';
import type { PdfViewerFrame } from './pdf/viewer-frame.ts';

export { setEndpointBackendFactory, type EndpointBackendFactory } from './backend-source.ts';

export function internalsOf(el: Element): InternalsView {
  const read = INTERNALS.get(el);
  if (!read) throw new Error('not a <doc-editor> element');
  return read();
}

const harnesses = new WeakMap<object, Promise<SpikeHarness>>();

/** The spike S1 harness for the element's current editing core. */
export function spikeHarness(el: Element): Promise<SpikeHarness> {
  const core = internalsOf(el).editor?.core;
  if (!core) return Promise.reject(new Error('not mounted'));
  let h = harnesses.get(core);
  if (!h) {
    h = import('@docedit/engine/testing').then((m) => new m.SpikeHarness(core));
    harnesses.set(core, h);
  }
  return h;
}

const featureHosts = new WeakMap<Element, HTMLElement>();

/** A container in the shadow root for the spike S2 features, which run in the host page. */
function featureHost(el: Element): HTMLElement {
  let host = featureHosts.get(el);
  if (!host || !host.isConnected) {
    host = document.createElement('div');
    host.className = 'de-feature';
    host.setAttribute('part', 'sidebar');
    internalsOf(el).root.append(host);
    featureHosts.set(el, host);
  }
  return host;
}

/**
 * Opens the PDF viewer the way the shell's PDF pane will (UX-019): a frame in a container inside
 * the shadow root. Resolves once the first page is drawn.
 */
export async function openPdfViewer(
  el: Element,
  source: PdfSource,
): Promise<{ frame: HTMLIFrameElement; isolation: string; pages: number; worker: boolean }> {
  const editor = internalsOf(el).editor;
  if (!editor) throw new Error('not mounted');
  const container = document.createElement('section');
  container.className = 'de-pdf';
  container.setAttribute('part', 'sidebar');
  internalsOf(el).root.append(container);
  // A browser holds back the drawing of a frame of another origin that is out of the viewport, so
  // the viewer would not answer. The ruler (UX-102) moved this section below the fold of the test
  // pages; a reader scrolls it into view to read it, as soon as the frame is in it.
  const scroll = new MutationObserver(() => container.scrollIntoView({ block: 'nearest' }));
  scroll.observe(container, { childList: true });
  let result;
  try {
    result = await editor.shell.pdf.open(container, source);
  } finally {
    scroll.disconnect();
  }
  const { viewer, pages, worker } = result;
  const state = viewerStates.get(el) ?? [];
  state.push(viewer);
  viewerStates.set(el, state);
  return { frame: viewer.frame, isolation: viewer.isolation, pages, worker };
}

const viewerStates = new WeakMap<Element, PdfViewerFrame[]>();

/** The viewers opened on an element with `openPdfViewer`, newest last. */
export function viewersOf(el: Element): readonly PdfViewerFrame[] {
  return viewerStates.get(el) ?? [];
}

export interface SpikeHooks {
  spike(): Promise<SpikeHarness>;
  showPdf(source: string | Uint8Array, options: PdfOptions): Promise<PdfReport>;
  showMath(items: MathItem[], throwOnError?: boolean): Promise<MathReport>;
  openMathEditor(latex: string, options: MathEditorOptions): Promise<MathEditorReport>;
  readonly mounted: boolean;
  readonly suspended: boolean;
  readonly stylePath: string;
}

/** Adds the spike methods and state to one element (the page opted in to spike instrumentation). */
export function installSpikeHooks(el: Element): void {
  const nonce = () => {
    const input = (el as Element & { config?: { styleNonce?: string } }).config;
    return input?.styleNonce;
  };
  const hooks: Omit<SpikeHooks, 'mounted' | 'suspended' | 'stylePath'> = {
    spike: () => spikeHarness(el),
    showPdf: async (source, options) => {
      const { showPdf } = await import('./features/pdf.ts');
      return showPdf(featureHost(el), source, options);
    },
    showMath: async (items, throwOnError = true) => {
      const { showMath } = await import('./features/math.ts');
      return showMath(internalsOf(el).root, featureHost(el), items, {
        throwOnError,
        nonce: nonce(),
      });
    },
    openMathEditor: async (latex, options) => {
      const { openMathEditor } = await import('./features/math.ts');
      return openMathEditor(featureHost(el), latex, options);
    },
  };
  Object.assign(el, hooks);
  Object.defineProperties(el, {
    mounted: { get: () => internalsOf(el).editor !== null, configurable: true },
    suspended: { get: () => internalsOf(el).suspended, configurable: true },
    stylePath: { get: () => internalsOf(el).editor?.stylePath ?? 'none', configurable: true },
  });
}
