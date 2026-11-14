/**
 * Sample lines for spike S5: corpus text cut into lines of roughly a page's width, each line a
 * sequence of segments in one manifest face and size. The cut is a fixed rule (a maximum number of
 * characters at a space, or any character for CJK text), independent of any measurer, so every
 * browser and both shapers measure exactly the same strings.
 *
 * Text is itemised by script class (`roleOf`): Latin text takes the run's own family, CJK text the
 * CJK face. Spaces, digits and punctuation stay with the class before them, as in a browser's
 * script itemisation. Korean text has no face in the manifest and is left out.
 */
import { flowParagraphs, type FlowDocument, type FlowParagraph } from '@docedit/layout';
import { faceFor, roleOf, type FontRole } from './fonts.ts';

export interface LineSegment {
  readonly text: string;
  /** Manifest file of the face (`files/...`). */
  readonly face: string;
  /** Font size in CSS pixels (points × 4/3). */
  readonly sizePx: number;
}

export interface SampleLine {
  readonly id: string;
  readonly doc: string;
  /** `cjk` when any segment uses the CJK face. */
  readonly role: FontRole;
  readonly segments: readonly LineSegment[];
}

export interface SampleOptions {
  /** Characters per Latin line (default 90, about an A4 text line at 11 pt). */
  readonly maxChars?: number;
  /** Characters per CJK line (default 38). */
  readonly maxCjkChars?: number;
}

interface Item {
  ch: string;
  face: string;
  sizePx: number;
  role: FontRole;
}

const NEUTRAL = /[\s\d!-/:-@[-`{-~\u00a0-\u00bf\u2000-\u206f]/;

function itemsOf(p: FlowParagraph): Item[][] {
  const parts: Item[][] = [[]];
  let previous: FontRole = 'latin';
  for (const inline of p.inlines) {
    if (inline.kind === 'lineBreak') {
      parts.push([]);
      continue;
    }
    if (inline.kind !== 'text' || inline.role === 'equation' || inline.role === 'noteRef') continue;
    const f = inline.font;
    for (const ch of inline.text) {
      const role: FontRole = NEUTRAL.test(ch) ? previous : roleOf(ch);
      previous = role;
      const face = faceFor(f.family, f.bold, f.italic, role).file;
      parts[parts.length - 1]!.push({ ch, face, sizePx: (f.sizePt * 4) / 3, role });
    }
  }
  return parts;
}

function toSegments(items: readonly Item[]): LineSegment[] {
  const out: { text: string; face: string; sizePx: number }[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.face === it.face && last.sizePx === it.sizePx) last.text += it.ch;
    else out.push({ text: it.ch, face: it.face, sizePx: it.sizePx });
  }
  return out;
}

function cut(items: readonly Item[], maxChars: number, maxCjk: number): Item[][] {
  const lines: Item[][] = [];
  let start = 0;
  while (start < items.length) {
    while (start < items.length && items[start]!.ch === ' ') start++;
    if (start >= items.length) break;
    const cjk = items[start]!.role !== 'latin';
    const limit = cjk ? maxCjk : maxChars;
    let end = Math.min(items.length, start + limit);
    if (end < items.length && !cjk) {
      let space = end;
      while (space > start && items[space]!.ch !== ' ') space--;
      if (space > start) end = space;
    }
    let trimmed = end;
    while (trimmed > start && items[trimmed - 1]!.ch === ' ') trimmed--;
    if (trimmed > start) lines.push(items.slice(start, trimmed));
    start = end;
  }
  return lines;
}

/** Every line of a document's body paragraphs (tables included) and footnotes. */
export function sampleLines(
  flow: FlowDocument,
  doc: string,
  options: SampleOptions = {},
): SampleLine[] {
  const maxChars = options.maxChars ?? 90;
  const maxCjk = options.maxCjkChars ?? 38;
  const paragraphs: FlowParagraph[] = [];
  for (const s of flow.sections) paragraphs.push(...flowParagraphs(s.blocks));
  for (const n of flow.notes.values()) paragraphs.push(...n.blocks);
  const out: SampleLine[] = [];
  let n = 0;
  for (const p of paragraphs)
    for (const part of itemsOf(p))
      for (const line of cut(part, maxChars, maxCjk)) {
        if (line.some((i) => i.role === 'hangul')) continue;
        const segments = toSegments(line);
        const role: FontRole = line.some((i) => i.role === 'cjk') ? 'cjk' : 'latin';
        out.push({ id: `${doc}#${n++}`, doc, role, segments });
      }
  return out;
}

/** The text of a line, for reports. */
export const lineText = (l: SampleLine): string => l.segments.map((s) => s.text).join('');
