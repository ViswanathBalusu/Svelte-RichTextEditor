/**
 * The editable page view (02 §7, §9; FE-101): pages painted from the layout engine's tree, with an
 * input bridge for the keyboard and input methods (ADR 0380). It runs over the element's one editing
 * core: it reads the document and the selection as block identifiers and offsets, and every change
 * goes back through the core's own transaction path, so the guards, suggestion mode, the sync queue
 * and the history see an edit as they see one made in the web view.
 *
 * - The pages are `toFlow`, `incrementalLayout` and `mountPageWindow` (only the visible pages and an
 *   overscan are in the DOM), painted by `paintTree` with runs from `FlowText`.
 * - The bridge is one single-line textarea, in the same shadow root, that holds the text of the
 *   current block around the caret and is placed on the painted caret. Typing and composition happen
 *   in it; each `input` event is one text edit of the block (a composition is a series of edits). It
 *   is moved, not rewritten, while a composition is open (ADR 0380 item 1).
 * - Movement by line, page, Home and End, and a click, come from the layout tree
 *   (`applyPageKey`, `hitTest`), never from the bridge (ADR 0380 item 2). Left and Right follow the
 *   document's block order.
 * - A failure of the layout or the painter is passed to `onError`; the element then shows the web
 *   view again with the document and its unconfirmed work (FE-101 criterion 3).
 *
 * This module is a lazy chunk (`./index.ts`): a session that never asks for the page view loads none
 * of it. It reads no `prosemirror-*`.
 */
import type { PageViewHandle, PageViewHooks, BlockPoint, BlockSelection } from '@docedit/engine';
import {
  caretGeometry,
  hitTest,
  type DocPosition,
  type SpanWidth,
} from '../../../layout/src/caret.ts';
import { toFlow, type CdmEnvelopeLike } from '../../../layout/src/flow.ts';
import { incrementalLayout, type IncrementalLayout } from '../../../layout/src/incremental.ts';
import type { ItemProviders } from '../../../layout/src/items.ts';
import { pageStatus, type PageStatus } from '../../../layout/src/readonly-view.ts';
import type { LayoutTree } from '../../../layout/src/tree.ts';
import { applyPageKey, pageKeyOf } from '../../../layout/src/page-keys.ts';
import { type InlineBoxPlace, type PaintSource } from '../../../painter/src/painter.ts';
import { paintSelection } from '../../../painter/src/selection-paint.ts';
import { mountPageWindow, type PageWindow } from '../../../painter/src/window.ts';
import { shortcutName, SHELL_SHORTCUTS } from '../shortcuts.ts';
import { FlowText, cssFamily } from './flow-text.ts';
import { mostVisiblePage, paintThumbnail, textStarts, type PageViewPages } from './pages.ts';
import { pageProviders } from './providers.ts';

const PX_PER_PT = 96 / 72;
/** The space between pages in points, as the painter's default. */
const PAGE_GAP_PT = 12;
/** How many characters of the block the bridge holds each side of the caret (ADR 0380 item 1). */
export const BRIDGE_RADIUS = 200;

/** What the element gives the page view. */
export interface PageViewOptions {
  /** The core: `EditorCore.attachPageView`. */
  readonly host: { attachPageView(hooks: PageViewHooks): PageViewHandle };
  /** The element the view is appended to (the shell's body frame). */
  readonly parent: HTMLElement;
  /** The accessible name of the input bridge (and of the read-only pages). */
  readonly label: string;
  /**
   * Paint the pages and nothing else (FE-095): no input bridge in the page, no caret, no keys and
   * no pointer handling, so the browser's own selection and copy work on the painted text. The
   * core is a version's (`VersionView`), which refuses every change.
   */
  readonly readOnly?: boolean;
  /** Runs a registry shortcut for a key event; true when one ran (FE-098 criterion 6). */
  readonly shortcut?: (event: KeyboardEvent) => boolean;
  /** An unrecoverable error of the layout or the painter: the element falls back to the web view. */
  readonly onError: (error: unknown) => void;
  /** Injected providers, for tests; the default is canvas measurement and the placeholder breaks. */
  readonly providers?: ItemProviders;
  /** The frame scheduler; the default is `requestAnimationFrame`. */
  readonly frame?: (run: () => void) => void;
  /** Called after each layout pass with the page status and the time the pass took (ms). */
  readonly onLayout?: (status: PageStatus, ms: number) => void;
}

