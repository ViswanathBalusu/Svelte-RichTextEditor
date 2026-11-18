/**
 * The word count of the status bar (UX-018 criterion 1; 13 §3). A word is a run of letters or
 * digits as the language's own rules see it: `Intl.Segmenter` with word granularity where the
 * runtime has it, else a run of characters between white space that holds a letter or a digit. The
 * count covers the body of the document the reader sees: the paragraphs of the body, with the
 * content of its regions and tables, but not the definitions, the headers and footers, or the text
 * of footnotes. Text a reader may not see is a placeholder in the document and holds no words.
 *
 * Decisions taken here, not in the spec (UX-018 Notes): footnotes are not counted, and a hidden
 * region adds no words.
 *
 * The count is a pass over the body. It is never run by a keystroke: the core schedules it away
 * from the typing path (`WordCounter`).
 */
import type { Node as PMNode } from 'prosemirror-model';

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

type Segmenter = { segment(text: string): Iterable<{ isWordLike?: boolean }> };

function segmenter(): Segmenter | null {
  const ctor = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => Segmenter })
    .Segmenter;
  return ctor ? new ctor(undefined, { granularity: 'word' }) : null;
}

/** The words in a piece of text. */
export function wordsIn(text: string, seg: Segmenter | null = segmenter()): number {
  if (text === '') return 0;
  let n = 0;
  if (seg) {
    for (const part of seg.segment(text)) if (part.isWordLike) n++;
    return n;
  }
  for (const token of text.split(/\s+/u)) if (LETTER_OR_DIGIT.test(token)) n++;
  return n;
}

/** The words in the body of a document. */
export function countBodyWords(doc: PMNode): number {
  const seg = segmenter();
  let n = 0;
  doc.descendants((node) => {
    const name = node.type.name;
    // The definitions and the stories (headers, footers) are not the body; footnote text is not counted.
    if (name === 'defs' || name === 'story' || name === 'footnote') return false;
    if (node.isTextblock) {
      // Text runs only: an inline node (a footnote reference, a field) breaks a word and adds none.
      let text = '';
      node.forEach((child) => {
        text += child.isText ? (child.text ?? '') : ' ';
      });
      n += wordsIn(text, seg);
      return false;
    }
    return true;
  });
  return n;
}

/**
 * Keeps a count that follows the document without running on each change. `changed()` only makes a
 * timer if none is waiting, so a burst of keystrokes costs one timer and one pass at the end of
 * `delayMs`; the count is at most that old.
 */
export class WordCounter {
  readonly #count: () => number;
  readonly #publish: (words: number) => void;
  readonly #delayMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** How many passes have run, for the tests. */
  passes = 0;

  constructor(count: () => number, publish: (words: number) => void, delayMs = 400) {
    this.#count = count;
    this.#publish = publish;
    this.#delayMs = delayMs;
  }

  /** The document changed: a count is due. Does no counting. */
  changed(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.passes++;
      this.#publish(this.#count());
    }, this.#delayMs);
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
