/**
 * The table of contents and the lists of figures or tables in the web view (FE-136 criterion 3;
 * 03 §4.3 `toc`). A `toc` node stores no entries: they are generated from the headings or captions
 * of the body (`tocEntries`, ../toc-entries.ts). This plugin computes them for each `toc` of the
 * document when the document changes and hands them to the node view as a node decoration, so the
 * list is drawn again as headings and captions change. Nothing is written into the document, and
 * the list is not editable. No page numbers are shown: the web view does not show pages (02 §7).
 *
 * Nothing is computed while the document has no `toc` node.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import {
  Decoration,
  DecorationSet,
  type NodeView,
  type NodeViewConstructor,
} from 'prosemirror-view';
import { type TocEntry, tocContext, tocEntries, tocNodes } from '../toc-entries.ts';

export const tocKey = new PluginKey<DecorationSet>('docedit-toc');

export const TOC_CLASS = 'de-toc';
export const TOC_ENTRY_CLASS = 'de-toc-entry';
export const TOC_TITLE = 'Table of contents';

/** The accessible name of a list: the contents of the headings, or the captions of a sequence. */
export function tocLabel(of: unknown): string {
  return typeof of === 'string' && of !== 'headings' ? `List of ${of.toLowerCase()}s` : TOC_TITLE;
}

/** The text shown while a list has no entry. */
export function tocEmpty(of: unknown): string {
  return typeof of === 'string' && of !== 'headings'
    ? `${tocLabel(of)}: no captions yet`
    : `${TOC_TITLE}: no headings yet`;
}

function decorationsOf(doc: PMNode): DecorationSet {
  const found = tocNodes(doc);
  if (found.length === 0) return DecorationSet.empty;
  const ctx = tocContext(doc);
  return DecorationSet.create(
    doc,
    found.map(({ pos, node }) =>
      // A string, so that an unchanged list is an equal decoration and nothing is redrawn.
      Decoration.node(pos, pos + node.nodeSize, {}, { toc: JSON.stringify(tocEntries(ctx, node)) }),
    ),
  );
}

/** The entries of each `toc` as node decorations; recomputed when the document changes. */
export function tocPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tocKey,
    state: {
      init: (_config, state) => decorationsOf(state.doc),
      apply: (tr, value) => (tr.docChanged ? decorationsOf(tr.doc) : value),
    },
    props: {
      decorations(state) {
        return tocKey.getState(state) ?? null;
      },
    },
  });
}

function entriesOf(decorations: readonly Decoration[]): string {
  for (const d of decorations) {
    const entries = (d.spec as { toc?: string } | undefined)?.toc;
    if (entries !== undefined) return entries;
  }
  return '[]';
}

/** The node view of a `toc`: one paragraph for each entry, indented by its level, as text only. */
export const tocView: NodeViewConstructor = (node, _view, _getPos, decorations): NodeView => {
  const dom = document.createElement('div');
  dom.className = TOC_CLASS;
  dom.contentEditable = 'false';
  dom.setAttribute('role', 'list');
  let current = node;
  dom.setAttribute('aria-label', tocLabel(node.attrs['of']));
  let drawn: string | null = null;
  const paint = (json: string): void => {
    if (json === drawn) return;
    drawn = json;
    const entries = JSON.parse(json) as TocEntry[];
    dom.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = `${TOC_ENTRY_CLASS} de-toc-empty`;
      empty.textContent = tocEmpty(current.attrs['of']);
      dom.append(empty);
      return;
    }
    for (const entry of entries) {
      const p = document.createElement('p');
      p.className = TOC_ENTRY_CLASS;
      p.setAttribute('role', 'listitem');
      p.setAttribute('data-level', String(entry.level));
      p.setAttribute('data-block', entry.blockId);
      p.style.paddingInlineStart = `${(entry.level - 1) * 1.5}em`;
      p.textContent = entry.label === '' ? entry.text : `${entry.label} ${entry.text}`;
      dom.append(p);
    }
  };
  paint(entriesOf(decorations));
  const type = node.type;
  return {
    dom,
    update(next, decos) {
      if (next.type !== type) return false;
      if (next.attrs['of'] !== current.attrs['of']) {
        current = next;
        dom.setAttribute('aria-label', tocLabel(next.attrs['of']));
        drawn = null;
      }
      current = next;
      paint(entriesOf(decos));
      return true;
    },
    // The list is drawn by this view; the editor does not read its changes back.
    ignoreMutation: () => true,
  };
};
