/**
 * Scripts that need a shaping engine (09 §8; EXP-037 criterion 2). Arabic and Syriac letters change
 * their form with their neighbours, and the Indic scripts, Thai, Lao, Tibetan, Myanmar and Khmer
 * reorder, join and stack their letters. A document that has any of them is set with the HarfBuzz
 * renderer of luaotfload; the others keep the renderer the caller asked for (the `node` renderer,
 * unless `renderer` says `harf`). Hebrew and the Latin, Greek and Cyrillic scripts, and the
 * Chinese, Japanese and Korean scripts, need no shaping beyond the font's own features.
 */
const COMPLEX_SCRIPT =
  /[\u0600-\u074f\u0750-\u077f\u0780-\u07bf\u08a0-\u08ff\u0900-\u0fff\u1000-\u109f\u1780-\u17ff\ufb50-\ufdff\ufe70-\ufeff]/u;

/** Whether `value` holds a character of a script that needs shaping. */
export function needsShaping(value: string): boolean {
  return COMPLEX_SCRIPT.test(value);
}

/** Whether any string in a JSON value (a document, a node) needs shaping; stops at the first. */
export function hasComplexScript(value: unknown): boolean {
  if (typeof value === 'string') return COMPLEX_SCRIPT.test(value);
  if (Array.isArray(value)) return value.some(hasComplexScript);
  if (value !== null && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).some(hasComplexScript);
  return false;
}

/** The OpenType script names (fontspec `Script=`) of the Unicode blocks that need shaping. */
export type ScriptName =
  | 'Arabic'
  | 'Syriac'
  | 'Thaana'
  | 'Devanagari'
  | 'Bengali'
  | 'Gurmukhi'
  | 'Gujarati'
  | 'Oriya'
  | 'Tamil'
  | 'Telugu'
  | 'Kannada'
  | 'Malayalam'
  | 'Sinhala'
  | 'Thai'
  | 'Lao'
  | 'Tibetan'
  | 'Myanmar'
  | 'Khmer';

const SCRIPT_BLOCKS: ReadonlyArray<readonly [number, number, ScriptName]> = [
  [0x0600, 0x06ff, 'Arabic'],
  [0x0700, 0x074f, 'Syriac'],
  [0x0750, 0x077f, 'Arabic'],
  [0x0780, 0x07bf, 'Thaana'],
  [0x08a0, 0x08ff, 'Arabic'],
  [0x0900, 0x097f, 'Devanagari'],
  [0x0980, 0x09ff, 'Bengali'],
  [0x0a00, 0x0a7f, 'Gurmukhi'],
  [0x0a80, 0x0aff, 'Gujarati'],
  [0x0b00, 0x0b7f, 'Oriya'],
  [0x0b80, 0x0bff, 'Tamil'],
  [0x0c00, 0x0c7f, 'Telugu'],
  [0x0c80, 0x0cff, 'Kannada'],
  [0x0d00, 0x0d7f, 'Malayalam'],
  [0x0d80, 0x0dff, 'Sinhala'],
  [0x0e00, 0x0e7f, 'Thai'],
  [0x0e80, 0x0eff, 'Lao'],
  [0x0f00, 0x0fff, 'Tibetan'],
  [0x1000, 0x109f, 'Myanmar'],
  [0x1780, 0x17ff, 'Khmer'],
  [0xfb50, 0xfdff, 'Arabic'],
  [0xfe70, 0xfeff, 'Arabic'],
];

/** The script name of a code point that needs shaping, or null. */
export function scriptOf(cp: number): ScriptName | null {
  for (const [a, b, name] of SCRIPT_BLOCKS) if (cp >= a && cp <= b) return name;
  return null;
}

/** A joiner or non-joiner: part of the word it is in, in any script. */
const JOINERS = new Set([0x200c, 0x200d]);

/**
 * A run of one script: consecutive characters of the same script that needs shaping, with the
 * joiners between them, and the code point and script name that start it.
 */
export interface ScriptRun {
  start: number;
  end: number;
  first: number;
  script: ScriptName;
}

/** The runs of `value` (an escaped TeX string or plain text: only the non-ASCII characters count). */
export function scriptRuns(value: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  let open: ScriptRun | null = null;
  let at = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    const script = scriptOf(cp);
    if (script !== null && (open === null || open.script === script)) {
      open ??= { start: at, end: at, first: cp, script };
      open.end = at + ch.length;
    } else if (open !== null && JOINERS.has(cp)) {
      open.end = at + ch.length;
    } else if (open !== null) {
      runs.push(open);
      open = script !== null ? { start: at, end: at + ch.length, first: cp, script } : null;
    }
    at += ch.length;
  }
  if (open) runs.push(open);
  return runs;
}
