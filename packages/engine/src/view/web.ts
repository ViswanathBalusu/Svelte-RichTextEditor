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
  NodeSelection,
  type Plugin,
  Selection,
  type Transaction,
} from 'prosemirror-state';
import { AttrStep, Mapping } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import type { CoreLabels, PeerCaretInfo } from '../api.ts';
import { type ClipboardPayload, fragmentFromHtml } from '../clipboard.ts';
import { CDM_VERSION, type CoreConfig, DocumentCore } from '../core.ts';
import { insertLineBreak, noNestedFootnote, oneParagraphLimit } from '../footnote.ts';
import type { AssetImageLookup } from '../image-source.ts';
import type { EquationDrawer } from '../equation-draw.ts';
import { EQUATION_NODES } from '../equation-commands.ts';
import { equationBlockView, equationNumbersPlugin, equationView } from './equation-view.ts';
import { figureView } from './figure-view.ts';
import { imageView } from './image-view.ts';
import { preservedView } from './preserved-view.ts';
import { coreKeys } from '../keys.ts';
import {
  COMMENT_RANGE_CLASS,
  COMMENT_SELECTED_CLASS,
  commentDecorations,
} from '../comment-decorations.ts';
import { pageGuideDecorations } from '../page-guide-decorations.ts';
import { proofingDecorations } from '../proofing-decorations.ts';
import { ReadValue, sameJson } from '../read-value.ts';
import { FIND_CURRENT_CLASS, findDecorations } from '../search-highlight.ts';
import { SubEditor, type SubEditorTarget } from '../subeditor.ts';
import { cssomMarkViews, type SelectionShim, shimShadowSelection } from '../view-support.ts';
import { bibliographyPlugin, bibliographyView } from './bibliography-view.ts';
import { footnoteNumbers, footnoteRefView } from './footnote-view.ts';
import { FormFieldViews, fieldView, formFieldView } from './form-field-view.ts';
import { listSemanticsPlugin } from './list-view.ts';
import { foreignClipboard, pasteThroughPolicy } from './paste-policy.ts';
import { picturePlaceholderView } from './picture-placeholder-view.ts';
import type { ComparisonSpec } from '../comparison-markup.ts';
import type { SuggestionLabel } from '../suggestion-markup.ts';
import { comparisonDecorations } from './comparison-decorations.ts';
import { suggestionDecorations } from './suggestion-decorations.ts';
import { paragraphView } from './paragraph-format-view.ts';
import { sectionWarningPlugin } from './section-warning-view.ts';
import { SuggestionCard } from './suggestion-card.ts';
import { tocPlugin, tocView } from './toc-view.ts';
import { tableCellView, tableStylePlugin } from './table-style-view.ts';

