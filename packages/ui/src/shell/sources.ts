/**
 * The rules of the sources pane (UX-103; CDM-052; 07 §4), without a DOM:
 *
 * - the form's text fields and the attributes of a `source_def` (`draftOf`, `valuesOf`);
 * - the mapping of an imported BibTeX or CSL-JSON entry onto those attributes (`entryToSource`),
 *   proposed in docs/adr/0365-w3-UX-103-source-import-mapping.md;
 * - the plan of an import (`planImport`): which entries become sources, and which are reported
 *   because their key occurs twice in the file, is already a source of the document, or because a
 *   value fails its grammar. Nothing is renamed or repaired silently.
 */
import type { SourcePerson, SourceSummary, SourceValues } from '../core-api.ts';
import type { ImportProblem, SourceEntry, SourceImport } from './source-import.ts';

/** The attributes the form edits, in the form's order. `authors` is edited as text. */
export const FORM_FIELDS = ['title', 'authors', 'issued', 'containerTitle', 'doi', 'url'] as const;
export type FormField = (typeof FORM_FIELDS)[number];

/** The kinds the form offers first; every other CSL type stays as it is when a source has it. */
export const FORM_KINDS = [
  'book',
  'chapter',
  'article-journal',
  'article-newspaper',
  'paper-conference',
  'report',
  'thesis',
  'webpage',
  'legislation',
  'legal_case',
  'standard',
  'dataset',
  'software',
  'document',
] as const;

export interface SourceDraft {
  id: string;
  kind: string;
  title: string;
  authors: string;
  issued: string;
  containerTitle: string;
  doi: string;
  url: string;
}

