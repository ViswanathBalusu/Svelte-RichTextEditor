/**
 * FE-087, criterion 3: when a page is painted, its header and footer `page` and `pageCount` fields
 * show the page's number and the document's page count, computed by the layout. The story is laid
 * out by the layout's story resolver (`flowStoryResolver`), so the text is the layout's, and the
 * painter draws the line's own text (`LayoutLine.text`) rather than the CDM range.
 *
 * Runs in Chromium, Firefox and WebKit (`pnpm vitest run --project browser
 * packages/painter/src/fe-087-fields.universal.test.ts`). In Node.js there is no DOM and the suite
 * is skipped. The Node.js half is packages/layout/src/fe-087-field-text.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type {
  FlowDocument,
  FlowFont,
  FlowPage,
  FlowParagraph,
  FlowText,
} from '../../layout/src/flow.ts';
import { firstFitBreaker, flowStoryResolver, type ItemProviders } from '../../layout/src/items.ts';
import { fixedWidthMeasurer } from '../../layout/src/measure.ts';
import type { LayoutTree } from '../../layout/src/tree.ts';
import { paintTree } from './painter.ts';

const font: FlowFont = {
  family: 'Noto Serif',
  sizePt: 11,
  bold: false,
  italic: false,
  color: null,
  underline: false,
  strike: false,
  vertAlign: null,
};

const providers: ItemProviders = {
  measurer: fixedWidthMeasurer(),
  breaks: { opportunities: () => [] },
  lineBreaker: firstFitBreaker,
};

function text(t: string, role: FlowText['role'] = 'text', ref?: string): FlowText {
  return {
    kind: 'text',
    role,
    text: t,
    font,
    offset: 0,
    size: role === 'text' ? t.length : 0,
    ...(ref === undefined ? {} : { ref }),
  };
}

/** The header paragraph 'Page <page> of <pageCount>' with its two field atoms. */
function header(): FlowParagraph {
  return {
    kind: 'paragraph',
    id: 'hdr',
    part: 0,
    start: 0,
    end: 9,
    generated: false,
    styleId: 'Header',
    outlineLevel: null,
    align: 'left',
    indentLeft: 0,
    indentRight: 0,
    indentFirstLine: 0,
    spaceBefore: 0,
    spaceAfter: 0,
    line: { rule: 'multiple', factor: 1 },
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: false,
    tabs: [],
    markFont: font,
    inlines: [
      text('Page '),
      text('?', 'field', 'page'),
      text(' of '),
      text('?', 'field', 'pageCount'),
    ],
    regionId: null,
  };
}

describe.skipIf(typeof document === 'undefined')(
  'header page fields are painted with the layout values (FE-087, criterion 3)',
  () => {
    it('paints the page number and the page count of each page', () => {
      const doc = {
        sections: [],
        stories: new Map([['hdr', [header()]]]),
        notes: new Map(),
        defaultTabStop: 0,
      } as unknown as FlowDocument;
      const flowPage = {
        width: 400,
        height: 600,
        marginLeft: 0,
        marginRight: 0,
      } as unknown as FlowPage;
      const factory = flowStoryResolver(doc, providers)('hdr', flowPage);
      expect(factory).toBeDefined();

      const pages = [1, 2, 3].map((number) => {
        const block = factory!({ number, label: String(number), pageCount: 3 });
        return {
          index: number - 1,
          section: 0,
          width: 400,
          height: 200,
          fragments: [],
          header: block.fragments,
          footer: [],
          footnotes: [],
        };
      });
      const tree: LayoutTree = { engine: 'test', measurer: 'canvas', pages };

      const host = document.createElement('div');
      host.style.width = '800px';
      document.body.appendChild(host);
      try {
        // The CDM range of the header is empty: the painted text can only come from the layout.
        const { pages: painted } = paintTree(host, tree, {
          lineText: () => '',
          fontFamily: 'Noto Serif',
          fontSizePt: 11,
        });
        const shown = painted.map((p) => p.querySelector('.de-line .de-text')?.textContent);
        expect(shown).toEqual(['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);
      } finally {
        host.remove();
      }
    });
  },
);