export interface MountedPageView {
  /** The view's root element. */
  readonly root: HTMLElement;
  /** Moves focus to the input bridge. */
  focus(): void;
  /** The number of pages of the last layout, and whether it is final. */
  status(): PageStatus | null;
  /** Lays the document out and paints now (tests; the view does it on the next frame itself). */
  flush(): void;
  /**
   * The element is suspended (FE-005; 02 §2.1): the view stops listening on the page's font set.
   * It stays mounted with its pages and its place.
   */
  suspend(): void;
  /** The element is back: the view listens again and lays out once more, as a face may have arrived. */
  resume(): void;
  /** The pages, for the navigation pane's thumbnails (UX-021). */
  readonly pages: PageViewPages;
  /** Removes the view and detaches it from the core. Safe to call twice. */
  destroy(): void;
}

/** The common prefix and suffix of two strings, so an edit becomes one replaced range. */
export function diffText(
  before: string,
  after: string,
): { readonly at: number; readonly removed: number; readonly inserted: string } {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < max - p &&
    before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)
  )
    s++;
  return { at: p, removed: before.length - p - s, inserted: after.slice(p, after.length - s) };
}

/** The key name of a keyboard event in prosemirror-keymap's notation, for the keys the core binds. */
export function keymapName(event: KeyboardEvent): string | null {
  const mods =
    (event.altKey ? 'Alt-' : '') +
    (event.ctrlKey || event.metaKey ? 'Mod-' : '') +
    (event.shiftKey ? 'Shift-' : '');
  switch (event.key) {
    case 'Enter':
    case 'Backspace':
    case 'Delete':
    case 'Tab':
      return `${mods}${event.key}`;
    case 'Home':
    case 'End':
      return event.ctrlKey || event.metaKey ? `${mods}${event.key}` : null;
    default:
      break;
  }
  if (event.key.length === 1 && /^[a-z]$/i.test(event.key) && (event.ctrlKey || event.metaKey))
    return `${mods}${event.key.toLowerCase()}`;
  return null;
}

/** The offset of the word boundary before or after `offset` in `text`. */
export function wordBoundary(text: string, offset: number, direction: 'left' | 'right'): number {
  if (direction === 'left') {
    let i = offset;
    while (i > 0 && /\s/.test(text.charAt(i - 1))) i--;
    while (i > 0 && !/\s/.test(text.charAt(i - 1))) i--;
    return i;
  }
  let i = offset;
  while (i < text.length && !/\s/.test(text.charAt(i))) i++;
  while (i < text.length && /\s/.test(text.charAt(i))) i++;
  return i;
}

const samePoint = (a: DocPosition, b: DocPosition): boolean =>
  a.blockId === b.blockId && a.offset === b.offset;

/**
 * The placeholder of a hidden region in the page view (FE-141 criterion 1): the same element as the
 * web view's (`.de-hidden-region`, a note named with the title), so that the stylesheet's colours and
 * border apply. The painter sets its place and size (the fixed height of the layout, 2.5 times the
 * font size); the margin is taken off, as the layout places it, and the text size is the font size
 * the height came from. It is not editable, not selectable and holds nothing.
 */
function placeholder(doc: Document, title: string | null, heightPt: number): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'de-hidden-region';
  el.setAttribute('role', 'note');
  el.setAttribute('aria-label', title ? `Hidden region: ${title}` : 'Hidden region');
  el.setAttribute('contenteditable', 'false');
  el.textContent = title || 'Hidden region';
  const s = el.style;
  s.margin = '0';
  s.fontSize = `${heightPt / 2.5}pt`;
  s.lineHeight = '1.2';
  s.userSelect = 'none';
  return el;
}

