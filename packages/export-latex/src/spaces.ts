/**
 * Which spaces of a paragraph the converter writes as explicit spaces (09 §3.2, Spaces; ADR 0032
 * §7). The model's `spaceRuns` decides over the paragraph's whole text, because a run of spaces can
 * cross text nodes with different marks. TeX drops spaces after a forced line break, so each line
 * of a paragraph is measured on its own: its first spaces are leading spaces, written explicitly,
 * as Word shows them.
 */
import { spaceRuns } from '@docedit/model';
import type { J } from './context.ts';

/** A non-space stand-in for an atom or for text that is not typeset (one per UTF-16 unit). */
const ATOM = '￼';

/** The offsets, in the block's text, of the spaces to write explicitly. */
export function explicitSpaces(
  content: readonly J[] | undefined,
  skipped: (n: J) => boolean,
): Set<number> {
  // The block's text as offsets count it: text nodes by their UTF-16 length, atoms as one unit,
  // anchors as none. A forced line break separates lines.
  let s = '';
  for (const n of content ?? []) {
    if (n.type === 'text') {
      const text = n.text ?? '';
      s += skipped(n) ? ATOM.repeat(text.length) : text;
    } else if (n.type === 'anchor') continue;
    else if (n.type === 'break') s += '\n';
    else s += ATOM;
  }
  const out = new Set<number>();
  let lineStart = 0;
  for (const lineText of s.split('\n')) {
    for (const r of spaceRuns(lineText)) {
      const first = r.position === 'between' ? 1 : 0;
      for (let k = first; k < r.length; k++) out.add(lineStart + r.start + k);
    }
    lineStart += lineText.length + 1;
  }
  return out;
}

/**
 * Whether the paragraph's typeset content ends with a space or a tab, which `\par` would otherwise
 * remove (TeX deletes a paragraph's last glue). A trailing tab can carry a leader, such as the line
 * of a signature field.
 */
export function endsWithSpace(
  content: readonly J[] | undefined,
  skipped: (n: J) => boolean,
): boolean {
  const nodes = (content ?? []).filter((n) => n.type !== 'anchor');
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (n.type === 'tab') return true;
    if (n.type !== 'text') return false;
    if (skipped(n)) continue;
    const text = n.text ?? '';
    if (text.length === 0) continue;
    return text.endsWith(' ');
  }
  return false;
}
