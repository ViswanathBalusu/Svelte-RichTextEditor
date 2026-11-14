/**
 * UX-040 criterion 3 and FE-020 in a browser: the hidden print frame of `printPdfAtUrl` is mounted
 * in the container the element passes (its shadow root), never in the host page's document. Runs
 * in Chromium, Firefox and WebKit (`*.universal.test.ts`); skipped in Node.js, which has no DOM.
 *
 * The frame is removed in the same task it is mounted in, before its document can load, so no
 * print dialogue opens in the test browser. This test does not show that a PDF prints.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { printPdfAtUrl } from './print-frame.ts';

const isBrowser = typeof document !== 'undefined';
const HOST_ID = 'v-ux-031-045-print-host';

describe.skipIf(!isBrowser)('print frame mount point (FE-020; UX-040 criterion 3)', () => {
  afterEach(() => {
    document.getElementById(HOST_ID)?.remove();
  });

  it('appends the hidden frame to the shadow root and nothing to the host document', () => {
    const host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const bodyChildren = document.body.childElementCount;

    const url = URL.createObjectURL(new Blob(['<p>V-UX-031-045</p>'], { type: 'text/html' }));
    void printPdfAtUrl(url, root);

    const frame = root.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.parentNode).toBe(root);
    expect(frame?.getAttribute('aria-hidden')).toBe('true');
    expect(frame?.getAttribute('tabindex')).toBe('-1');
    expect(frame?.style.visibility).toBe('hidden');
    expect(document.body.childElementCount).toBe(bodyChildren);
    expect(document.body.querySelector(':scope > iframe')).toBeNull();

    frame?.remove();
    URL.revokeObjectURL(url);
  });
});
