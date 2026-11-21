/**
 * The card that names who made a suggestion and when (FE-046 criterion 2; 02 §5.2; 13 §5). It shows
 * while the pointer is over a suggestion and while the caret is inside one, so a keyboard reader
 * gets it too, and it goes with Escape (WCAG 1.4.13: dismissible, hoverable, persistent).
 *
 * The suggestion marks carry no time (03 §7): the time is the server time of the commit that
 * introduced the suggestion (decision 109 of `docs/owner-decisions-2026-11-15.md`), which the core
 * asks the history port for. The card shows the author at once and adds the time when it arrives;
 * without a time (no history port, or a commit below the reader's gate) it shows the author alone.
 * The words, the author's name and the time's format are the shell's: it gives `format`.
 *
 * The card is drawn beside the editing surface and is never part of the document. It is a status
 * region, so a screen reader reads the author and the time when the caret enters a suggestion. It
 * does not mark the suggestion's own element: ProseMirror reads a change of attributes inside the
 * content as an edit of its DOM and draws the node again.
 */
import type { EditorView } from 'prosemirror-view';

/** The shell's words for the card: the author's identifier and the time (ISO 8601), or null. */
export type SuggestionCardFormat = (user: string, time: string | null) => string;

export interface SuggestionCardSource {
  /** The shell's formatter, or null when it gave none (the card then does not show). */
  format(): SuggestionCardFormat | null;
  /** The server time of the commit that introduced the suggestion, or null when it is not known. */
  time(id: string): Promise<string | null>;
}

const SELECTOR = '[data-suggestion-id]';
let cards = 0;

export class SuggestionCard {
  readonly #view: EditorView;
  readonly #source: SuggestionCardSource;
  readonly #element: HTMLElement;
  readonly #id: string;
  readonly #listeners: Array<() => void> = [];
  /** The suggestion shown, and the element that carries it. */
  #shown: { id: string; user: string; on: Element } | null = null;
  /** Escape was pressed for this suggestion: the card stays away until the caret or pointer moves on. */
  #dismissed: string | null = null;
  #hover: Element | null = null;
  #selectionKey = '';
  /** The times that arrived, by suggestion; a time does not change. */
  readonly #times = new Map<string, string>();
  readonly #asking = new Set<string>();

  constructor(view: EditorView, source: SuggestionCardSource) {
    this.#view = view;
    this.#source = source;
    this.#id = `de-suggestion-card-${++cards}`;
    const doc = view.dom.ownerDocument;
    this.#element = doc.createElement('div');
    this.#element.className = 'de-suggestion-card';
    this.#element.id = this.#id;
    this.#element.setAttribute('role', 'status');
    this.#element.contentEditable = 'false';
    this.#element.hidden = true;
    const host = view.dom.parentElement ?? view.dom;
    host.append(this.#element);

    const on = (target: EventTarget, type: string, fn: (e: Event) => void) => {
      target.addEventListener(type, fn);
      this.#listeners.push(() => target.removeEventListener(type, fn));
    };
    on(view.dom, 'mouseover', (e) => {
      this.#hover = (e.target as Element | null)?.closest?.(SELECTOR) ?? null;
      this.refresh();
    });
    on(view.dom, 'mouseleave', () => {
      this.#hover = null;
      this.refresh();
    });
    on(view.dom, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape' && this.#shown) {
        this.#dismissed = this.#shown.id;
        this.#hide();
      }
    });
    // The pointer may rest on the card itself without it going away (WCAG 1.4.13).
    on(this.#element, 'mouseover', () => {
      this.#hover = this.#shown?.on ?? null;
    });
    on(this.#element, 'mouseleave', () => {
      this.#hover = null;
      this.refresh();
    });
  }

  /**
   * Called after each state change of the view: the caret may have moved into or out of a
   * suggestion, and the view may have drawn the suggestion's element again (which drops the
   * attribute the card put on it), so the card is placed again every time.
   */
  update(): void {
    const { from, empty } = this.#view.state.selection;
    const key = `${from}:${empty}`;
    if (key !== this.#selectionKey) {
      this.#selectionKey = key;
      this.#dismissed = null;
    }
    this.refresh();
  }

  /**
   * The suggestion the caret is in or touches, as a DOM element, or null. A caret at either end of a
   * suggestion counts: text typed in suggestion mode leaves the caret at its end.
   */
  #atCaret(): Element | null {
    const { selection } = this.#view.state;
    if (!selection.empty || !this.#view.hasFocus()) return null;
    const $from = selection.$from;
    const kinds = ['ins', 'del', 'fmt'];
    const mark = [
      ...$from.marks(),
      ...($from.nodeBefore?.marks ?? []),
      ...($from.nodeAfter?.marks ?? []),
    ].find((m) => kinds.includes(m.type.name));
    if (!mark) return null;
    return this.#view.dom.querySelector(
      `[data-suggestion-id="${CSS.escape(String(mark.attrs['id']))}"]`,
    );
  }

  refresh(): void {
    const on = this.#hover ?? this.#atCaret();
    const format = this.#source.format();
    if (!on || !format) return this.#hide();
    const id = on.getAttribute('data-suggestion-id') ?? '';
    const user = on.getAttribute('data-suggestion-user') ?? '';
    if (id === '' || this.#dismissed === id) return this.#hide();
    this.#shown = { id, user, on };
    this.#element.textContent = format(user, this.#times.get(id) ?? null);
    this.#element.hidden = false;
    this.#place(on);
    // The time arrives later: the words are drawn again, if this suggestion is still the one shown.
    if (this.#times.has(id) || this.#asking.has(id)) return;
    this.#asking.add(id);
    void this.#source
      .time(id)
      .then((time) => {
        if (time === null) return;
        this.#times.set(id, time);
        if (this.#shown?.id === id) this.refresh();
      })
      .catch(() => {})
      .finally(() => this.#asking.delete(id));
  }

  #place(on: Element): void {
    const host = this.#element.parentElement;
    if (!host) return;
    if (host.ownerDocument.defaultView?.getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
    const box = on.getBoundingClientRect();
    const around = host.getBoundingClientRect();
    this.#element.style.insetBlockStart = `${box.bottom - around.top + host.scrollTop + 4}px`;
    this.#element.style.insetInlineStart = `${Math.max(0, box.left - around.left + host.scrollLeft)}px`;
  }

  #hide(): void {
    this.#shown = null;
    this.#element.hidden = true;
    this.#element.textContent = '';
  }

  destroy(): void {
    this.#hide();
    for (const off of this.#listeners) off();
    this.#element.remove();
  }
}
