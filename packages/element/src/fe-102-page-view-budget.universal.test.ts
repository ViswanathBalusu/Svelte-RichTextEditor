/* eslint-disable no-restricted-syntax -- the events here are the browser's own scroll and input, made to drive the view; none is a component event (FE-022) */
/**
 * FE-102: what the page view costs on long documents, measured in a real browser (Chromium,
 * Firefox, WebKit through `pnpm test:browsers`; skipped in Node.js, which has no canvas). A figure
 * here is a measurement on the machine that ran the test, with the browser's own canvas and no CPU
 * throttling; it is not the reference machine of 11 §6, so it does not show that a target holds.
 *
 * - Virtualisation (criterion 2): however long the document is, only the visible pages and an
 *   overscan are in the DOM. The test uses 100 and 300 pages to stay quick; a run with 22,500
 *   paragraphs (979 pages) in Chromium gave 2 pages in the DOM and 7.2 s to the first paint.
 *   That is a figure of one run, not a claim that 1,000 pages are usable.
 * - Cost: the time of the first layout and paint, and of one keystroke from the bridge's `input`
 *   event to the painted result with the frame scheduler made synchronous, are written to the test's
 *   output (`FE-102 measurement ...`).
 */
import { EditorCore } from '@docedit/engine';
import { describe, expect, it } from 'vitest';
import { mountPageView } from './page-view/page-view.ts';

const hasDom = typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';

function longDocument(paragraphs: number) {
  const body = Array.from({ length: paragraphs }, (_, i) => ({
    type: 'paragraph',
    attrs: { id: `p${String(i).padStart(7, '0')}`, style: 'Normal' },
    content: [
      {
        type: 'text',
        text: `Paragraph ${i}: the quick brown fox jumps over the lazy dog, and then jumps back again to be sure of it, while the dog sleeps on.`,
      },
    ],
  }));
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontSize: 220,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

function setup(paragraphs: number) {
  const core = new EditorCore({
    doc: longDocument(paragraphs) as never,
    schedule: (run) => queueMicrotask(run),
  });
  const parent = document.createElement('div');
  parent.style.cssText = 'width:900px;';
  document.body.append(parent);
  let failure: unknown = null;
  const started = performance.now();
  const view = mountPageView({
    host: core,
    parent,
    label: 'Document',
    frame: (run) => run(),
    onError: (e) => (failure = e),
  });
  const scroller = parent.querySelector<HTMLElement>('.de-page-scroller')!;
  // The component's stylesheet is not loaded here: give the scroller the height and the scrolling it has there.
  scroller.style.cssText = 'height:700px;overflow:auto;';
  scroller.dispatchEvent(new Event('scroll'));
  return {
    core,
    view,
    parent,
    scroller,
    openMs: performance.now() - started,
    failure: () => failure,
    done() {
      view.destroy();
      core.destroy();
      parent.remove();
    },
  };
}

describe.skipIf(!hasDom)('the page view on long documents (FE-102)', () => {
  it('mounts only the visible pages and an overscan, in 100 and in about 300 pages', () => {
    for (const paragraphs of [2_250, 6_750]) {
      const s = setup(paragraphs);
      try {
        const pages = s.view.status()?.pages ?? 0;
        const mounted = s.parent.querySelectorAll('.de-window > .de-page').length;
        console.log(
          `FE-102 measurement: ${paragraphs} paragraphs, ${pages} pages, first layout and paint ${s.openMs.toFixed(0)} ms, ${mounted} pages in the DOM`,
        );
        expect(pages).toBeGreaterThan(paragraphs / 40);
        expect(mounted).toBeGreaterThan(0);
        expect(mounted).toBeLessThanOrEqual(5);
        // Scrolling to the end mounts the last pages and unmounts the first ones.
        s.scroller.scrollTop = s.scroller.scrollHeight;
        s.scroller.dispatchEvent(new Event('scroll'));
        const last = [...s.parent.querySelectorAll<HTMLElement>('.de-window > .de-page')].map((p) =>
          Number(p.dataset['page']),
        );
        expect(Math.max(...last)).toBe(pages - 1);
        expect(last.length).toBeLessThanOrEqual(5);
        expect(s.failure()).toBeNull();
      } finally {
        s.done();
      }
    }
  }, 60_000);

  it('measures one keystroke from the bridge to the painted page in a 100-page document', () => {
    const s = setup(2_250);
    try {
      const bridge = s.parent.querySelector<HTMLTextAreaElement>('.de-page-bridge')!;
      bridge.focus();
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        bridge.value = bridge.value + 'x';
        const t = performance.now();
        bridge.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x' }));
        samples.push(performance.now() - t);
      }
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)]!;
      const p95 = samples[Math.floor(samples.length * 0.95)]!;
      console.log(
        `FE-102 measurement: 100-page keystroke to paint, 20 samples: median ${median.toFixed(1)} ms, 95th ${p95.toFixed(1)} ms (layout and paint, synchronous frame, no throttling)`,
      );
      expect(s.failure()).toBeNull();
    } finally {
      s.done();
    }
  });
});
