/**
 * Spike S9 (SPK-022): the smallest document the input-bridge prototype needs. Blocks hold plain
 * text; an edit is one text step in one block. The real document is the CDM and its steps are
 * ProseMirror steps (02 §5); this stand-in has the same shape for the part the bridge touches, a
 * replacement of a range of one block's text (03 §4).
 *
 * No DOM and no Node.js API.
 */
export interface SpikeBlock {
  readonly id: string;
  readonly text: string;
}

export interface SpikeDoc {
  readonly blocks: readonly SpikeBlock[];
}

/** Replace `[from, to)` of a block's text by `insert`. */
export interface TextStep {
  readonly blockId: string;
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export function applyStep(doc: SpikeDoc, step: TextStep): SpikeDoc {
  let found = false;
  const blocks = doc.blocks.map((b) => {
    if (b.id !== step.blockId) return b;
    found = true;
    if (step.from < 0 || step.to < step.from || step.to > b.text.length) {
      throw new RangeError(`step [${step.from}, ${step.to}) is outside block ${b.id}`);
    }
    return { id: b.id, text: b.text.slice(0, step.from) + step.insert + b.text.slice(step.to) };
  });
  if (!found) throw new RangeError(`no block ${step.blockId}`);
  return { blocks };
}

export function blockText(doc: SpikeDoc, blockId: string): string {
  const b = doc.blocks.find((x) => x.id === blockId);
  if (!b) throw new RangeError(`no block ${blockId}`);
  return b.text;
}

/**
 * The one step that turns `before` into `after`: the text between their longest common prefix and
 * suffix is replaced. `base` is the offset of `before` inside the block. The caret position a
 * browser reports after the edit breaks ties when the same text repeats: a prefix never runs past
 * `caretAfter`, so typing "a" after "a" in "aa" is an insert at the caret and not before it.
 * Null when nothing changed.
 */
export function diffStep(
  blockId: string,
  base: number,
  before: string,
  after: string,
  caretAfter?: number,
): TextStep | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  const prefixMax = caretAfter === undefined ? limit : Math.min(limit, caretAfter);
  while (prefix < prefixMax && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  return {
    blockId,
    from: base + prefix,
    to: base + before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
