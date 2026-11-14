/**
 * Sub-editors (02 §5.2, §8; FE-056): headers, footers and footnotes are edited in their own small
 * editor states whose steps are mapped onto the one document. The sub-editor's document is the
 * story or footnote node itself, so its positions are the node's content positions shifted by one.
 *
 * - Local edits in the sub-editor are applied to its own state at once, then forwarded to the main
 *   state as offset steps, where the identifier plugin, the guard and the sync client see them as
 *   any local edit.
 * - Every main state change is diffed against the sub-editor's document and the difference is
 *   applied to the sub-editor, so remote commits and identifier fills appear in it (the approach of
 *   ProseMirror's footnote example, with the inner view mounted in a panel instead of a tooltip).
 */
import { EditorState, type Plugin, type Transaction } from 'prosemirror-state';
import type { Mapping } from 'prosemirror-transform';
import {
  type EditorProps,
  EditorView,
  type MarkViewConstructor,
  type NodeViewConstructor,
} from 'prosemirror-view';
import {
  FROM_MAIN,
  FROM_SUB,
  forwardToMain,
  locate,
  replaceInner,
  type SubEditorTarget,
} from './subeditor-sync.ts';

export { FROM_MAIN, FROM_SUB, locate, type SubEditorTarget };

export interface MainHost {
  readonly state: EditorState;
  dispatch(tr: Transaction): void;
}

export interface SubEditorOptions {
  plugins: Plugin[];
  nodeViews?: Record<string, NodeViewConstructor>;
  markViews?: Record<string, MarkViewConstructor>;
  attributes?: Record<string, string>;
  /** Whether the sub-editor accepts input; read again on `view.setProps` (FE-029). */
  editable?: () => boolean;
  /**
   * DOM event handlers of the sub-editor's view. The web view routes `copy`, `cut` and `dragstart`
   * through the core here, as it does for the body (FE-050, FE-055 criterion 1).
   */
  handleDOMEvents?: NonNullable<EditorProps['handleDOMEvents']>;
}

export class SubEditor {
  readonly view: EditorView;
  readonly target: SubEditorTarget;
  readonly #main: MainHost;
  #pos: number;

  constructor(
    main: MainHost,
    target: SubEditorTarget,
    mount: HTMLElement,
    options: SubEditorOptions,
  ) {
    this.#main = main;
    this.target = target;
    this.#pos = locate(main.state.doc, target);
    const node = main.state.doc.nodeAt(this.#pos);
    if (this.#pos < 0 || !node) throw new Error(`no ${target.kind} with id ${target.id}`);
    this.view = new EditorView(
      { mount },
      {
        state: EditorState.create({ doc: node, plugins: options.plugins }),
        dispatchTransaction: (tr) => this.#dispatchInner(tr),
        nodeViews: options.nodeViews ?? {},
        markViews: options.markViews ?? {},
        attributes: options.attributes ?? {},
        ...(options.editable ? { editable: options.editable } : {}),
        ...(options.handleDOMEvents ? { handleDOMEvents: options.handleDOMEvents } : {}),
      },
    );
  }

  /** Position of the edited node in the main document. */
  get pos(): number {
    return this.#pos;
  }

  /**
   * The sub-editor's selection as main-document positions: its document is the node itself, so a
   * position is the node's content start plus the inner position.
   */
  mainSelection(): { from: number; to: number } {
    const { from, to } = this.view.state.selection;
    return { from: this.#pos + 1 + from, to: this.#pos + 1 + to };
  }

  #dispatchInner(tr: Transaction): void {
    const { state, transactions } = this.view.state.applyTransaction(tr);
    this.view.updateState(state);
    if (tr.getMeta(FROM_MAIN) === true) return;
    const steps = transactions.flatMap((t) => t.steps);
    if (steps.length === 0) return;
    const outer = forwardToMain(this.#main.state, this.target, this.#pos, steps);
    if (!outer) {
      // The sub-editor and the main document disagree: resynchronise from the main document.
      this.sync(this.#main.state, null);
      return;
    }
    if (tr.getMeta('addToHistory') === false) outer.setMeta('addToHistory', false);
    const before = this.#main.state.doc;
    this.#main.dispatch(outer);
    // The main state refused it (the region guard, an invariant): the panel shows the document's
    // content again, never content the document does not have.
    if (this.#main.state.doc === before) this.sync(this.#main.state, null);
  }

  /**
   * Brings the sub-editor up to date with the main state. `mapping` maps the old main document
   * to the new one; without it the node is looked up by identifier. Returns false when the node
   * no longer exists, so the caller can close the panel.
   */
  sync(main: EditorState, mapping: Mapping | null): boolean {
    let pos = this.#pos;
    if (mapping) pos = mapping.map(pos, 1);
    let node = main.doc.nodeAt(pos);
    if (!node || node.type.name !== this.target.kind || node.attrs['id'] !== this.target.id) {
      pos = locate(main.doc, this.target);
      node = pos >= 0 ? main.doc.nodeAt(pos) : null;
    }
    if (!node) return false;
    this.#pos = pos;
    const tr = replaceInner(this.view.state, node);
    if (tr) this.view.dispatch(tr);
    return true;
  }

  destroy(): void {
    this.view.destroy();
  }
}
