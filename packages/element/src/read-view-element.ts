/**
 * The read view in the element's shadow root (FE-072; FE-065 criterion 2). `view="read"` shows the
 * pages of the typeset PDF, read-only, with no editing surface. The editing core is not created for
 * this view: the element starts the export with the backend it has, shows the progress and the
 * diagnostics, and opens the signed URL in the PDF viewer frame (pdf/viewer-frame.ts).
 *
 * Everything shown is set with DOM APIs and textContent, never with a document value through
 * innerHTML (FE-067). The labels are the strings of read-view.ts (UX's, 13 §8).
 *
 * Not here (FE-072 Notes): moving the editor to a diagnostic's block (criterion 4 needs the editing
 * core and the user's edit right), and a change of `view` while the element is open (FE-065
 * criterion 3).
 */
import type { Backend } from '@docedit/protocol';
import { PdfViewerFrame } from './pdf/viewer-frame.ts';
import {
  openReadView,
  READ_VIEW_STRINGS,
  type ReadViewDiagnostic,
  type ReadViewOutcome,
} from './read-view.ts';

export interface ReadViewElementOptions {
  /** The element's shadow root; the read view is appended to it. */
  readonly root: ShadowRoot;
  readonly docId: string;
  /** Connected by this module before the export starts. */
  readonly backend: Backend;
  /** The viewer's page (the build's `viewer/pdf-viewer.html`, or `config.pdfViewerUrl`). */
  readonly viewerUrl: string;
  /** True when the element created the backend, so that it closes it on `close()`. */
  readonly ownsBackend: boolean;
}

export interface MountedReadView {
  /** Resolves with the outcome of the export; never rejects. */
  readonly outcome: Promise<ReadViewOutcome>;
  /** Removes the view, the viewer frame and, when owned, the backend. Safe to call twice. */
  close(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Mounts the read view and starts its export; returns at once, the outcome arrives later. */
export function mountReadView(options: ReadViewElementOptions): MountedReadView {
  const section = element('section', 'de-read-view');
  section.dataset['view'] = 'read';
  const label = element('p', 'de-read-label', READ_VIEW_STRINGS.label);
  const status = element('p', 'de-read-status');
  status.setAttribute('role', 'status');
  const diagnostics = element('ul', 'de-read-diagnostics');
  const pages = element('div', 'de-read-pages');
  section.append(label, status, diagnostics, pages);
  options.root.append(section);

  let viewer: PdfViewerFrame | null = null;
  let closed = false;

  const showDiagnostics = (list: readonly ReadViewDiagnostic[]): void => {
    for (const d of list) {
      const item = element('li', 'de-read-diagnostic', `${d.severity}: ${d.code}: ${d.message}`);
      if (d.blockId !== null) item.dataset['blockId'] = d.blockId;
      diagnostics.append(item);
    }
  };

  const outcome = (async (): Promise<ReadViewOutcome> => {
    try {
      await options.backend.connect();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!closed) status.textContent = `${READ_VIEW_STRINGS.failed}: ${message}`;
      return { status: 'unavailable', code: 'unavailable', message };
    }
    if (closed) return { status: 'unavailable', code: 'unavailable', message: 'closed' };

    const result = await openReadView({
      source: { docId: options.docId, backend: options.backend, access: null },
      openPdf: async (url) => {
        if (closed) throw new Error('the read view was closed');
        viewer = new PdfViewerFrame(pages, { url: options.viewerUrl });
        await viewer.open({ url });
      },
      onDiagnostics: (list) => {
        if (!closed) showDiagnostics(list);
      },
      onProgress: ({ state, percent }) => {
        if (closed) return;
        // The job reports a fraction (0 to 1, as pro-086 does); the text shows a whole percentage.
        const suffix = percent === null ? '' : `, ${Math.round(percent * 100)}%`;
        status.textContent = `${READ_VIEW_STRINGS.exporting} (${state}${suffix})`;
      },
    });
    // The diagnostics were listed by onDiagnostics; this sets what the status says at the end.
    if (closed) return result;
    status.textContent =
      result.status === 'shown' ? '' : `${READ_VIEW_STRINGS.failed}: ${result.message}`;
    return result;
  })();

  return {
    outcome,
    close(): void {
      if (closed) return;
      closed = true;
      viewer?.destroy();
      viewer = null;
      section.remove();
      if (options.ownsBackend) void options.backend.close().catch(() => {});
    },
  };
}
