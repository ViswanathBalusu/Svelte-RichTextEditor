/**
 * Spike S9 (SPK-022): the input bridge as a small projection of the current block (02 §9.6).
 *
 * The bridge is one editable element (a one-line textarea in the prototype) that holds the text of
 * the block around the caret, placed so that its caret sits on the painted caret. The browser and
 * the input method edit that text; this module maps what they did onto the document as text steps.
 * It does not hold the whole document (so a screen reader is not pointed at it, and find-in-page
 * does not find every match twice) and it does not move the caret by line or page (that comes from
 * the layout tree, `navigate.ts`).
 *
 * A projection is a window of `radius` characters either side of the caret, so that a very long
 * block does not become a very long element. The window is fixed while a composition is open: an
 * input method is not given a new text under it.
 *
 * No DOM and no Node.js API.
 */
import type { DocPosition } from '@docedit/layout';
import { blockText, diffStep, type SpikeDoc, type TextStep } from './doc.ts';

export const DEFAULT_RADIUS = 200;

export interface Projection {
  readonly blockId: string;
  /** Offset in the block of the first projected character. */
  readonly start: number;
  /** The projected text. */
  readonly text: string;
  /** The caret inside `text`. */
  readonly caret: number;
}

export function projectBlock(doc: SpikeDoc, pos: DocPosition, radius = DEFAULT_RADIUS): Projection {
  const text = blockText(doc, pos.blockId);
  const offset = Math.max(0, Math.min(pos.offset, text.length));
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + radius);
  return { blockId: pos.blockId, start, text: text.slice(start, end), caret: offset - start };
}

/** The document position of a caret inside a projection. */
export function positionIn(p: Projection, caret: number): DocPosition {
  return { blockId: p.blockId, offset: p.start + Math.max(0, Math.min(caret, p.text.length)) };
}

export interface BridgeUpdate {
  /** The step to apply to the document; null when the text did not change (a caret move only). */
  readonly step: TextStep | null;
  /** The caret after the update, as a document position. */
  readonly pos: DocPosition;
}

/**
 * One bridge session: from a projection to the next time the bridge is re-projected. It keeps the
 * text the document currently holds for the window, so that every update is a step against the
 * document as it is now. That makes a composition a series of steps, each replacing the range the
 * previous one made: the composing text is in the document while it is composed, painted like any
 * other text, and the input method's window stays where the bridge's caret is.
 */
export class BridgeSession {
  private projection: Projection;
  private value: string;
  private composing = false;
  private steps = 0;

  constructor(projection: Projection) {
    this.projection = projection;
    this.value = projection.text;
  }

  get current(): Projection {
    return { ...this.projection, text: this.value };
  }

  get isComposing(): boolean {
    return this.composing;
  }

  get stepCount(): number {
    return this.steps;
  }

  compositionStart(): void {
    this.composing = true;
  }

  compositionEnd(): void {
    this.composing = false;
  }

  /** The bridge's text and caret after an `input` event or a selection change. */
  update(value: string, caret: number): BridgeUpdate {
    const step = diffStep(this.projection.blockId, this.projection.start, this.value, value, caret);
    this.value = value;
    if (step) this.steps++;
    return { step, pos: positionIn({ ...this.projection, text: value }, caret) };
  }
}
