/**
 * Citations and sources in the DOCX writers (09 §11; EXP-122). A citation becomes a Word citation
 * field (`CITATION <tag> \l 1033 [\m <tag>]... [\n]`) whose result is the cached text, inside the
 * content control Word puts round it (`w:sdt` with `w:citation`); the sources of the document
 * become the package's bibliography sources part, a custom XML item whose items carry the
 * `b:Sources` namespace, so Word can update the fields from them.
 *
 * Spec defaults, recorded in docs/stories/EXP-export.md (EXP-122) and ADR 0230: the source tag is the
 * source's identifier; the language switch is the LCID of en-US unless the imported field had
 * another; a prefix or suffix is written only into the cached text, because a plain `CITATION`
 * field has no place for them; a locator of the page kind of a citation of one source is `\p`.
 */
import type { JsonNode } from '@docedit/model';
import { NamespaceWriter, type TreeBody, elementsOf } from './tree.ts';
import { el, textElement } from './writer-xml.ts';

export const BIBLIOGRAPHY_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography';

/** A tag Word accepts in a citation field: no spaces, no switches, no quotes. */
export const FIELD_TAG = /^[A-Za-z0-9_-]{1,64}$/;

/** The LCID Word puts in a citation field when no other language is given (en-US). */
const CITATION_LCID = 1033;

/** Word's source types for the CSL item types the model names (CDM-052). Others are `Misc`. */
const SOURCE_TYPES: Readonly<Record<string, string>> = {
  article: 'JournalArticle',
  'article-journal': 'JournalArticle',
  'article-magazine': 'JournalArticle',
  'article-newspaper': 'ArticleInAPeriodical',
  book: 'Book',
  chapter: 'BookSection',
  'paper-conference': 'ConferenceProceedings',
  report: 'Report',
  webpage: 'InternetSite',
  'post-weblog': 'InternetSite',
  patent: 'Patent',
  interview: 'Interview',
  motion_picture: 'Film',
  legal_case: 'Case',
  performance: 'Performance',
  software: 'ElectronicSource',
  dataset: 'ElectronicSource',
};

export const sourceType = (kind: string): string => SOURCE_TYPES[kind] ?? 'Misc';

/** The CSL item type an imported Word source type becomes (the first kind that maps to it). */
const KIND_OF_TYPE: Readonly<Record<string, string>> = {
  JournalArticle: 'article-journal',
  ArticleInAPeriodical: 'article-newspaper',
  Book: 'book',
  BookSection: 'chapter',
  ConferenceProceedings: 'paper-conference',
  Report: 'report',
  InternetSite: 'webpage',
  Patent: 'patent',
  Interview: 'interview',
  Film: 'motion_picture',
  Case: 'legal_case',
  Performance: 'performance',
  ElectronicSource: 'software',
  Misc: 'document',
};

/** The model kind of a Word source type, or null when writing that kind back would not give the type. */
export function kindOfSourceType(type: string): string | null {
  const kind = KIND_OF_TYPE[type];
  return kind !== undefined && sourceType(kind) === type ? kind : null;
}

/** The element that holds the container's title, by Word source type (`b:JournalName` by default). */
const CONTAINER_ELEMENT: Readonly<Record<string, string>> = {
  BookSection: 'BookTitle',
  ArticleInAPeriodical: 'PeriodicalTitle',
  ConferenceProceedings: 'ConferenceName',
  InternetSite: 'InternetSiteTitle',
};
export const containerElement = (type: string): string => CONTAINER_ELEMENT[type] ?? 'JournalName';

interface CitationItemLike {
  source?: unknown;
  locator?: unknown;
  label?: unknown;
}

/** The field instruction of a citation, or null when no item has a tag Word can take. */
export function citationInstruction(
  items: readonly CitationItemLike[],
  mode: string,
  residual = '',
): string | null {
  const tags = items
    .map((i) => i.source)
    .filter((s): s is string => typeof s === 'string' && FIELD_TAG.test(s));
  const [first, ...more] = tags;
  if (!first) return null;
  let instr = ` CITATION ${first}`;
  if (!/\\l\s/.test(`${residual} `)) instr += ` \\l ${CITATION_LCID}`;
  for (const t of more) instr += ` \\m ${t}`;
  if (mode === 'suppressAuthor') instr += ' \\n';
  const only = items.length === 1 ? items[0] : undefined;
  if (
    only &&
    typeof only.locator === 'string' &&
    FIELD_TAG.test(only.locator) &&
    only.label === 'page'
  )
    instr += ` \\p ${only.locator}`;
  if (residual) instr += ` ${residual}`;
  return `${instr} `;
}

