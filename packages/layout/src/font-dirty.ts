/**
 * The blocks that use a font (FE-064 criterion 3; 02 §6, §9.3). When a font arrives, the font epoch
 * advances and the paragraphs that measured with that font are the only ones whose line breaking is
 * stale. The incremental layout (`incremental.ts`) keeps each paragraph's lines while its breaker
 * input is unchanged, and a font arrival does not change that input, so the caller marks these
 * blocks dirty and no others.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import { flowParagraphs, type FlowBlock, type FlowDocument } from './flow.ts';

/**
 * The identifiers of the CDM blocks that have a paragraph measured with one of `aliases`: the mark
 * font or any inline's font, in the body, the header and footer stories, the footnotes, and inside
 * tables. A block split into several paragraphs (`FlowParagraph.part`) contributes its one
 * identifier, which is how the incremental cache is keyed.
 */
export function blocksUsingFonts(
  doc: FlowDocument,
  aliases: ReadonlySet<string> | readonly string[],
): Set<string> {
  const wanted = new Set<string>(aliases);
  const out = new Set<string>();
  const visit = (blocks: readonly FlowBlock[]): void => {
    for (const paragraph of flowParagraphs(blocks)) {
      if (
        wanted.has(paragraph.markFont.family) ||
        paragraph.inlines.some((inline) => wanted.has(inline.font.family))
      )
        out.add(paragraph.id);
    }
  };
  for (const section of doc.sections) visit(section.blocks);
  for (const blocks of doc.stories.values()) visit(blocks);
  for (const note of doc.notes.values()) visit(note.blocks);
  return out;
}
