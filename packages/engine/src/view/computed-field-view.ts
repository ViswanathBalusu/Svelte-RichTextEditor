/**
 * The node view of a `seq` or `ref` field in the web view (FE-134 criterion 3; 03 §4.4, §7;
 * CDM-042). It shows the text the model's shared label computation gives the field (`fieldTexts`,
 * captions-refs.ts), not the field's `cached` text, so a caption number and every reference to it
 * follow the content as it moves or is inserted. The PDF export computes the same texts from the
 * same `computeLabels`, so the two agree.
 *
 * Nothing is written into the document: owner decision 90 of 2026-11-15 says refreshed texts are
 * computed when shown and when exported. `cached` stays what it was, for consumers that cannot
 * compute (FE-134 criterion 5).
 *
 * A field whose target has no label (a `ref` to a deleted or hidden target) keeps its `cached` text
 * and carries `data-unresolved`; the export prints nothing for it and reports a warning.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import type { StaleCache } from '../captions-refs.ts';

/** What the view needs of the registry of live field views (form-field-view.ts). */
export interface ComputedTexts {
  add(view: { refresh(doc: PMNode): void }): void;
  remove(view: { refresh(doc: PMNode): void }): void;
  /** The computed `seq` and `ref` texts of `doc` by position; computed once for each document. */
  textsOf(doc: PMNode): ReadonlyMap<number, StaleCache>;
}

/** The text a field shows: the computed one, or its cached text when nothing computes. */
export function shownText(node: PMNode, computed: StaleCache | undefined): string {
  if (computed?.text !== undefined && computed.text !== null && computed.text !== '') {
    return computed.text;
  }
  const cached = node.attrs['cached'];
  return typeof cached === 'string' && cached !== '' ? cached : `{${String(node.attrs['kind'])}}`;
}

class ComputedFieldView implements NodeView {
  readonly dom: HTMLElement;
  #node: PMNode;
  readonly #views: ComputedTexts;
  readonly #pos: () => number | undefined;
  readonly #self: { refresh(doc: PMNode): void };

  constructor(
    node: PMNode,
    doc: PMNode,
    views: ComputedTexts,
    pos: () => number | undefined,
    dom: HTMLElement,
  ) {
    this.#node = node;
    this.#views = views;
    this.#pos = pos;
    this.dom = dom;
    this.#self = { refresh: (d) => this.#draw(d) };
    views.add(this.#self);
    this.#draw(doc);
  }

  #draw(doc: PMNode): void {
    const at = this.#pos();
    const computed = at === undefined ? undefined : this.#views.textsOf(doc).get(at);
    const text = shownText(this.#node, computed);
    if (this.dom.textContent !== text) this.dom.textContent = text;
    this.dom.toggleAttribute('data-unresolved', computed !== undefined && computed.text === null);
  }

  update(next: PMNode): boolean {
    if (next.type !== this.#node.type || next.attrs['kind'] !== this.#node.attrs['kind']) {
      return false;
    }
    this.#node = next;
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.#views.remove(this.#self);
  }
}

/** A computed view for `node`, whose schema drawing is `dom`; `pos` gives its position in the view. */
export function computedFieldView(
  views: ComputedTexts,
  schemaDOM: (node: PMNode) => HTMLElement,
): NodeViewConstructor {
  return (node, view, getPos) =>
    new ComputedFieldView(
      node,
      view.state.doc,
      views,
      () => {
        const pos = getPos();
        return typeof pos === 'number' ? pos : undefined;
      },
      schemaDOM(node),
    );
}
