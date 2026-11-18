/**
 * Spike S9's prototype page (SPK-022): painted pages with an input bridge, in an open shadow root
 * like the real element (query `shadow=0` mounts in the light DOM instead, for the find-in-page
 * probe).
 *
 * - The pages are the project's painter (`paintTree`) over a first-fit layout tree
 *   (`src/s9/layout.ts`); the caret is the painter's caret box (`paintSelection`).
 * - The bridge is a one-line textarea holding the text of the current block around the caret
 *   (`src/s9/bridge.ts`), positioned so that its caret is on the painted caret. Typing and input
 *   method composition happen in it; each `input` event becomes one text step on the document and
 *   the pages are laid out and painted again. The bridge's own text is not rewritten while the
 *   input method has a composition open, only moved.
 * - Movement by line, page, Home and End, and a click, come from the layout tree
 *   (`src/s9/navigate.ts`, `@docedit/layout`'s `hitTest`); the bridge is then projected again at
 *   the new position.
 * - `window.__s9` is what the Playwright spec (e2e/s9.spec.ts) reads and calls.
 *
 * `?bridge=opacity|clip` chooses how the bridge is hidden (find-in-page probe); `?ec=1` also
 * mounts the EditContext probe (S9 §5).
 */
import {
  caretGeometry,
  hitTest,
  type DocPosition,
  type LayoutTree,
  type SpanWidth,
} from '@docedit/layout';
import { paintTree, type PaintSource } from '../../../painter/src/painter.ts';
import { paintSelection } from '../../../painter/src/selection-paint.ts';
import { BridgeSession, projectBlock } from '../s9/bridge.ts';
import { applyStep, blockText, type SpikeDoc } from '../s9/doc.ts';
import { layoutSpikeDoc, SPIKE_PAGE } from '../s9/layout.ts';
import { navigate, navKey } from '../s9/navigate.ts';

const PX_PER_PT = 96 / 72;
const FONT_PT = 12;
const FAMILY = 'serif';
const params = new URLSearchParams(location.search);
const useShadow = params.get('shadow') !== '0';
const hiding = params.get('bridge') ?? 'opacity';

const WORDS =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron'.split(' ');
const sentence = (n: number, seed: number): string =>
  Array.from({ length: n }, (_, i) => WORDS[(i + seed) % WORDS.length]).join(' ') + '.';
let doc: SpikeDoc = {
  blocks: [
    { id: 'p1', text: sentence(30, 0) },
    { id: 'p2', text: sentence(12, 3) },
    { id: 'p3', text: '' },
    { id: 'p4', text: sentence(40, 5) },
    { id: 'p5', text: sentence(25, 8) },
  ],
};

const ctx = document.createElement('canvas').getContext('2d')!;
ctx.font = `${FONT_PT * PX_PER_PT}px ${FAMILY}`;
const measurePt = (text: string): number => ctx.measureText(text).width / PX_PER_PT;

const host = document.getElementById('host')!;
const root: ShadowRoot | HTMLElement = useShadow ? host.attachShadow({ mode: 'open' }) : host;
const styleEl = document.createElement('style');
styleEl.textContent = `
  .stage { position: relative; padding: 8px 0; background: #ddd; }
  .bridge {
    position: absolute; margin: 0; padding: 0; border: 0; outline: 0; resize: none;
    background: transparent; white-space: pre; overflow: hidden; z-index: 2;
    font: ${FONT_PT}pt ${FAMILY}; font-kerning: auto; font-variant-ligatures: normal;
    line-height: ${SPIKE_PAGE.lineHeight}pt; caret-color: transparent;
  }
  .bridge.opacity { opacity: 0; color: transparent; }
  .bridge.clip { clip-path: inset(50%); color: transparent; }
`;
root.appendChild(styleEl);
const stage = document.createElement('div');
stage.className = 'stage';
root.appendChild(stage);

const bridge = document.createElement('textarea');
bridge.className = `bridge ${hiding}`;
bridge.rows = 1;
bridge.wrap = 'off';
bridge.spellcheck = false;
bridge.setAttribute('autocomplete', 'off');
bridge.setAttribute('autocapitalize', 'off');
bridge.setAttribute('aria-label', 'Text input for the page');
stage.appendChild(bridge);

let pos: DocPosition = { blockId: 'p1', offset: 0 };
let goalX: number | undefined;
let tree: LayoutTree = layoutSpikeDoc(doc, measurePt);
let pages: HTMLElement[] = [];
let session = new BridgeSession(projectBlock(doc, pos));
let renders = 0;

const span: SpanWidth = (blockId, from, to) => measurePt(blockText(doc, blockId).slice(from, to));
const source: PaintSource = {
  lineText: (blockId, from, to) => blockText(doc, blockId).slice(from, to),
  fontFamily: FAMILY,
  fontSizePt: FONT_PT,
};