export interface ParsedCitation {
  tags: string[];
  mode: 'normal' | 'suppressAuthor';
  /** The page of a citation of one source (`\p`). */
  locator: string | null;
  /** The switches the model has no place for, as they were written. */
  residual: string;
}

const SWITCHES_WITH_ARGUMENT = new Set(['\\l', '\\p', '\\f', '\\s', '\\v']);

/** Reads `CITATION <tag> [switches]`; null for any other field or an instruction it cannot read. */
export function parseCitationInstruction(instr: string): ParsedCitation | null {
  const tokens = [...instr.matchAll(/"[^"]*"|\S+/g)].map((m) => m[0]);
  if (tokens.length < 2 || tokens[0]!.toUpperCase() !== 'CITATION') return null;
  const tag = tokens[1]!;
  if (!FIELD_TAG.test(tag)) return null;
  const tags = [tag];
  let mode: ParsedCitation['mode'] = 'normal';
  let page: string | null = null;
  const residual: string[] = [];
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i]!;
    const arg = (): string | null => (i + 1 < tokens.length ? tokens[++i]! : null);
    if (t === '\\m') {
      const more = arg();
      if (more === null || !FIELD_TAG.test(more)) return null;
      tags.push(more);
    } else if (t === '\\n') mode = 'suppressAuthor';
    else if (t === '\\l') {
      const lcid = arg();
      if (lcid === null) return null;
      if (lcid !== String(CITATION_LCID)) residual.push(t, lcid);
    } else if (t === '\\p') {
      const p = arg();
      if (p === null) return null;
      if (page === null && FIELD_TAG.test(p)) page = p;
      else residual.push(t, p);
    } else if (SWITCHES_WITH_ARGUMENT.has(t)) {
      const a = arg();
      if (a === null) return null;
      residual.push(t, a);
    } else if (t.startsWith('\\')) residual.push(t);
    else return null;
  }
  if (page !== null && tags.length > 1) {
    residual.push('\\p', page);
    page = null;
  }
  return { tags, mode, locator: page, residual: residual.join(' ') };
}

/** Identifiers of the content controls written round citations start here, clear of other controls. */
export const CITATION_CONTROL_BASE = 0x4c000000;

/** The content control Word wraps a citation field in (`w:sdt` with `w:citation`). */
export function citationControl(id: number, fieldXml: string, p = 'w'): string {
  return `<${p}:sdt><${p}:sdtPr><${p}:id ${p}:val="${id}"/><${p}:citation/></${p}:sdtPr><${p}:sdtContent>${fieldXml}</${p}:sdtContent></${p}:sdt>`;
}

/**
 * The runs of a complex field: begin, instruction, separate, result, end. Each run carries `rPr`.
 * `p` is the prefix the part binds to the main namespace.
 */
export function fieldRuns(instr: string, result: string, rPr: string, p = 'w'): string {
  const fld = (type: string): string =>
    el(`${p}:r`, {}, rPr, el(`${p}:fldChar`, { [`${p}:fldCharType`]: type }));
  return `${fld('begin')}${el(`${p}:r`, {}, rPr, textElement(`${p}:instrText`, instr))}${fld('separate')}${el(`${p}:r`, {}, rPr, textElement(`${p}:t`, result))}${fld('end')}`;
}

/** The text of the unmodelled switches of an imported citation, kept in its `preserved` tree. */
export function residualOf(preserved: unknown): string {
  if (typeof preserved !== 'object' || preserved === null) return '';
  const kids = (preserved as TreeBody).children;
  const first = kids?.[0];
  if (!first || !('name' in first) || first.name !== 'w:instrText') return '';
  const text = first.children?.[0];
  return text && 'text' in text ? text.text : '';
}

/** The `preserved` value that keeps the unmodelled switches of a citation. */
export function residualTree(residual: string): TreeBody | null {
  return residual ? { children: [{ name: 'w:instrText', children: [{ text: residual }] }] } : null;
}

