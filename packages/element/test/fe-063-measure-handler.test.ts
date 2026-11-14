/**
 * FE-063 in Node.js, with a fake scope: the measuring worker's sequence (`measureHandler`,
 * src/worker-fonts.ts) registers on the scope's own font set before any measurement, refuses a
 * measurement before `start`, and takes no width until the font set has loaded the face. The browser
 * run with a real Worker is `src/fe-063-worker-fonts.universal.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { CanvasFontKey, CanvasTextMeasurer } from '../src/canvas-measure.ts';
import { fontAlias, type FontFileEntry } from '../src/font-registration.ts';
import { cssFont, measureHandler } from '../src/worker-fonts.ts';

const HASH = 'a'.repeat(64);
const ALIAS = fontAlias(HASH);
const entries: readonly FontFileEntry[] = [
  {
    family: 'Noto Serif',
    style: 'normal',
    weight: '400',
    url: '/f.ttf',
    hash: HASH,
    licence: 'OFL-1.1',
  },
];
const font: CanvasFontKey = { family: ALIAS, sizePt: 11, bold: false, italic: false };

function fakeScope() {
  const events: string[] = [];
  const faces: Array<{ family: string }> = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fonts = {
    add(face: { family: string }) {
      events.push(`add ${face.family}`);
      faces.push(face);
    },
    [Symbol.iterator]: () => faces[Symbol.iterator](),
    async load(css: string) {
      events.push(`load ${css}`);
      const match = faces.filter((f) => css.endsWith(`"${f.family}"`));
      if (match.length) await gate;
      events.push('loaded');
      return match;
    },
  };
  class FontFace {
    readonly family: string;
    constructor(family: string) {
      this.family = family;
    }
  }
  const measurer = (): CanvasTextMeasurer => ({
    id: 'fake',
    advance: (_f, text) => {
      events.push('measure');
      return text.length;
    },
    lineMetrics: () => ({ ascent: 0, descent: 0, lineGap: 0 }),
  });
  return { scope: { fonts, FontFace }, events, measurer, release };
}

describe('measureHandler: register, then wait, then measure (FE-063 criteria 1 and 3)', () => {
  it('refuses a measurement before start, so nothing is measured without the aliases', async () => {
    const f = fakeScope();
    const handle = measureHandler(f.scope, f.measurer);
    await expect(handle({ kind: 'measure', id: 1, font, text: 'abc' })).resolves.toMatchObject({
      kind: 'error',
      code: 'not_started',
    });
    expect(f.events).toEqual([]);
  });

  it('registers on its own font set, waits for the load, and only then measures', async () => {
    const f = fakeScope();
    const handle = measureHandler(f.scope, f.measurer);
    await expect(handle({ kind: 'start', id: 1, entries })).resolves.toEqual({
      kind: 'started',
      id: 1,
      aliases: [ALIAS],
    });
    const width = handle({ kind: 'measure', id: 2, font, text: 'abcd' });
    await new Promise((r) => setTimeout(r, 10));
    expect(f.events).toEqual([`add ${ALIAS}`, `load ${cssFont(font)}`]);
    f.release();
    await expect(width).resolves.toEqual({ kind: 'width', id: 2, width: 4 });
    expect(f.events).toEqual([`add ${ALIAS}`, `load ${cssFont(font)}`, 'loaded', 'measure']);
  });

  it('answers face_missing, and does not measure, for an alias no face holds', async () => {
    const f = fakeScope();
    const handle = measureHandler(f.scope, f.measurer);
    await handle({ kind: 'start', id: 1, entries });
    const other = { ...font, family: fontAlias('b'.repeat(64)) };
    await expect(handle({ kind: 'measure', id: 2, font: other, text: 'x' })).resolves.toMatchObject(
      {
        kind: 'error',
        code: 'face_missing',
      },
    );
    expect(f.events).not.toContain('measure');
  });

  it('names the face to load with the measurer CSS font, without a fallback family', () => {
    expect(cssFont({ ...font, bold: true, italic: true })).toBe(
      `italic bold ${11 * (4 / 3)}px "${ALIAS}"`,
    );
  });
});
