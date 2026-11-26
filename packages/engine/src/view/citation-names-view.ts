/**
 * The accessible name of a citation in the web view (FE-140 criterion 3; 13 §2; 02 §10).
 *
 * The schema's own rendering names a citation by the identifiers of its sources, because the node
 * cannot read the document's definitions (`citationLabel` in schema.ts). This plugin gives each
 * rendered citation the name a reader needs: the sources it cites in the document's citation style
 * (the entry text of `bibliography.ts`), each with the prefix, locator and suffix the author set.
 * A source that the document does not define keeps its identifier. The name is the `aria-label` of
 * the `note` element, which assistive technology reads when the caret reaches the citation.
 *
 * - `citationName` is the pure part.
 * - `citationNamesPlugin` is the view part: it renames the citations after the view brings its DOM
 *   up to date, when the document changes (a source can change without its citations changing).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { bibliographyEntries, entryText } from '../bibliography.ts';

type Attrs = Readonly<Record<string, unknown>>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The words of the name of one cited item: prefix, the source, locator, suffix. */
function itemName(item: Attrs, label: (id: string) => string | null): string | null {
  const id = str(item['source']);
  if (id === '') return null;
  const parts = [str(item['prefix']), label(id) ?? id];
  const locator = str(item['locator']);
  if (locator !== '') {
    const kind = str(item['label']);
    parts.push(kind === '' || kind === 'page' ? `(${locator})` : `(${kind} ${locator})`);
  }
  parts.push(str(item['suffix']));
  return parts.filter((p) => p !== '').join(' ');
}

/**
 * The accessible name of a citation. `label` gives the text of a source by identifier, or null for
 * one the document does not define.
 */
export function citationName(attrs: Attrs, label: (id: string) => string | null): string {
  const items: unknown = attrs['items'];
  if (!Array.isArray(items)) return 'Citation';
  const names: string[] = [];
  for (const item of items as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const name = itemName(item as Attrs, label);
    if (name !== null) names.push(name);
  }
  return names.length === 0 ? 'Citation' : `Citation: ${names.join('; ')}`;
}

/** The text of every source of the document, by identifier. */
export function sourceLabels(doc: PMNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of bibliographyEntries(doc, 'all')) out.set(entry.sourceId, entryText(entry));
  return out;
}

/** Renames the rendered citations of the view. */
export function nameCitations(view: EditorView): void {
  const doc = view.state.doc;
  let labels: Map<string, string> | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'citation') return true;
    labels ??= sourceLabels(doc);
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return false;
    const known = labels;
    const name = citationName(node.attrs, (id) => known.get(id) ?? null);
    if (dom.getAttribute('aria-label') !== name) dom.setAttribute('aria-label', name);
    return false;
  });
}

/** Pass it as a plugin of the view (a plugin without state), not of the editor state. */
export function citationNamesPlugin(): Plugin {
  return new Plugin({
    view(view) {
      nameCitations(view);
      return {
        update(next, prev) {
          if (next.state.doc !== prev.doc) nameCitations(next);
        },
      };
    },
  });
}