/** The persons of one name list of a source, as a `b:Author`, `b:Editor` or `b:Corporate` content. */
function nameXml(p: Record<string, unknown>): string {
  const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const last = [str('particle'), str('family'), str('literal')].filter(Boolean).join(' ');
  return `<b:Person>${last ? textElement('b:Last', last) : '<b:Last/>'}${str('given') ? textElement('b:First', str('given')) : '<b:First/>'}</b:Person>`;
}

function peopleOf(people: unknown): Array<Record<string, unknown>> {
  return Array.isArray(people)
    ? people.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    : [];
}

/** One name list: a single corporate author, or the persons. */
function nameList(people: unknown, tag: 'Author' | 'Editor'): string {
  const list = peopleOf(people);
  if (!list.length) return '';
  const [only] = list;
  const inner =
    list.length === 1 && only && typeof only['literal'] === 'string' && only['literal']
      ? textElement('b:Corporate', only['literal'])
      : `<b:NameList>${list.map(nameXml).join('')}</b:NameList>`;
  return `<b:${tag}>${inner}</b:${tag}>`;
}

/** The contributors of a source: Word nests the authors and the editors in one `b:Author`. */
function contributorsXml(authors: unknown, editors: unknown): string {
  const inner = `${nameList(authors, 'Author')}${nameList(editors, 'Editor')}`;
  return inner ? `<b:Author>${inner}</b:Author>` : '';
}

/** The children of an imported source that the model has no place for, written back as they were. */
function residueXml(residue: unknown): string {
  const kids = elementsOf((residue as TreeBody | null | undefined)?.children);
  if (!kids.length) return '';
  const ns = new NamespaceWriter(new Map([['b', BIBLIOGRAPHY_NS]]));
  return kids.map((k) => ns.element(k)).join('');
}

/** True when the residue holds an element of this local name in the bibliography namespace. */
function residueHas(residue: unknown, local: string): boolean {
  const name = `{${BIBLIOGRAPHY_NS}}${local}`;
  return elementsOf((residue as TreeBody | null | undefined)?.children).some(
    (k) => k.name === name,
  );
}

/** One `b:Source` for a source definition node (the attribute names of CDM-052). */
export function sourceXml(
  s: JsonNode,
  residue: unknown = s.attrs?.['preserved'],
  tag?: string,
): string {
  const a = s.attrs ?? {};
  const str = (k: string): string | null => (typeof a[k] === 'string' ? (a[k] as string) : null);
  const type = sourceType(str('kind') ?? 'book');
  const parts: string[] = [textElement('b:Tag', tag ?? String(a['id'] ?? ''))];
  if (!residueHas(residue, 'SourceType')) parts.push(textElement('b:SourceType', type));
  parts.push(contributorsXml(a['authors'], a['editors']));
  const text = (tag: string, value: string | null): void => {
    if (value) parts.push(textElement(tag, value));
  };
  text('b:Title', str('title'));
  const year = /^[0-9]{4}/.exec(str('issued') ?? '');
  if (year) parts.push(textElement('b:Year', year[0]));
  text(`b:${containerElement(type)}`, str('containerTitle'));
  text('b:Publisher', str('publisher'));
  text('b:City', str('publisherPlace'));
  text('b:Edition', str('edition'));
  text('b:Volume', str('volume'));
  text('b:Issue', str('issue'));
  text('b:Pages', str('pages'));
  text('b:URL', str('url'));
  text('b:Comments', str('note'));
  parts.push(residueXml(residue));
  return `<b:Source>${parts.join('')}</b:Source>`;
}

/** The bibliography sources part (a custom XML item) for the sources of the document. */
export function sourcesPart(sources: readonly JsonNode[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<b:Sources xmlns:b="${BIBLIOGRAPHY_NS}" SelectedStyle="" StyleName="" Version="6">${sources.map((s) => sourceXml(s)).join('')}</b:Sources>`;
}

/** A `b:Source` with its own namespace declaration, for a part whose root binds another prefix. */
export function sourceElementXml(s: JsonNode, residue?: unknown, tag?: string): string {
  return sourceXml(s, residue, tag).replace(
    '<b:Source>',
    `<b:Source xmlns:b="${BIBLIOGRAPHY_NS}">`,
  );
}

/** The identifier of the bibliography item's datastore, a GUID in the store's family. */
export function sourcesItemId(storeItemId: string): string {
  return `{${storeItemId.slice(1, 9)}-0000-4000-8000-000000000004}`;
}
