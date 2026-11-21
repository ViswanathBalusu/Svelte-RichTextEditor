/**
 * Listing the document's sources and finding where each is cited (UX-103; CDM-052). The reading
 * half of `source-edit.ts` and `source-delete.ts`: the shell reads the list as soon as it has the
 * sources service, so this stays in the first load, while the editing and its grammar checks load
 * with the sources pane (`./parts.ts`; FND-008).
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import type { JsonValue } from '@docedit/model/definition';
import type { Node } from 'prosemirror-model';

/** The attributes of a source an author may set; `id` is fixed when the source is made. */
export const SOURCE_FIELDS = [
  'kind',
  'title',
  'authors',
  'editors',
  'issued',
  'accessed',
  'containerTitle',
  'publisher',
  'publisherPlace',
  'edition',
  'volume',
  'issue',
  'pages',
  'number',
  'doi',
  'url',
  'isbn',
  'issn',
  'language',
  'note',
] as const;

export type SourceField = (typeof SOURCE_FIELDS)[number];

/** One place that cites a source: the position of the citation and the text of its block. */
export interface SourceCitedAt {
  readonly pos: number;
  readonly excerpt: string;
}

export interface SourceInfo {
  readonly id: string;
  readonly values: Readonly<Record<SourceField, JsonValue>>;
  readonly citedAt: readonly SourceCitedAt[];
}

/** The document positions of the citation nodes that name `sourceId` in one of their items, in order. */
export function citationsCiting(doc: Node, sourceId: string): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'citation') return true;
    const items = node.attrs['items'];
    if (!Array.isArray(items)) return false;
    const names = items.some(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>)['source'] === sourceId,
    );
    if (names) out.push(pos);
    return false;
  });
  return out;
}

/** The text of the block that holds position `pos`, shortened; citations show as nothing. */
function excerptAt(doc: Node, pos: number): string {
  const $pos = doc.resolve(pos);
  const text = $pos.parent.textContent.replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** The sources of the document in the order of its definitions, each with where it is cited. */
export function listSources(doc: Node): SourceInfo[] {
  const out: SourceInfo[] = [];
  doc.firstChild?.forEach((child) => {
    if (child.type.name !== 'source_def') return;
    const id = child.attrs['id'];
    if (typeof id !== 'string') return;
    const values = {} as Record<SourceField, JsonValue>;
    for (const field of SOURCE_FIELDS) values[field] = child.attrs[field] as JsonValue;
    out.push({
      id,
      values,
      citedAt: citationsCiting(doc, id).map((pos) => ({ pos, excerpt: excerptAt(doc, pos) })),
    });
  });
  return out;
}
