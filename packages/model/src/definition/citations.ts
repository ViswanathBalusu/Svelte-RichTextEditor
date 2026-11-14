/**
 * Sources, citations and bibliographies (CDM-052; decision proposed in
 * docs/adr/0031-cdm-1-model-completion.md). Sources are definition nodes in `defs`, so they share
 * the commit log, permissions and history with everything else (03 §1 principle 1). Their data is
 * compatible with CSL-JSON: every attribute maps to one CSL variable, and dates are strings, never
 * numbers (03 §1 principle 7). They are core, not a feature: both writers support them (biblatex
 * for LaTeX; Word's citations and sources part for DOCX).
 */
import { type NodeDef, arr, attr, nullable, obj, oneOf, ref, str } from './grammar.ts';
import { DEF_ID, LANG, TEXT, ext, id, origin, preserved } from './shared.ts';

/** The item types of CSL 1.0.2, spelt as CSL spells them. */
export const SOURCE_KINDS = [
  'article',
  'article-journal',
  'article-magazine',
  'article-newspaper',
  'bill',
  'book',
  'broadcast',
  'chapter',
  'classic',
  'collection',
  'dataset',
  'document',
  'entry',
  'entry-dictionary',
  'entry-encyclopedia',
  'event',
  'figure',
  'graphic',
  'hearing',
  'interview',
  'legal_case',
  'legislation',
  'manuscript',
  'map',
  'motion_picture',
  'musical_score',
  'pamphlet',
  'paper-conference',
  'patent',
  'performance',
  'periodical',
  'personal_communication',
  'post',
  'post-weblog',
  'regulation',
  'report',
  'review',
  'review-book',
  'software',
  'song',
  'speech',
  'standard',
  'thesis',
  'treaty',
  'webpage',
] as const;

/** The locator labels of CSL 1.0.2. */
export const LOCATOR_LABELS = [
  'act',
  'appendix',
  'article-locator',
  'book',
  'canon',
  'chapter',
  'column',
  'elocation',
  'equation',
  'figure',
  'folio',
  'issue',
  'line',
  'note',
  'opus',
  'page',
  'paragraph',
  'part',
  'rule',
  'scene',
  'section',
  'sub-verbo',
  'supplement',
  'table',
  'timestamp',
  'title-locator',
  'verse',
  'version',
  'volume',
] as const;

/** The citation styles of the house class (A3), proposed in ADR 0031. */
export const CITATION_STYLES = ['authorYear', 'numeric'] as const;

/** EDTF level 0 dates and intervals: `2026`, `2026-11`, `2026-11-06`, `2025/2026`. */
export const SOURCE_DATE_PATTERN =
  '^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?(?:/[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?)?$';
export const DOI_PATTERN = '^10\\.[0-9]{4,9}/[!-~]{1,240}$';
export const SOURCE_URL_PATTERN = '^https?://[^\\s<>"{}|\\\\^`]+$';
export const ISBN_PATTERN = '^(?:97[89][- ]?)?[0-9][0-9 -]{7,15}[0-9Xx]$';
export const ISSN_PATTERN = '^[0-9]{4}-?[0-9]{3}[0-9Xx]$';
/** Further CSL variables in `extra`, spelt as CSL spells them (`event-place`, `genre`). */
export const CSL_VARIABLE_PATTERN = '^[a-z][a-z0-9-]{0,63}$';

const SHORT = nullable(str(255));
const NUMBERISH = nullable(str(64));
const PERSON = obj({
  family: str(255),
  given: str(255),
  particle: str(64),
  suffix: str(64),
  literal: str(255),
});
const PEOPLE = nullable(arr(PERSON, 100, { minItems: 1 }));
const DATE = nullable(str(21, { pattern: SOURCE_DATE_PATTERN }));

