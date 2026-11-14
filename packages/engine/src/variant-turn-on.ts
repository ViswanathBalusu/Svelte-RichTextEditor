/**
 * Turning on the first-page or odd and even variants creates their header and footer stories
 * (FE-137 criterion 2; 03 §4.1, §4.2; FE-057 criterion 2).
 *
 * The page setup's flags (`differentFirstPage`, `differentOddEven`) and the stories they need are
 * changed in one transaction, so a turned-on flag never points at a missing story. The module
 * builds the transaction; it does not dispatch it, and it does not open the header panel. The
 * panel is the view's (FE-057), and the core names the story for it.
 *
 * Rights: the caller passes `writable` for the position of the `page_setup` definition (07 §5.3,
 * PRM-012), as `setPageSetup` does. A false `writable` returns null and nothing is built.
 *
 * Not wired: no document API command calls this module yet. The core's `setPageSetup` still
 * changes the flags alone; the wiring is recorded in the story's Notes.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import {
  type StoryPart,
  type StoryVariant,
  storyOfVariant,
  variantAttribute,
} from './header-footer.ts';

/** The page setup flags that switch on a variant. */
export type VariantFlag = 'differentFirstPage' | 'differentOddEven';

const FLAG_VARIANT: Readonly<Record<VariantFlag, StoryVariant>> = {
  differentFirstPage: 'first',
  differentOddEven: 'even',
};

/** The story a new variant gets: its part, its variant and the identifier the caller chose. */
export interface CreatedVariantStory {
  readonly part: StoryPart;
  readonly variant: StoryVariant;
  readonly storyId: string;
}

/** The page setup node with the identifier, or null when the document holds none. */
function findPageSetup(doc: PMNode, pageSetupId: string): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'page_setup' && node.attrs['id'] === pageSetupId) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

/** The position of the body in a document, or null when it has none. */
function bodyPosition(doc: PMNode): number | null {
  let pos: number | null = null;
  doc.forEach((child, offset) => {
    if (pos === null && child.type.name === 'body') pos = offset;
  });
  return pos;
}

/**
 * Builds the transaction that turns on the given flags and creates the header and footer stories
 * their variants need. `storyIdOf` gives the identifier of each new story; each must be a new
 * 16-character identifier, and the caller keeps them unique.
 *
 * Returns null when the caller may not change the definition, the page setup or the body is
 * missing, or `storyIdOf` returns an identifier that is already in use in the document.
 * A flag whose variant already has both stories only sets the flag.
 */
export function turnOnVariants(
  state: EditorState,
  pageSetupId: string,
  flags: readonly VariantFlag[],
  storyIdOf: (part: StoryPart, variant: StoryVariant) => string,
  writable: boolean,
): { tr: Transaction; created: CreatedVariantStory[] } | null {
  if (!writable) return null;
  const { schema, doc } = state;
  const setup = findPageSetup(doc, pageSetupId);
  if (setup === null) return null;

  const tr = state.tr;
  const created: CreatedVariantStory[] = [];
  const usedIds = new Set<string>();
  doc.descendants((node) => {
    if (typeof node.attrs['id'] === 'string') usedIds.add(node.attrs['id']);
    return true;
  });

  for (const flag of flags) {
    const variant = FLAG_VARIANT[flag];
    for (const part of ['header', 'footer'] as const) {
      if (storyOfVariant(doc, pageSetupId, part, variant) !== null) continue;
      const storyId = storyIdOf(part, variant);
      if (usedIds.has(storyId)) return null;
      usedIds.add(storyId);
      const bodyPos = bodyPosition(tr.doc);
      if (bodyPos === null) return null;
      const story = schema.nodes['story']!.create(
        { id: storyId, kind: part },
        schema.nodes['paragraph']!.create(),
      );
      // The body sits after the page setup, so the page setup's position is unchanged.
      tr.insert(bodyPos, story);
      created.push({ part, variant, storyId });
    }
  }

  // The insertions may move the page setup if it sits after the body, so find it again.
  const after = findPageSetup(tr.doc, pageSetupId);
  if (after === null) return null;
  for (const story of created) {
    tr.setNodeAttribute(after.pos, variantAttribute(story.part, story.variant), story.storyId);
  }
  for (const flag of flags) tr.setNodeAttribute(after.pos, flag, true);
  return { tr, created };
}
