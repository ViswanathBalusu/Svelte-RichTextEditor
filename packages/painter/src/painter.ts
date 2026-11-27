/**
 * DOM painter (02 §9.1, §9.3; ADR 0005; FE-090, FE-091). The painter draws a layout tree into page
 * boxes: every line is one absolutely positioned box with `white-space: pre`, at the point the
 * engine put it, so the browser never re-wraps a line. Text is real DOM text, built with DOM APIs
 * (`createElement`, `textContent`), never with HTML strings.
 *
 * The tree carries no text and no fonts. The caller supplies them through `PaintSource`: the text of
 * a CDM range, and the one face and size the measurer used. Justification (FE-091) is applied as
 * CSS `word-spacing` with the value `justifyLine` computes, and the trailing run of blanks is
 * reset to zero so that it does not stretch.
 *
 * This is a DOM package (`packages/painter`, 01 §6): it is not universal and may use DOM APIs.
 */
import type {
  BoxFragment,
  LayoutFragment,
  LayoutLine,
  LayoutTree,
  ParagraphFragment,
} from '../../layout/src/tree.ts';
import { justifyLine } from '../../layout/src/justify.ts';

/**
 * The text settings the painter's CSS and the measurer share (FE-090 criterion 4). Owner decision
 * 249: measuring and painting both use normal kerning, so the lines the layout computed are the
 * lines that are painted. The default measurer (`canvasTextMeasurer`,
 * packages/element/src/canvas-measure.ts) sets canvas `fontKerning` to `normal` and leaves the
 * ligatures at their default, and CSS `font-kerning: normal` paints the same widths in Chromium,
 * Firefox and WebKit. Canvas `auto` is not used: in Chromium no CSS value reproduces it on kerned
 * pairs (about 0.9 px wide on `AVATAR Wave Yes` at 16 px serif, measured 2026-11-13).
 *
 * `textRendering: geometricPrecision` keeps the advances unhinted. Chromium on Linux (hosted CI,
 * Playwright 1.65, headless) otherwise rounds each glyph advance to a whole pixel, and a line of 40
 * characters is painted up to 11 px away from the width the layout computed; with it the painted
 * widths of the half-pixel harness (WASM-006) are within 0.4 px. Windows and macOS position glyphs
 * at fractions of a pixel already, so the value changes nothing there.
 */
export const PAINT_TEXT_PINS = {
  fontKerning: 'normal',
  fontVariantLigatures: 'normal',
  textRendering: 'geometricPrecision',
} as const;

/**
 * One run of a line in one face (FE-101). A source that gives runs paints each line as a series of
 * spans, so a heading, bold text or a coloured word shows as the layout measured it. The text of the
 * runs, joined, is the text of the line.
 */
export interface PaintRun {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSizePt: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  /** A CSS colour, or null for the text colour of the page. */
  readonly color: string | null;
  readonly vertAlign: 'super' | 'sub' | null;
}

/** What the painter needs that the layout tree does not hold. */
export interface PaintSource {
  /**
   * The runs of the line [from, to) of a block, each in its own face (FE-101). When this is given,
   * the line is painted from the runs and `fontFamily` and `fontSizePt` are only the fallback for a
   * line that carries its own text (a page-number field). Return null to paint the line from
   * lineText in the one face.
   */
  runs?(blockId: string, from: number, to: number): readonly PaintRun[] | null;
  /** The advance in points of the line [from, to) of a block, with each run in its own face; used to justify when 
uns is given. */
  measureRange?(blockId: string, from: number, to: number): number;
  /** The text of the CDM range `[from, to)` of a block, with no line break in it. */
  lineText(blockId: string, from: number, to: number): string;
  /** The CSS font family the text is set in: the face the measurer measured. */
  readonly fontFamily: string;
  /** The font size in points. */
  readonly fontSizePt: number;
  /** The advance of a text in points, from the same measurer as the layout. Needed to justify. */
  readonly measure?: (text: string) => number;
}

