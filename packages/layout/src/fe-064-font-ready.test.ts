/**
 * FE-064 criterion 1 in Node.js, with fake faces: `FontAwareLayout.ready` waits for the faces of the
 * aliases a pass needs before the pass measures, so the pass that follows measures the loaded face
 * and sees no new arrival. The browser run with a real FontFace is `fe-064-font-ready.universal.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { faceArrivals, type LoadableFaceLike } from './font-arrivals.ts';
import { FontAwareLayout } from './font-pass.ts';
import { toFlow, type CdmEnvelopeLike } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';

/** A face that a test finishes loading, as a FontFace loaded elsewhere would. */
function pendingFace(family: string) {
  let finish!: () => void;
  const loaded = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const face = {
    family,
    status: 'unloaded' as string,
    loads: 0,
    loaded,
    load() {
      face.loads += 1;
      return loaded;
    },
    finishLoading() {
      face.status = 'loaded';
      finish();
    },
  };
  return face;
}

const A = `de-font-${'7'.repeat(64)}`;
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
const providers = { breaks: afterSpace, lineBreaker: firstFitBreaker };

describe('FontAwareLayout.ready: a pass waits for its faces (FE-064 criterion 1)', () => {
  it('waits for an unloaded face before the pass measures, then the pass sees no new arrival', async () => {
    const face = pendingFace(A);
    const layout = new FontAwareLayout({
      measurer: fixedWidthMeasurer(),
      arrivals: faceArrivals(() => [face as LoadableFaceLike], { load: true }),
    });
    const before = layout.measurer().id;

    const ready = layout.ready([A]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(face.loads).toBe(1); // the source starts the load it waits for
    expect(layout.epoch.value).toBe(0); // nothing has advanced while the face is pending

    face.finishLoading();
    await expect(ready).resolves.toBe(true);
    expect(layout.epoch.value).toBe(1);
    expect(layout.measurer().id).not.toBe(before);

    const pass = layout.layout(toFlow(envelope(A)), providers);
    expect(pass.epoch).toBe(1); // the pass measures under the epoch the wait produced
    await expect(pass.fonts).resolves.toBe(false);
    expect(layout.epoch.value).toBe(1);
  });

  it('does not wait or advance for a face that is already loaded', async () => {
    const face = pendingFace(A);
    face.finishLoading();
    const layout = new FontAwareLayout({
      measurer: fixedWidthMeasurer(),
      arrivals: faceArrivals(() => [face as LoadableFaceLike], { load: true }),
    });
    await expect(layout.ready([A])).resolves.toBe(false);
    expect(face.loads).toBe(0);
    expect(layout.epoch.value).toBe(0);
  });

  it('resolves for an alias the page does not hold, with no advance', async () => {
    const layout = new FontAwareLayout({
      measurer: fixedWidthMeasurer(),
      arrivals: faceArrivals(() => [], { load: true }),
    });
    await expect(layout.ready([A])).resolves.toBe(false);
    expect(layout.epoch.value).toBe(0);
  });
});
