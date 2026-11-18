/**
 * EXP-114 criterion 1: the mappings of 09 §3 against the stored reference PDFs. Every mapping
 * names the features of the shared corpus (FND-006) that exercise it. The features of a reference
 * are those the corpus manifest lists for the document it was made from, less the ones its
 * manifest entry says it leaves out, plus the options that make a feature (`suggestions=markup`).
 * A mapping with no reference is on `GAPS` with the reason, and the test fails when a gap is
 * covered, so that the list cannot go stale. Node.js only; it reads files and compiles nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifest as corpus } from '@docedit/corpus';

const refDir = fileURLToPath(new URL('../test/references/', import.meta.url));

interface Entry {
  file: string;
  corpus?: string;
  without?: string[];
  options: Record<string, unknown>;
}

const references = (
  JSON.parse(readFileSync(refDir + 'manifest.json', 'utf8')) as { references: Entry[] }
).references;

/** A pattern of `without` is a feature name, or a prefix ending in `.*`. */
const left = (feature: string, without: readonly string[]): boolean =>
  without.some((w) => (w.endsWith('.*') ? feature.startsWith(w.slice(0, -1)) : feature === w));

/** The features that the stored references exercise. */
function covered(): Set<string> {
  const out = new Set<string>();
  for (const r of references) {
    if (r.corpus) {
      const doc = corpus.documents.find((d) => d.name === r.corpus);
      if (!doc) throw new Error(`the corpus has no document ${r.corpus}`);
      for (const f of doc.features) if (!left(f, r.without ?? [])) out.add(f);
    }
    if (r.options['suggestions'] === 'markup') out.add('suggestions.markup');
  }
  return out;
}

/** The mappings of 09 §3, each with the corpus features that exercise it. */
const MAPPINGS: ReadonlyArray<{ mapping: string; features: readonly string[] }> = [
  {
    mapping: 'page setups and sections (§3.1)',
    features: ['sections', 'sections.landscape', 'sections.columns'],
  },
  {
    mapping: 'headers and footers',
    features: ['headers', 'footers', 'headers.firstPage', 'headers.evenPage'],
  },
  { mapping: 'fields', features: ['fields.page', 'fields.pageCount', 'fields.ref', 'fields.seq'] },
  {
    mapping: 'paragraph styles',
    features: ['styles.named.paragraph', 'styles.basedOnChain.paragraph'],
  },
  { mapping: 'headings', features: ['headings', 'toc.headings'] },
  {
    mapping: 'spacing and alignment',
    features: ['paragraphs.align.justify', 'paragraphs.lineRule.exact'],
  },
  {
    mapping: 'numbering',
    features: ['numbering.numbered', 'numbering.legal', 'numbering.bullets'],
  },
  {
    mapping: 'tables: longtable in the body (§3.2)',
    features: ['tables', 'tables.longerThanPage', 'tables.headerRows'],
  },
  {
    mapping: 'tables: boxed tabular in columns and in footnotes (§3.2)',
    features: ['tables.inColumns', 'footnotes.inTable'],
  },
  {
    mapping: 'tables: row and column spans (§3.2)',
    features: ['tables.rowspan', 'tables.colspan'],
  },
  { mapping: 'images and figures', features: ['images.inline', 'figures', 'figures.float'] },
  { mapping: 'footnotes', features: ['footnotes'] },
  { mapping: 'links and bookmarks', features: ['links.web', 'links.internal', 'bookmarks'] },
  {
    mapping: 'highlight, underline, strike',
    features: ['marks.highlight', 'marks.underline', 'marks.strike'],
  },
  { mapping: 'languages', features: ['marks.lang'] },
  { mapping: 'breaks', features: ['breaks.page', 'breaks.column', 'breaks.line'] },
  { mapping: 'regions', features: ['regions.inherit', 'regions.restricted'] },
  { mapping: 'form fields', features: ['fields.form'] },
  { mapping: 'math (§4.6)', features: ['math.inline', 'math.display'] },
  { mapping: 'suggestions (§10)', features: ['suggestions.markup'] },
  {
    mapping: 'fallback fonts (§3.2, missing glyphs)',
    features: ['cjk.han', 'cjk.hangul', 'cjk.ja'],
  },
  { mapping: 'comments in the margin (§10)', features: ['comments.margin'] },
];

/** The mappings that have no reference yet, and why. */
const GAPS: Readonly<Record<string, string>> = {
  'fallback fonts (§3.2, missing glyphs)':
    'the CJK fallback fonts are not in the worker image (ADR 0045, open question 7), so a final export of CJK text fails and no reference can be made',
  'comments in the margin (§10)':
    'the option `comments: margin` is not built (EXP-084); the criterion asks for it once phase 2 arrives',
};

describe('EXP-114 criterion 1: the stored references against the mappings of 09 §3', () => {
  const have = covered();

  it('has a reference for the corpus documents and the suggestions sample', () => {
    const files = references.map((r) => r.file);
    for (const name of ['pages-1', 'form-fields', 'pages-20'])
      expect(files).toContain(`exp-114-corpus-${name}-ua2-a4f.pdf`);
    expect(files).toContain('exp-114-suggestions-markup.pdf');
  });

  for (const { mapping, features } of MAPPINGS) {
    if (GAPS[mapping] !== undefined) continue;
    it(`covers ${mapping}`, () => {
      expect(
        features.filter((f) => !have.has(f)),
        'features no reference exercises',
      ).toEqual([]);
    });
  }

  it('lists as gaps only mappings that no reference covers yet', () => {
    for (const [mapping, reason] of Object.entries(GAPS)) {
      const row = MAPPINGS.find((m) => m.mapping === mapping);
      expect(row, `${mapping} is a mapping`).toBeDefined();
      expect(reason.length).toBeGreaterThan(20);
      expect(
        row!.features.some((f) => have.has(f)),
        `${mapping} is covered now: take it off GAPS`,
      ).toBe(false);
    }
  });
});