/** Mounts the page view. Throws when the document cannot be laid out the first time. */
export function mountPageView(options: PageViewOptions): MountedPageView {
  const doc = options.parent.ownerDocument;
  const frame = options.frame ?? ((run) => requestAnimationFrame(() => run()));

  // The measurer is made first: with no canvas it throws here, before anything is in the page.
  let providers = options.providers ?? pageProviders();
  let layout: IncrementalLayout = incrementalLayout(providers);

  const root = doc.createElement('div');
  const readOnly = options.readOnly === true;
  root.className = 'de-page-view';
  root.dataset['view'] = readOnly ? 'read' : 'print';
  if (readOnly) {
    root.dataset['readonly'] = 'true';
    root.setAttribute('role', 'document');
    root.setAttribute('aria-label', options.label);
  }
  const scroller = doc.createElement('div');
  scroller.className = 'de-page-scroller';
  const bridge = doc.createElement('textarea');
  bridge.className = 'de-page-bridge';
  bridge.rows = 1;
  bridge.wrap = 'off';
  bridge.spellcheck = false;
  bridge.setAttribute('autocomplete', 'off');
  bridge.setAttribute('autocapitalize', 'off');
  bridge.setAttribute('autocorrect', 'off');
  bridge.setAttribute('aria-label', options.label);
  bridge.setAttribute('aria-multiline', 'true');
  // A read-only view has no bridge: nothing in the page takes input or focus (FE-095).
  if (readOnly) root.append(scroller);
  else root.append(scroller, bridge);
  options.parent.append(root);

  let tree: LayoutTree | null = null;
  let text: FlowText | null = null;
  let status: PageStatus | null = null;
  let win: PageWindow | null = null;
  let tops: number[] = [];
  /** The pages' heights in points, beside `tops`, and what the thumbnails are told (UX-021). */
  let heights: number[] = [];
  let revision = 0;
  let shownPage = 0;
  const pageListeners = new Set<() => void>();
  let destroyed = false;
  let failed = false;
  let queued = false;
  let relayout = true;
  let goalX: number | undefined;
  let composing = false;
  // What the bridge holds: the block, the offset of its first character, and its text.
  let proj: { blockId: string; start: number; value: string } | null = null;

  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    options.onError(error);
  };

  const guard = <T>(run: () => T): T | undefined => {
    if (failed || destroyed) return undefined;
    try {
      return run();
    } catch (error) {
      fail(error);
      return undefined;
    }
  };

  // --- The core ------------------------------------------------------------------------------

  const handle: PageViewHandle = options.host.attachPageView({
    update(docChanged) {
      if (destroyed) return;
      if (docChanged) relayout = true;
      if (!composing) project();
      schedule();
    },
    focus() {
      bridge.focus({ preventScroll: true });
    },
  });

  const selection = (): BlockSelection | null => handle.selection();

  // --- Layout and paint ----------------------------------------------------------------------

  const span: SpanWidth = (blockId, from, to) => text?.width(blockId, from, to) ?? 0;

  const source = (flowText: FlowText): PaintSource => ({
    lineText: (blockId, from, to) =>
      flowText
        .runs(blockId, from, to)
        ?.map((r) => r.text)
        .join('') ?? '',
    fontFamily: cssFamily('Noto Serif'),
    fontSizePt: 11,
    runs: (blockId, from, to) => flowText.runs(blockId, from, to),
    measureRange: (blockId, from, to) => flowText.width(blockId, from, to),
  });

  function layoutNow(): void {
    const started = performance.now();
    const content = handle.content() as unknown as CdmEnvelopeLike;
    const flow = toFlow(content);
    const result = layout.update(flow, handle.takeDirty());
    tree = result.tree;
    text = new FlowText(flow, providers.measurer);
    status = pageStatus(result);
    // The placeholders of hidden regions (ADR 0019; FE-141): the title of each, by block identifier.
    const placeholders = new Map<string, string | null>();
    for (const section of flow.sections)
      for (const b of section.blocks)
        if (b.kind === 'box' && b.what === 'placeholder') placeholders.set(b.id, b.title ?? null);
    // A field control that has focus keeps it over the repaint (FE-101 criterion 5).
    const rootNode = root.getRootNode() as Document | ShadowRoot;
    const focusedField =
      readOnly || !(rootNode.activeElement instanceof Element)
        ? null
        : (rootNode.activeElement.closest('.de-control[data-field]') as HTMLElement | null);
    const focusedControl = focusedField === null ? null : rootNode.activeElement;
    const caretAt =
      focusedControl instanceof HTMLInputElement && focusedControl.type === 'text'
        ? ([focusedControl.selectionStart, focusedControl.selectionEnd] as const)
        : null;
    // Mount the new window before the old one goes, so the scroll position is kept.
    const old = win;
    const fresh = mountPageWindow(scroller, result.tree, source(text), {
      justify: (blockId) => text?.justified(blockId) === true,
      pageGap: PAGE_GAP_PT,
      control: (box) => {
        const title = placeholders.get(box.blockId);
        return title === undefined ? null : placeholder(doc, title, box.height);
      },
      // The form fields are the web view's own controls, over the room the layout left (FE-093).
      // A read-only page view (a version) draws no controls: its core refuses every change.
      ...(readOnly
        ? {}
        : {
            inlineControl: (place: InlineBoxPlace): HTMLElement | null => {
              const control = handle.fieldControl(place.id);
              if (control) control.style.fontSize = `${place.heightPt}pt`;
              return control;
            },
          }),
    });
    win = fresh;
    old?.dispose();
    if (!readOnly) {
      handle.keepFieldControls(text.fieldIds());
      if (focusedControl instanceof HTMLElement && rootNode.activeElement !== focusedControl) {
        focusedControl.focus({ preventScroll: true });
        const from = caretAt?.[0];
        const to = caretAt?.[1];
        if (
          typeof from === 'number' &&
          typeof to === 'number' &&
          focusedControl instanceof HTMLInputElement
        )
          focusedControl.setSelectionRange(from, to);
      }
    }
    tops = [];
    heights = [];
    let y = 0;
    for (const page of result.tree.pages) {
      tops.push(y);
      heights.push(page.height);
      y += page.height + PAGE_GAP_PT;
    }
    options.onLayout?.(status, performance.now() - started);
    revision++;
    shownPage = currentPage();
    tellPages();
  }

  // --- The pages, for thumbnails (UX-021) ----------------------------------------------------

  /** The page that takes most of the scroller's viewport. */
  function currentPage(): number {
    return mostVisiblePage(
      tops,
      heights,
      scroller.scrollTop / PX_PER_PT,
      scroller.clientHeight / PX_PER_PT,
    );
  }

  function tellPages(): void {
    for (const listener of [...pageListeners]) listener();
  }

  /** After a scroll: tells the thumbnails when the view shows another page. */
  function followPage(): void {
    const now = currentPage();
    if (now === shownPage) return;
    shownPage = now;
    tellPages();
  }

  /**
   * Moves the view to a page. The caret goes with it, to the start of the page's text, as it does
   * for a heading chosen in the pane; left where it was, the next edit, or a change from someone
   * else, would bring the view back to the caret.
   */
  function goToPage(index: number): boolean {
    if (destroyed || failed || tree === null) return false;
    const page = tree.pages[index];
    if (!page) return false;
    guard(() => {
      // The first place the core knows as body text: a block the layout made itself is passed over.
      for (const start of textStarts(page)) {
        if (!handle.select(start, start)) continue;
        project();
        break;
      }
      goalX = undefined;
      scroller.scrollTop = (tops[index] ?? 0) * PX_PER_PT;
      win?.update();
      paintCaret();
      followCaret(false);
      followPage();
    });
    return !failed;
  }

  const pages: PageViewPages = {
    info: () => ({
      count: destroyed || failed ? 0 : (tree?.pages.length ?? 0),
      current: shownPage,
      revision,
    }),
    size(index) {
      const page = tree?.pages[index];
      return page ? { width: page.width, height: page.height } : null;
    },
    paint(index, target, width) {
      if (destroyed || failed || tree === null || text === null) return false;
      const flowText = text;
      try {
        return paintThumbnail(target, tree, index, source(flowText), width, {
          justify: (blockId) => flowText.justified(blockId) === true,
        });
      } catch {
        // A thumbnail that cannot be drawn is left empty; the page view itself goes on.
        return false;
      }
    },
    goTo: goToPage,
    subscribe(listener) {
      pageListeners.add(listener);
      return () => {
        pageListeners.delete(listener);
      };
    },
  };

  /** The page elements that are mounted, by page index. */
  function mountedPages(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const el of scroller.querySelectorAll<HTMLElement>('.de-window > .de-page')) {
      const n = Number(el.dataset['page']);
      if (Number.isInteger(n)) out[n] = el;
    }
    return out;
  }

  function paintCaret(): void {
    if (tree === null || readOnly) return;
    const pages = mountedPages();
    for (const el of pages)
      el?.querySelectorAll('.de-caret, .de-selection').forEach((n) => n.remove());
    const sel = selection();
    if (sel === null) return;
    paintSelection(doc, pages, tree, span, { anchor: sel.anchor, head: sel.head });
  }

  /** Scrolls so that the caret is inside the scroller, and places the bridge on it. */
  function followCaret(reveal: boolean): void {
    if (readOnly) return;
    const sel = selection();
    if (tree === null || sel === null) return;
    const g = caretGeometry(tree, sel.head, span);
    if (g === null) return;
    const top = ((tops[g.page] ?? 0) + g.y) * PX_PER_PT;
    const bottom = top + g.height * PX_PER_PT;
    if (reveal) {
      const margin = 24;
      if (top - margin < scroller.scrollTop) scroller.scrollTop = Math.max(0, top - margin);
      else if (bottom + margin > scroller.scrollTop + scroller.clientHeight)
        scroller.scrollTop = bottom + margin - scroller.clientHeight;
      win?.update();
      paintCaret();
    }
    const page = mountedPages()[g.page];
    if (!page) return;
    const rect = page.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    bridge.style.left = `${rect.left - host.left + g.x * PX_PER_PT}px`;
    bridge.style.top = `${rect.top - host.top + g.y * PX_PER_PT}px`;
    bridge.style.height = `${g.height * PX_PER_PT}px`;
  }

  function schedule(): void {
    if (queued) return;
    queued = true;
    frame(() => {
      queued = false;
      if (destroyed) return;
      flush();
    });
  }

  function flush(): void {
    guard(() => {
      if (relayout || tree === null) {
        relayout = false;
        layoutNow();
      }
      paintCaret();
      followCaret(true);
    });
  }

  // --- The input bridge ----------------------------------------------------------------------

  /** Shows the head's block around the caret in the bridge; not while a composition is open. */
  function project(): void {
    const sel = selection();
    bridge.readOnly = handle.readOnly();
    if (sel === null) {
      proj = null;
      if (bridge.value !== '') bridge.value = '';
      return;
    }
    const full = handle.text(sel.head.blockId) ?? '';
    const start = Math.max(0, sel.head.offset - BRIDGE_RADIUS);
    const end = Math.min(full.length, sel.head.offset + BRIDGE_RADIUS);
    const value = full.slice(start, end);
    proj = { blockId: sel.head.blockId, start, value };
    if (bridge.value !== value) bridge.value = value;
    const head = sel.head.offset - start;
    let from = head;
    let to = head;
    if (sel.anchor.blockId === sel.head.blockId) {
      const anchor = sel.anchor.offset - start;
      if (anchor >= 0 && anchor <= value.length) {
        from = Math.min(anchor, head);
        to = Math.max(anchor, head);
      }
    }
    const direction =
      sel.anchor.blockId === sel.head.blockId && sel.anchor.offset > sel.head.offset
        ? 'backward'
        : 'forward';
    if (bridge.selectionStart !== from || bridge.selectionEnd !== to)
      bridge.setSelectionRange(from, to, direction);
  }

  /** A selection that is not inside the block the bridge holds is deleted before text replaces it. */
  function clearForeignSelection(): void {
    const sel = selection();
    if (sel === null || handle.readOnly()) return;
    const collapsed = samePoint(sel.anchor, sel.head);
    if (collapsed || sel.anchor.blockId === sel.head.blockId) return;
    handle.key('Backspace');
    project();
  }

  function onInput(): void {
    if (proj === null || destroyed) return;
    const value = bridge.value;
    const { at, removed, inserted } = diffText(proj.value, value);
    if (removed === 0 && inserted === '') return;
    const blockId = proj.blockId;
    const from = proj.start + at;
    const caret = proj.start + bridge.selectionEnd;
    proj.value = value;
    const ok = handle.replace(blockId, from, from + removed, inserted, caret);
    if (!ok) {
      // Refused or no longer there: the bridge shows what the document holds again.
      composing = false;
      handle.composing(null);
      project();
    }
  }

  const point = (position: DocPosition): BlockPoint => position;

  function select(anchor: DocPosition, head: DocPosition): void {
    handle.select(point(anchor), point(head));
    project();
    schedule();
  }

  function moveBy(direction: 'left' | 'right', extend: boolean, byWord: boolean): void {
    const sel = selection();
    if (sel === null) return;
    let head: BlockPoint;
    if (byWord) {
      const block = handle.text(sel.head.blockId) ?? '';
      const offset = wordBoundary(block, sel.head.offset, direction);
      head =
        offset !== sel.head.offset
          ? { blockId: sel.head.blockId, offset }
          : handle.step(sel.head, direction);
    } else if (!extend && !samePoint(sel.anchor, sel.head)) {
      // Without Shift a range collapses to its edge on that side (as a text field does).
      const forward =
        sel.anchor.blockId === sel.head.blockId
          ? sel.anchor.offset <= sel.head.offset
          : handle.blocks().findIndex((b) => b.id === sel.anchor.blockId) <=
            handle.blocks().findIndex((b) => b.id === sel.head.blockId);
      const edge =
        direction === 'right' ? (forward ? sel.head : sel.anchor) : forward ? sel.anchor : sel.head;
      select(edge, edge);
      return;
    } else head = handle.step(sel.head, direction);
    goalX = undefined;
    select(extend ? sel.anchor : head, head);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || composing || event.keyCode === 229 || tree === null) return;
    // Registry shortcuts first (Mod-f, Mod-k, ...): the shell's own table and the host's buttons agree.
    if (options.shortcut?.(event) === true) {
      event.preventDefault();
      return;
    }
    const nav = pageKeyOf(event);
    if (nav !== null) {
      const sel = selection();
      if (sel === null) return;
      event.preventDefault();
      const moved = applyPageKey(
        tree,
        { anchor: sel.anchor, head: sel.head, goalX },
        nav.key,
        nav.extend,
        span,
      );
      goalX = moved.goalX;
      handle.select(point(moved.anchor), point(moved.head));
      project();
      schedule();
      return;
    }
    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      moveBy(event.key === 'ArrowLeft' ? 'left' : 'right', event.shiftKey, event.ctrlKey);
      return;
    }
    const name = keymapName(event);
    if (name !== null) {
      const short = shortcutName(event);
      const command = short === null ? undefined : SHELL_SHORTCUTS[short];
      if (command === 'undo' || command === 'redo') {
        event.preventDefault();
        handle.run(command);
        goalX = undefined;
        return;
      }
      if (handle.key(name)) {
        event.preventDefault();
        goalX = undefined;
        project();
        schedule();
      }
      // A key the core does not bind (a Backspace inside a block, a Tab outside a table) is left to
      // the bridge: the browser edits its text and `input` follows.
    }
  }

  function onBeforeInput(event: InputEvent): void {
    if (event.inputType.startsWith('insert') || event.inputType.startsWith('delete'))
      clearForeignSelection();
    goalX = undefined;
  }

  function onCompositionStart(): void {
    clearForeignSelection();
    composing = true;
    if (proj) handle.composing(proj.blockId);
  }

  function onCompositionEnd(): void {
    composing = false;
    handle.composing(null);
    project();
    schedule();
  }

  // --- The pointer ---------------------------------------------------------------------------

  function positionAt(event: PointerEvent): DocPosition | null {
    if (tree === null) return null;
    for (const el of mountedPages()) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (
        event.clientY < r.top - (PAGE_GAP_PT * PX_PER_PT) / 2 ||
        event.clientY > r.bottom + (PAGE_GAP_PT * PX_PER_PT) / 2
      )
        continue;
      const n = Number(el.dataset['page']);
      const x = (event.clientX - r.left) / PX_PER_PT;
      const y = (event.clientY - r.top) / PX_PER_PT;
      return hitTest(tree, n, x, y, span);
    }
    return null;
  }

  let dragging: { anchor: DocPosition } | null = null;

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.de-control') !== null) return;
    const pos = positionAt(event);
    if (pos === null) return;
    event.preventDefault();
    bridge.focus({ preventScroll: true });
    goalX = undefined;
    const sel = selection();
    if (event.detail >= 2 && sel !== null) {
      const block = handle.text(pos.blockId) ?? '';
      if (event.detail >= 3) {
        select({ blockId: pos.blockId, offset: 0 }, { blockId: pos.blockId, offset: block.length });
      } else {
        const from = wordBoundary(block, Math.min(block.length, pos.offset + 1), 'left');
        const end = wordBoundary(block, from, 'right');
        let stop = end;
        while (stop > from && /\s/.test(block.charAt(stop - 1))) stop--;
        select({ blockId: pos.blockId, offset: from }, { blockId: pos.blockId, offset: stop });
      }
      return;
    }
    const anchor = event.shiftKey && sel !== null ? sel.anchor : pos;
    select(anchor, pos);
    dragging = { anchor };
    scroller.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (dragging === null) return;
    const pos = positionAt(event);
    if (pos === null) return;
    select(dragging.anchor, pos);
  }

  function onPointerUp(event: PointerEvent): void {
    if (dragging === null) return;
    dragging = null;
    scroller.releasePointerCapture?.(event.pointerId);
  }

  // --- The clipboard -------------------------------------------------------------------------

  const onCopy = (event: ClipboardEvent): void => handle.copy(event);
  const onCut = (event: ClipboardEvent): void => {
    if (handle.readOnly()) return handle.copy(event);
    handle.cut(event);
  };
  const onPaste = (event: ClipboardEvent): void => {
    if (handle.paste(event)) {
      goalX = undefined;
      project();
      schedule();
    }
  };

  // --- Wiring --------------------------------------------------------------------------------

  const on = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    name: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): (() => void) => {
    target.addEventListener(name, listener);
    return () => target.removeEventListener(name, listener);
  };
  const stops = readOnly
    ? [
        // No key, input or pointer handler: the browser selects and copies the painted text itself.
        on(scroller, 'scroll', () => {
          if (tree !== null) followPage();
        }),
      ]
    : [
        on(bridge, 'keydown', onKeyDown),
        on(bridge, 'beforeinput', onBeforeInput),
        on(bridge, 'input', onInput),
        on(bridge, 'compositionstart', onCompositionStart),
        on(bridge, 'compositionend', onCompositionEnd),
        on(bridge, 'copy', onCopy),
        on(bridge, 'cut', onCut),
        on(bridge, 'paste', onPaste),
        on(scroller, 'pointerdown', onPointerDown),
        on(scroller, 'pointermove', onPointerMove),
        on(scroller, 'pointerup', onPointerUp),
        on(scroller, 'scroll', () => {
          if (tree !== null) {
            paintCaret();
            followCaret(false);
            followPage();
          }
        }),
      ];
  // A face that arrives after the first layout changes the widths: lay out again (FE-064). The font
  // set is the page's own, so the listener is held only while the element is not suspended (FE-005).
  const fonts = doc.fonts;
  const onFonts = (): void => {
    providers = options.providers ?? pageProviders(undefined, Date.now());
    layout = incrementalLayout(providers);
    relayout = true;
    schedule();
  };
  let onFontSet = false;
  const listenToFonts = (on: boolean): void => {
    if (on === onFontSet) return;
    onFontSet = on;
    if (on) fonts?.addEventListener?.('loadingdone', onFonts);
    else fonts?.removeEventListener?.('loadingdone', onFonts);
  };
  listenToFonts(true);
  /** The faces the page has loaded, so that a suspension can tell whether one arrived meanwhile. */
  const loadedFaces = (): string => {
    if (!fonts || typeof fonts.forEach !== 'function') return '';
    const faces: string[] = [];
    fonts.forEach((face) => {
      if (face.status === 'loaded')
        faces.push(
          [face.family, face.style, face.weight, face.stretch, face.unicodeRange].join('|'),
        );
    });
    return faces.sort().join('\n');
  };
  let facesAtSuspension = '';

  project();
  // The first pass runs now, so the pages exist when the element reports the view as shown.
  try {
    layoutNow();
    relayout = false;
    paintCaret();
    followCaret(true);
  } catch (error) {
    destroy();
    throw error;
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    for (const stop of stops) stop();
    listenToFonts(false);
    handle.detach();
    win?.dispose();
    win = null;
    pageListeners.clear();
    root.remove();
  }

  return {
    root,
    focus: () => {
      if (!readOnly) bridge.focus({ preventScroll: true });
    },
    status: () => status,
    flush: () => {
      relayout = true;
      flush();
    },
    suspend: () => {
      if (destroyed || !onFontSet) return;
      listenToFonts(false);
      facesAtSuspension = loadedFaces();
    },
    resume: () => {
      if (destroyed || onFontSet) return;
      listenToFonts(true);
      // A face that finished loading during the suspension was not heard: measure again.
      if (loadedFaces() !== facesAtSuspension) onFonts();
    },
    pages,
    destroy,
  };
}