export interface PaintOptions {
  /**
   * Blocks to justify (FE-091). Every line of such a block but its last one is stretched to the
   * right edge of its paragraph. Ignored when `PaintSource.measure` is absent.
   */
  readonly justify?: (blockId: string) => boolean;
  /** Space between pages, in points. Defaults to 12. */
  readonly pageGap?: number;
  /**
   * Interactive controls (FE-093). Called for each box fragment of a page, in document order (body,
   * then header, footer and footnotes). The element it returns is placed at the box, in an overlay
   * above the lines. The overlay takes no pointer events; only the controls do. Null leaves the box
   * as it is. The caller builds the element with DOM APIs and reads its value from the document.
   */
  readonly control?: (box: BoxFragment) => HTMLElement | null;
  /**
   * The accessible label of the control placed for a box (FE-093 criterion 3). When it returns a
   * text, the painter puts a visually hidden label element in the same overlay, as the control's
   * sibling, and points the control's `aria-labelledby` at it, so that the reference resolves in the
   * root the pages were painted into (a shadow root included). A control that already has
   * `aria-labelledby` or `aria-label` keeps it, and no label element is made for it.
   */
  readonly controlLabel?: (box: BoxFragment) => string | null;
}

export interface PaintResult {
  /** The page boxes, in page order. */
  readonly pages: readonly HTMLElement[];
  /** The number of line boxes painted, across all pages. */
  readonly lineCount: number;
  /** The number of controls placed in the overlay layers (FE-093), across all pages. */
  readonly controlCount: number;
}

/** Makes the ids of the label elements unique across pages and paints in one document (FE-093). */
let labelSerial = 0;

/** Characters a trailing run may hold: ordinary space, no-break space and tab. */
function isBlank(ch: string): boolean {
  return ch === ' ' || ch === ' ' || ch === '\t';
}

/** Whether a run is set in the face of the run before it, so that a browser would shape the two together. */
function joinsFace(prev: PaintRun | null, run: PaintRun): boolean {
  return (
    prev !== null &&
    prev.fontFamily === run.fontFamily &&
    prev.fontSizePt === run.fontSizePt &&
    prev.bold === run.bold &&
    prev.italic === run.italic
  );
}

/** Appends the runs of a line to `span`; the trailing blanks of the line are left out of the word spacing (FE-091). */
function paintRuns(
  doc: Document,
  span: HTMLElement,
  runs: readonly PaintRun[],
  wordSpacing: number,
): void {
  if (wordSpacing > 0) span.style.wordSpacing = `${wordSpacing}pt`;
  const last = runs.length - 1;
  runs.forEach((run, i) => {
    const prev = i > 0 ? runs[i - 1]! : null;
    let body = run.text;
    let tail = '';
    if (wordSpacing > 0 && i === last) {
      let end = body.length;
      while (end > 0 && isBlank(body.charAt(end - 1))) end--;
      tail = body.slice(end);
      body = body.slice(0, end);
    }
    const piece = (text: string, reset: boolean): void => {
      if (text === '') return;
      const el = doc.createElement('span');
      el.className = 'de-run';
      const s = el.style;
      s.fontFamily = run.fontFamily;
      s.fontSize = `${run.fontSizePt}pt`;
      if (run.bold) s.fontWeight = 'bold';
      if (run.italic) s.fontStyle = 'italic';
      const decoration = [run.underline ? 'underline' : '', run.strike ? 'line-through' : '']
        .filter((d) => d !== '')
        .join(' ');
      if (decoration !== '') s.textDecoration = decoration;
      if (run.color !== null) s.color = run.color;
      if (run.vertAlign !== null) s.verticalAlign = run.vertAlign;
      if (reset) s.wordSpacing = '0pt';
      // The layout measures each run on its own, so the browser must not shape a run together with
      // the one before it (it kerns a pair across two spans of one face, as 'r' and ',' in
      // "colour" and ", ", and Chromium and Firefox then paint the line narrower than it was
      // measured). A bidi isolate ends the shaping run at each edge (FE-094).
      if (joinsFace(prev, run)) s.unicodeBidi = 'isolate';
      el.textContent = text;
      span.appendChild(el);
    };
    piece(body, false);
    piece(tail, true);
  });
}