export const SOURCE_DEF: NodeDef = {
  name: 'source_def',
  atom: true,
  selectable: false,
  spec: '03 §4.1; CDM-052',
  doc: 'A bibliographic source that citations cite; one attribute per CSL variable, so concurrent edits to different variables do not collide.',
  attrs: {
    id: attr(DEF_ID, null, 'Source identifier; also the citation key in LaTeX output.', {
      presence: 'required',
    }),
    kind: attr(oneOf(SOURCE_KINDS), 'book', 'CSL item type (`type`).'),
    title: attr(nullable(str(1024)), null, 'Title (CSL `title`).'),
    authors: attr(PEOPLE, null, 'Authors (CSL `author`), in order.'),
    editors: attr(PEOPLE, null, 'Editors (CSL `editor`), in order.'),
    issued: attr(DATE, null, 'Date of publication (CSL `issued`), EDTF level 0.'),
    accessed: attr(DATE, null, 'Date of access (CSL `accessed`), EDTF level 0.'),
    containerTitle: attr(
      nullable(str(1024)),
      null,
      'Journal, book or site the source appears in (CSL `container-title`).',
    ),
    publisher: attr(SHORT, null, 'Publisher (CSL `publisher`).'),
    publisherPlace: attr(SHORT, null, 'Place of publication (CSL `publisher-place`).'),
    edition: attr(NUMBERISH, null, 'Edition (CSL `edition`).'),
    volume: attr(NUMBERISH, null, 'Volume (CSL `volume`).'),
    issue: attr(NUMBERISH, null, 'Issue (CSL `issue`).'),
    pages: attr(NUMBERISH, null, 'Page range (CSL `page`).'),
    number: attr(NUMBERISH, null, 'Report, patent or standard number (CSL `number`).'),
    doi: attr(nullable(str(255, { pattern: DOI_PATTERN })), null, 'DOI (CSL `DOI`).'),
    url: attr(nullable(str(2048, { pattern: SOURCE_URL_PATTERN })), null, 'URL (CSL `URL`).'),
    isbn: attr(nullable(str(32, { pattern: ISBN_PATTERN })), null, 'ISBN (CSL `ISBN`).'),
    issn: attr(nullable(str(16, { pattern: ISSN_PATTERN })), null, 'ISSN (CSL `ISSN`).'),
    language: attr(nullable(LANG), null, 'Language of the source (CSL `language`).'),
    note: attr(nullable(TEXT), null, 'Note (CSL `note`).'),
    extra: attr(
      {
        kind: 'json',
        maxBytes: 4096,
        maxDepth: 4,
        keyPattern: CSL_VARIABLE_PATTERN,
        objectOnly: true,
      },
      {},
      'Further CSL variables by their CSL names; strings and integers only.',
    ),
    preserved: preserved(),
    ext: ext(),
  },
};

const CITATION_ITEM = obj(
  {
    source: ref('source'),
    prefix: str(255),
    suffix: str(255),
    locator: str(64),
    label: oneOf(LOCATOR_LABELS),
  },
  { required: ['source'] },
);

export const CITATION: NodeDef = {
  name: 'citation',
  group: 'inline caption_inline',
  inline: true,
  atom: true,
  spec: '03 §4.4; CDM-052',
  doc: 'A citation of one or more sources; the text is generated at layout and export time from the citation style.',
  attrs: {
    items: attr(
      arr(CITATION_ITEM, 32, { minItems: 1 }),
      null,
      'The cited sources in order, each with an optional prefix, suffix, locator and locator label (I4).',
      { presence: 'required' },
    ),
    mode: attr(
      oneOf(['normal', 'narrative', 'suppressAuthor']),
      'normal',
      '`narrative` puts the authors in the text; `suppressAuthor` leaves them out.',
    ),
    cached: attr(
      nullable(str(1024)),
      null,
      'Last generated text, for consumers that cannot generate it.',
    ),
    preserved: preserved(),
    origin: origin(),
    ext: ext(),
  },
};

export const BIBLIOGRAPHY: NodeDef = {
  name: 'bibliography',
  group: 'block',
  atom: true,
  spec: '03 §4.3; CDM-052',
  doc: 'A bibliography; its entries are generated at layout and export time from the sources.',
  attrs: {
    id: id(),
    include: attr(
      oneOf(['cited', 'all']),
      'cited',
      '`cited` lists the sources the document cites; `all` lists every source.',
    ),
    preserved: preserved(),
    ext: ext(),
  },
};
