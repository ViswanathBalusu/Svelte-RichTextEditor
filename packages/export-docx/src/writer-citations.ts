/**
 * Citations and sources in the direct DOCX writer (09 §11; EXP-122 criterion 1). A citation becomes a
 * Word citation field (`CITATION <tag> \l 1033 [\m <tag>]... [\n]`) whose result is the cached text;
 * the sources of the document become the package's bibliography sources part, a custom XML part
 * whose items carry the `b:Sources` namespace, so Word can update the fields from them.
 *
 * Spec defaults, recorded in docs/stories/EXP-export.md (EXP-122) and ADR 0230: the source tag is the
 * source's identifier; the language switch is the LCID of en-US; a locator, prefix or suffix is
 * written only into the cached text, because a plain `CITATION` field has no place for them.
 */
import type { JsonNode } from '@docedit/model';
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

interface CitationItemLike {
  source?: unknown;
}

/** The field instruction of a citation, or null when no item has a tag Word can take. */
export function citationInstruction(
  items: readonly CitationItemLike[],
  mode: string,
): string | null {
  const tags = items
    .map((i) => i.source)
    .filter((s): s is string => typeof s === 'string' && FIELD_TAG.test(s));
  const [first, ...more] = tags;
  if (!first) return null;
  let instr = ` CITATION ${first} \\l ${CITATION_LCID}`;
  for (const t of more) instr += ` \\m ${t}`;
  if (mode === 'suppressAuthor') instr += ' \\n';
  return `${instr} `;
}

/** The runs of a complex field: begin, instruction, separate, result, end. Each run carries `rPr`. */
export function fieldRuns(instr: string, result: string, rPr: string): string {
  const fld = (type: string): string =>
    el('w:r', {}, rPr, el('w:fldChar', { 'w:fldCharType': type }));
  return `${fld('begin')}${el('w:r', {}, rPr, textElement('w:instrText', instr))}${fld('separate')}${el('w:r', {}, rPr, textElement('w:t', result))}${fld('end')}`;
}

/** A `b:Person` or `b:Corporate` name of an author or editor, from a CSL name. */
function nameXml(p: Record<string, unknown>): string {
  const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
  if (str('literal')) return textElement('b:Corporate', str('literal'));
  const last = [str('particle'), str('family')].filter(Boolean).join(' ');
  return `<b:Person>${last ? textElement('b:Last', last) : '<b:Last/>'}${str('given') ? textElement('b:First', str('given')) : '<b:First/>'}</b:Person>`;
}

function authorsXml(people: unknown, tag: 'Author' | 'Editor'): string {
  if (!Array.isArray(people) || !people.length) return '';
  const names = people
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map(nameXml)
    .join('');
  return `<b:${tag}><b:${tag}><b:NameList>${names}</b:NameList></b:${tag}></b:${tag}>`;
}

/** One `b:Source` for a source definition node (the attribute names of CDM-052). */
export function sourceXml(s: JsonNode): string {
  const a = s.attrs ?? {};
  const str = (k: string): string | null => (typeof a[k] === 'string' ? (a[k] as string) : null);
  const parts: string[] = [
    textElement('b:Tag', String(a['id'] ?? '')),
    textElement('b:SourceType', sourceType(str('kind') ?? 'book')),
    authorsXml(a['authors'], 'Author'),
  ];
  const text = (tag: string, value: string | null): void => {
    if (value) parts.push(textElement(tag, value));
  };
  text('b:Title', str('title'));
  const year = /^[0-9]{4}/.exec(str('issued') ?? '');
  if (year) parts.push(textElement('b:Year', year[0]));
  text('b:JournalName', str('containerTitle'));
  text('b:Publisher', str('publisher'));
  text('b:City', str('publisherPlace'));
  text('b:Edition', str('edition'));
  text('b:Volume', str('volume'));
  text('b:Issue', str('issue'));
  text('b:Pages', str('pages'));
  text('b:URL', str('url'));
  text('b:Comments', str('note'));
  return `<b:Source>${parts.join('')}</b:Source>`;
}

/** The bibliography sources part (a custom XML item) for the sources of the document. */
export function sourcesPart(sources: readonly JsonNode[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<b:Sources xmlns:b="${BIBLIOGRAPHY_NS}" SelectedStyle="" StyleName="" Version="6">${sources.map(sourceXml).join('')}</b:Sources>`;
}

/** The identifier of the bibliography item's datastore, a GUID in the store's family. */
export function sourcesItemId(storeItemId: string): string {
  return `{${storeItemId.slice(1, 9)}-0000-4000-8000-000000000004}`;
}
