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
  readonly #ready: Promise<MessagePort>;
  #port: MessagePort | null = null;
  #destroyed = false;
  #failReady: ((e: Error) => void) | null = null;

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
    this.#ready = new Promise<MessagePort>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PdfViewerError('unavailable', 'the PDF viewer did not answer')),
        timeout,
      );
      this.#failReady = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      frame.addEventListener(
        'load',
        () => {
          if (this.#destroyed || !frame.contentWindow) return;
          const channel = new MessageChannel();
          channel.port1.onmessage = (event: MessageEvent<FromViewer>) => {
            const message = event.data;
            if (message?.type === 'ready') {
              clearTimeout(timer);
              this.#port = channel.port1;
              resolve(channel.port1);
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
        },
        { once: true },
      );
    });
    // A rejection nobody awaits yet is not an error of the page.
    this.#ready.catch(() => {});
    frame.src = url.href;
    container.append(frame);
  }

  /** Called with every message from the frame; returns the function that stops listening. */
  onMessage(listener: (message: FromViewer) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Opens a PDF; resolves with its page count once the first page is drawn. */
  async open(source: PdfSource): Promise<{ pages: number; worker: boolean }> {
    const port = await this.#ready;
    if (this.#destroyed) throw new PdfViewerError('unavailable', 'the viewer was closed');
    return new Promise((resolve, reject) => {
      let opened: { pages: number; worker: boolean } | null = null;
      const stop = this.onMessage((m) => {
        if (m.type === 'opened') opened = { pages: m.pages, worker: m.worker };
        else if (m.type === 'rendered' && opened) {
          stop();
          resolve(opened);
        } else if (m.type === 'failed' && m.code === 'load_failed') {
          stop();
          reject(new PdfViewerError('load_failed', m.message));
        }
      });
      const message: ToViewer = { type: 'open', source, strings: this.#strings };
      if ('data' in source) port.postMessage(message, [source.data]);
      else port.postMessage(message);
    });
  }

  /** Shows a page (1-based). */
  async showPage(page: number): Promise<void> {
    const port = await this.#ready;
    const message: ToViewer = { type: 'page', page };
    port.postMessage(message);
  }

  /** Removes the frame; its document and PDF.js worker end with it. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#failReady?.(new PdfViewerError('unavailable', 'the viewer was closed'));
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
