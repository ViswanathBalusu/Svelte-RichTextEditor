/**
 * FE-094, criterion 3: the layout corpus includes ligature-rich and kerning-heavy text, mixed fonts,
 * justified paragraphs, tables, footnotes, columns and sections. This test reads the document a
 * layout test measures (`pages-20`, the corpus document that holds every special case) and checks
 * each construct in the CDM itself, not in the manifest's summary. Node.js only; no browser.
 */
import { documentEntry, loadDocument } from '@docedit/corpus';
import { describe, expect, it } from 'vitest';

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
  content?: JsonNode[];
}

/** Every node of the tree, depth first. */
function walk(node: JsonNode, visit: (n: JsonNode) => void): void {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}

async function corpusDocument(): Promise<JsonNode> {
  const { envelope } = await loadDocument('pages-20');
  return (envelope as unknown as { doc: JsonNode }).doc;
}

describe('the layout corpus covers the constructs of FE-094 (pages-20)', () => {
  it('is the document the corpus lists, with the features its manifest entry names', async () => {
    const entry = documentEntry('pages-20');
    expect(entry.features).toEqual(
      expect.arrayContaining([
        'footnotes',
        'tables',
        'sections.columns',
        'sections.landscape',
        'sections.start.continuous',
        'marks.fontFamily',
        'paragraphs.align.justify',
      ]),
    );
  });

  it('has ligature-rich and kerning-heavy text in its runs', async () => {
    const doc = await corpusDocument();
    let text = '';
    walk(doc, (n) => {
      if (typeof n.text === 'string') text += `${n.text}\n`;
    });
    for (const word of ['office', 'efficient', 'fjord', 'suffix']) {
      expect(text, `ligature word "${word}"`).toContain(word);
    }
    // Kerning pairs at sentence starts (text.ts): AV, Wa, Ye, To.
    expect(text).toMatch(/\bAVATAR\b/);
    expect(text).toMatch(/\bWave\b/);
    expect(text).toMatch(/\bYes\b/);
  });

  it('uses mixed fonts: at least two distinct font families among the runs and styles', async () => {
    const doc = await corpusDocument();
    const families = new Set<string>();
    walk(doc, (n) => {
      for (const mark of n.marks ?? []) {
        if (mark.type === 'fontFamily' && typeof mark.attrs?.value === 'string') {
          families.add(mark.attrs.value);
        }
      }
      if (n.type === 'style_def' && typeof n.attrs?.fontFamily === 'string') {
        families.add(n.attrs.fontFamily);
      }
    });
    expect(families.size).toBeGreaterThanOrEqual(2);
  });

  it('has justified paragraphs', async () => {
    const doc = await corpusDocument();
    let justified = 0;
    walk(doc, (n) => {
      if (n.type === 'paragraph' && n.attrs?.align === 'justify') justified += 1;
      if (n.type === 'style_def' && n.attrs?.align === 'justify') justified += 1;
    });
    expect(justified).toBeGreaterThan(0);
  });

  it('has tables, footnotes, a two-column section and sections with their own page setup', async () => {
    const doc = await corpusDocument();
    const counts = { table: 0, footnote: 0, sectionBreak: 0, columnsSetup: 0, landscape: 0 };
    walk(doc, (n) => {
      if (n.type === 'table') counts.table += 1;
      if (n.type === 'footnote') counts.footnote += 1;
      if (n.type === 'section_break') counts.sectionBreak += 1;
      if (n.type === 'page_setup') {
        if (typeof n.attrs?.columns === 'number' && n.attrs.columns > 1) counts.columnsSetup += 1;
        if (n.attrs?.orientation === 'landscape') counts.landscape += 1;
      }
    });
    expect(counts.table).toBeGreaterThan(0);
    expect(counts.footnote).toBeGreaterThan(0);
    expect(counts.sectionBreak).toBeGreaterThan(0);
    expect(counts.columnsSetup).toBeGreaterThan(0);
    expect(counts.landscape).toBeGreaterThan(0);
  });
});
