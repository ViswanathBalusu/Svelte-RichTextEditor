/**
 * The browser Worker entry for `fe-075-tree-crossing.universal.test.ts` (FE-075, criterion 3): lays
 * out a document of about 100 pages once, inside the Worker, and then answers each request with the
 * layout tree, one page of it, or an empty reply, so that the main thread can measure what receiving
 * each costs it. Not a test file: vitest does not collect it. The Worker global is not typed here (the
 * universal package has no DOM types), so it is reached through a structural type.
 */
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { layoutFlow } from './engine.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import type { LayoutTree } from './tree.ts';

declare const performance: { now(): number; timeOrigin: number };

/** The paragraphs of the test document; chosen so that the layout runs to a little over 100 pages. */
const PARAGRAPHS = 1100;

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

function envelope(paragraphs: number): CdmEnvelopeLike {
  const body: CdmNode[] = [];
  for (let i = 0; i < paragraphs; i++) {
    // About 70 words, so a paragraph is a handful of lines at the body width.
    const words = Array.from({ length: 60 + (i % 21) }, (_, w) => `item${i}w${w}`).join(' ');
    body.push({
      type: 'paragraph',
      attrs: { id: `p${i}`, style: 'Normal' },
      content: [{ type: 'text', text: words }],
    });
  }
  return {
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
                fontFamily: 'Noto Serif',
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

/** Lays out the test document with the stock measurer, break provider and line breaker. */
function layoutTestDocument(paragraphs: number = PARAGRAPHS): LayoutTree {
  return layoutFlow(toFlow(envelope(paragraphs)), {
    measurer: fixedWidthMeasurer(),
    breaks: afterSpace,
    lineBreaker: firstFitBreaker,
  }).tree;
}

interface Scope {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: { kind: string; page?: number } }) => void) | null;
}

const scope = globalThis as unknown as Scope;
{
  const tree = layoutTestDocument();
  scope.onmessage = (event) => {
    // The send time on the shared clock of the page and its Workers, so the receiver can read the
    // whole round trip; the receiver's own measure is the block it makes on its main thread.
    const sentAt = performance.timeOrigin + performance.now();
    const { kind, page } = event.data;
    if (kind === 'full') scope.postMessage({ kind, sentAt, tree });
    else if (kind === 'page')
      scope.postMessage({ kind, sentAt, pages: tree.pages.slice(page ?? 0, (page ?? 0) + 1) });
    else if (kind === 'info')
      scope.postMessage({ kind, pages: tree.pages.length, json: JSON.stringify(tree).length });
    else scope.postMessage({ kind, sentAt });
  };
}
