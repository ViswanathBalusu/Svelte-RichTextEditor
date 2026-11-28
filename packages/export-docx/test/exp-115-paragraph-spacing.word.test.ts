/**
 * EXP-115 criterion 2, paragraph spacing, DOCX side (EXP-090 criterion 6): the `pairs` and the
 * `flows` of the model's shared fixture `paragraph-spacing.json` written by `writeDocx`, laid out
 * by Microsoft Word 16 and measured in the PDF it exports (`pdftotext -bbox`), as the LaTeX runners
 * do (`cdm-043-gap-compile.test.ts` and `exp-115-paragraph-spacing.compile.test.ts`).
 *
 * Every paragraph gets a text of its own (`W1`, `W2`, ...), so that the PDF names it. Each document
 * is laid out twice, as the fixture has it and with the spacing of every paragraph set to zero by
 * direct properties. For a gap between two blocks on one page, the difference of the distance
 * between their anchor words in the two PDFs is the gap that Word placed; it must equal the
 * fixture's `gap` within 5 twips (Word's PDF export places text on a grid of about 0.12 pt, and two positions are subtracted). The anchor of a paragraph is its word, of a figure its caption,
 * of a table the first word of its first row when it is the lower block and of its last row when it
 * is the upper one (the rows are as high in both documents), of an equation its label. In the
 * body, the paragraphs inside table cells keep their spacing in the second document, so that a
 * table is as high in both; a gap in a cell is compared with a document that has no spacing at all.
 * A gap that starts at the top of the body is compared by the position of the block below.
 *
 * A section break of a flow is written as continuous, so that the gap across it is on one page.
 *
 * Not measured, and listed in the failure message: a trailing gap (nothing follows it), the leading
 * gap of a cell, a gap across a page, the containers `footnote` and `story` of the flows (a header
 * story is not printed by a document that does not use it).
 *
 * Node.js only, Windows with Word and `pdftotext`; skips without them (CI has no Word).
 * Evidence: `pnpm exec vitest run --project node packages/export-docx/test/exp-115-paragraph-spacing.word.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { AssetStore } from '../src/index.ts';
import { makePng } from './writer-docs.ts';
import {
  type DefsFile,
  type DocCase,
  type J,
  documentOf,
  findById,
  layOutInWord,
  loadSemantics,
  nodesOf,
  wordAvailable,
  wordsOf,
} from './exp-115-word.ts';

interface Side {
  styleId: string;
  spaceBefore: number;
  spaceAfter: number;
  contextualSpacing: boolean;
}
interface Pair {
  id: string;
  above: Side | null;
  below: Side | null;
  expected: number;
}
interface Gap {
  above: string | null;
  below: string | null;
  gap: number;
}
interface Flow extends DocCase {
  expected: { container: string; gaps: Gap[] }[];
}
interface File extends DefsFile {
  pairs: Pair[];
  flows: Flow[];
}

const FILE = loadSemantics<File>('paragraph-spacing');
const DIR = 'exp-115-paragraph-spacing';
/**
 * Word's PDF export places text on a grid of about 0.12 pt (2.4 twips): the same gap measured in two
 * documents differs by up to that much. Two measurements are subtracted, so the tolerance is two steps, 5 twips; the gaps that the rules tell apart differ by 40 twips or more.
 */
const TOL_TWIPS = 5;
/** How many gaps of each flow are measured in the PDF (the rest are listed in the failure message). */
const MEASURED: Readonly<Record<string, number>> = {
  'region-is-transparent': 4,
  'table-and-its-cells': 4,
  'table-style-in-cells': 3,
  'section-break-is-transparent': 2,
  'figure-and-equation': 4,
  'footnote-edges': 0,
  'story-edges': 0,
};
const ready = wordAvailable();

const para = (id: string, token: string, attrs: J): J => ({
  type: 'paragraph',
  attrs: { id, ...attrs },
  content: [{ type: 'text', text: token }],
});
const sideAttrs = (s: Side, plain: boolean): J => ({
  style: s.styleId,
  spaceBefore: plain ? 0 : s.spaceBefore,
  spaceAfter: plain ? 0 : s.spaceAfter,
  contextualSpacing: plain ? false : s.contextualSpacing,
});