function repaint(): void {
  for (const el of [...stage.children]) if (el !== bridge) el.remove();
  tree = layoutSpikeDoc(doc, measurePt);
  pages = [...paintTree(stage, tree, source).pages];
  paintSelection(document, pages, tree, span, { anchor: pos, head: pos });
  renders++;
  placeBridge();
}

/** The caret's top-left corner on the screen, in CSS pixels, from the layout tree. */
function caretPx(): { left: number; top: number; height: number } | null {
  const g = caretGeometry(tree, pos, span);
  const page = g ? pages[g.page] : undefined;
  if (!g || !page) return null;
  const r = page.getBoundingClientRect();
  return {
    left: r.left + g.x * PX_PER_PT,
    top: r.top + g.y * PX_PER_PT,
    height: g.height * PX_PER_PT,
  };
}

/**
 * Puts the bridge where its caret is on the painted caret: its left edge is the caret's x less the
 * width of the bridge text before the bridge's caret. Only the box moves; the text is untouched.
 */
function placeBridge(): void {
  const c = caretPx();
  if (!c) return;
  const sr = stage.getBoundingClientRect();
  const before = bridge.value.slice(0, bridge.selectionStart);
  const prefix = ctx.measureText(before).width;
  bridge.style.width = `${ctx.measureText(bridge.value).width + 24}px`;
  bridge.style.height = `${c.height}px`;
  bridge.style.left = `${c.left - sr.left - prefix}px`;
  bridge.style.top = `${c.top - sr.top}px`;
}

/** Projects the block at `pos` into the bridge. Never while a composition is open. */
function project(): void {
  session = new BridgeSession(projectBlock(doc, pos));
  const p = session.current;
  bridge.value = p.text;
  bridge.setSelectionRange(p.caret, p.caret);
  placeBridge();
}

bridge.addEventListener('compositionstart', () => session.compositionStart());
bridge.addEventListener('compositionend', () => session.compositionEnd());
bridge.addEventListener('input', () => {
  const u = session.update(bridge.value, bridge.selectionStart);
  if (u.step) doc = applyStep(doc, u.step);
  pos = u.pos;
  goalX = undefined;
  repaint();
});
bridge.addEventListener('keydown', (e) => {
  if (session.isComposing || e.isComposing) return;
  if (e.key === 'Enter') {
    // A new block is not part of the prototype (S9 §6).
    e.preventDefault();
    return;
  }
  const key = navKey(e);
  if (!key) return;
  e.preventDefault();
  const r = navigate(key, doc, tree, pos, goalX, span);
  pos = r.pos;
  goalX = r.goalX;
  repaint();
  project();
});
stage.addEventListener('pointerdown', (e) => {
  const page = (e.target as Element).closest?.('.de-page') as HTMLElement | null;
  if (!page) return;
  e.preventDefault();
  const r = page.getBoundingClientRect();
  const hit = hitTest(
    tree,
    Number(page.dataset['page']),
    (e.clientX - r.left) / PX_PER_PT,
    (e.clientY - r.top) / PX_PER_PT,
    span,
  );
  if (!hit) return;
  pos = hit;
  goalX = undefined;
  repaint();
  project();
  bridge.focus();
});

