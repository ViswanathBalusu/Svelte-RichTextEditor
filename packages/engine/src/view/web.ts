/**
 * The web view (02 §7, §8): the editing core plus a visible `prosemirror-view` in the shadow root,
 * and the footnote and header sub-editors (FE-056). This is the class the element and the shell use
 * (`CoreApi` of packages/ui); everything about the document lives in `DocumentCore`.
 */
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { keymap } from 'prosemirror-keymap';
import type { Schema } from 'prosemirror-model';
import {
  type Command,
  type EditorState,
  type Plugin,
  Selection,
  type Transaction,
} from 'prosemirror-state';
import { Mapping } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import type { CoreLabels } from '../api.ts';
import { type ClipboardPayload, fragmentFromHtml } from '../clipboard.ts';
import { CDM_VERSION, type CoreConfig, DocumentCore } from '../core.ts';
import { insertLineBreak, noNestedFootnote, oneParagraphLimit } from '../footnote.ts';
import { coreKeys } from '../keys.ts';
import { commentDecorations } from '../comment-decorations.ts';
import { pageGuideDecorations } from '../page-guide-decorations.ts';
import { FIND_CURRENT_CLASS, findDecorations } from '../search-highlight.ts';
import { SubEditor, type SubEditorTarget } from '../subeditor.ts';
import { cssomMarkViews, type SelectionShim, shimShadowSelection } from '../view-support.ts';
import { footnoteNumbers, footnoteRefView } from './footnote-view.ts';
import { listSemanticsPlugin } from './list-view.ts';
import { foreignClipboard, pasteThroughPolicy } from './paste-policy.ts';
import { picturePlaceholderView } from './picture-placeholder-view.ts';
import { suggestionDecorations } from './suggestion-decorations.ts';

function viewPlugins(schema: Schema): Plugin[] {
  return [
    keymap(coreKeys(schema)),
    keymap(baseKeymap),
    gapCursor(),
    dropCursor(),
    footnoteNumbers(),
    listSemanticsPlugin(),
    // FE-053 criterion 3: draws the core's pending picture placeholders (the core keeps only state).
    picturePlaceholderView(),
  ];
}

const webViews = new WeakMap<
  object,
  { view: () => EditorView | null; sub: () => SubEditor | null }
>();

/** The body view and the open sub-editor of a core, for tests and the spike harness. */
export function viewsOf(core: object): { view: EditorView | null; subEditor: SubEditor | null } {
  const v = webViews.get(core);
  return { view: v?.view() ?? null, subEditor: v?.sub() ?? null };
}

/** English names of the surfaces, used until the shell sets its own (UX-064). */
const DEFAULT_LABELS: CoreLabels = { body: 'Document', footnote: 'Footnote text', story: 'Header' };

/**
 * Writes a copy or cut to the browser's clipboard: the two standard types the core chose, and nothing
 * else (FE-050). The browser's own copy is always prevented, so a refused copy (FE-055) writes nothing.
 */
function writeClipboard(event: ClipboardEvent, payload: ClipboardPayload | null): void {
  event.preventDefault();
  const data = event.clipboardData;
  if (!payload || !data) return;
  data.setData('text/html', payload['text/html']);
  data.setData('text/plain', payload['text/plain']);
}

/** The picture files of a clipboard event, or none when the core's choice is not pictures (FE-053). */
function clipboardPictures(data: DataTransfer): File[] {
  const files = [...data.files].filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return [];
  const html = data.getData('text/html');
  const text = data.getData('text/plain');
  // The same order as `chooseClipboard`: a fragment, then text, then pictures.
  if (text !== '' || (html !== '' && fragmentFromHtml(html) !== null)) return [];
  return files;
}

/**
 * Takes a drop that did not start in this view: the caret goes to the drop point and `paste` reads
 * the data. A drag inside the view keeps ProseMirror's handling, which moves the dragged slice and
 * reads no HTML. Returns whether the event was taken.
 */
function dropFromOutside(
  view: EditorView,
  event: DragEvent,
  paste: (data: DataTransfer) => void,
): boolean {
  const data = event.dataTransfer;
  if (view.dragging || !view.editable || !data) return false;
  event.preventDefault();
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return true;
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(at.pos))));
  paste(data);
  return true;
}