/**
 * Paints a layout tree into `root` (an element or a shadow root). The previous content of `root` is
 * kept; the caller clears it when it repaints.
 */
export function paintTree(
  root: Node,
  tree: LayoutTree,
  source: PaintSource,
  options: PaintOptions = {},
): PaintResult {
  const doc = root.ownerDocument ?? (root as Document);
  const gap = options.pageGap ?? 12;
  const pages: HTMLElement[] = [];
  let lineCount = 0;
  let controlCount = 0;
  // The overlay of the page being painted (FE-093); set per page below.
  let overlay: HTMLElement | null = null;

  const paintLine = (
    parent: HTMLElement,
    f: ParagraphFragment,
    line: LayoutLine,
    index: number,
  ): void => {
    const x = f.x + line.x;
    const y = f.y + line.y;
    // A line that carries its own text (a field's value, FE-087) shows it; any other line shows the
    // CDM text of its range.
    // With runs (FE-101) the line is painted in the faces the layout measured; a line that carries
    // its own text is painted in the one face.
    const runs =
      line.text === undefined ? (source.runs?.(f.blockId, line.from, line.to) ?? null) : null;
    const text = runs
      ? runs.map((r) => r.text).join('')
      : (line.text ?? source.lineText(f.blockId, line.from, line.to));
    const el = doc.createElement('div');
    el.className = 'de-line';
    el.dataset['block'] = f.blockId;
    el.dataset['from'] = String(line.from);
    el.dataset['to'] = String(line.to);
    const style = el.style;
    style.position = 'absolute';
    style.left = `${x}pt`;
    style.top = `${y}pt`;
    style.height = `${line.height}pt`;
    style.lineHeight = `${line.height}pt`;
    style.whiteSpace = 'pre';
    style.overflow = 'visible';
    style.margin = '0';
    style.padding = '0';
    style.fontFamily = runs?.[0]?.fontFamily ?? source.fontFamily;
    style.fontSize = `${runs?.[0]?.fontSizePt ?? source.fontSizePt}pt`;
    // Kerning and ligatures are the ones the measurer measures with (`PAINT_TEXT_PINS`; FE-090
    // criterion 4, owner decision 249, spec 02 §9.3).
    style.fontKerning = PAINT_TEXT_PINS.fontKerning;
    style.fontVariantLigatures = PAINT_TEXT_PINS.fontVariantLigatures;
    style.textRendering = PAINT_TEXT_PINS.textRendering;
    style.color = 'CanvasText';

    const span = doc.createElement('span');
    span.className = 'de-text';
    const justified =
      (runs ? source.measureRange !== undefined : source.measure !== undefined) &&
      options.justify?.(f.blockId) === true &&
      index < f.lines.length - 1;
    if (runs) {
      let spacing = 0;
      if (justified && source.measureRange) {
        const target = f.x + f.width - x;
        spacing = justifyLine(
          text,
          source.measureRange(f.blockId, line.from, line.to),
          target,
        ).wordSpacing;
      }
      paintRuns(doc, span, runs, spacing);
    } else if (justified && source.measure) {
      const target = f.x + f.width - x;
      const { wordSpacing } = justifyLine(text, source.measure(text), target);
      if (wordSpacing > 0) {
        // Only the run of blanks at the end of the line is left out of the stretch (FE-091).
        let end = text.length;
        while (end > 0 && isBlank(text.charAt(end - 1))) end--;
        span.style.wordSpacing = `${wordSpacing}pt`;
        span.appendChild(doc.createTextNode(text.slice(0, end)));
        if (end < text.length) {
          const tail = doc.createElement('span');
          tail.style.wordSpacing = '0pt';
          tail.textContent = text.slice(end);
          span.appendChild(tail);
        }
      } else {
        span.textContent = text;
      }
    } else {
      span.textContent = text;
    }
    el.appendChild(span);
    parent.appendChild(el);
    lineCount++;
  };

  const paintFragments = (parent: HTMLElement, fragments: readonly LayoutFragment[]): void => {
    for (const f of fragments) {
      if (f.kind === 'paragraph') {
        f.lines.forEach((line, i) => paintLine(parent, f, line, i));
      } else if (f.kind === 'table') {
        for (const row of f.rows)
          for (const cell of row.cells) paintFragments(parent, cell.fragments);
      } else {
        const box = doc.createElement('div');
        box.className = 'de-box';
        box.dataset['block'] = f.blockId;
        box.style.position = 'absolute';
        box.style.left = `${f.x}pt`;
        box.style.top = `${f.y}pt`;
        box.style.width = `${f.width}pt`;
        box.style.height = `${f.height}pt`;
        // A box is not an interactive surface by itself; only a control placed on it is (FE-093).
        box.style.pointerEvents = 'none';
        parent.appendChild(box);
        const control = options.control?.(f) ?? null;
        if (control && overlay) {
          control.classList.add('de-control');
          control.dataset['block'] = f.blockId;
          const cs = control.style;
          cs.position = 'absolute';
          // The control fills its box exactly, padding and border included (FE-093).
          cs.boxSizing = 'border-box';
          cs.left = `${f.x}pt`;
          cs.top = `${f.y}pt`;
          cs.width = `${f.width}pt`;
          cs.height = `${f.height}pt`;
          cs.pointerEvents = 'auto';
          const labelText = options.controlLabel?.(f) ?? null;
          if (
            labelText !== null &&
            labelText !== '' &&
            !control.hasAttribute('aria-labelledby') &&
            !control.hasAttribute('aria-label')
          ) {
            const label = doc.createElement('span');
            label.id = `de-control-label-${++labelSerial}`;
            label.className = 'de-control-label';
            label.textContent = labelText;
            // Visually hidden, still in the accessibility tree; set through the style object.
            const ls = label.style;
            ls.position = 'absolute';
            ls.width = '1px';
            ls.height = '1px';
            ls.overflow = 'hidden';
            ls.setProperty('clip-path', 'inset(50%)');
            ls.whiteSpace = 'nowrap';
            ls.pointerEvents = 'none';
            control.setAttribute('aria-labelledby', label.id);
            overlay.appendChild(label);
          }
          overlay.appendChild(control);
          controlCount++;
        }
      }
    }
  };

  for (const page of tree.pages) {
    const el = doc.createElement('div');
    el.className = 'de-page';
    el.dataset['page'] = String(page.index);
    const style = el.style;
    style.position = 'relative';
    style.overflow = 'hidden';
    style.boxSizing = 'border-box';
    style.width = `${page.width}pt`;
    style.height = `${page.height}pt`;
    style.margin = `0 auto ${gap}pt`;
    style.background = 'Canvas';
    style.color = 'CanvasText';
    // The overlay is appended after the lines, so it stacks above them; it takes no pointer events
    // itself, so text under it stays selectable (FE-093).
    const layer = doc.createElement('div');
    layer.className = 'de-overlay';
    layer.style.position = 'absolute';
    layer.style.left = '0';
    layer.style.top = '0';
    layer.style.width = '100%';
    layer.style.height = '100%';
    layer.style.pointerEvents = 'none';
    overlay = layer;
    paintFragments(el, page.fragments);
    paintFragments(el, [...page.header, ...page.footer, ...page.footnotes]);
    overlay = null;
    if (layer.childElementCount > 0) el.appendChild(layer);
    root.appendChild(el);
    pages.push(el);
  }
  return { pages, lineCount, controlCount };
}
