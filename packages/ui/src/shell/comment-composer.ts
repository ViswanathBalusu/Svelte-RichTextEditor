/**
 * The text model of the comment box (`components/CommentBox.svelte`; UX-028, UX-031 criterion 1).
 *
 * The box is a plain text field. A mention chosen in the picker is shown in the text as `@` and the
 * name, and kept beside the text as the principal it stands for. When the comment is posted, each
 * shown mention that is still intact becomes a mention node, which holds the principal identifier
 * only (`mention-search.ts`); a mention whose text was edited becomes plain text. The body format is
 * not defined in 03 or 05, so this is the editor's working shape (see UX-028 Notes).
 */
import type { CommentBodyPart } from '../core-api.ts';
import type { BodyPart } from './mention-picker.ts';

/** A mention shown in the text: the principal, and the text that shows it (`@` and the name). */
export interface PlacedMention {
  readonly principal: string;
  readonly label: string;
}

/**
 * The text and caret after a choice in the picker. `parts` are what `MentionPicker.choose` gave:
 * the text before the trigger, the mention node, the text after the caret. The node is shown as
 * `@name`, followed by a space unless the text after it already starts with whitespace; the caret
 * goes after that. Null when `parts` hold no mention.
 */
export function placeMention(
  parts: readonly BodyPart[],
  name: string,
): { readonly text: string; readonly caret: number; readonly mention: PlacedMention } | null {
  const at = parts.findIndex((p) => p.type === 'mention');
  const node = parts[at];
  if (node === undefined || node.type !== 'mention') return null;
  const textOf = (list: readonly BodyPart[]) =>
    list.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const before = textOf(parts.slice(0, at));
  const after = textOf(parts.slice(at + 1));
  const label = `@${name}`;
  const gap = /^\s/.test(after) ? '' : ' ';
  const text = `${before}${label}${gap}${after}`;
  return {
    text,
    caret: before.length + label.length + gap.length,
    mention: { principal: node.principal, label },
  };
}

const WORD = /[\p{L}\p{N}]/u;

/** Whether `label` stands at `index` of `text` as a whole mention: after a start or whitespace, before no letter. */
function standsAt(text: string, index: number, label: string): boolean {
  if (index > 0 && !/\s/.test(text.charAt(index - 1))) return false;
  const next = text.charAt(index + label.length);
  return next === '' || !WORD.test(next);
}

/**
 * The comment body for the text and the mentions placed in it: text parts, and a mention node for
 * each placed mention whose label is still in the text, in text order. Each placed mention is used
 * once. Adjacent text is merged and empty text is dropped.
 */
export function bodyParts(text: string, mentions: readonly PlacedMention[]): CommentBodyPart[] {
  const left = [...mentions];
  const parts: CommentBodyPart[] = [];
  const pushText = (t: string) => {
    if (t.length === 0) return;
    const last = parts[parts.length - 1];
    if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + t };
    else parts.push({ type: 'text', text: t });
  };
  let pos = 0;
  for (;;) {
    let index = -1;
    let at = -1;
    for (let k = 0; k < left.length; k++) {
      const m = left[k]!;
      if (m.label.length === 0) continue;
      let i = text.indexOf(m.label, pos);
      while (i >= 0 && !standsAt(text, i, m.label)) i = text.indexOf(m.label, i + 1);
      if (i < 0) continue;
      // The earliest mention wins; at the same place, the longer label.
      if (at < 0 || i < index || (i === index && m.label.length > left[at]!.label.length)) {
        index = i;
        at = k;
      }
    }
    if (at < 0) break;
    const m = left[at]!;
    pushText(text.slice(pos, index));
    parts.push({ type: 'mention', principal: m.principal });
    pos = index + m.label.length;
    left.splice(at, 1);
  }
  pushText(text.slice(pos));
  return parts;
}