function viewPlugins(schema: Schema): Plugin[] {
  return [
    keymap(coreKeys(schema)),
    keymap(baseKeymap),
    gapCursor(),
    dropCursor(),
    footnoteNumbers(),
    listSemanticsPlugin(),
    // FE-135 criterion 6: a note after a continuous section break that changes the margins.
    sectionWarningPlugin(),
    // FE-069 criterion 5: the numbers of numbered equation blocks, from the shared labels.
    equationNumbersPlugin(),
    // FE-131 criterion 1: the borders and shading a table takes from its table style.
    tableStylePlugin(),
    // FE-140 criterion 2: the generated entries of each bibliography.
    bibliographyPlugin(),
    // FE-136 criterion 3: the generated entries of each table of contents and list of captions.
    tocPlugin(),
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
/**
 * Whether the transactions changed the value of form fields and nothing else: every step sets the
 * `value` of a `form_field`. Then the access, the mode, the definitions and the structure are as they
 * were, and only the fields whose own state moved need drawing (FRW-023 criterion 6). No transaction
 * (a reload or a reset of the state) is not such a change.
 */
function onlyFieldValues(transactions: readonly Transaction[]): boolean {
  if (transactions.length === 0) return false;
  return transactions.every((t) =>
    t.steps.every(
      (step, i) =>
        step instanceof AttrStep &&
        step.attr === 'value' &&
        t.docs[i]?.nodeAt(step.pos)?.type.name === 'form_field',
    ),
  );
}

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
  readonly #assetImage: AssetImageLookup | undefined;
  readonly #drawEquation: EquationDrawer | undefined;
  #shimResult: 'native' | 'instance' | 'none' | null = null;
  /** The blocks before which a page guide is drawn (FE-068); empty when guides are off. */
  #pageGuides: ReadonlySet<string> = new Set();
  /** The comparison drawn in a version view (HIS-013); null in the live editor. */
  #comparison: readonly ComparisonSpec[] | null = null;
  #view: EditorView | null = null;
  #card: SuggestionCard | null = null;
  /** The live form field controls and mirrors of the body view (FRW-004, FRW-006). */
  readonly #fieldViews = new FormFieldViews();
  #sub: SubEditor | null = null;
  #subKind: SubEditorTarget['kind'] | null = null;
  #labels: CoreLabels = DEFAULT_LABELS;
  /** Set by a find navigation; the next draw of the highlights scrolls the current match in (FE-059). */
  #scrollToMatch = false;

  /** Draws the suggestions again with the new words for assistive technology (UX-035 criterion 4). */
  override setSuggestionLabel(label: SuggestionLabel | null): void {
    super.setSuggestionLabel(label);
    this.#view?.setProps({});
  }

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
    this.#labels = {
      body: labels.body,
      footnote: labels.footnote,
      story: labels.story,
      ...(labels.footer === undefined ? {} : { footer: labels.footer }),
    };
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
    const name =
      kind === 'footnote'
        ? this.#labels.footnote
        : this.panel.get()?.part === 'footer'
          ? (this.#labels.footer ?? this.#labels.story)
          : this.#labels.story;
    return {
      class: `de-sub-editor de-sub-${kind}`,
      spellcheck: 'true',
      'aria-label': name,
    };
  }

  /**
   * The other sessions' carets and selections as rectangles relative to the element the body view
   * is mounted in (SYN-036 criterion 5; ui `CoreApi.carets`, UX-027). The positions are those of
   * `peerSelections`: confirmed positions mapped through this reader's own steps, so each lies in
   * the document this view shows. Empty while no body view is mounted.
   */
  readonly carets: ReadValue<readonly PeerCaretInfo[]>;

  /** Measures the peers' carets in the mounted body view. */
  #drawCarets(): void {
    const view = this.#view;
    const peers = this.peerSelections.get();
    if (!view || peers.length === 0) {
      this.carets.set([]);
      return;
    }
    const origin = view.dom.getBoundingClientRect();
    const rect = (r: { left: number; top: number; right: number; bottom: number }) => ({
      x: r.left - origin.left,
      y: r.top - origin.top,
      width: r.right - r.left,
      height: r.bottom - r.top,
    });
    const size = view.state.doc.content.size;
    const out: PeerCaretInfo[] = [];
    for (const p of peers) {
      const { session, user, name, status } = p;
      let caret: PeerCaretInfo['caret'] = null;
      let selection: PeerCaretInfo['selection'] = [];
      // A position outside the document the view holds is never measured: nothing is drawn.
      if (p.head >= 0 && p.head <= size && p.anchor >= 0 && p.anchor <= size) {
        try {
          caret = rect(view.coordsAtPos(p.head));
          if (p.anchor !== p.head) {
            const from = view.domAtPos(Math.min(p.anchor, p.head));
            const to = view.domAtPos(Math.max(p.anchor, p.head));
            const range = view.dom.ownerDocument.createRange();
            range.setStart(from.node, from.offset);
            range.setEnd(to.node, to.offset);
            selection = [...range.getClientRects()].map(rect);
          }
        } catch {
          caret = null;
          selection = [];
        }
      }
      out.push({ session, user, name, status, caret, selection });
    }
    this.carets.set(out);
  }

  constructor(config: CoreConfig) {
    super(config, viewPlugins);
    this.carets = new ReadValue<readonly PeerCaretInfo[]>([], sameJson, config.schedule);
    this.#selectionShim = config.selectionShim ?? 'instance';
    this.#fontAlias = config.fontAlias;
    this.#assetImage = config.assetImage;
    this.#drawEquation = config.drawEquation;
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

  /**
   * Draws a comparison in the document (HIS-013): the specs of comparisonSpecs, or null to remove
   * them. Like the page guides, the view is redrawn without a transaction and the document is not
   * changed. Used by the read-only version view; the live editor never sets one.
   */
  setComparison(specs: readonly ComparisonSpec[] | null): void {
    this.#comparison = specs;
    this.#view?.setProps({});
  }

  /**
   * The caret's rectangle in viewport coordinates: the head of the selection of the view that has
   * focus (the panel's sub-editor when focus is there, otherwise the body). The shell opens a menu
   * there when it is asked for from the keyboard (UX-008; ui `CoreApi.caretRect`). Null while no
   * view is mounted, or when the browser gives no position for the caret.
   */
  /**
   * Moves focus to the control of the form field `id` and scrolls it into view (12 §11; FRW-078
   * criterion 2; ui `CoreApi.focusField`). False when no view is mounted, or the document has no
   * such field, or the field has no control (a kind drawn as text).
   */
  focusField(id: string): boolean {
    const fields = this.#view?.dom.querySelectorAll<HTMLElement>('.de-form-field') ?? [];
    for (const field of fields) {
      if (field.getAttribute('data-field') !== id) continue;
      const control = field.querySelector<HTMLElement>('.de-form-field-control');
      if (!control) return false;
      control.scrollIntoView({ block: 'nearest' });
      control.focus();
      return true;
    }
    return false;
  }

  /** Moves focus to the control of the form field with `key`; false for a key no field has (FRW-069). */
  focusFieldByKey(key: string): boolean {
    let id: string | null = null;
    this.editorState.doc.descendants((node) => {
      if (id !== null || node.type.name !== 'form_field') return id === null;
      if (node.attrs['key'] === key && typeof node.attrs['id'] === 'string') id = node.attrs['id'];
      return false;
    });
    return id !== null && this.focusField(id);
  }

  /**
   * Moves focus to the next form field the person may fill, in document order, after the one that
   * last had focus (the first one when none had). It does not wrap: after the last one there is none
   * (FRW-069; wrapping is an open question of the story). False when no control took focus.
   */
  nextFillableField(): boolean {
    const active = this.selectedField();
    const fields = this.fillFields();
    const from = active === null ? -1 : fields.findIndex((f) => f.id === active);
    for (const f of fields.slice(from + 1))
      if (this.fieldFillable(f.id) && this.focusField(f.id)) return true;
    return false;
  }

  caretRect(): { x: number; y: number; width: number; height: number } | null {
    const view = this.#sub?.view.hasFocus() ? this.#sub.view : this.#view;
    if (!view) return null;
    try {
      // The browser's own selection first: after a caret key the view's state follows it only on
      // the next `selectionchange`, which may come after the key that asks for the menu.
      let head = view.state.selection.head;
      // `domSelectionRange` reads the selection inside a shadow root in every browser. The view's
      // types do not publish it, so it is called only when present; without it the state is used.
      const dom = (
        view as unknown as {
          domSelectionRange?: () => { focusNode: Node | null; focusOffset: number };
        }
      ).domSelectionRange?.();
      if (dom?.focusNode && view.dom.contains(dom.focusNode))
        head = view.posAtDOM(dom.focusNode, dom.focusOffset);
      const c = view.coordsAtPos(head);
      return { x: c.left, y: c.top, width: c.right - c.left, height: c.bottom - c.top };
    } catch {
      return null;
    }
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
        nodeViews: {
          footnote: footnoteRefView((id) => this.openFootnote(id)),
          table_cell: tableCellView,
          // FE-129: the indents, spacing, line spacing, borders and shading a paragraph carries.
          paragraph: paragraphView,
          // FRW-004, FRW-006: a native control for a form field, and a mirror that follows its target.
          form_field: formFieldView(
            {
              entry: (id) => this.fieldEntry(id),
              check: (id, value) => this.checkFieldEntry(id, value),
              enter: (id, value) => {
                this.enterFieldValue(id, value);
              },
              fillable: (id) => this.fieldFillable(id),
              rules: (id) => this.fieldRuleState(id),
              focused: (id) => this.selectField(id),
            },
            this.#fieldViews,
          ),
          field: fieldView(this.#fieldViews),
          bibliography: bibliographyView,
          toc: tocView,
          image: imageView(this.#assetImage),
          // FE-132: the figure's stored size and its resize handle.
          figure: figureView,
          // FE-139: the preserved atom's label, fallback picture and display size.
          preserved_block: preservedView('div', this.#assetImage),
          preserved_inline: preservedView('span', this.#assetImage),
          equation: equationView(this.#drawEquation),
          equation_block: equationBlockView(this.#drawEquation),
        },
        markViews: cssomMarkViews(this.#fontAlias),
        attributes: this.#bodyAttributes(),
        // An equation opens in the math editor on a double click or on Enter while it is selected
        // (FE-070); the shell reads the request (`equationRequest`). Nothing is opened here.
        handleDoubleClickOn: (_view, _pos, node, nodePos) =>
          EQUATION_NODES.has(node.type.name) && this.requestEquationEdit(nodePos),
        // Copy and cut are the core's (FE-050, FE-055): the browser's own copy would write ProseMirror's format.
        handleDOMEvents: {
          // A link to a place in the document is followed with Ctrl or Command and a click while the
          // text is editable (a plain click places the caret), and with a plain click where it is not
          // (FE-133 criterion 3). The browser's own jump to a fragment is stopped either way: the
          // shadow root has no such target.
          click: (view, event) => {
            const target = event.target;
            // The highlight of a comment, chosen in the page, selects its thread in the pane (UX-030).
            const range =
              target instanceof Element ? target.closest(`.${COMMENT_RANGE_CLASS}`) : null;
            const threadId = range?.getAttribute('data-thread-id');
            if (threadId) this.pickThread(threadId);
            const anchor = target instanceof Element ? target.closest('a[href^="#"]') : null;
            if (anchor === null) return false;
            if (view.editable && !(event.ctrlKey || event.metaKey)) return false;
            const href = anchor.getAttribute('href');
            if (href !== null) this.run('followInternalLink', { href });
            event.preventDefault();
            return true;
          },
          // Enter on a selected equation opens the math editor (FE-070). A DOM handler, not `handleKeyDown`,
          // so that a read-only view opens it too (ProseMirror runs `handleKeyDown` only in editable views).
          keydown: (view, event) => {
            const { selection } = view.state;
            if (
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              event.isComposing ||
              !(selection instanceof NodeSelection) ||
              !EQUATION_NODES.has(selection.node.type.name) ||
              !this.requestEquationEdit(selection.from)
            )
              return false;
            event.preventDefault();
            return true;
          },
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
        // The suggestion marks are drawn in the markup view the reader chose, `all` first (FE-046
        // criterion 4; FE-045 criterion 1; UX-035).
        decorations: (state) => {
          const f = this.findState.get();
          return findDecorations(state.doc, {
            query: f.query,
            current: f.current,
            ...(f.matchCase === false ? { matchCase: false } : {}),
          })
            .add(
              state.doc,
              suggestionDecorations(
                state.doc,
                this.markupView.get(),
                this.suggestionLabel ?? undefined,
              ).find(),
            )
            .add(
              state.doc,
              commentDecorations(
                state.doc,
                this.threadRanges.get(),
                this.selectedThread.get(),
              ).find(),
            )
            .add(state.doc, pageGuideDecorations(state.doc, this.#pageGuides).find())
            .add(state.doc, comparisonDecorations(state.doc, this.#comparison).find())
            .add(
              state.doc,
              proofingDecorations(
                state.doc,
                this.proofingFindings(),
                this.proofingCurrentId(),
              ).find(),
            );
        },
      },
    );
    this.#view = view;
    // FE-046 criterion 2: the card that names a suggestion's author and time, on hover and at the caret.
    const card = new SuggestionCard(view, {
      format: () => this.suggestionCardFormat,
      time: (id) => this.suggestionTime(id),
    });
    this.#card = card;
    const uncard = this.suggestionCardChanged.subscribe(() => card.refresh());
    const ended = () => this.compositionEnded();
    target.addEventListener('compositionend', ended);
    // A change of the find state redraws the highlights at once (the view is not told by a transaction).
    // A change of a thread's range redraws its decoration at once (FE-048).
    const unthread = this.threadRanges.subscribe(() => this.#view?.setProps({}));
    // A thread chosen in the comments pane is marked and brought into view (UX-030 criterion 2).
    const unselect = this.selectedThread.subscribe(() => {
      const v = this.#view;
      if (!v) return;
      v.setProps({});
      if (this.selectedThread.get() === null) return;
      v.dom.querySelector(`.${COMMENT_SELECTED_CLASS}`)?.scrollIntoView({ block: 'center' });
    });
    // Next, previous and the review pane bring a suggestion into view, even when the editing surface
    // has no focus: ProseMirror scrolls only from the DOM selection (UX-036 criterion 1).
    const unreveal = this.revealedSuggestion.subscribe(() => {
      const id = this.revealedSuggestion.get()?.id;
      if (!id || !this.#view) return;
      this.#view.dom
        .querySelector(`[data-suggestion-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'center' });
    });
    // A result of the proofing port, or a navigation, draws the findings again (UX-041).
    const unproof = this.proofing.subscribe(() => this.#view?.setProps({}));
    // Choosing another markup view draws the suggestions again; the document is not touched (UX-035).
    const unmarkup = this.markupView.subscribe(() => this.#view?.setProps({}));
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
    // The peers' carets are measured again when their positions change and when the window is resized.
    const redraw = () => this.#drawCarets();
    const uncarets = this.peerSelections.subscribe(redraw);
    const win = target.ownerDocument.defaultView;
    win?.addEventListener('resize', redraw);
    this.#drawCarets();
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
      // The fields a person may fill depend on the access too, and the access arrives after the
      // controls are drawn (FRW-076 criterion 1).
      accessChanged: () => {
        if (this.#view) this.#fieldViews.refresh(this.#view.state.doc);
      },
      lockChanged: () => {
        this.#view?.setProps({});
        if (this.#view) this.#fieldViews.refresh(this.#view.state.doc);
        this.#sub?.view.setProps({});
      },
    });
    return () => {
      remove();
      unfind();
      unthread();
      unselect();
      unreveal();
      unproof();
      unmarkup();
      uncard();
      card.destroy();
      if (this.#card === card) this.#card = null;
      undirection();
      uncarets();
      win?.removeEventListener('resize', redraw);
      target.removeEventListener('compositionend', ended);
      view.destroy();
      if (this.#view === view) this.#view = null;
      this.#drawCarets();
    };
  }

  #update(state: EditorState, transactions: readonly Transaction[]): void {
    const before = this.#view?.state.doc;
    this.#view?.updateState(state);
    this.#card?.update();
    // Mirrors follow their target fields, and a control follows its entry (FRW-004, FRW-006).
    // A change of nothing but field values draws only the fields whose state moved (FRW-023 c. 6).
    if (before !== state.doc) this.#fieldViews.refresh(state.doc, onlyFieldValues(transactions));
    // The layout may have moved: the peers' carets are measured in the new state.
    this.#drawCarets();
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