export class EditorCore extends DocumentCore {
  /**
   * A paste whose clipboard holds pictures and no text goes through the core (FE-053): the files are
   * read and handed to `pasteFromClipboard`, which asks the guard before anything is uploaded.
   * Everything else stays with ProseMirror's own paste handling.
   */
  #pastePictures(data: DataTransfer): boolean {
    const files = clipboardPictures(data);
    if (files.length === 0) return false;
    void Promise.all(
      files.map(async (f) => ({
        name: f.name,
        mime: f.type,
        bytes: new Uint8Array(await f.arrayBuffer()),
      })),
    ).then((images) => this.pasteFromClipboard({ files: images }));
    return true;
  }

  /**
   * A paste goes through the core (FE-050 to FE-052, FE-054): a copied fragment, then the HTML read
   * through the whitelist, then plain text, then pictures are chosen by `pasteFromClipboard`. The HTML
   * is parsed here into an inert document and never by ProseMirror's own paste.
   */
  #paste(data: DataTransfer | null): boolean {
    if (!data) return false;
    if (clipboardPictures(data).length > 0) return this.#pastePictures(data);
    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    if (html === '' && text === '') return false;
    // Under Trusted Types the parse goes through a policy; where none is allowed it yields null and the
    // plain text is used, so the handler never throws (FE-054 criterion 5; paste-policy.ts).
    const { fragment: foreign, pictures: htmlPictures } = foreignClipboard(html, CDM_VERSION);
    this.pasteFromClipboard({ html, text, foreign, htmlPictures });
    return true;
  }

  readonly #selectionShim: SelectionShim;
  readonly #fontAlias: ((family: string) => string | undefined) | undefined;
  #shimResult: 'native' | 'instance' | 'none' | null = null;
  /** The blocks before which a page guide is drawn (FE-068); empty when guides are off. */
  #pageGuides: ReadonlySet<string> = new Set();
  #view: EditorView | null = null;
  #sub: SubEditor | null = null;
  #subKind: SubEditorTarget['kind'] | null = null;
  #labels: CoreLabels = DEFAULT_LABELS;
  /** Set by a find navigation; the next draw of the highlights scrolls the current match in (FE-059). */
  #scrollToMatch = false;

  override findNext(): boolean {
    const moved = super.findNext();
    if (moved) this.#scrollToMatch = true;
    return moved;
  }

  override findPrevious(): boolean {
    const moved = super.findPrevious();
    if (moved) this.#scrollToMatch = true;
    return moved;
  }

  /**
   * Sets the accessible names of the editing surfaces in the interface's locale (UX-064; the
   * shell's `setLabels`). Applied at once to mounted surfaces and to every later mount.
   */
  setLabels(labels: CoreLabels): void {
    this.#labels = { body: labels.body, footnote: labels.footnote, story: labels.story };
    this.#view?.setProps({ attributes: this.#bodyAttributes() });
    if (this.#sub && this.#subKind)
      this.#sub.view.setProps({ attributes: this.#subAttributes(this.#subKind) });
  }

  /** The labels in use. */
  get labels(): CoreLabels {
    return this.#labels;
  }

  #bodyAttributes(): Record<string, string> {
    // The base direction is the document's (`settings.dir`, FE-111), not the interface's.
    return {
      class: 'de-editing-surface',
      spellcheck: 'true',
      'aria-label': this.#labels.body,
      dir: this.direction.get(),
    };
  }

  #subAttributes(kind: SubEditorTarget['kind']): Record<string, string> {
    return {
      class: `de-sub-editor de-sub-${kind}`,
      spellcheck: 'true',
      'aria-label': kind === 'footnote' ? this.#labels.footnote : this.#labels.story,
    };
  }

  constructor(config: CoreConfig) {
    super(config, viewPlugins);
    this.#selectionShim = config.selectionShim ?? 'instance';
    this.#fontAlias = config.fontAlias;
    webViews.set(this, { view: () => this.#view, sub: () => this.#sub });
  }

  /** What the shadow-root selection shim did when the view was mounted (02 §8). */
  get selectionShimResult(): 'native' | 'instance' | 'none' | null {
    return this.#shimResult;
  }

  /**
   * Sets the blocks before which the web view draws a page guide (FE-068; 02 §7). The element computes
   * them from the compile's `layout.json`; an empty list removes every guide. The view is redrawn at
   * once, without a transaction, and the document is not changed.
   */
  setPageGuides(blockIds: readonly string[]): void {
    this.#pageGuides = new Set(blockIds);
    this.#view?.setProps({});
  }

  /** Mounts the body web view on an element inside the shadow root. */
  mountBody(target: HTMLElement): () => void {
    if (this.#view) throw new Error('the body view is already mounted');
    this.#shimResult = shimShadowSelection(target.getRootNode(), this.#selectionShim);
    const view = new EditorView(
      { mount: target },
      {
        state: this.editorState,
        dispatchTransaction: this.dispatch,
        editable: () => !this.readOnly,
        nodeViews: { footnote: footnoteRefView((id) => this.openFootnote(id)) },
        markViews: cssomMarkViews(this.#fontAlias),
        attributes: this.#bodyAttributes(),
        // Copy and cut are the core's (FE-050, FE-055): the browser's own copy would write ProseMirror's format.
        handleDOMEvents: {
          // Paste is taken here, not by `handlePaste`: ProseMirror parses the clipboard's HTML before it calls
          // `handlePaste`, and under Trusted Types that parse uses ProseMirror's own policy, which a host may
          // refuse (FE-054 criterion 5). Read-only views keep ProseMirror's handling, which does nothing there.
          paste: (view, event) => {
            if (!view.editable) return false;
            const handled = this.#paste(event.clipboardData);
            if (handled) event.preventDefault();
            return handled;
          },
          copy: (_view, event) => {
            writeClipboard(event, this.copySelection());
            return true;
          },
          cut: (_view, event) => {
            writeClipboard(event, this.cutSelection().payload);
            return true;
          },
          // A drag out of the surface is refused where a copy is (FE-055 criterion 1): no drag starts and
          // no drag data is written. A drag the core allows keeps ProseMirror's own handling.
          dragstart: (_view, event) => {
            if (this.copySelection() !== null) return false;
            event.preventDefault();
            return true;
          },
          // A drop from outside the view is read as a paste at the drop point (FE-016 criterion 5):
          // ProseMirror's own drop would read the HTML under its own policy name.
          drop: (view, event) =>
            dropFromOutside(view, event, (data) => {
              this.#paste(data);
            }),
        },
        // The find highlights (FE-059): drawn from the document and the find state, never stored.
        // The suggestion marks in the `all` view are drawn too (FE-046 criterion 4; FE-045 criterion 1).
        decorations: (state) => {
          const f = this.findState.get();
          return findDecorations(state.doc, { query: f.query, current: f.current })
            .add(state.doc, suggestionDecorations(state.doc, 'all').find())
            .add(state.doc, commentDecorations(state.doc, this.threadRanges.get()).find())
            .add(state.doc, pageGuideDecorations(state.doc, this.#pageGuides).find());
        },
      },
    );
    this.#view = view;
    const ended = () => this.compositionEnded();
    target.addEventListener('compositionend', ended);
    // A change of the find state redraws the highlights at once (the view is not told by a transaction).
    // A change of a thread's range redraws its decoration at once (FE-048).
    const unthread = this.threadRanges.subscribe(() => this.#view?.setProps({}));
    const unfind = this.findState.subscribe(() => {
      const v = this.#view;
      if (!v) return;
      v.setProps({});
      // A navigation brings its match into view even when the editing surface has no focus (FE-059
      // criterion 2): ProseMirror scrolls only from the DOM selection, which an unfocused view lacks.
      if (this.#scrollToMatch) {
        this.#scrollToMatch = false;
        v.dom.querySelector(`.${FIND_CURRENT_CLASS}`)?.scrollIntoView({ block: 'nearest' });
      }
    });
    // A change of the document's base direction (FE-111) is applied to the surface at once.
    const undirection = this.direction.subscribe(() =>
      this.#view?.setProps({ attributes: this.#bodyAttributes() }),
    );
    const remove = this.addView({
      update: (state, transactions) => this.#update(state, transactions),
      composing: () => this.#composing(),
      focus: () => this.#view?.focus(),
      // The caret of an open sub-editor that has focus, as a main-document position (FE-026 c.3).
      focusedPosition: () => {
        const sub = this.#sub;
        return sub && sub.view.hasFocus() ? sub.mainSelection().from : null;
      },
      // `editable` is read again by setProps; the open sub-editor follows the same lock (FE-029).
      lockChanged: () => {
        this.#view?.setProps({});
        this.#sub?.view.setProps({});
      },
    });
    return () => {
      remove();
      unfind();
      unthread();
      undirection();
      target.removeEventListener('compositionend', ended);
      view.destroy();
      if (this.#view === view) this.#view = null;
    };
  }

  #update(state: EditorState, transactions: readonly Transaction[]): void {
    this.#view?.updateState(state);
    const sub = this.#sub;
    if (!sub) return;
    if (transactions.length === 0) {
      // A new state (reload, reset): follow the node by its identifier.
      if (!sub.sync(state, null)) this.closePanel();
      return;
    }
    if (transactions.some((t) => t.docChanged)) {
      const mapping = new Mapping();
      for (const t of transactions) mapping.appendMapping(t.mapping);
      if (!sub.sync(state, mapping)) this.closePanel();
    }
  }

  /** The block being composed: the body paragraph, or the open sub-editor's whole node (S1). */
  #composing(): number | null {
    if (this.#view?.composing) {
      const $head = this.editorState.selection.$head;
      return $head.depth > 0 ? $head.before() : null;
    }
    if (this.#sub?.view.composing) return this.#sub.pos;
    return null;
  }

  /** Mounts the sub-editor of the open panel on an element inside the shadow root. */
  mountPanel(target: HTMLElement): () => void {
    const panel = this.panelTarget;
    if (!panel) return () => {};
    this.#sub?.destroy();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const editor = this;
    const main = {
      get state(): EditorState {
        return editor.editorState;
      },
      dispatch: (tr: Transaction) => this.dispatch(tr),
    };
    const sub = new SubEditor(main, panel, target, {
      plugins: this.#subPlugins(panel),
      markViews: cssomMarkViews(this.#fontAlias),
      attributes: this.#subAttributes(panel.kind),
      editable: () => !this.readOnly,
      // The sub-editor's copy, cut and drag go through the core as the body's do (FE-050, FE-055
      // criterion 1): its selection is mapped to main positions, so `no-copy` refuses here too.
      handleDOMEvents: {
        copy: (_view, event) => {
          writeClipboard(event, this.copySelection(sub.mainSelection()));
          return true;
        },
        cut: (view, event) => {
          const payload = this.copySelection(sub.mainSelection());
          writeClipboard(event, payload);
          // The deletion goes through the sub-editor, so the main state's guard sees it as any edit.
          if (payload && !this.readOnly) view.dispatch(view.state.tr.deleteSelection());
          return true;
        },
        dragstart: (_view, event) => {
          if (this.copySelection(sub.mainSelection()) !== null) return false;
          event.preventDefault();
          return true;
        },
        // Paste and drop are read under the project's policy, never ProseMirror's (FE-016 criterion 5).
        // The sub-editor's own schema parses the result, as ProseMirror's paste did.
        paste: (view, event) => {
          if (!view.editable || !event.clipboardData) return false;
          const handled = pasteThroughPolicy(view, event.clipboardData);
          if (handled) event.preventDefault();
          return handled;
        },
        drop: (view, event) =>
          dropFromOutside(view, event, (data) => {
            pasteThroughPolicy(view, data);
          }),
      },
    });
    this.#sub = sub;
    this.#subKind = panel.kind;
    const ended = () => this.compositionEnded();
    target.addEventListener('compositionend', ended);
    sub.view.focus();
    return () => {
      target.removeEventListener('compositionend', ended);
      sub.destroy();
      if (this.#sub === sub) {
        this.#sub = null;
        this.#subKind = null;
      }
    };
  }

  #subPlugins(target: SubEditorTarget): Plugin[] {
    const s = this.schema;
    const keys: Record<string, Command> = {
      'Shift-Enter': insertLineBreak(s),
      'Mod-b': toggleMark(s.marks['bold']!, { value: true }),
      'Mod-i': toggleMark(s.marks['italic']!, { value: true }),
    };
    const plugins: Plugin[] = [];
    // CDM-001: one paragraph in a footnote in version 1; Enter's split is refused. I10: no
    // footnote inside it, however it arrives.
    if (target.kind === 'footnote') plugins.push(oneParagraphLimit(), noNestedFootnote());
    plugins.push(keymap(keys), keymap(baseKeymap));
    return plugins;
  }

  override closePanel(): void {
    this.#sub?.destroy();
    this.#sub = null;
    this.#subKind = null;
    super.closePanel();
  }

  override destroy(): void {
    this.#sub?.destroy();
    this.#sub = null;
    this.#view?.destroy();
    this.#view = null;
    super.destroy();
  }
}
