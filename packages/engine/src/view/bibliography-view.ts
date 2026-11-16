/**
 * The bibliography in the web view (FE-140 criterion 2; CDM-052).
 *
 * A `bibliography` node stores no entries: they are generated from the sources the document cites
 * (`bibliographyEntries`, ../bibliography.ts). This plugin computes them for each bibliography of
 * the document and hands them to the node view as a node decoration, so the list is drawn again
 * when a citation is added or removed, a source changes or the citation style changes. Nothing is
 * written into the document, and the list is not editable.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import {
  Decoration,
  DecorationSet,
  type NodeView,
  type NodeViewConstructor,
} from 'prosemirror-view';
import {
  type BibliographyEntry,
  type BibliographyInclude,
  bibliographyEntries,
} from '../bibliography.ts';

export const bibliographyKey = new PluginKey<DecorationSet>('docedit-bibliography');

export const BIBLIOGRAPHY_CLASS = 'de-bibliography';
export const BIBLIOGRAPHY_ENTRY_CLASS = 'de-bibliography-entry';
/** The accessible name of the list, and the text shown while it has no entry. */
export const BIBLIOGRAPHY_LABEL = 'Bibliography';
export const BIBLIOGRAPHY_EMPTY = 'Bibliography: no sources cited yet';

/** The positions of the bibliography nodes of the document. */
function bibliographies(doc: PMNode): Array<{ pos: number; node: PMNode }> {
  const out: Array<{ pos: number; node: PMNode }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'bibliography') out.push({ pos, node });
    return !node.isTextblock && !node.isLeaf && node.type.name !== 'defs';
  });
  return out;
}

function decorationsOf(doc: PMNode): DecorationSet {
  const found = bibliographies(doc);
  if (found.length === 0) return DecorationSet.empty;
  const byInclude = new Map<BibliographyInclude, string>();
  return DecorationSet.create(
    doc,
    found.map(({ pos, node }) => {
      const include: BibliographyInclude = node.attrs['include'] === 'all' ? 'all' : 'cited';
      let entries = byInclude.get(include);
      if (entries === undefined) {
        // A string, so that an unchanged list is an equal decoration and nothing is redrawn.
        entries = JSON.stringify(bibliographyEntries(doc, include));
        byInclude.set(include, entries);
      }
      return Decoration.node(pos, pos + node.nodeSize, {}, { bibliography: entries });
    }),
  );
}

/** The entries of each bibliography as node decorations; recomputed when the document changes. */
export function bibliographyPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: bibliographyKey,
    state: {
      init: (_config, state) => decorationsOf(state.doc),
      apply: (tr, value) => (tr.docChanged ? decorationsOf(tr.doc) : value),
    },
    props: {
      decorations(state) {
        return bibliographyKey.getState(state) ?? null;
      },
    },
  });
}

function entriesOf(decorations: readonly Decoration[]): string {
  for (const d of decorations) {
    const entries = (d.spec as { bibliography?: string } | undefined)?.bibliography;
    if (entries !== undefined) return entries;
  }
  return '[]';
}

/**
 * The node view of a bibliography: a list of the generated entries, one paragraph each, with the
 * italic runs as `i` elements. Addresses are shown as text, never as links. The list is one
 * non-editable unit.
 */
export const bibliographyView: NodeViewConstructor = (
  node,
  _view,
  _getPos,
  decorations,
): NodeView => {
  const dom = document.createElement('div');
  dom.className = BIBLIOGRAPHY_CLASS;
  dom.contentEditable = 'false';
  dom.setAttribute('role', 'list');
  dom.setAttribute('aria-label', BIBLIOGRAPHY_LABEL);
  let drawn: string | null = null;
  const paint = (json: string): void => {
    if (json === drawn) return;
    drawn = json;
    const entries = JSON.parse(json) as BibliographyEntry[];
    dom.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = `${BIBLIOGRAPHY_ENTRY_CLASS} de-bibliography-empty`;
      empty.textContent = BIBLIOGRAPHY_EMPTY;
      dom.append(empty);
      return;
    }
    for (const entry of entries) {
      const p = document.createElement('p');
      p.className = BIBLIOGRAPHY_ENTRY_CLASS;
      p.setAttribute('role', 'listitem');
      p.setAttribute('data-source', entry.sourceId);
      for (const part of entry.parts) {
        if (part.italic) {
          const i = document.createElement('i');
          i.textContent = part.text;
          p.append(i);
        } else p.append(part.text);
      }
      dom.append(p);
    }
  };
  paint(entriesOf(decorations));
  const type = node.type;
  return {
    dom,
    update(next, decos) {
      if (next.type !== type) return false;
      paint(entriesOf(decos));
      return true;
    },
    // The list is drawn by this view; the editor does not read its changes back.
    ignoreMutation: () => true,
  };
};