/** The width of `text` as the browser sets it in the bridge's font, by a mirror element. */
function domWidth(text: string): number {
  const m = document.createElement('span');
  m.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT_PT}pt ${FAMILY};font-kerning:auto;font-variant-ligatures:normal`;
  m.textContent = text;
  stage.appendChild(m);
  const w = m.getBoundingClientRect().width;
  m.remove();
  return w;
}

const selectionRoot = (): Selection | null =>
  useShadow && 'getSelection' in (root as ShadowRoot)
    ? (root as unknown as { getSelection(): Selection }).getSelection()
    : window.getSelection();

/** Counts the matches window.find reports, from the top, without wrapping. */
function findAll(term: string): { count: number; inBridge: number; inPage: number; other: number } {
  const sel = selectionRoot();
  sel?.removeAllRanges();
  bridge.blur();
  const find = (window as unknown as { find?: (...a: unknown[]) => boolean }).find;
  const result = { count: 0, inBridge: 0, inPage: 0, other: 0 };
  if (!find) return result;
  // Start at the top of the page.
  window.scrollTo(0, 0);
  for (let i = 0; i < 50; i++) {
    // A match inside a textarea is reported by the textarea's own selection, not by the page's.
    const had = `${bridge.selectionStart},${bridge.selectionEnd}`;
    if (!find.call(window, term, false, false, false, false, false, false)) break;
    result.count++;
    const node = selectionRoot()?.anchorNode ?? null;
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    const inText =
      `${bridge.selectionStart},${bridge.selectionEnd}` !== had &&
      bridge.selectionEnd - bridge.selectionStart === term.length &&
      bridge.value.slice(bridge.selectionStart, bridge.selectionEnd).toLowerCase() === term;
    if (el?.closest('.de-line')) result.inPage++;
    else if (inText) result.inBridge++;
    else result.other++;
  }
  return result;
}

interface EditContextLike extends EventTarget {
  updateText(start: number, end: number, text: string): void;
  updateSelection(start: number, end: number): void;
  updateControlBounds(r: DOMRect): void;
  updateSelectionBounds(r: DOMRect): void;
  readonly text: string;
}
const ecLog: Array<Record<string, unknown>> = [];

function startEditContext(): { supported: boolean } {
  const EC = (window as unknown as { EditContext?: new (o?: object) => EditContextLike })
    .EditContext;
  if (!EC) return { supported: false };
  const el = document.createElement('div');
  el.tabIndex = 0;
  el.id = 'ec-surface';
  el.style.cssText = 'position:fixed;left:10px;top:10px;width:300px;height:30px;background:#fff';
  document.body.appendChild(el);
  const ec = new EC({ text: 'ab', selectionStart: 2, selectionEnd: 2 });
  (el as unknown as { editContext: EditContextLike }).editContext = ec;
  for (const type of [
    'textupdate',
    'textformatupdate',
    'characterboundsupdate',
    'compositionstart',
    'compositionend',
  ]) {
    ec.addEventListener(type, (e) => {
      const ev = e as Event & Record<string, unknown>;
      ecLog.push({
        type,
        text: ev['text'],
        updateRangeStart: ev['updateRangeStart'],
        updateRangeEnd: ev['updateRangeEnd'],
        selectionStart: ev['selectionStart'],
        selectionEnd: ev['selectionEnd'],
        contextText: ec.text,
      });
    });
  }
  ec.updateControlBounds(el.getBoundingClientRect());
  ec.updateSelectionBounds(new DOMRect(40, 10, 1, 30));
  el.focus();
  return { supported: true };
}

declare global {
  interface Window {
    __s9: unknown;
  }
}

window.__s9 = {
  texts: (): Record<string, string> => Object.fromEntries(doc.blocks.map((b) => [b.id, b.text])),
  pos: (): DocPosition => pos,
  setPos(blockId: string, offset: number): void {
    pos = { blockId, offset };
    goalX = undefined;
    repaint();
    project();
  },
  focus: (): void => bridge.focus(),
  renders: (): number => renders,
  pageCount: (): number => tree.pages.length,
  bridgeValue: (): string => bridge.value,
  composing: (): boolean => session.isComposing,
  steps: (): number => session.stepCount,
  /** Where the painted caret and the bridge's caret are, in CSS pixels, as the browser has them. */
  geometry(): {
    painted: { left: number; top: number; height: number } | null;
    bridgeCaret: { left: number; top: number; height: number };
    bridgeRect: { left: number; top: number; width: number; height: number };
    page: number;
  } {
    const caret = pages.flatMap((p) => [...p.querySelectorAll('.de-caret')])[0];
    const pr = caret?.getBoundingClientRect();
    const br = bridge.getBoundingClientRect();
    const w = domWidth(bridge.value.slice(0, bridge.selectionStart));
    return {
      painted: pr ? { left: pr.left, top: pr.top, height: pr.height } : null,
      bridgeCaret: { left: br.left + w, top: br.top, height: br.height },
      bridgeRect: { left: br.left, top: br.top, width: br.width, height: br.height },
      page: caretGeometry(tree, pos, span)?.page ?? -1,
    };
  },
  paintedText(blockId: string): string {
    return [...stage.querySelectorAll(`.de-line[data-block="${blockId}"] .de-text`)]
      .map((s) => s.textContent ?? '')
      .join('');
  },
  activeIsBridge: (): boolean =>
    (useShadow ? (root as ShadowRoot).activeElement : document.activeElement) === bridge,
  /** Pixel centre of a painted position, for a click. */
  pointOf(blockId: string, offset: number): { x: number; y: number } | null {
    const save = pos;
    pos = { blockId, offset };
    const c = caretPx();
    pos = save;
    return c ? { x: c.left + 0.5, y: c.top + c.height / 2 } : null;
  },
  findAll,
  startEditContext,
  ecLog: (): Array<Record<string, unknown>> => ecLog,
  ecText: (): string => {
    const el = document.getElementById('ec-surface') as
      (HTMLElement & { editContext?: EditContextLike }) | null;
    return el?.editContext?.text ?? '';
  },
};

repaint();
project();
if (params.get('ec') !== '1') bridge.focus();
document.documentElement.dataset['ready'] = '1';
