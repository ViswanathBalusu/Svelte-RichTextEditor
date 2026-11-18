/**
 * What a recovered-edits item carries as content (FE-010 criterion 6; 02 §2.2; 05 §8.1): the work
 * that was set aside, read back from the steps that made it, as a CDM fragment that the pane or a
 * host can show or put back. Nothing is changed in the document.
 *
 * A step that inserts content gives that content. Steps that insert inline content one after
 * another (typing) are joined into one run, and a run that sits between block content is wrapped in
 * a paragraph so that the fragment is valid. Steps that only delete or only change marks give no
 * content, and the item then has no fragment.
 */
import { Fragment, type Node as PMNode, type Schema, Slice } from 'prosemirror-model';
import { ReplaceAroundStep, ReplaceStep, Step } from 'prosemirror-transform';
import type { StepJson } from '@docedit/authority';
import type { CdmFragment } from './api.ts';
import { fragmentOfSlice } from './content.ts';

/**
 * Why work was set aside, in the three words of FE-010 criterion 6: a rebase drops it, a reload, a
 * reset or a stale commit leaves it unsent, and any other reason is a rejection code.
 */
export function recoveredKind(reason: string): 'rejected' | 'dropped' | 'unsent' {
  if (reason === 'rebase') return 'dropped';
  if (reason === 'reload' || reason === 'reset' || reason === 'stale') return 'unsent';
  return 'rejected';
}

/**
 * The fragment of the content the steps inserted, or null when they inserted none. `doc` is the
 * document that holds the style and numbering definitions the content refers to.
 */
export function fragmentOfSteps(
  doc: PMNode,
  steps: readonly StepJson[],
  schema: Schema,
  cdm: number,
  requires: readonly string[],
): CdmFragment | null {
  const slices: Slice[] = [];
  for (const json of steps) {
    let step: Step;
    try {
      step = Step.fromJSON(schema, json);
    } catch {
      continue;
    }
    if ((step instanceof ReplaceStep || step instanceof ReplaceAroundStep) && step.slice.size > 0)
      slices.push(step.slice);
  }
  if (slices.length === 0) return null;
  if (slices.length === 1) return fragmentOfSlice(doc, slices[0]!, cdm, requires);

  const parts: Array<{ blocks: Fragment } | { inline: Fragment }> = [];
  for (const slice of slices) {
    const inline = slice.content.firstChild?.isInline === true;
    const last = parts[parts.length - 1];
    if (inline && last && 'inline' in last) last.inline = last.inline.append(slice.content);
    else parts.push(inline ? { inline: slice.content } : { blocks: slice.content });
  }
  const only = parts.length === 1 ? parts[0]! : null;
  if (only && 'inline' in only)
    return fragmentOfSlice(doc, new Slice(only.inline, 0, 0), cdm, requires);

  let content = Fragment.empty;
  for (const part of parts) {
    if ('blocks' in part) content = content.append(part.blocks);
    else {
      const paragraph = schema.nodes['paragraph']?.createAndFill(null, part.inline);
      if (paragraph) content = content.addToEnd(paragraph);
    }
  }
  const first = slices[0]!;
  const last = slices[slices.length - 1]!;
  const blockFirst = first.content.firstChild?.isInline !== true;
  const blockLast = last.content.firstChild?.isInline !== true;
  return fragmentOfSlice(
    doc,
    new Slice(content, blockFirst ? first.openStart : 0, blockLast ? last.openEnd : 0),
    cdm,
    requires,
  );
}
