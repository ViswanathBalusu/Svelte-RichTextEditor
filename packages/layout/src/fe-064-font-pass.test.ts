/**
 * FE-064 criterion 2 in Node.js, with fake faces: the font source remembers how each face stood when
 * a pass measured under its alias, so a face loaded later by any route is one arrival, and the
 * layout pass (`FontAwareLayout`) tracks the aliases it measured. The browser run with a real
 * FontFace is `fe-064-font-arrivals.universal.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { faceArrivals, type LoadableFaceLike } from './font-arrivals.ts';
import { FontEpoch } from './font-epoch.ts';
import { FontAwareLayout, notingMeasurer } from './font-pass.ts';
import { toFlow, type CdmEnvelopeLike } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import { fixedWidthMeasurer, type FontKey } from './measure.ts';

/** A face whose load is resolved or rejected by the test, like a FontFace loaded elsewhere. */
function fakeFace(family: string, status = 'unloaded') {
  let settle!: (ok: boolean) => void;
  const face = {
    family,
    status,
    loads: 0,
    loaded: new Promise<void>((resolve, reject) => {
      settle = (ok) => {
        face.status = ok ? 'loaded' : 'error';
        if (ok) resolve();
        else reject(new Error('load failed'));
      };
    }),
    load() {
      face.loads += 1;
      return face.loaded;
    },
    /** Another route (the browser, another `load()` call) finishes loading the face. */
    finish(ok = true) {
      settle(ok);
    },
  };
  if (status === 'loaded') settle(true);
  face.loaded.catch(() => {});
  return face;
}

const A = `de-font-${'1'.repeat(64)}`;
const B = `de-font-${'2'.repeat(64)}`;

describe('faceArrivals: arrivals it did not start (FE-064 criterion 2)', () => {
  it('counts a face loaded by another route after the pass noted it', async () => {
    const face = fakeFace(A);
    const arrivals = faceArrivals(() => [face]);
    const epoch = new FontEpoch(0);
    arrivals.note(A);
    face.finish();
    await face.loaded;
    await epoch.track(arrivals, [A]);
    expect(epoch.value).toBe(1);
    expect(face.loads).toBe(0); // the source only waited
    await epoch.track(arrivals, [A]);
    expect(epoch.value).toBe(1);
  });

  it('does not count a face that was loaded when the pass noted it', async () => {
    const face = fakeFace(A, 'loaded');
    const epoch = new FontEpoch(0);
    const arrivals = faceArrivals(() => [face]);
    arrivals.note(A);
    await epoch.track(arrivals, [A]);
    expect(epoch.value).toBe(0);
  });

  it('counts the faces of an alias that had none when the pass measured it', async () => {
    const faces: ReturnType<typeof fakeFace>[] = [];
    const arrivals = faceArrivals(() => faces);
    arrivals.note(A); // measured with a fallback: no face holds the alias yet
    faces.push(fakeFace(A, 'loaded'));
    const epoch = new FontEpoch(0);
    await epoch.track(arrivals, [A]);
    expect(epoch.value).toBe(1);
  });

  it('leaves the epoch for a face that fails, and starts loads only when asked to', async () => {
    const failing = fakeFace(A);
    const epoch = new FontEpoch(0);
    const tracked = epoch.track(
      faceArrivals(() => [failing]),
      [A],
    );
    failing.finish(false);
    await tracked;
    expect(epoch.value).toBe(0);
    expect(failing.loads).toBe(0);

    const lazy = fakeFace(B);
    const loading = faceArrivals(() => [lazy], { load: true });
    const done = epoch.track(loading, [B]);
    await new Promise((resolve) => setTimeout(resolve, 0)); // `track` asks on a later turn
    expect(lazy.loads).toBe(1);
    lazy.finish();
    await done;
    expect(epoch.value).toBe(1);
  });
});

describe('FontAwareLayout: a layout pass that tracks its fonts (FE-064 criterion 2)', () => {
  const afterSpace: BreakOpportunities = {
    opportunities: (text) => [...text.matchAll(/ (?=\S)/g)].map((m) => m.index + 1),
  };
  const envelope = (family: string): CdmEnvelopeLike => ({
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'style_def',
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                fontFamily: family,
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
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'p1', style: 'Normal' },
              content: [{ type: 'text', text: 'Alpha beta' }],
            },
          ],
        },
      ],
    },
  });

  it('notes the aliases it measures, advances when one arrives, and hands out a new cache', async () => {
    const face = fakeFace(A);
    const layout = new FontAwareLayout({
      measurer: fixedWidthMeasurer(),
      arrivals: faceArrivals(() => [face]),
    });
    const before = layout.measurer();
    const pass = layout.layout(toFlow(envelope(A)), {
      breaks: afterSpace,
      lineBreaker: firstFitBreaker,
    });
    expect([...pass.aliases]).toEqual([A]);
    expect(pass.result.tree.measurer).toBe(before.id);
    face.finish();
    await expect(pass.fonts).resolves.toBe(true);
    expect(layout.epoch.value).toBe(1);
    expect(layout.measurer().id).not.toBe(before.id);
    const next = layout.layout(toFlow(envelope(A)), {
      breaks: afterSpace,
      lineBreaker: firstFitBreaker,
    });
    await expect(next.fonts).resolves.toBe(false);
    expect(layout.epoch.value).toBe(1);
  });

  it('notes each alias once per pass and leaves widths and the id unchanged', () => {
    const notes: string[] = [];
    const inner = fixedWidthMeasurer();
    const aliases = new Set<string>();
    const m = notingMeasurer(inner, { note: (a) => notes.push(a) }, aliases);
    const font: FontKey = { family: A, sizePt: 10, bold: false, italic: false };
    expect(m.id).toBe(inner.id);
    expect(m.advance(font, 'abc')).toBe(inner.advance(font, 'abc'));
    m.lineMetrics(font);
    m.advances?.({ ...font, family: B }, 'x');
    expect(notes).toEqual([A, B]);
    expect([...aliases]).toEqual([A, B]);
  });
});

// Keep the structural type honest: a fake face is a LoadableFaceLike.
const _check: LoadableFaceLike = fakeFace(A);
void _check;