/** The y of the word `token` (points from the top) and its page, or null when it is not printed. */
function place(name: string, token: string): { page: number; y: number } | null {
  const hits = wordsOf(DIR, name).filter((w) => w.text === token);
  if (hits.length !== 1) return null;
  return { page: hits[0]!.page, y: hits[0]!.yMin };
}

/** A copy of the flow whose paragraphs, captions and equations carry a token each; returns the anchors. */
function tokenised(flow: Flow, assetId: string): { flow: Flow; anchors: Map<string, string> } {
  const copy = structuredClone(flow) as Flow;
  const anchors = new Map<string, string>();
  let n = 0;
  const visit = (node: J): void => {
    const attrs = (node['attrs'] as J | undefined) ?? {};
    if (node['type'] === 'figure') {
      attrs['asset'] = assetId;
      for (const c of (node['content'] as J[] | undefined) ?? [])
        if (c['type'] === 'caption') {
          const token = `W${++n}`;
          c['content'] = [{ type: 'text', text: token }];
          anchors.set(String(attrs['id']), token);
        }
      return;
    }
    // A section break starts a page by default; here it is continuous, so that the gap across it is
    // on one page and can be measured (the spacing rule does not depend on where a section starts).
    if (node['type'] === 'section_break') attrs['start'] = 'continuous';
    // The equation is anchored at its equals sign, the only one of the document.
    if (node['type'] === 'equation_block') anchors.set(String(attrs['id']), '=');
    if (node['type'] === 'paragraph') {
      const token = `W${++n}`;
      const notes = ((node['content'] as J[] | undefined) ?? []).filter(
        (c) => c['type'] === 'footnote',
      );
      node['content'] = [{ type: 'text', text: token }, ...notes];
      anchors.set(String(attrs['id']), token);
    }
    const content = node['content'];
    if (Array.isArray(content)) for (const c of content as J[]) visit(c);
  };
  for (const b of [...(copy.body ?? []), ...(copy.stories ?? [])]) visit(b);
  // A table is anchored at the first paragraph of its first row (as the lower block) and of its last
  // row (as the upper block): `first:<id>` and `last:<id>`.
  for (const b of copy.body ?? [])
    for (const t of nodesOf(b)) {
      if (t['type'] !== 'table') continue;
      const rows = ((t['content'] as J[]) ?? []).filter((r) => r['type'] === 'table_row');
      const firstOf = (row: J | undefined): string | undefined => {
        const p = row ? [...nodesOf(row)].find((x) => x['type'] === 'paragraph') : undefined;
        return p ? anchors.get(String((p['attrs'] as J)['id'])) : undefined;
      };
      const id = String((t['attrs'] as J)['id']);
      const first = firstOf(rows[0]);
      const last = firstOf(rows[rows.length - 1]);
      if (first) anchors.set(`first:${id}`, first);
      if (last) anchors.set(`last:${id}`, last);
    }
  return { flow: copy, anchors };
}

/** The flow with every paragraph's spacing zero (`cells` false: not those inside table cells). */
function plainOf(flow: Flow, cells: boolean): Flow {
  const copy = structuredClone(flow) as Flow;
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as J;
    if (!cells && node['type'] === 'table_cell') return;
    if (node['type'] === 'paragraph') {
      const attrs = ((node['attrs'] as J | undefined) ?? {}) as J;
      attrs['spaceBefore'] = 0;
      attrs['spaceAfter'] = 0;
      attrs['contextualSpacing'] = false;
      node['attrs'] = attrs;
    }
    const content = node['content'];
    if (Array.isArray(content)) content.forEach(visit);
  };
  for (const b of copy.body ?? []) visit(b);
  return copy;
}

/**
 * Gaps of the flows that Word is known to place differently from the fixture, with the reason.
 * Each is asserted to still differ (by `placed`, in twips, within the tolerance), so that a change on
 * either side shows. Empty when none differs.
 */
const WORD_DIFFERS: Readonly<Record<string, { reason: string; placed: number }>> = {};

