/**
 * FE-005 (02 §2.1; ADR 0419 item 2): the page view while the element is suspended, in a real browser
 * with the page's own font set (Chromium, Firefox and WebKit through `pnpm test:browsers`; skipped
 * in Node.js, which has no canvas and no font set).
 *
 * The page view listens for `loadingdone` on `document.fonts`, because a face that arrives changes
 * the widths (FE-064). The font set is an object of the host page, so a suspended view must not be
 * reachable from it. These tests count the view's listener on the real font set, and count the
 * layout passes: none while suspended, none on return when no face arrived, one on return when a
 * face did.
 */
import notoSerifUrl from '../../perf/fonts/files/NotoSerif-Regular.ttf?url';
import { EditorCore } from '@docedit/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { mountPageView } from './page-view/page-view.ts';

const hasDom =
  typeof document !== 'undefined' &&
  typeof HTMLCanvasElement !== 'undefined' &&
  typeof FontFace === 'function';

const FAMILY = 'W1-FE-005 Arriving Serif';

function smallDocument() {
  const body = Array.from({ length: 6 }, (_, i) => ({
    type: 'paragraph',
    attrs: { id: `p${String(i).padStart(7, '0')}`, style: 'Normal' },
    content: [{ type: 'text', text: `Paragraph ${i}: the quick brown fox jumps over the dog.` }],
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
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
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

/**
 * Counts the `loadingdone` listeners that are added to and removed from the page's font set from
 * now on. The wrappers sit on the font set itself and change nothing else; `restore` removes them.
 */
function watchFontSet() {
  const set = document.fonts;
  const held = new Set<unknown>();
  const add = set.addEventListener.bind(set);
  const remove = set.removeEventListener.bind(set);
  set.addEventListener = ((type: string, fn: unknown, options?: unknown) => {
    if (type === 'loadingdone' && fn) held.add(fn);
    add(type, fn as EventListener, options as AddEventListenerOptions);
  }) as typeof set.addEventListener;
  set.removeEventListener = ((type: string, fn: unknown, options?: unknown) => {
    if (type === 'loadingdone') held.delete(fn);
    remove(type, fn as EventListener, options as EventListenerOptions);
  }) as typeof set.removeEventListener;
  return {
    count: () => held.size,
    restore: () => {
      Reflect.deleteProperty(set, 'addEventListener');
      Reflect.deleteProperty(set, 'removeEventListener');
    },
  };
}

let arrivals = 0;

/**
 * Loads a face the page does not have yet. Resolves with whether the font set raised `loadingdone`
 * for it: the event follows the load in a task of its own, so the function waits for it, up to two
 * seconds. Chromium and Firefox raise it. Playwright's WebKit raises `loading` and never
 * `loadingdone` (measured on 2026-11-20 for `FontFace.load()`, `document.fonts.load()` and a face
 * used by a style), so there the answer is false. The listener is added through the prototype, so
 * `watchFontSet` does not count it.
 */
async function faceArrives(): Promise<boolean> {
  const set = document.fonts;
  let raised = false;
  const onDone = (): void => {
    raised = true;
  };
  EventTarget.prototype.addEventListener.call(set, 'loadingdone', onDone);
  try {
    const face = new FontFace(`${FAMILY} ${++arrivals}`, `url("${notoSerifUrl}")`);
    set.add(face);
    await face.load();
    const deadline = performance.now() + 2000;
    while (!raised && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return raised;
  } finally {
    EventTarget.prototype.removeEventListener.call(set, 'loadingdone', onDone);
  }
}

function setup() {
  const core = new EditorCore({
    doc: smallDocument() as never,
    schedule: (run) => queueMicrotask(run),
  });
  const parent = document.createElement('div');
  parent.style.cssText = 'width:900px;';
  document.body.append(parent);
  let failure: unknown = null;
  let layouts = 0;
  const view = mountPageView({
    host: core,
    parent,
    label: 'Document',
    // A synchronous frame: a layout pass that is asked for has run when the call returns.
    frame: (run) => run(),
    onLayout: () => {
      layouts++;
    },
    onError: (e) => (failure = e),
  });
  return {
    view,
    parent,
    layouts: () => layouts,
    failure: () => failure,
    done() {
      view.destroy();
      core.destroy();
      parent.remove();
    },
  };
}

describe.skipIf(!hasDom)('the page view while the element is suspended (FE-005)', () => {
  afterEach(() => {
    for (const face of Array.from(document.fonts))
      if (face.family.includes('W1-FE-005')) document.fonts.delete(face);
  });

  it('holds one listener on the font set, none while suspended, and one again after', () => {
    const fonts = watchFontSet();
    const s = setup();
    try {
      expect(fonts.count()).toBe(1);
      s.view.suspend();
      expect(fonts.count()).toBe(0);
      // A second suspension, and a second return, change nothing.
      s.view.suspend();
      expect(fonts.count()).toBe(0);
      s.view.resume();
      expect(fonts.count()).toBe(1);
      s.view.resume();
      expect(fonts.count()).toBe(1);
      // The pages are still there: the view was never unmounted.
      expect(s.parent.querySelectorAll('.de-page-view .de-page').length).toBeGreaterThan(0);
      expect(s.failure()).toBeNull();
    } finally {
      s.done();
      expect(fonts.count()).toBe(0);
      fonts.restore();
    }
  });

  it('does not lay out again on return when no face arrived meanwhile', () => {
    const s = setup();
    try {
      const before = s.layouts();
      expect(before).toBe(1);
      s.view.suspend();
      s.view.resume();
      expect(s.layouts()).toBe(before);
      expect(s.failure()).toBeNull();
    } finally {
      s.done();
    }
  });

  it('not suspended, it lays out again when the font set reports a face (the control)', async (ctx) => {
    const s = setup();
    try {
      const before = s.layouts();
      const raised = await faceArrives();
      // Without the event the view hears nothing, suspended or not: nothing to compare with here.
      // That an arriving face goes unheard in such an engine is FE-064's, not this story's.
      if (!raised) ctx.skip('this engine raises no loadingdone on document.fonts');
      expect(s.layouts()).toBe(before + 1);
      expect(s.failure()).toBeNull();
    } finally {
      s.done();
    }
  });

  it('suspended, it does nothing when a face arrives, and lays out once on return', async () => {
    const s = setup();
    try {
      const before = s.layouts();
      s.view.suspend();
      await faceArrives();
      // Where the font set raised `loadingdone` (see the control), the view did not hear it.
      expect(s.layouts()).toBe(before);
      // On return the view compares the loaded faces with those at the suspension, so the face is
      // found in every engine, also in one that raises no event.
      s.view.resume();
      expect(s.layouts()).toBe(before + 1);
      // The face is known now: a second suspension and return finds nothing new.
      s.view.suspend();
      s.view.resume();
      expect(s.layouts()).toBe(before + 1);
      expect(s.failure()).toBeNull();
    } finally {
      s.done();
    }
  });

  it('destroyed while suspended, it leaves nothing on the font set and a return does nothing', () => {
    const fonts = watchFontSet();
    const s = setup();
    try {
      s.view.suspend();
      s.view.destroy();
      expect(fonts.count()).toBe(0);
      const before = s.layouts();
      s.view.resume();
      s.view.suspend();
      expect(fonts.count()).toBe(0);
      expect(s.layouts()).toBe(before);
      expect(s.failure()).toBeNull();
    } finally {
      s.done();
      fonts.restore();
    }
  });
});
