/**
 * The entries of a bibliography, generated from the document (FE-140 criterion 2; CDM-052; 03 §4.3).
 *
 * The CDM stores no bibliography text: the entries are generated from the `source_def` definitions
 * the document cites, in the style of `settings.citationStyle`. The rules are those the LaTeX
 * converter prints (`packages/export-latex/src/citations.ts`; ADR 0046, proposed), so the web view
 * and the PDF list the same sources in the same order with the same words (review SR-M20):
 *
 * - numeric: the sources in the order they are first cited, each with its number `[n]`;
 * - authorYear: the sources by first author, year and title, and sources with the same author
 *   label and year take `a`, `b`, … after the year;
 * - `include: cited` lists the cited sources, `include: all` every source of the document.
 *
 * This module repeats those rules because the engine does not depend on `@docedit/export-latex`
 * (ADR 0366, proposed, says why and what should replace the copy). Pure: it reads the document and
 * writes nothing into it.
 */
import type { Node as PMNode } from 'prosemirror-model';

type Attrs = Readonly<Record<string, unknown>>;

interface Person {
  readonly family?: string;
  readonly given?: string;
  readonly particle?: string;
  readonly suffix?: string;
  readonly literal?: string;
}

/** A run of an entry: plain or italic text; `url` is set on the run that is an address. */
export interface BibliographyPart {
  readonly text: string;
  readonly italic?: boolean;
  readonly url?: string;
}

export interface BibliographyEntry {
  readonly sourceId: string;
  readonly parts: readonly BibliographyPart[];
}

export type BibliographyInclude = 'cited' | 'all';

/** Kinds whose title is a whole work, set in italics; the others italicise the container. */
const WHOLE_WORKS: ReadonlySet<string> = new Set([
  'book',
  'report',
  'thesis',
  'webpage',
  'dataset',
  'software',
  'manuscript',
  'map',
  'motion_picture',
  'musical_score',
  'pamphlet',
  'patent',
  'standard',
  'document',
  'collection',
  'periodical',
]);

/** A non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function people(v: unknown): Person[] {
  return Array.isArray(v) ? (v.filter((p) => typeof p === 'object' && p !== null) as Person[]) : [];
}

function familyName(p: Person): string {
  if (p.literal) return p.literal;
  return [p.particle, p.family].filter(Boolean).join(' ') || p.given || '';
}

function fullName(p: Person, inverted: boolean): string {
  if (p.literal) return p.literal;
  const family = familyName(p);
  const given = p.given ?? '';
  const suffix = p.suffix ? `, ${p.suffix}` : '';
  if (!given) return family + suffix;
  return inverted ? `${family}, ${given}${suffix}` : `${given} ${family}${suffix}`;
}

function andList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function year(issued: unknown): string {
  const s = str(issued);
  return s ? s.slice(0, 4) : 'n.d.';
}

function authorLabel(a: Attrs): string {
  const authors = people(a['authors']);
  const list = authors.length ? authors : people(a['editors']);
  if (list.length === 0) return str(a['title']) ?? '?';
  const names = list.map(familyName);
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

function sortKey(a: Attrs): string {
  return `${authorLabel(a).toLowerCase()}\u0000${year(a['issued'])}\u0000${(str(a['title']) ?? '').toLowerCase()}`;
}

function entryParts(a: Attrs, label: string | null, yearText: string | null): BibliographyPart[] {
  const out: Array<{ text: string; italic?: boolean; url?: string }> = [];
  const push = (text: string, extra: { italic?: boolean; url?: string } = {}): void => {
    if (text) out.push({ text, ...extra });
  };
  if (label) push(`${label} `);
  const authors = people(a['authors']);
  const editors = people(a['editors']);
  const names = authors.length ? authors : editors;
  if (names.length)
    push(
      andList(names.map((p, i) => fullName(p, i === 0))) +
        (authors.length === 0 ? (editors.length > 1 ? ' (eds.)' : ' (ed.)') : ''),
    );
  push(`${names.length ? ' ' : ''}(${yearText ?? year(a['issued'])}). `);
  const kind = str(a['kind']) ?? 'book';
  const title = str(a['title']);
  if (title)
    push(title.endsWith('.') ? `${title} ` : `${title}. `, { italic: WHOLE_WORKS.has(kind) });
  const container = str(a['containerTitle']);
  if (container) {
    if (authors.length && editors.length)
      push(
        `In ${andList(editors.map((p) => fullName(p, false)))} (${editors.length > 1 ? 'eds.' : 'ed.'}), `,
      );
    push(container, { italic: true });
    const vol = str(a['volume']);
    const issue = str(a['issue']);
    if (vol) push(`, ${vol}${issue ? `(${issue})` : ''}`);
    else if (issue) push(`, no. ${issue}`);
    const pages = str(a['pages']);
    if (pages) push(`, ${/[-–]/.test(pages) ? 'pp.' : 'p.'} ${pages}`);
    push('. ');
  }
  const edition = str(a['edition']);
  if (edition) push(`${edition} edn. `);
  const number = str(a['number']);
  if (number) push(`No. ${number}. `);
  const publisher = str(a['publisher']);
  const place = str(a['publisherPlace']);
  if (publisher || place) push(`${[place, publisher].filter(Boolean).join(': ')}. `);
  const doi = str(a['doi']);
  const url = str(a['url']);
  if (doi) push(`https://doi.org/${doi}`, { url: `https://doi.org/${doi}` });
  else if (url) push(url, { url });
  const accessed = str(a['accessed']);
  if (url && accessed) push(` (accessed ${accessed})`);
  // Trim the final separator.
  const last = out[out.length - 1];
  if (last && !last.url) last.text = last.text.replace(/\s+$/, '');
  return out;
}

/** The document's sources by identifier, in the order of the definitions. */
export function sourcesOf(doc: PMNode): Map<string, Attrs> {
  const out = new Map<string, Attrs>();
  doc.firstChild?.forEach((child) => {
    if (child.type.name !== 'source_def') return;
    const id = child.attrs['id'];
    if (typeof id === 'string') out.set(id, child.attrs);
  });
  return out;
}

