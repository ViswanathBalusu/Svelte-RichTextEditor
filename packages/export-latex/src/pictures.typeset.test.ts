/**
 * Pictures and figures (Node.js only): the converter's output for images and figures (EXP-028). The
 * tests read main.tex and the class source. They do not compile a PDF, so they do not show the
 * picture at its size or where a float lands; criteria 3 to 5 (caption label, alternative text,
 * keeping a figure with its caption across a page break) stay unticked, see the story Notes.
 */
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';

const CLASS = readFileSync(new URL('../class/docedit.cls', import.meta.url), 'utf8');

const SHA = 'e'.repeat(64);
const ASSETS = {
  asset1: {
    sha256: SHA,
    mediaType: 'image/png',
    status: 'ready' as const,
    bytes: new Uint8Array([137, 80, 78, 71]),
  },
};

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

/** A figure block with the given attributes, and no caption. */
function figure(attrs: J): J {
  return {
    type: 'figure',
    attrs: {
      id: nid('f'),
      asset: 'asset1',
      width: 2880,
      height: 1440,
      alt: 'A test picture',
      ...attrs,
    },
  };
}

describe('EXP-028 a picture is set with graphicx at its width and height through dimen (criterion 1)', () => {
  it('writes an inline image with \\DEimg, its file and a width and height in points', async () => {
    const pid = nid('p');
    const img: J = {
      type: 'image',
      attrs: { id: nid('i'), asset: 'asset1', width: 2880, height: 1440, alt: 'Inline' },
    };
    const b = await run(doc([para('Before ', { id: pid }, [img])]), { assets: ASSETS });
    const line = blockLines(b, pid).join('\n');
    expect(line).toMatch(/\\DEimg\{assets\/e{64}\.png\}\{[0-9.]+bp\}\{[0-9.]+bp\}\{\d+\}/);
    expect(line).not.toContain('\\DEph{');
  });

  it("writes a block figure with \\DEimg at the figure's own width and height", async () => {
    const f = figure({ width: 2880, height: 1440 });
    const b = await run(doc([f]), { assets: ASSETS });
    const body = blockLines(b, idOf(f)).join('\n');
    expect(body).toMatch(/\\DEimg\{assets\/e{64}\.png\}\{[0-9.]+bp\}\{[0-9.]+bp\}/);
  });

  it('gives a width and height that are the dimensions twips converted, for any size (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 20, max: 20000 }),
        fc.integer({ min: 20, max: 20000 }),
        async (w, h) => {
          const f = figure({ width: w, height: h });
          const b = await run(doc([f]), { assets: ASSETS });
          const body = blockLines(b, idOf(f)).join('\n');
          const m = /\\DEimg\{[^}]*\}\{([0-9.]+)bp\}\{([0-9.]+)bp\}/.exec(body);
          expect(m).not.toBeNull();
          expect(Number(m![1])).toBeCloseTo((w * 72) / 1440, 2);
          expect(Number(m![2])).toBeCloseTo((h * 72) / 1440, 2);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('is set by graphicx with the explicit width and height the macro is given', () => {
    expect(CLASS).toContain('\\includegraphics[width=#2,height=#3,alt=#5]{#1}');
  });
});

describe('EXP-028 placement here stays in place, float may float (criterion 2)', () => {
  it('writes a body figure with placement here as not floating, and float as floating', async () => {
    const here = figure({ placement: 'here' });
    const float = figure({ placement: 'float' });
    const b = await run(doc([here, float]), { assets: ASSETS });
    expect(blockLines(b, idOf(here)).join('\n')).toMatch(/\\DEfig\{\d+\}\{0\}/);
    expect(blockLines(b, idOf(float)).join('\n')).toMatch(/\\DEfig\{\d+\}\{1\}/);
  });

  it('writes float as the only placement that may float, and any other placement as not floating (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('here', 'float', undefined), async (placement) => {
        const f = figure(placement === undefined ? {} : { placement });
        const b = await run(doc([f]), { assets: ASSETS });
        const want = placement === 'float' ? '1' : '0';
        expect(blockLines(b, idOf(f)).join('\n')).toMatch(
          new RegExp(`\\\\DEfig\\{\\d+\\}\\{${want}\\}`),
        );
      }),
      { numRuns: 15 },
    );
  });

  it('keeps the class rule that a floating figure may move, and a here figure does not', () => {
    expect(CLASS).toMatch(/\\ifnum#2=1 \\begin\{figure\}\[tbp\]/);
    expect(CLASS).toMatch(/\\else \\DE@figbody\{#3\}\{#4\}\{#5\}\\fi/);
  });
});
