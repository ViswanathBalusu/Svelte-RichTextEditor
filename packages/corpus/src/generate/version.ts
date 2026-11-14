/**
 * Corpus versions (FND-006: "The corpus is versioned"). Any change to the generator or to its
 * output takes a new version: add an entry below with the fingerprint that the generator prints.
 *
 * The fingerprint is the SHA-256 of the RFC 8785 form of the manifest without its `version` and
 * `fingerprint` members. The manifest holds the canonical hash and the file hash of every document
 * and every asset, the page estimates, the features and the licences, so any change to the output
 * changes the fingerprint. The tests fail when the output no longer matches the fingerprint of the
 * latest version, which is what keeps a changed corpus from going out under an old number.
 */

export interface CorpusVersion {
  version: number;
  date: string;
  fingerprint: string;
  change: string;
}

export const CORPUS_HISTORY: readonly CorpusVersion[] = [
  {
    version: 1,
    date: '2026-11-06',
    fingerprint: '528ab574d427cd6db2a9368e585272c476ab19ad6131c7e31ba2643430d56fc9',
    change:
      'First corpus (FND-006): documents of about 1, 20, 100, 300 and 1,000 pages and a one-page form.',
  },
  {
    version: 2,
    date: '2026-11-06',
    fingerprint: 'dd2dac5a76f64fc4630dda4fbf4f8bef5efb64666493dedef04259e6041e18b4',
    change:
      'A footnote holds one paragraph in the FootnoteText style (CDM-001, option B), so every footnote gains a paragraph identifier and the identifiers after it shift; footnote words are counted once; the licence is Apache-2.0 (SPK-007).',
  },
];

export const CURRENT: CorpusVersion = CORPUS_HISTORY[CORPUS_HISTORY.length - 1]!;