/**
 * Pairs that Word places differently from the fixture. Each is asserted to still differ, as stated.
 * The owner has not ruled on these (decision 238 is about labels), so the fixture is not changed.
 */
const PAIR_DIFFERS: Readonly<Record<string, { reason: string; placed: number }>> = {
  'contextual-only-above': {
    reason:
      'When only the upper paragraph has contextual spacing and both have one style, Word removes the whole gap, the space before of the lower paragraph too; the fixture removes only the space after of the upper one and keeps the 120 of the lower one.',
    placed: 0,
  },
};

describe.skipIf(!ready)('EXP-115 criterion 2: paragraph spacing as Word lays it out', () => {
  const store = new AssetStore();
  let assetId = '';
  let made: Promise<void> | undefined;
  const flows = FILE.flows.map((f) => ({ f, ...tokenisedLazy(f) }));
  const pairNames = FILE.pairs.map((p) => p.id);

  function tokenisedLazy(f: Flow): { get: () => ReturnType<typeof tokenised> } {
    let t: ReturnType<typeof tokenised> | undefined;
    return { get: () => (t ??= tokenised(f, assetId)) };
  }

  const laidOut = (): Promise<void> =>
    (made ??= (async () => {
      assetId = await store.add(makePng(80, 40), 'image/png', 'image');
      const docs = new Map<string, { env: ReturnType<typeof documentOf>; assets: AssetStore }>();
      for (const p of FILE.pairs) {
        for (const plain of [false, true]) {
          const name = `pair-${p.id}-${plain ? 'plain' : 'spaced'}`;
          let body: J[];
          if (p.above?.styleId === 'FootnoteText' && p.below) {
            body = [
              {
                type: 'paragraph',
                attrs: { id: 'pbodyxxxxxxxxxx', style: 'Body' },
                content: [
                  { type: 'text', text: 'Text' },
                  {
                    type: 'footnote',
                    attrs: { id: 'fnpairxxxxxxxxxx' },
                    content: [
                      para('fpaxxxxxxxxxxxxx', 'PairA', sideAttrs(p.above, plain)),
                      para('fpbxxxxxxxxxxxxx', 'PairB', sideAttrs(p.below, plain)),
                    ],
                  },
                ],
              },
            ];
          } else {
            body = [
              ...(p.above ? [para('paxxxxxxxxxxxxxx', 'PairA', sideAttrs(p.above, plain))] : []),
              ...(p.below ? [para('pbxxxxxxxxxxxxxx', 'PairB', sideAttrs(p.below, plain))] : []),
            ];
          }
          docs.set(name, {
            env: documentOf(FILE, { id: name, description: p.id }, body),
            assets: store,
          });
        }
      }
      for (const { f, get } of flows) {
        const { flow } = get();
        for (const [kind, c] of [
          ['spaced', flow],
          ['plain', plainOf(flow, true)],
          ['plainbody', plainOf(flow, false)],
        ] as const)
          docs.set(`flow-${f.id}-${kind}`, { env: documentOf(FILE, c), assets: store });
      }
      await layOutInWord(DIR, docs);
    })());

  describe('[paragraph-spacing x DOCX] pairs', () => {
    for (const p of FILE.pairs) {
      const measurable = p.below !== null;
      (measurable ? it : it.skip)(
        `[paragraph-spacing x DOCX] pair ${p.id}${measurable ? '' : ' (not run: a trailing gap has nothing after it to measure)'}${PAIR_DIFFERS[p.id] ? ' (Word differs from the fixture)' : ''}`,
        async () => {
          await laidOut();
          const at = (kind: string, token: string) => place(`pair-${p.id}-${kind}`, token);
          const b = at('spaced', 'PairB');
          const pb = at('plain', 'PairB');
          expect(b && pb, `PairB is printed in ${p.id}`).toBeTruthy();
          let placed: number;
          if (p.above === null) placed = (b!.y - pb!.y) * 20;
          else {
            const a = at('spaced', 'PairA');
            const pa = at('plain', 'PairA');
            expect(a && pa, `PairA is printed in ${p.id}`).toBeTruthy();
            expect(a!.page).toBe(b!.page);
            expect(pa!.page).toBe(pb!.page);
            placed = (b!.y - a!.y - (pb!.y - pa!.y)) * 20;
          }
          const differs = PAIR_DIFFERS[p.id];
          expect(
            Math.abs(placed - (differs ? differs.placed : p.expected)),
            `Word placed ${placed.toFixed(1)} twips, the fixture says ${p.expected}${differs ? `; ${differs.reason}` : ''}`,
          ).toBeLessThanOrEqual(TOL_TWIPS);
        },
        900_000,
      );
    }
    it('lists the pairs by name', () => expect(pairNames.length).toBe(FILE.pairs.length));
  });

  describe('[paragraph-spacing x DOCX] flows', () => {
    for (const { f, get } of flows) {
      // A flow with nothing measurable here (footnote and story containers) is skipped, not passed.
      (MEASURED[f.id] === 0 ? it.skip : it)(
        `[paragraph-spacing x DOCX] flow ${f.id}${MEASURED[f.id] === 0 ? ' (not run: no body or cell gap)' : ''}`,
        async () => {
          await laidOut();
          const { flow, anchors } = get();
          const body = (flow.body ?? []) as J[];
          const measured: string[] = [];
          const notMeasured: string[] = [];
          const wrong: string[] = [];
          const anchorOf = (id: string, role: 'upper' | 'lower'): string | undefined => {
            const node = findById([...body, ...((flow.stories ?? []) as J[])], id);
            if (node?.['type'] === 'table')
              return anchors.get(`${role === 'upper' ? 'last' : 'first'}:${id}`);
            return anchors.get(id);
          };
          for (const container of f.expected) {
            for (const g of container.gaps) {
              const label = `${container.container}: ${g.above ?? 'top'} -> ${g.below ?? 'end'}`;
              const inBody = container.container === 'body';
              const cell = findById(body, container.container)?.['type'] === 'table_cell';
              if (g.above === null && !inBody) {
                notMeasured.push(`${label} (leading gap outside the body)`);
                continue;
              }
              if (!inBody && !cell) {
                notMeasured.push(`${label} (a footnote or story container)`);
                continue;
              }
              if (g.below === null) {
                notMeasured.push(`${label} (a trailing gap: nothing follows it)`);
                continue;
              }
              const kind = cell ? 'plain' : 'plainbody';
              const bt = anchorOf(g.below, 'lower');
              const at = g.above === null ? undefined : anchorOf(g.above, 'upper');
              const b = bt ? place(`flow-${f.id}-spaced`, bt) : null;
              const pb = bt ? place(`flow-${f.id}-${kind}`, bt) : null;
              const a = at ? place(`flow-${f.id}-spaced`, at) : null;
              const pa = at ? place(`flow-${f.id}-${kind}`, at) : null;
              if (!b || !pb || (g.above !== null && (!a || !pa))) {
                notMeasured.push(`${label} (no anchor word in the PDF)`);
                continue;
              }
              if (g.above !== null && (a!.page !== b.page || pa!.page !== pb.page)) {
                notMeasured.push(`${label} (across a page)`);
                continue;
              }
              const placed =
                g.above === null ? (b.y - pb.y) * 20 : (b.y - a!.y - (pb.y - pa!.y)) * 20;
              const differs = WORD_DIFFERS[`${f.id} ${g.above ?? 'top'} -> ${g.below}`];
              const want = differs ? differs.placed : g.gap;
              if (Math.abs(placed - want) > TOL_TWIPS)
                wrong.push(
                  `${label}: Word placed ${placed.toFixed(1)} twips, the fixture says ${g.gap}${differs ? ` (expected to differ: ${differs.reason})` : ''}`,
                );
              measured.push(`${label} = ${placed.toFixed(0)}`);
            }
          }
          expect(wrong).toEqual([]);
          expect(
            measured.length,
            `${f.id}: gaps measured (not measured: ${notMeasured.join('; ')})`,
          ).toBe(MEASURED[f.id]);
        },
        900_000,
      );
    }
  });
});
