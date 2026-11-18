/**
 * A comparison drawn in the newer version's document (HIS-013; 08 §6, last paragraph): the changes
 * of `GET /diff` turned into decoration specs over the document. Insertions and formatting changes
 * are drawn with the classes of suggestion marks (`de-suggest-ins`, `de-suggest-fmt`; FE-046) and
 * the author tone of the same function, so one stylesheet and one set of cues serve both, and the
 * kind is a line style as well as a colour. A deletion is text that is no longer in the document,
 * so it is a widget at the point where it was, drawn only when the user asks for deletions: with
 * them off nothing is added and the layout does not move. Every changed block carries a change bar
 * (`de-change-bar`) that the stylesheet draws in the margin.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { authorTone, suggestionClasses } from './suggestion-markup.ts';

/** The part of a change this module reads (the wire shape of `GET /diff`, 08 §6). */
export interface ComparisonChange {
  readonly kind: string;
  readonly blockId?: string;
  readonly fieldId?: string;
  readonly user?: string;
  readonly seq?: number;
  readonly spans?: ReadonlyArray<{
    readonly op: 'insert' | 'delete';
    readonly at: number;
    readonly text: string;
    readonly user?: string;
    readonly seq?: number;
  }>;
}

/** One decoration of the comparison, as plain data. */
export type ComparisonSpec =
  | {
      readonly type: 'block';
      readonly from: number;
      readonly to: number;
      readonly index: number;
      readonly attrs: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'inline';
      readonly from: number;
      readonly to: number;
      readonly index: number;
      readonly attrs: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'deleted';
      readonly at: number;
      readonly index: number;
      readonly text: string;
      readonly attrs: Readonly<Record<string, string>>;
    };

const markAttrs = (
  classes: readonly string[],
  user: string | undefined,
  index: number,
): Record<string, string> => ({
  class: classes.join(' '),
  'data-suggestion-user': user ?? '',
  'data-suggestion-tone': String(authorTone(user ?? '')),
  'data-change-index': String(index),
});

/** The position and node of every identified block and field of `doc`, by identifier. */
function identified(doc: PMNode): Map<string, { pos: number; node: PMNode }> {
  const out = new Map<string, { pos: number; node: PMNode }>();
  doc.descendants((node, pos) => {
    const id: unknown = node.attrs['id'];
    if (typeof id === 'string' && !out.has(id)) out.set(id, { pos, node });
    return true;
  });
  return out;
}

/**
 * The decoration specs of `changes` in `doc` (the newer version). A change whose block is not in
 * the document (a removed block) has no place to draw; the navigator and the summary still list it.
 * The `index` of a spec is the position of its change in `changes`, which the navigator uses.
 */
export function comparisonSpecs(
  doc: PMNode,
  changes: readonly ComparisonChange[],
  options: { readonly showDeleted: boolean },
): ComparisonSpec[] {
  const ids = identified(doc);
  const specs: ComparisonSpec[] = [];
  changes.forEach((change, index) => {
    const id = change.blockId ?? change.fieldId;
    const found = id === undefined ? undefined : ids.get(id);
    if (found === undefined) return;
    const { pos, node } = found;
    const to = pos + node.nodeSize;
    if (change.kind === 'added') {
      specs.push({
        type: 'block',
        from: pos,
        to,
        index,
        attrs: markAttrs([...suggestionClasses('all', 'ins'), 'de-change-bar'], change.user, index),
      });
    } else if (change.kind === 'formatted' || change.kind === 'field' || change.kind === 'moved') {
      specs.push({
        type: 'block',
        from: pos,
        to,
        index,
        attrs: markAttrs([...suggestionClasses('all', 'fmt'), 'de-change-bar'], change.user, index),
      });
    } else if (change.kind === 'modified') {
      specs.push({
        type: 'block',
        from: pos,
        to,
        index,
        attrs: markAttrs(['de-change-bar'], change.user, index),
      });
      const start = pos + 1;
      for (const span of change.spans ?? []) {
        const at = start + span.at;
        if (span.op === 'insert') {
          const end = Math.min(at + span.text.length, to - 1);
          if (end > at)
            specs.push({
              type: 'inline',
              from: at,
              to: end,
              index,
              attrs: markAttrs(suggestionClasses('all', 'ins'), span.user ?? change.user, index),
            });
        } else if (options.showDeleted) {
          specs.push({
            type: 'deleted',
            at: Math.min(at, to - 1),
            index,
            text: span.text,
            attrs: markAttrs(suggestionClasses('all', 'del'), span.user ?? change.user, index),
          });
        }
      }
    }
  });
  return specs;
}

/** The position of the block or field id in `doc`, or null when the document has none (a removed block). */
export function positionOf(doc: PMNode, id: string): number | null {
  return identified(doc).get(id)?.pos ?? null;
}
