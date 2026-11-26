/**
 * Prints one PDF at a signed URL through a hidden frame (02 §9.8; FE-073; UX-040 criterion 3).
 *
 * The element never prints its own shadow DOM or painted pages. It loads only the typeset PDF in a
 * frame of zero size, asks that frame to print, and removes the frame when the print dialogue
 * reports `afterprint`. This is the default `printPdf` of `printTypesetPdf` (print.ts); the viewer's
 * own print path is not built yet, so a caller that has one can supply it instead.
 *
 * The frame is mounted in `container`, which the element passes as its own shadow root. It is never
 * appended to the host page's document (FE-020: the element adds nothing to the host document). A
 * frame in a shadow root still loads and prints its own document.
 *
 * With `viewerUrl` the PDF is drawn by the PDF viewer and printed from a separate print-only frame
 * (owner decision 48, docs/owner-decisions-2026-11-15.md; FE-073 criterion 1). A browser lets a page
 * call `print` only on a window of its own origin, and it does not let a script print a PDF that a
 * frame shows (Firefox answers "cross-origin object" on the PDF viewer's window; Chromium and WebKit
 * raise no `load` for it in a headless run). So the viewer, whose frame stays sandboxed without
 * `allow-modals`, draws each page to a bitmap and sends it over its port; the print-only frame is an
 * empty document of the page's origin (a `blob:` URL), the element draws the bitmaps on canvases
 * there, and `print()` is called on that frame's window. The document is filled with DOM calls only, nothing of the editor is
 * copied into it (FE-073 criterion 2), and no print rule is added to any style sheet.
 *
 * Browser only: this module uses `document`. The unit and browser tests of the refusal do not reach
 * this function, because a refused print returns before `printPdf` runs.
 */
export function printPdfAtUrl(
  url: string,
  container: Node,
  options: { viewerUrl?: string } = {},
): Promise<void> {
  if (options.viewerUrl !== undefined) return printThroughViewer(url, container, options.viewerUrl);
  return new Promise<void>((resolve, reject) => {
    const frame = (container.ownerDocument ?? document).createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.style.position = 'fixed';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.style.visibility = 'hidden';

    const remove = (): void => {
      frame.remove();
    };

    frame.addEventListener(
      'load',
      () => {
        const win = frame.contentWindow;
        if (!win) {
          remove();
          reject(new Error('the print frame has no window'));
          return;
        }
        win.addEventListener('afterprint', remove, { once: true });
        try {
          win.focus();
          win.print();
          resolve();
        } catch (e) {
          remove();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
      { once: true },
    );
    frame.addEventListener(
      'error',
      () => {
        remove();
        reject(new Error('the typeset PDF could not be loaded for printing'));
      },
      { once: true },
    );

    frame.src = url;
    container.appendChild(frame);
  });
}

/** Resolution of the pages drawn for printing: a provisional default, not a measurement. */
export const PRINT_DPI = 150;

function hideFrame(frame: HTMLIFrameElement): void {
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.style.visibility = 'hidden';
}

/** The viewer draws the pages; a print-only frame of this page's origin prints them. */
async function printThroughViewer(url: string, container: Node, viewerUrl: string): Promise<void> {
  const owner = container.ownerDocument ?? document;
  const { PdfViewerFrame } = await import('./pdf/viewer-frame.ts');
  const viewer = new PdfViewerFrame(container as Element, { url: viewerUrl });
  hideFrame(viewer.frame);
  let pages: Awaited<ReturnType<typeof viewer.renderAll>>;
  try {
    await viewer.open({ url });
    pages = await viewer.renderAll(PRINT_DPI);
  } finally {
    viewer.destroy();
  }

  const frame = owner.createElement('iframe');
  hideFrame(frame);
  const blobUrl = URL.createObjectURL(
    new Blob(['<!doctype html><meta charset="utf-8"><title></title>'], { type: 'text/html' }),
  );
  const remove = (): void => {
    frame.remove();
    URL.revokeObjectURL(blobUrl);
    for (const p of pages) p.bitmap.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      frame.addEventListener('error', () => reject(new Error('the print frame did not load')), {
        once: true,
      });
      frame.src = blobUrl;
      container.appendChild(frame);
    });
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc) throw new Error('the print frame has no window');
    doc.body.style.margin = '0';
    for (const page of pages) {
      const canvas = doc.createElement('canvas');
      canvas.width = page.bitmap.width;
      canvas.height = page.bitmap.height;
      canvas.getContext('2d')?.drawImage(page.bitmap, 0, 0);
      // Each page fills the width of the paper and starts a new sheet; CSSOM writes only.
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.style.breakAfter = 'page';
      doc.body.appendChild(canvas);
    }
    win.addEventListener('afterprint', remove, { once: true });
    win.focus();
    win.print();
  } catch (e) {
    remove();
    throw e instanceof Error ? e : new Error(String(e));
  }
}
