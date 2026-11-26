/**
 * The PDF viewer as the element runs it (02 §7; 09 §9.3 rule 7; 10 §3.1; FE-071): PDF.js draws
 * the pages inside a sandboxed frame whose origin differs from the host page's, so that a bug in
 * the PDF parser runs in neither the host page nor its origin.
 *
 * - `sandbox="allow-scripts"`, never `allow-popups`, `allow-forms`, `allow-modals`,
 *   `allow-top-navigation` or `allow-downloads`. When the viewer is served from another origin
 *   (recommended) `allow-same-origin` is added, so the frame keeps that origin and PDF.js gets its
 *   worker; served from the host's own origin it stays opaque, and PDF.js then runs on the frame's
 *   main thread.
 * - The frame's own response policy (where the viewer is served) disables `eval`; this build of
 *   PDF.js does not use it, and the viewer neither draws annotation layers nor runs PDF scripts.
 * - The frame never receives the user's token: a signed URL or the PDF's bytes, and the strings.
 * - Nothing loads until a viewer is opened; `destroy()` removes the frame, which ends its worker.
 * - A browser loads the frame's page afresh when the frame leaves the document and returns (the
 *   element was moved or suspended; FE-005). The new page is connected as the first one was and
 *   opens the PDF that was open by its URL, at its first page. The page that asks is the one the
 *   frame loaded from the viewer's URL: under a cross-origin viewer the port is delivered to that
 *   origin only.
 */
import { EN, type PdfViewerStrings } from '../strings.ts';
import {
  VIEWER_CHANNEL,
  VIEWER_PROTOCOL,
  type ConnectMessage,
  type FromViewer,
  type PdfSource,
  type ToViewer,
} from './messages.ts';

export interface PdfViewerOptions {
  /** URL of the viewer's page (`viewer/pdf-viewer.html` of the build, or `config.pdfViewerUrl`). */
  url: string;
  strings?: Partial<PdfViewerStrings>;
  /** How long to wait for the frame to answer before giving up, in milliseconds (ADR 0039). */
  readyTimeoutMs?: number;
}

export type Isolation = 'cross-origin' | 'opaque';

/** One page drawn for printing: the bitmap, and the page's size in PDF points (1/72 inch). */
export interface PrintPage {
  readonly width: number;
  readonly height: number;
  readonly bitmap: ImageBitmap;
}

export class PdfViewerError extends Error {
  readonly code: 'unavailable' | 'load_failed';
  constructor(code: 'unavailable' | 'load_failed', message: string) {
    super(message);
    this.name = 'PdfViewerError';
    this.code = code;
  }
}

/** 15 seconds: a provisional default, not a measurement (ADR 0039). */
export const READY_TIMEOUT_MS = 15_000;

export class PdfViewerFrame {
  readonly frame: HTMLIFrameElement;
  readonly isolation: Isolation;
  readonly #strings: PdfViewerStrings;
  readonly #listeners = new Set<(message: FromViewer) => void>();
  /** Settles when the frame's page has answered for the first time, or cannot. */
  readonly #ready: Promise<void>;
  /** The port of the page the frame shows now; null until it answers, and while it loads again. */
  #port: MessagePort | null = null;
  /** True once a page of the frame has answered: a later answer is from a page loaded again. */
  #answered = false;
  #destroyed = false;
  #failReady: ((e: Error) => void) | null = null;
  /** The `open` calls that wait for the frame's answer: `destroy()` rejects them (FE-005). */
  readonly #opening = new Set<(e: Error) => void>();
  /** An `open` made while the frame's page was loading again: sent when the page answers. */
  #waiting: { message: ToViewer; transfer: Transferable[] } | null = null;
  /** The PDF that was opened by its URL, so that a page loaded again shows it again (FE-005). */
  #url: string | null = null;

