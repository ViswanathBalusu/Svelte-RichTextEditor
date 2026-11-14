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
 * Browser only: this module uses `document`. The unit and browser tests of the refusal do not reach
 * this function, because a refused print returns before `printPdf` runs.
 */
export function printPdfAtUrl(url: string, container: Node): Promise<void> {
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