export const EMPTY_DRAFT: Readonly<SourceDraft> = {
  id: '',
  kind: 'book',
  title: '',
  authors: '',
  issued: '',
  containerTitle: '',
  doi: '',
  url: '',
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One person as the form writes it: `Family, Given`, or the literal name. */
export function personText(person: SourcePerson): string {
  if (person.literal) return person.literal;
  const family = person.family ?? '';
  const given = person.given ?? '';
  return family && given ? `${family}, ${given}` : family || given;
}

/** People as the form writes them: `Family, Given; Family, Given`. */
export function peopleText(people: unknown): string {
  if (!Array.isArray(people)) return '';
  return (people as SourcePerson[]).map(personText).filter(Boolean).join('; ');
}

/**
 * People from the form's text. A name with a comma is family and given; one without is kept whole
 * as a literal name, since the order of its parts is not known. Empty text is no people (null).
 */
export function parsePeople(value: string): SourcePerson[] | null {
  const out: SourcePerson[] = [];
  for (const part of value.split(';')) {
    const name = part.trim();
    if (!name) continue;
    const comma = name.indexOf(',');
    if (comma < 0) out.push({ literal: name });
    else {
      const family = name.slice(0, comma).trim();
      const given = name.slice(comma + 1).trim();
      if (family && given) out.push({ family, given });
      else out.push({ literal: family || given });
    }
  }
  return out.length > 0 ? out : null;
}

export function draftOf(source: SourceSummary): SourceDraft {
  const v = source.values;
  return {
    id: source.id,
    kind: text(v['kind']) || 'book',
    title: text(v['title']),
    authors: peopleText(v['authors']),
    issued: text(v['issued']),
    containerTitle: text(v['containerTitle']),
    doi: text(v['doi']),
    url: text(v['url']),
  };
}

/** The attributes a draft sets: empty text is null (the attribute is not set). */
export function valuesOf(draft: SourceDraft): SourceValues {
  const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
  return {
    kind: draft.kind,
    title: orNull(draft.title),
    authors: parsePeople(draft.authors),
    issued: orNull(draft.issued),
    containerTitle: orNull(draft.containerTitle),
    doi: orNull(draft.doi),
    url: orNull(draft.url),
  };
}

/** A one-line description of a source for the list: authors, date, title. */
export function sourceLine(source: SourceSummary): { who: string; when: string; title: string } {
  return {
    who: peopleText(source.values['authors']),
    when: text(source.values['issued']),
    title: text(source.values['title']),
  };
}

// --- Import (criterion 3) -----------------------------------------------------------------------

/** BibTeX entry types as CSL item types (ADR 0365, decision 1). An unknown type is `document`. */
const BIBTEX_KIND: Readonly<Record<string, string>> = {
  article: 'article-journal',
  book: 'book',
  booklet: 'pamphlet',
  inbook: 'chapter',
  incollection: 'chapter',
  inproceedings: 'paper-conference',
  conference: 'paper-conference',
  manual: 'document',
  mastersthesis: 'thesis',
  phdthesis: 'thesis',
  thesis: 'thesis',
  proceedings: 'book',
  techreport: 'report',
  report: 'report',
  unpublished: 'manuscript',
  online: 'webpage',
  misc: 'document',
};

/** BibTeX fields that are one text attribute of a source (ADR 0365, decision 2). */
const BIBTEX_TEXT: Readonly<Record<string, string>> = {
  title: 'title',
  publisher: 'publisher',
  address: 'publisherPlace',
  edition: 'edition',
  volume: 'volume',
  pages: 'pages',
  doi: 'doi',
  url: 'url',
  isbn: 'isbn',
  issn: 'issn',
  note: 'note',
};

/** CSL-JSON variables that are one text attribute of a source. */
const CSL_TEXT: Readonly<Record<string, string>> = {
  title: 'title',
  'container-title': 'containerTitle',
  publisher: 'publisher',
  'publisher-place': 'publisherPlace',
  edition: 'edition',
  volume: 'volume',
  issue: 'issue',
  page: 'pages',
  number: 'number',
  DOI: 'doi',
  URL: 'url',
  ISBN: 'isbn',
  ISSN: 'issn',
  language: 'language',
  note: 'note',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** BibTeX braces that only protect capitals are removed; the text is otherwise kept. */
const unbrace = (value: string): string => value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

/** BibTeX names (`A and B`, each `Family, Given` or `Given Family`) as people. */
function bibtexPeople(value: string): SourcePerson[] | null {
  const out: SourcePerson[] = [];
  for (const raw of value.split(/\s+and\s+/i)) {
    // A name wholly in braces is an organisation: kept as one literal name.
    const whole = /^\{.*\}$/.test(raw.trim());
    const name = unbrace(raw);
    if (!name) continue;
    if (whole) out.push({ literal: name });
    else if (name.includes(',')) {
      const [family = '', given = ''] = name.split(',').map((s) => s.trim());
      out.push(family && given ? { family, given } : { literal: family || given });
    } else {
      const words = name.split(' ');
      const family = words.pop() ?? '';
      out.push(words.length > 0 ? { family, given: words.join(' ') } : { literal: family });
    }
  }
  return out.length > 0 ? out : null;
}

/** A BibTeX year and month as an EDTF level 0 date; null when the year is not four digits. */
function bibtexDate(year: string | undefined, month: string | undefined): string | null {
  const y = unbrace(year ?? '');
  if (!/^[0-9]{4}$/.test(y)) return y === '' ? null : y;
  const m = unbrace(month ?? '').toLowerCase();
  const index = /^[0-9]{1,2}$/.test(m) ? Number(m) : MONTHS.indexOf(m.slice(0, 3)) + 1;
  return index >= 1 && index <= 12 ? `${y}-${String(index).padStart(2, '0')}` : y;
}

/** A CSL date (`{"date-parts":[[2026,11,6]]}`, as JSON text) as an EDTF level 0 date. */
function cslDate(json: string | undefined): string | null {
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return json;
  }
  if (!value || typeof value !== 'object') return json;
  const rec = value as { 'date-parts'?: unknown; raw?: unknown };
  const parts = rec['date-parts'];
  if (Array.isArray(parts) && Array.isArray(parts[0])) {
    const one = (p: unknown[]): string =>
      p.map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0')).join('-');
    return (parts as unknown[][]).slice(0, 2).map(one).join('/');
  }
  return typeof rec.raw === 'string' ? rec.raw : json;
}

/** CSL names (JSON text of an array) as people; a name that is not an object is dropped. */
function cslPeople(json: string | undefined): SourcePerson[] | null {
  if (json === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: SourcePerson[] = [];
  for (const item of value as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const person: { family?: string; given?: string; literal?: string } = {};
    if (typeof rec['family'] === 'string') person.family = rec['family'];
    if (typeof rec['given'] === 'string') person.given = rec['given'];
    if (typeof rec['literal'] === 'string') person.literal = rec['literal'];
    if (Object.keys(person).length > 0) out.push(person);
  }
  return out.length > 0 ? out : null;
}

export interface MappedSource {
  readonly id: string;
  readonly values: SourceValues;
  /** Fields of the entry that no attribute of a source takes; they are not imported. */
  readonly dropped: readonly string[];
}

/** One parsed entry as the identifier and attributes of a source (ADR 0365). */
export function entryToSource(entry: SourceEntry, format: 'bibtex' | 'csl'): MappedSource {
  const values: Record<string, string | readonly SourcePerson[] | null> = {};
  const dropped: string[] = [];
  const f = entry.fields;
  if (format === 'csl') {
    values['kind'] = entry.type;
    for (const [name, value] of Object.entries(f)) {
      const target = CSL_TEXT[name];
      if (target) values[target] = value;
      else if (name === 'author') values['authors'] = cslPeople(value);
      else if (name === 'editor') values['editors'] = cslPeople(value);
      else if (name === 'issued') values['issued'] = cslDate(value);
      else if (name === 'accessed') values['accessed'] = cslDate(value);
      else dropped.push(name);
    }
    return { id: entry.key, values, dropped };
  }
  const kind = BIBTEX_KIND[entry.type] ?? 'document';
  values['kind'] = kind;
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(f)) lower[name.toLowerCase()] = value;
  for (const [name, value] of Object.entries(lower)) {
    const target = BIBTEX_TEXT[name];
    if (target)
      values[target] = target === 'pages' ? unbrace(value).replace(/--/g, '-') : unbrace(value);
    else if (name === 'author') values['authors'] = bibtexPeople(value);
    else if (name === 'editor') values['editors'] = bibtexPeople(value);
    else if (name === 'journal' || name === 'journaltitle' || name === 'booktitle')
      values['containerTitle'] = unbrace(value);
    // BibTeX's `number` is the issue of a journal and the number of a report or a standard.
    else if (name === 'number')
      values[kind === 'article-journal' ? 'issue' : 'number'] = unbrace(value);
    else if (name === 'year' || name === 'month') continue;
    else if (name === 'date') values['issued'] = unbrace(value);
    else dropped.push(name);
  }
  if (lower['date'] === undefined) {
    const issued = bibtexDate(lower['year'], lower['month']);
    if (issued !== null) values['issued'] = issued;
  }
  return { id: entry.key, values, dropped };
}

export interface ImportRefusal {
  readonly key: string;
  /** The line (BibTeX) or the array position (CSL-JSON) of the entry. */
  readonly at: number;
  /**
   * `duplicate`: the key occurs more than once in the file. `exists`: the document already has a
   * source with this identifier. `invalid`: `fields` fail their grammar.
   */
  readonly reason: 'duplicate' | 'exists' | 'invalid';
  readonly fields?: readonly string[];
}

export interface ImportPlan {
  readonly add: readonly (MappedSource & { readonly at: number })[];
  readonly refused: readonly ImportRefusal[];
  /** What the parser could not read. */
  readonly problems: readonly ImportProblem[];
}

/**
 * What an import would create. `existing` are the identifiers of the document's sources (compared
 * without regard to case, as the parser compares keys); `check` is the grammar check of the core.
 */
export function planImport(
  parsed: SourceImport,
  format: 'bibtex' | 'csl',
  existing: readonly string[],
  check: (id: string, values: SourceValues) => readonly string[],
): ImportPlan {
  const twice = new Set(parsed.duplicates.map((d) => d.key.toLowerCase()));
  const have = new Set(existing.map((id) => id.toLowerCase()));
  const add: (MappedSource & { at: number })[] = [];
  const refused: ImportRefusal[] = [];
  for (const entry of parsed.entries) {
    const key = entry.key.toLowerCase();
    if (twice.has(key)) refused.push({ key: entry.key, at: entry.at, reason: 'duplicate' });
    else if (have.has(key)) refused.push({ key: entry.key, at: entry.at, reason: 'exists' });
    else {
      const mapped = entryToSource(entry, format);
      const fields = check(mapped.id, mapped.values);
      if (fields.length > 0)
        refused.push({ key: entry.key, at: entry.at, reason: 'invalid', fields: [...fields] });
      else add.push({ ...mapped, at: entry.at });
    }
  }
  return { add, refused, problems: parsed.problems };
}

/** Whether a file is read as CSL-JSON (a `.json` name or JSON text) or as BibTeX. */
export function importFormat(name: string, content: string): 'bibtex' | 'csl' {
  if (/\.json$/i.test(name)) return 'csl';
  if (/\.bib(tex)?$/i.test(name)) return 'bibtex';
  return /^\s*[[{]/.test(content) ? 'csl' : 'bibtex';
}