  constructor(container: Element, options: PdfViewerOptions) {
    const url = new URL(options.url, document.baseURI);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new PdfViewerError(
        'unavailable',
        `the PDF viewer must be served over HTTP(S): ${url.href}`,
      );
    this.#strings = { ...EN.pdf, ...options.strings };
    this.isolation = url.origin === location.origin ? 'opaque' : 'cross-origin';
    const frame = document.createElement('iframe');
    frame.className = 'de-pdf-frame';
    frame.title = this.#strings.title;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute(
      'sandbox',
      this.isolation === 'cross-origin' ? 'allow-scripts allow-same-origin' : 'allow-scripts',
    );
    this.frame = frame;
    const timeout = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    let answered: () => void = () => {};
    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PdfViewerError('unavailable', 'the PDF viewer did not answer')),
        timeout,
      );
      answered = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#failReady = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });
    // A rejection nobody awaits yet is not an error of the page.
    this.#ready.catch(() => {});
    // Every load, not only the first: a browser unloads a frame that leaves the document and loads
    // its page afresh when it returns, also within one task, which is what a framework does when it
    // moves the element (FE-005). The page that was loaded again has no port and shows nothing, so
    // it is given a port of its own and the PDF that was open.
    frame.addEventListener('load', () => {
      if (this.#destroyed || !frame.contentWindow) return;
      this.#port?.close();
      this.#port = null;
      const channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent<FromViewer>) => {
        const message = event.data;
        if (message?.type === 'ready' && !this.#destroyed) {
          const again = this.#answered;
          this.#answered = true;
          this.#port = channel.port1;
          answered();
          this.#resume(again);
        }
        for (const listener of [...this.#listeners]) listener(message);
      };
      const connect: ConnectMessage = {
        channel: VIEWER_CHANNEL,
        version: VIEWER_PROTOCOL,
        type: 'connect',
      };
      // An opaque origin cannot be named as a target, so the message goes to any origin; it
      // carries only the port, and the port is the only way in.
      frame.contentWindow.postMessage(
        connect,
        this.isolation === 'cross-origin' ? url.origin : '*',
        [channel.port2],
      );
    });
    frame.src = url.href;
    container.append(frame);
  }

  /**
   * The frame's page has answered. An `open` that waited for it is sent. Otherwise, when this is a
   * page loaded again, the PDF that was open by its URL is opened again; a PDF that was given as
   * bytes is gone with the old page (its buffer was transferred), so an `open` that still waits for
   * it is refused.
   */
  #resume(again: boolean): void {
    const port = this.#port;
    if (!port) return;
    const waiting = this.#waiting;
    this.#waiting = null;
    if (waiting) {
      port.postMessage(waiting.message, waiting.transfer);
      return;
    }
    if (!again) return;
    if (this.#url !== null) {
      const message: ToViewer = {
        type: 'open',
        source: { url: this.#url },
        strings: this.#strings,
      };
      port.postMessage(message);
      return;
    }
    for (const closed of [...this.#opening])
      closed(new PdfViewerError('unavailable', 'the viewer was loaded again and its PDF is gone'));
  }

  /** Called with every message from the frame; returns the function that stops listening. */
  onMessage(listener: (message: FromViewer) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Opens a PDF; resolves with its page count once the first page is drawn. Rejects with
   * `unavailable` when the viewer is destroyed before the frame has answered, so that a caller never
   * waits on a frame that is gone. When the frame's page loads again meanwhile (the element was
   * moved in the DOM), a PDF given by its URL is opened in the new page and the call resolves then.
   */
  async open(source: PdfSource): Promise<{ pages: number; worker: boolean }> {
    await this.#ready;
    if (this.#destroyed) throw new PdfViewerError('unavailable', 'the viewer was closed');
    return new Promise((resolve, reject) => {
      let opened: { pages: number; worker: boolean } | null = null;
      const settle = (run: () => void): void => {
        stop();
        this.#opening.delete(closed);
        run();
      };
      const closed = (e: Error): void => settle(() => reject(e));
      const stop = this.onMessage((m) => {
        if (m.type === 'opened') opened = { pages: m.pages, worker: m.worker };
        else if (m.type === 'rendered' && opened) {
          const result = opened;
          settle(() => resolve(result));
        } else if (m.type === 'failed' && m.code === 'load_failed') {
          settle(() => reject(new PdfViewerError('load_failed', m.message)));
        }
      });
      this.#opening.add(closed);
      const message: ToViewer = { type: 'open', source, strings: this.#strings };
      const transfer: Transferable[] = 'data' in source ? [source.data] : [];
      this.#url = 'url' in source ? source.url : null;
      // While the frame's page loads again there is no port: the message waits for its answer.
      if (this.#port) this.#port.postMessage(message, transfer);
      else this.#waiting = { message, transfer };
    });
  }

  /** Shows a page (1-based). Ignored while the frame's page loads again: it opens at page 1. */
  async showPage(page: number): Promise<void> {
    await this.#ready;
    const message: ToViewer = { type: 'page', page };
    this.#port?.postMessage(message);
  }

  /**
   * Draws every page of the open PDF for printing (FE-073) and resolves with the pages in order,
   * each a bitmap and its size in PDF points. The caller owns the bitmaps (close them when done).
   * Rejects when the viewer fails or is destroyed first.
   */
  async renderAll(dpi = 150): Promise<PrintPage[]> {
    await this.#ready;
    if (this.#destroyed) throw new PdfViewerError('unavailable', 'the viewer was closed');
    return new Promise((resolve, reject) => {
      const pages: PrintPage[] = [];
      const settle = (run: () => void): void => {
        stop();
        this.#opening.delete(closed);
        run();
      };
      const closed = (e: Error): void => settle(() => reject(e));
      const stop = this.onMessage((m) => {
        if (m.type === 'print-page')
          pages.push({ width: m.width, height: m.height, bitmap: m.bitmap });
        else if (m.type === 'print-done') settle(() => resolve(pages));
        else if (m.type === 'failed')
          settle(() => {
            for (const p of pages) p.bitmap.close();
            reject(new PdfViewerError('load_failed', m.message));
          });
      });
      this.#opening.add(closed);
      const message: ToViewer = { type: 'render-all', dpi };
      this.#port?.postMessage(message);
    });
  }

  /** Removes the frame; its document and PDF.js worker end with it. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#failReady?.(new PdfViewerError('unavailable', 'the viewer was closed'));
    // An `open` that still waits for its pages will get no answer from a frame that is removed.
    for (const closed of [...this.#opening])
      closed(new PdfViewerError('unavailable', 'the viewer was closed'));
    this.#opening.clear();
    this.#waiting = null;
    this.#url = null;
    if (this.#port) {
      const close: ToViewer = { type: 'close' };
      this.#port.postMessage(close);
      this.#port.close();
    }
    this.#port = null;
    this.#listeners.clear();
    this.frame.remove();
  }
}