/** The sources the document cites and defines, in the order they are first cited. */
export function citedSources(doc: PMNode, sources: ReadonlyMap<string, Attrs>): string[] {
  const order: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'citation') return true;
    const items: unknown = node.attrs['items'];
    if (!Array.isArray(items)) return false;
    for (const item of items as unknown[]) {
      const id =
        typeof item === 'object' && item !== null
          ? str((item as Record<string, unknown>)['source'])
          : null;
      if (id && sources.has(id) && !order.includes(id)) order.push(id);
    }
    return false;
  });
  return order;
}

/** The citation style of the document's settings: `authorYear` unless it says `numeric`. */
export function citationStyleOf(doc: PMNode): 'authorYear' | 'numeric' {
  let style: unknown;
  doc.firstChild?.forEach((child) => {
    if (child.type.name === 'settings') style = child.attrs['citationStyle'];
  });
  return style === 'numeric' ? 'numeric' : 'authorYear';
}

/** The entries of a bibliography of the document, in the document's citation style. */
export function bibliographyEntries(
  doc: PMNode,
  include: BibliographyInclude = 'cited',
): BibliographyEntry[] {
  const sources = sourcesOf(doc);
  const order = citedSources(doc, sources);
  const listed =
    include === 'all'
      ? [...order, ...[...sources.keys()].filter((k) => !order.includes(k))]
      : order;
  if (citationStyleOf(doc) === 'numeric')
    return listed.map((id, i) => ({
      sourceId: id,
      parts: entryParts(sources.get(id)!, `[${i + 1}]`, null),
    }));

  const sorted = [...listed].sort((x, y) => {
    const a = sortKey(sources.get(x)!);
    const b = sortKey(sources.get(y)!);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  // Sources with the same author label and year take a, b, … after the year.
  const groups = new Map<string, string[]>();
  for (const id of sorted) {
    const a = sources.get(id)!;
    const key = `${authorLabel(a)}\u0000${year(a['issued'])}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const years = new Map<string, string>();
  for (const ids of groups.values())
    ids.forEach((id, i) => {
      const suffix = ids.length > 1 ? String.fromCharCode(97 + (i % 26)) : '';
      years.set(id, `${year(sources.get(id)!['issued'])}${suffix}`);
    });
  return sorted.map((id) => ({
    sourceId: id,
    parts: entryParts(sources.get(id)!, null, years.get(id) ?? null),
  }));
}

/** The plain text of an entry. */
export function entryText(entry: BibliographyEntry): string {
  return entry.parts.map((p) => p.text).join('');
}
