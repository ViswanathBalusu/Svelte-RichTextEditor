/**
 * Messages between the element and the PDF viewer's frame (FE-071; 09 §9.3 rule 7). The element
 * sends one `connect` message to the frame's window, carrying a `MessagePort`; everything after
 * goes over that port, so no other page can talk to the viewer or listen to it, and the element
 * needs no listener on its window. What crosses is the PDF (its bytes or its signed URL) and the
 * interface strings: never the user's token, cookies or anything of the host page (10 §3.1).
 */
import type { PdfViewerStrings } from '../strings.ts';

export const VIEWER_CHANNEL = 'docedit-pdf-viewer';
export const VIEWER_PROTOCOL = 1;

/** Sent to the frame's window, with the port to use as its only transfer. */
export interface ConnectMessage {
  channel: typeof VIEWER_CHANNEL;
  version: typeof VIEWER_PROTOCOL;
  type: 'connect';
}

/** The PDF: a signed URL the frame fetches itself, or the bytes. */
export type PdfSource = { url: string } | { data: ArrayBuffer };

export type ToViewer =
  | { type: 'open'; source: PdfSource; strings: PdfViewerStrings }
  | { type: 'page'; page: number }
  | { type: 'close' };

export type ViewerFailure = 'load_failed' | 'page_failed';

export type FromViewer =
  | { type: 'ready' }
  /** `worker`: whether PDF.js runs in its own worker rather than on the frame's main thread. */
  | { type: 'opened'; pages: number; worker: boolean }
  | { type: 'rendered'; page: number; pages: number; scale: number }
  | { type: 'failed'; code: ViewerFailure; message: string; page?: number };

export function isConnectMessage(value: unknown): value is ConnectMessage {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<ConnectMessage>;
  return v.channel === VIEWER_CHANNEL && v.version === VIEWER_PROTOCOL && v.type === 'connect';
}
