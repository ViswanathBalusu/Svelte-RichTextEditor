/**
 * Figure kept with its caption in the compiled PDF (Node.js only, sandbox): EXP-028 criterion 5.
 * The converter's bundle is compiled in the export worker's sandbox (Podman) through `test/harness.ts`.
 *
 * The test builds documents of trials. Each trial starts a page with a one-line spacer paragraph
 * whose space after is S twips, followed by a figure (a picture one inch high and a one-line
 * caption). As S grows, the figure is pushed down the page. The page of each picture comes from the
 * class's layout report (layout.json, 1-based), and the page of each caption from `pdftotext` (the
 * form feed separates the pages).
 *
 * 1. A coarse sweep over S, with the class as shipped, finds the largest S at which the figure
 *    still starts on the spacer's page.
 * 2. A fine sweep from there covers the values of S at which the picture still fits at the foot of
 *    the page and the caption does not. The same document is compiled twice: with the class as
 *    shipped, and with the class's `\penalty\@M` between picture and caption (in `\DE@figbody`)
 *    removed. Without the penalty, at least one trial must print its picture and its caption on
 *    different pages: this shows that a page break falls between them in that trial. With the
 *    penalty, every picture is on the page of its caption, and in those trials the whole figure
 *    has moved to the next page.
 *
 * The values of S come from the search, not from fixed numbers, so the test does not depend on the
 * page size or the font metrics.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { convert } from './index.ts';
import { doc, nid, para, type J } from '../test/docs.ts';
import {
  classFiles,
  compileBundle,
  imageFonts,
  keep,
  pdfText,
  sandboxReady,
  type Compiled,
} from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';

/** The keep rule of the class, as written in `\DE@figbody`. */
const KEEP_RULE = '\\penalty\\@M #3}';

interface Trial {
  space: number;
  spacerId: string;
  figId: string;
  /** Printed in the caption; the trailing `Q` keeps `CAP1Q` from matching `CAP10Q`. */
  tag: string;
}

interface Placed {
  space: number;
  spacerPage: number;
  picturePage: number;
  captionPage: number;
}

function trials(spaces: number[], run: string): { body: J[]; trials: Trial[] } {
  const body: J[] = [];
  const out: Trial[] = [];
  spaces.forEach((space, i) => {
    const spacer = para(`Spacer ${run} ${i}.`, {
      spaceBefore: 0,
      spaceAfter: space,
      ...(i > 0 ? { pageBreakBefore: true } : {}),
    });
    const figId = nid(`fig${run}`);
    const tag = `CAP${run}${i}Q`;
    body.push(spacer, {
      type: 'figure',
      attrs: { id: figId, width: 2880, height: 1440, alt: `Figure ${i}`, placement: 'here' },
      content: [
        {
          type: 'caption',
          attrs: { id: nid(`cap${run}`) },
          content: [{ type: 'text', text: tag }],
        },
      ],
    });
    out.push({ space, spacerId: (spacer['attrs'] as J)['id'] as string, figId, tag });
  });
  return { body, trials: out };
}

async function compile(body: J[], name: string, cls: Record<string, string>): Promise<Compiled> {
  const bundle = await convert(doc(body), {
    fonts: await imageFonts(),
    classFiles: cls,
    profile: 'preview',
    title: name,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
  } as never);
  const c = await compileBundle(bundle);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed (${keep(name, c)}):\n${c.compile.log.slice(-1500)}`);
  expect(c.layoutErrors).toEqual([]);
  return c;
}

function place(c: Compiled, list: Trial[]): Placed[] {
  const text = pdfText(c.compile.pdf!);
  if (text === null) throw new Error('pdftotext is not installed or failed');
  const pages = text.split('\f');
  return list.map((t) => {
    const spacer = c.layout?.blocks[t.spacerId];
    const picture = c.layout?.blocks[t.figId];
    if (!spacer || !picture) throw new Error(`no layout block for the trial with space ${t.space}`);
    const captionPage = pages.findIndex((p) => p.includes(t.tag)) + 1;
    expect(captionPage, `caption ${t.tag} is printed`).toBeGreaterThan(0);
    return { space: t.space, spacerPage: spacer.page, picturePage: picture.page, captionPage };
  });
}

describe.skipIf(!ready)('EXP-028 criterion 5: a figure stays on the page of its caption', () => {
  it('keeps picture and caption together when a page break would fall between them', async () => {
    const shipped = classFiles();
    const cls = shipped['docedit.cls'] ?? '';
    expect(cls.split(KEEP_RULE).length - 1, 'the class has one keep rule in \\DE@figbody').toBe(1);
    const withoutRule = { ...shipped, 'docedit.cls': cls.replace(KEEP_RULE, '#3}') };

    // 1. Coarse sweep: 0 to 16000 twips (more than a page body) in steps of 400.
    const coarseSpaces = Array.from({ length: 41 }, (_, i) => i * 400);
    const coarse = trials(coarseSpaces, 'C');
    const coarsePlaced = place(
      await compile(coarse.body, 'exp-028-keep-coarse', shipped),
      coarse.trials,
    );
    const fits = coarsePlaced.filter((p) => p.picturePage === p.spacerPage);
    const moved = coarsePlaced.filter((p) => p.picturePage > p.spacerPage);
    expect(fits.length, 'some figures start on the page of their spacer').toBeGreaterThan(0);
    expect(moved.length, 'some figures are pushed to the next page').toBeGreaterThan(0);
    const start = Math.max(...fits.map((p) => p.space));

    // 2. Fine sweep: from the last coarse value that fits, in steps of 20 twips (one point), over
    // the coarse step plus the height of a caption and its gaps.
    const fineSpaces = Array.from({ length: 61 }, (_, i) => start + i * 20);
    const fineShipped = trials(fineSpaces, 'F');
    const withPenalty = place(
      await compile(fineShipped.body, 'exp-028-keep-fine', shipped),
      fineShipped.trials,
    );
    const fineBare = trials(fineSpaces, 'F');
    const withoutPenalty = place(
      await compile(fineBare.body, 'exp-028-keep-fine-bare', withoutRule),
      fineBare.trials,
    );

    // Without the keep rule, a page break falls between picture and caption in some trials.
    const split = withoutPenalty.filter((p) => p.picturePage !== p.captionPage);
    expect(
      split.length,
      'without the keep rule some picture is printed apart from its caption',
    ).toBeGreaterThan(0);
    for (const p of split)
      expect(
        p.picturePage,
        `without the rule, picture at space ${p.space} is on its spacer's page`,
      ).toBe(p.spacerPage);

    // With the keep rule, every picture is on the page of its caption.
    for (const p of withPenalty)
      expect(p.picturePage, `picture and caption at space ${p.space} share a page`).toBe(
        p.captionPage,
      );

    // In the trials that split without the rule, the whole figure moved to the next page.
    const splitSpaces = new Set(split.map((p) => p.space));
    for (const p of withPenalty.filter((q) => splitSpaces.has(q.space))) {
      expect(
        p.picturePage,
        `with the rule, the figure at space ${p.space} starts the next page`,
      ).toBe(p.spacerPage + 1);
    }
  }, 900_000);
});
