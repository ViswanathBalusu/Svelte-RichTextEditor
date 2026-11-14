/**
 * One layout run from a fixed CDM envelope and the stock providers (FE-076, criterion 1). The same
 * scenario runs on the Node.js main thread and in a Node.js worker thread (`test/fe-076-worker.test.ts`),
 * and each run reports whether the host globals of a browser exist where it runs. Universal: it reads
 * no host object, and the check of `document` and `window` is a plain lookup on `globalThis`.
 */
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { layoutFlow } from './engine.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import { serialiseTree } from './tree.ts';

export interface ScenarioRun {
  /** True when a browser global (`document` or `window`) is visible where the run happens. */
  readonly domGlobals: boolean;
  readonly pages: number;
  readonly serialised: string;
}

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

function envelope(): CdmEnvelopeLike {
  const body: CdmNode[] = [];
  for (let i = 0; i < 40; i++) {
    const words = Array.from({ length: 5 + (i % 6) }, (_, w) => `item${i}w${w}`).join(' ');
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

/** Lays out the fixed document with the stock measurer, break provider and line breaker. */
export function runScenario(): ScenarioRun {
  const globals = globalThis as Record<string, unknown>;
  const domGlobals = 'document' in globals || 'window' in globals;
  const result = layoutFlow(toFlow(envelope()), {
    measurer: fixedWidthMeasurer(),
    breaks: afterSpace,
    lineBreaker: firstFitBreaker,
  });
  return {
    domGlobals,
    pages: result.tree.pages.length,
    serialised: serialiseTree(result.tree),
  };
}
